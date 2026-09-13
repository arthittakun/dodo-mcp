import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrainQueryResult } from '../../src/services/brain/contracts.js';
import { launch, mcpRaw, obtainToken, rpc, type TestContext, type TokenSet } from '../helpers/testServer.js';
import { assertOk, tool } from '../helpers/multimodal.js';

async function initialBuild(ctx: TestContext): Promise<void> {
  const brain = ctx.server.services.brain!;
  const state = brain.status();
  if (state.status === 'running' && state.activeRunId) await brain.wait(state.activeRunId, 10_000);
  const run = await brain.start('full');
  expect((await brain.wait(run.runId, 10_000)).status).toBe('completed');
}

describe('Phase 05 Project Brain security boundaries', () => {
  let ctx: TestContext;
  let owner: TokenSet;
  let reader: TokenSet;
  let writer: TokenSet;
  beforeAll(async () => {
    ctx = await launch({ toolSurface: 'compact', fixtureFiles: {
      'safe.ts': 'export const visibleBrainSymbol = 1;\n',
      '.env': 'SECRET_BRAIN_SYMBOL=never\n',
      '.dodo-dev-state/private.ts': 'export const privateStateSymbol = 1;\n',
    } });
    fs.writeFileSync(path.join(ctx.fixtureDir, 'hard.ts'), 'export const hardlinkSymbol = 1;\n');
    fs.linkSync(path.join(ctx.fixtureDir, 'hard.ts'), path.join(ctx.fixtureDir, 'hard-alias.ts'));
    await initialBuild(ctx);
    owner = await obtainToken(ctx);
    reader = await obtainToken(ctx, { scope: 'dodo:read' });
    writer = await obtainToken(ctx, { scope: 'dodo:read dodo:write' });
  }, 120_000);
  afterAll(async () => ctx?.cleanup());
  const gateway = (token: string, name: string, operation: string, args: Record<string, unknown> = {}) => tool(ctx, token, name, { operation, args });

  it('requires OAuth and allows read-only query while denying control scopes', async () => {
    expect((await mcpRaw(ctx, rpc('tools/list'))).status).toBe(401);
    const read = BrainQueryResult.parse(assertOk(await gateway(reader.accessToken, 'dodo_assist_read', 'brain_query', { query: 'visibleBrainSymbol' })));
    expect(read.nodes.some((node) => node.name === 'visibleBrainSymbol')).toBe(true);
    const denied = await gateway(writer.accessToken, 'dodo_assist_change', 'brain_rebuild', { mode: 'incremental' });
    expect(denied.envelope.error).toMatchObject({ code: 'FORBIDDEN', detail: { requiredScope: 'dodo:exec' } });
  });

  it('enforces workspace context and rejects nested overrides through the gateway', async () => {
    const stale = await tool(ctx, owner.accessToken, 'dodo_assist_read', { workspaceEpoch: 'boot_stale', operation: 'brain_query', args: {} });
    expect(stale.envelope.error).toMatchObject({ code: 'STALE_WORKSPACE' });
    const nested = await gateway(owner.accessToken, 'dodo_assist_read', 'brain_query', { workspaceId: 'ws_evil' });
    expect(nested.envelope.error).toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('never indexes or reveals secret, private-state, symlink/hardlink or traversal paths', async () => {
    const paths = ctx.server.services.store.db.prepare('SELECT path FROM brain_file_cache ORDER BY path').all() as Array<{ path: string }>;
    expect(paths.map((row) => row.path)).toEqual(['safe.ts']);
    for (const deniedPath of ['.env', '.dodo-dev-state/private.ts', '../safe.ts']) {
      const denied = await gateway(owner.accessToken, 'dodo_assist_read', 'brain_query', { path: deniedPath });
      expect((denied.envelope.error as { code?: string } | null)?.code, deniedPath).toMatch(/^(SECRET_PATH_DENIED|PATH_DENIED)$/);
    }
  });

  it('rechecks live ACL and source hash instead of treating index data as permission', async () => {
    const before = ctx.server.services.store.clientAccess(ctx.server.workspaceId, reader.clientId);
    ctx.server.services.store.setClientAccess(ctx.server.workspaceId, reader.clientId, []);
    try {
      const denied = await gateway(reader.accessToken, 'dodo_assist_read', 'brain_query', {});
      expect(denied.envelope.error).toMatchObject({ code: 'WORKSPACE_ACCESS_REQUIRED' });
    } finally { ctx.server.services.store.setClientAccess(ctx.server.workspaceId, reader.clientId, before); }

    // Keep the indexed snapshot fixed while testing live source validation.
    // A background rebuild between the two HTTP requests would legitimately
    // make the second result current, hiding the stale-snapshot scenario.
    const brain = ctx.server.services.brain!;
    await brain.pause(true);
    try {
      fs.writeFileSync(path.join(ctx.fixtureDir, 'safe.ts'), 'export const visibleBrainSymbol = 2;\n');
      const freshOnly = BrainQueryResult.parse(assertOk(await gateway(owner.accessToken, 'dodo_assist_read', 'brain_query', { query: 'visibleBrainSymbol' })));
      expect(freshOnly.nodes).toEqual([]);
      expect(freshOnly.staleOmitted).toBeGreaterThan(0);
      const stale = BrainQueryResult.parse(assertOk(await gateway(owner.accessToken, 'dodo_assist_read', 'brain_query', { query: 'visibleBrainSymbol', includeStale: true })));
      expect(stale.nodes[0]?.freshness).toBe('stale');
    } finally { await brain.pause(false); }
  });

  it('binds cursors to query, workspace and principal and rejects tampering', async () => {
    const page = BrainQueryResult.parse(assertOk(await gateway(owner.accessToken, 'dodo_assist_read', 'brain_query', { includeStale: true, limit: 1 })));
    expect(page.nextCursor).toBeTruthy();
    const tampered = page.nextCursor!.slice(0, -1) + (page.nextCursor!.endsWith('a') ? 'b' : 'a');
    const bad = await gateway(owner.accessToken, 'dodo_assist_read', 'brain_query', { includeStale: true, limit: 1, cursor: tampered });
    expect(bad.envelope.error).toMatchObject({ code: 'INVALID_INPUT' });
    const other = await gateway(reader.accessToken, 'dodo_assist_read', 'brain_query', { includeStale: true, limit: 1, cursor: page.nextCursor });
    expect(other.envelope.error).toMatchObject({ code: 'STALE_WORKSPACE' });
  });

  it('keeps inspect-mode approvals bound to the target maintenance action', async () => {
    const attempt = await gateway(owner.accessToken, 'dodo_assist_change', 'brain_rebuild', { mode: 'incremental' });
    expect(attempt.envelope.error).toMatchObject({ code: 'APPROVAL_REQUIRED' });
    const approvalId = (attempt.envelope.error as { detail: { approvalId: string } }).detail.approvalId;
    expect(ctx.server.services.store.getApproval(approvalId)?.tool).toBe('brain_rebuild');
    expect(ctx.server.services.store.setApprovalStatus(approvalId, 'approved')).toBe(true);
    const retry = await gateway(owner.accessToken, 'dodo_assist_change', 'brain_rebuild', { mode: 'incremental', waitMs: 10_000 });
    expect(retry.envelope.ok, JSON.stringify(retry.envelope.error)).toBe(true);
    const pause = await gateway(owner.accessToken, 'dodo_assist_change', 'brain_pause', { paused: true });
    expect(pause.envelope.error).toMatchObject({ code: 'APPROVAL_REQUIRED' });
  });

  it('fails closed on corrupt cached rows and queues recovery', async () => {
    ctx.server.services.store.db.prepare("UPDATE brain_nodes SET details='not-json' WHERE workspace_id=? LIMIT 1").run(ctx.server.workspaceId);
    const result = await gateway(owner.accessToken, 'dodo_assist_read', 'brain_query', { includeStale: true });
    expect(result.envelope.error).toMatchObject({ code: 'RECOVERY_REQUIRED' });
    const brain = ctx.server.services.brain!;
    let recovered = brain.status();
    // Corruption recovery is queued on a zero-delay timer. Wait for that
    // explicit lifecycle transition instead of racing the timer callback.
    for (let attempt = 0; recovered.status === 'failed' && attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      recovered = brain.status();
    }
    if (recovered.status === 'running' && recovered.activeRunId) recovered = await brain.wait(recovered.activeRunId, 10_000);
    expect(recovered).toMatchObject({ status: 'completed', lastError: null });
    expect((await gateway(owner.accessToken, 'dodo_assist_read', 'brain_query', { includeStale: true })).envelope.ok).toBe(true);
  });
});
