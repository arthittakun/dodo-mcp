import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { launch, obtainToken, callToolLegacy, wsArgs, type TestContext, type TokenSet } from '../helpers/testServer.js';

/**
 * CHG-08/CHG-09 fault injection: a write that fails mid-changeset must be
 * reverted (or reported as PARTIAL_RECOVERY_REQUIRED) — never left half-applied
 * silently — and an interrupted changeset must be reconciled on boot before
 * new mutations are accepted.
 */
describe('CHG-08/09: fault injection & boot reconciliation', () => {
  let ctx: TestContext;
  let tokens: TokenSet;

  beforeEach(async () => {
    ctx = await launch({ toolSurface: 'full',  trust: 'edit', fixtureFiles: { 'a.txt': 'A\n', 'locked/b.txt': 'B\n' } });
    tokens = await obtainToken(ctx);
  }, 120_000);
  afterEach(async () => {
    vi.restoreAllMocks();
    try {
      fs.chmodSync(path.join(ctx.fixtureDir, 'locked'), 0o755);
    } catch {
      /* ignore */
    }
    await ctx?.cleanup();
  });

  const data = (env: Record<string, unknown>) => env['data'] as Record<string, unknown>;
  const errCode = (env: Record<string, unknown>) => (env['error'] as Record<string, unknown> | null)?.['code'];
  const readFile = (rel: string) => fs.readFileSync(path.join(ctx.fixtureDir, rel), 'utf8');

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('CHG-08: a failing second write reverts the first (no half-applied changeset)', async () => {
    const preview = await callToolLegacy(ctx, tokens.accessToken, 'preview_changes', {
      ...wsArgs(ctx),
      operations: [
        { op: 'replace_file', path: 'a.txt', content: 'A2\n' },
        { op: 'replace_file', path: 'locked/b.txt', content: 'B2\n' },
      ],
    });
    const d = data(preview.envelope);
    // Inject the fault AFTER preview: make the second file's directory unwritable
    // so its temp-file creation fails during apply.
    fs.chmodSync(path.join(ctx.fixtureDir, 'locked'), 0o555);
    const res = await callToolLegacy(ctx, tokens.accessToken, 'apply_changes', { ...wsArgs(ctx), planId: d['planId'], planHash: d['planHash'], idempotencyKey: 'k-fault-001' });
    expect(res.isError).toBe(true);
    expect(['INTERNAL_ERROR', 'PARTIAL_RECOVERY_REQUIRED', 'RESOURCE_LIMIT']).toContain(errCode(res.envelope));
    // The first file must have been reverted (or, if revert was impossible, the
    // changeset must be flagged for recovery) — never a silent partial apply.
    const store = ctx.server.services.store;
    const cs = store.listChangesets(ctx.server.workspaceId, 5)[0];
    if (cs?.status === 'recovery_required') {
      expect(errCode(res.envelope)).toBe('PARTIAL_RECOVERY_REQUIRED');
    } else {
      expect(readFile('a.txt')).toBe('A\n');
      expect(cs?.status).toBe('failed');
    }
    expect(readFile('locked/b.txt')).toBe('B\n');
  });

  it('CHG-08b: an injected filesystem failure on the second write rolls back the first on every platform', async () => {
    const preview = await callToolLegacy(ctx, tokens.accessToken, 'preview_changes', {
      ...wsArgs(ctx), operations: [
        { op: 'replace_file', path: 'a.txt', content: 'A2\n' },
        { op: 'replace_file', path: 'locked/b.txt', content: 'B2\n' },
      ],
    });
    expect(preview.isError).toBe(false);
    const plan = data(preview.envelope);
    const open = fs.openSync;
    let injected = false;
    vi.spyOn(fs, 'openSync').mockImplementation((file, flags, mode) => {
      if (!injected && typeof file === 'string' && path.dirname(file) === ctx.server.services.wfs.absOf('locked') && flags === 'wx') {
        expect(readFile('a.txt')).toBe('A2\n');
        injected = true;
        throw Object.assign(new Error('fixture second-write failure'), { code: 'EACCES' });
      }
      return open(file, flags, mode);
    });
    const result = await callToolLegacy(ctx, tokens.accessToken, 'apply_changes', {
      ...wsArgs(ctx), planId: plan['planId'], planHash: plan['planHash'], idempotencyKey: 'k-fault-portable',
    });
    expect(injected).toBe(true);
    expect(result.isError).toBe(true);
    expect(readFile('a.txt')).toBe('A\n');
    expect(readFile('locked/b.txt')).toBe('B\n');
    expect(ctx.server.services.store.listChangesets(ctx.server.workspaceId, 1)[0]?.status).toBe('failed');
  });

  it('CHG-09: a changeset left "committing" by a crash is reconciled on boot and blocks mutations until resolved', async () => {
    const store = ctx.server.services.store;
    // Simulate a crash mid-apply: a committing changeset whose first step was
    // written with bytes that do NOT match the recorded after-hash (ambiguous).
    fs.writeFileSync(path.join(ctx.fixtureDir, 'a.txt'), 'half-written\n');
    store.createChangeset({ id: 'cs_crashed01', workspaceId: ctx.server.workspaceId, epoch: 'boot_old', planId: null, principal: tokens.grantId, kind: 'apply', summary: 'crash sim' });
    store.addJournalStep({ changesetId: 'cs_crashed01', seq: 0, op: 'modify', path: 'a.txt', destPath: null, beforeHash: 'sha256:before', afterHash: 'sha256:expected-after', backupPath: null, state: 'written' });
    const port = ctx.port;
    const configDir = ctx.configDir;
    const fixtureDir = ctx.fixtureDir;
    await ctx.server.close();
    const restarted = await launch({ toolSurface: 'full',  configDir, fixtureDir, port, trust: 'edit' });
    ctx.server = restarted.server;
    const cs = restarted.server.services.store.getChangeset('cs_crashed01');
    expect(cs?.status).toBe('recovery_required');
    // New mutations are refused until the owner resolves it.
    const t2 = await obtainToken(restarted);
    const w = await callToolLegacy(restarted, t2.accessToken, 'write_file', { ...wsArgs(restarted), path: 'new.txt', content: 'x' });
    expect(errCode(w.envelope)).toBe('RECOVERY_REQUIRED');
    // Owner resolves over IPC-equivalent → mutations flow again.
    restarted.server.services.store.setChangesetStatus('cs_crashed01', 'failed', 'manually resolved');
    const w2 = await callToolLegacy(restarted, t2.accessToken, 'write_file', { ...wsArgs(restarted), path: 'new.txt', content: 'x' });
    expect(w2.isError).toBe(false);
  }, 60_000);
});
