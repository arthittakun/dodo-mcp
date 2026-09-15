import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrainNode, BrainQueryResult, BrainStatus } from '../../src/services/brain/contracts.js';
import { callToolLegacy, launch, obtainToken, type TestContext, type TokenSet } from '../helpers/testServer.js';
import { assertOk, tool } from '../helpers/multimodal.js';

async function build(ctx: TestContext, mode: 'incremental' | 'full' = 'incremental') {
  const brain = ctx.server.services.brain!;
  const current = brain.status();
  if (current.status === 'running' && current.activeRunId) await brain.wait(current.activeRunId, 10_000);
  const started = await brain.start(mode);
  const status = await brain.wait(started.runId, 10_000);
  expect(status.status, status.lastError ?? '').toBe('completed');
  return status;
}

describe('Phase 05 Project Brain over real HTTP + OAuth', () => {
  let ctx: TestContext;
  let token: TokenSet;
  beforeAll(async () => {
    ctx = await launch({ toolSurface: 'full', trust: 'trusted', fixtureFiles: {
      'src/a.ts': 'export function alpha(value: number) { return value + 1; }\n',
      'src/b.ts': "import { alpha } from './a.js';\nexport const beta = () => alpha(1);\ntest('beta', () => beta());\n",
      'src/routes.ts': "app.get('/health', () => ({ ok: true }));\n",
      'dist/generated.ts': 'export const ignoredGenerated = true;\n',
      '.env': 'DODO_SECRET=never-index\n',
      'package.json': JSON.stringify({ dependencies: { zod: '^4.2.0' }, devDependencies: { vitest: '^5.0.0' } }),
    } });
    await build(ctx, 'full');
    token = await obtainToken(ctx);
  }, 120_000);
  afterAll(async () => ctx?.cleanup());
  const call = (name: string, args: Record<string, unknown> = {}) => tool(ctx, token.accessToken, name, args);

  it('reports a fresh bounded index and exposes it from project_overview', async () => {
    const status = BrainStatus.parse(assertOk(await call('brain_status')));
    expect(status).toMatchObject({ status: 'completed', paused: false, files: 4, staleFiles: 0 });
    expect(status.nodes).toBeGreaterThan(0);
    const overviewResult = await callToolLegacy(ctx, token.accessToken, 'project_overview', {});
    expect(overviewResult.envelope['ok'], JSON.stringify(overviewResult.envelope['error'])).toBe(true);
    const overview = overviewResult.envelope['data'] as { brain: Record<string, unknown> };
    expect(overview.brain).toMatchObject({ available: true, status: 'completed', files: 4 });
    const privateRows = ctx.server.services.store.db.prepare("SELECT path FROM brain_file_cache WHERE path='.env' OR path LIKE 'dist/%'").all();
    expect(privateRows).toEqual([]);
  });

  it('queries symbols, imports, routes, tests and dependencies with current-source evidence', async () => {
    const result = BrainQueryResult.parse(assertOk(await call('brain_query', { limit: 100 })));
    expect(result.nodes.map((node) => node.type)).toEqual(expect.arrayContaining(['file', 'symbol', 'route', 'test', 'dependency']));
    expect(result.edges.map((edge) => edge.type)).toEqual(expect.arrayContaining(['contains', 'imports', 'references', 'depends_on']));
    expect(result.nodes.every((node) => node.freshness === 'current')).toBe(true);
    expect(result.evidence.sourceVerified).toBe(true);
    const alpha = BrainNode.parse(assertOk(await call('brain_symbol', {
      uri: result.nodes.find((node) => node.type === 'symbol' && node.name === 'alpha')!.uri,
    })));
    expect(alpha).toMatchObject({ name: 'alpha', path: 'src/a.ts', freshness: 'current' });
  });

  it('preserves semantic identity across an exact-content move and reparses only changed files', async () => {
    const before = BrainQueryResult.parse(assertOk(await call('brain_query', { query: 'alpha', nodeTypes: ['symbol'], limit: 20 })));
    const original = before.nodes.find((node) => node.name === 'alpha')!;
    fs.renameSync(path.join(ctx.fixtureDir, 'src/a.ts'), path.join(ctx.fixtureDir, 'src/moved.ts'));
    let status = await build(ctx);
    expect(status.metrics.movedFiles).toBe(1);
    expect(status.metrics.parsedFiles).toBe(0);
    const moved = BrainNode.parse(assertOk(await call('brain_symbol', { uri: original.uri })));
    expect(moved).toMatchObject({ id: original.id, uri: original.uri, path: 'src/moved.ts', freshness: 'current' });

    fs.writeFileSync(path.join(ctx.fixtureDir, 'src/b.ts'), "import { alpha } from './moved.js';\nexport const beta = () => alpha(2);\n");
    status = await build(ctx);
    expect(status.metrics.parsedFiles).toBe(1);
    expect(status.metrics.reusedFiles).toBeGreaterThanOrEqual(3);
    expect(status.metrics.affectedFiles).toBeGreaterThanOrEqual(1);
  });

  it('removes deleted sources, records syntax diagnostics and paginates without skipping rows', async () => {
    fs.rmSync(path.join(ctx.fixtureDir, 'src/routes.ts'));
    fs.writeFileSync(path.join(ctx.fixtureDir, 'src/broken.ts'), 'export function broken( {\n');
    const status = await build(ctx);
    expect(status.metrics.removedFiles).toBe(1);
    expect(status.metrics.syntaxErrors).toBeGreaterThan(0);
    const deleted = BrainQueryResult.parse(assertOk(await call('brain_query', { path: 'src/routes.ts', includeStale: true })));
    expect(deleted.nodes).toEqual([]);
    const broken = BrainQueryResult.parse(assertOk(await call('brain_query', { path: 'src/broken.ts', nodeTypes: ['file'] })));
    expect(JSON.stringify(broken.nodes[0]?.details)).toContain('diagnostics');

    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 100; page += 1) {
      const result = BrainQueryResult.parse(assertOk(await call('brain_query', { limit: 2, ...(cursor ? { cursor } : {}) })));
      for (const node of result.nodes) { expect(seen.has(`n:${node.id}`)).toBe(false); seen.add(`n:${node.id}`); }
      for (const edge of result.edges) { expect(seen.has(`e:${edge.id}`)).toBe(false); seen.add(`e:${edge.id}`); }
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    const counts = ctx.server.services.brain!.status();
    expect(seen.size).toBe(counts.nodes + counts.edges);
  });
});

describe('Project Brain through the compact gateway', () => {
  it('discovers, queries and rebuilds without exceeding the 20-tool compact surface', async () => {
    const ctx = await launch({ toolSurface: 'compact', trust: 'trusted', fixtureFiles: { 'index.ts': 'export const compactBrain = 1;\n' } });
    try {
      await build(ctx, 'full');
      const token = await obtainToken(ctx);
      const gateway = (name: string, operation: string, args: Record<string, unknown> = {}) => tool(ctx, token.accessToken, name, { operation, args });
      const detail = assertOk(await tool(ctx, token.accessToken, 'dodo_discover', { operation: 'brain_query' })) as { gateway: string };
      expect(detail.gateway).toBe('dodo_assist_read');
      const query = BrainQueryResult.parse(assertOk(await gateway('dodo_assist_read', 'brain_query', { query: 'compactBrain' })));
      expect(query.nodes.some((node) => node.name === 'compactBrain')).toBe(true);
      const rebuilt = assertOk(await gateway('dodo_assist_change', 'brain_rebuild', { mode: 'incremental', waitMs: 10_000 })) as { status: { status: string } };
      expect(rebuilt.status.status).toBe('completed');
    } finally { await ctx.cleanup(); }
  }, 120_000);
});

describe('Project Brain lifecycle controls', () => {
  it('refuses concurrent runs, cancels before commit and recovers interrupted state on restart', async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 120; index += 1) files[`src/f${index}.ts`] = `export const value${index} = ${index};\n`;
    let ctx = await launch({ toolSurface: 'full', trust: 'trusted', fixtureFiles: files });
    const fixtureDir = ctx.fixtureDir, configDir = ctx.configDir, port = ctx.port;
    try {
      const brain = ctx.server.services.brain!;
      const first = await brain.start('full');
      await expect(brain.start('incremental')).rejects.toMatchObject({ code: 'CONFLICT' });
      expect((await brain.cancel(first.runId)).changed).toBe(true);
      expect(['canceled', 'completed']).toContain(brain.status().status);
      ctx.server.services.store.db.prepare("UPDATE brain_index_state SET status='running',active_run_id='brainrun_crash' WHERE workspace_id=?").run(ctx.server.workspaceId);
      ctx.server.services.store.db.prepare("INSERT INTO brain_runs(id,workspace_id,mode,trigger_kind,status,started_at,metrics) VALUES ('brainrun_crash',?,'full','automatic','running',?,?)")
        .run(ctx.server.workspaceId, Date.now(), JSON.stringify({ scannedFiles: 0, parsedFiles: 0, reusedFiles: 0, movedFiles: 0, removedFiles: 0, skippedFiles: 0, affectedFiles: 0, nodes: 0, edges: 0, syntaxErrors: 0 }));
      await ctx.cleanup();
      ctx = await launch({ fixtureDir, configDir, port, locked: true, toolSurface: 'full', trust: 'trusted' });
      expect(ctx.server.services.brain!.status()).toMatchObject({ status: 'interrupted', lastError: expect.stringContaining('interrupted') });
      expect((ctx.server.services.store.db.prepare("SELECT status FROM brain_runs WHERE id='brainrun_crash'").get() as { status: string }).status).toBe('interrupted');
    } finally { await ctx.cleanup(); }
  }, 120_000);
});
