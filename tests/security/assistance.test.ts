import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { launch, obtainToken, callToolLegacy, mcpRaw, rpc, wsArgs, type TestContext, type TokenSet } from '../helpers/testServer.js';
import { SymbolSchema } from '../../src/services/assistance/contracts.js';
import { VerificationSchema } from '../../src/services/assistance/verification.js';

/** Only isolated fixture policy is manipulated to exercise the existing boundaries. */
describe('assistance inherits existing authorization and file boundaries', () => {
  let ctx: TestContext, owner: TokenSet, reader: TokenSet;
  beforeAll(async () => {
    ctx = await launch({ toolSurface: 'full',  fixtureFiles: {
      'package.json': JSON.stringify({ name: 'assist-security', version: '1', scripts: { test: 'node test.cjs', build: 'node test.cjs' } }),
      'test.cjs': 'console.log(JSON.stringify({numTotalTests:1,numPassedTests:1,numFailedTests:0}));',
      'a.ts': 'export function add(a: number,b: number) { return a + b; }',
      '.env': 'NEVER_DISCLOSE=private-value',
    } });
    owner = await obtainToken(ctx); reader = await obtainToken(ctx, { scope: 'dodo:read' });
  });
  afterEach(() => { vi.restoreAllMocks(); ctx.server.services.store.setTrustMode(ctx.server.workspaceId, 'inspect'); });
  afterAll(async () => ctx?.cleanup());
  const call = (name: string, args: Record<string, unknown>, token = owner.accessToken) => callToolLegacy(ctx, token, name, { ...wsArgs(ctx), ...args });
  const error = (result: Awaited<ReturnType<typeof call>>, code: string) => { expect(result.isError).toBe(true); expect(result.envelope.error).toMatchObject({ code }); };
  async function runArgs(key: string) {
    const res = await call('verify_changes', { mode: 'plan', files: ['a.ts'] });
    expect(res.isError).toBe(false);
    const p = VerificationSchema.parse(res.envelope.data), t = p.recommendedTasks.find(r => r.taskId === 'npm:test')!;
    return { mode: 'run', files: ['a.ts'], tasks: [{ taskId: t.taskId, recipeDigest: t.recipeDigest }], sourceDigest: p.freshness.baselineDigest, idempotencyKey: key, waitMs: 10000 };
  }
  it('anonymous access is still rejected before dispatch', async () => {
    expect((await mcpRaw(ctx, rpc('tools/call', { name: 'context_for_task', arguments: { ...wsArgs(ctx), goal: 'add' } }))).status).toBe(401);
  });
  it('read-only clients can analyze/read but cannot refactor or execute verification', async () => {
    expect((await call('context_for_task', { goal: 'add', files: ['a.ts'] }, reader.accessToken)).isError).toBe(false);
    const read = await call('read_symbol', { file: 'a.ts', symbol: 'add' }, reader.accessToken);
    expect(read.isError).toBe(false);
    error(await call('preview_refactor', { file: 'a.ts', symbol: 'add', expectedHash: SymbolSchema.parse(read.envelope.data).hash, body: 'return 0;' }, reader.accessToken), 'FORBIDDEN');
    error(await call('verify_changes', { mode: 'plan' }, reader.accessToken), 'FORBIDDEN');
    error(await call('verify_changes', await runArgs('assist-sec-reader'), reader.accessToken), 'FORBIDDEN');
  });
  it('inspect mode permits preview but requires the existing owner approval for apply and exec', async () => {
    const read = SymbolSchema.parse((await call('read_symbol', { file: 'a.ts', symbol: 'add' })).envelope.data);
    const result = await call('preview_refactor', { file: 'a.ts', symbol: 'add', expectedHash: read.hash, body: 'return 0;' });
    const p = result.envelope.data as { planId: string; planHash: string; requiresApproval: boolean };
    expect(p.requiresApproval).toBe(true);
    error(await call('apply_changes', { planId: p.planId, planHash: p.planHash, idempotencyKey: 'assist-sec-apply' }), 'APPROVAL_REQUIRED');
    const before = ctx.server.services.jobs.list(ctx.server.workspaceId, 100).length;
    error(await call('verify_changes', await runArgs('assist-sec-inspect')), 'APPROVAL_REQUIRED');
    expect(ctx.server.services.jobs.list(ctx.server.workspaceId, 100)).toHaveLength(before);
    expect(fs.readFileSync(path.join(ctx.fixtureDir, 'a.ts'), 'utf8')).toContain('a + b');
    expect(ctx.server.services.trustMode()).toBe('inspect');
  });
  it('all new filesystem entry points reject secrets, traversal and stale workspace context', async () => {
    for (const [file, code] of [['.env', 'SECRET_PATH_DENIED'], ['../a.ts', 'PATH_DENIED']] as const) {
      error(await call('context_for_task', { goal: 'secret', files: [file] }), code);
      error(await call('analyze_impact', { files: [file] }), code);
      error(await call('read_symbol', { file, symbol: 'add' }), code);
      error(await call('preview_refactor', { file, symbol: 'add', expectedHash: 'sha256:' + '0'.repeat(64), body: '' }), code);
      error(await call('verify_changes', { mode: 'plan', files: [file] }), code);
    }
    error(await call('context_for_task', { goal: 'add', workspaceEpoch: 'stale-epoch' }), 'STALE_WORKSPACE');
    const result = await call('context_for_task', { goal: 'NEVER_DISCLOSE', terms: ['NEVER_DISCLOSE'] });
    expect(JSON.stringify(result.envelope.data)).not.toContain('private-value');
  });
  it('verification keeps default sandbox arguments and report ownership; no client can borrow another report', async () => {
    ctx.server.services.store.setTrustMode(ctx.server.workspaceId, 'trusted');
    const spy = vi.spyOn(ctx.server.services.jobs, 'start');
    const res = await call('verify_changes', await runArgs('assist-sec-owner-report'));
    expect(res.isError).toBe(false);
    const r = VerificationSchema.parse(res.envelope.data); expect(r.status).toBe('passed');
    expect(spy.mock.calls[0]?.[0].sandbox).toBeUndefined(); expect(spy.mock.calls[0]?.[0].network).toBeUndefined();
    const other = await obtainToken(ctx);
    error(await call('verify_changes', { mode: 'report', verificationId: r.verificationId }, other.accessToken), 'NOT_FOUND');
  });
  it('failed initial receipt persistence launches zero jobs', async () => {
    ctx.server.services.store.setTrustMode(ctx.server.workspaceId, 'trusted');
    const args = await runArgs('assist-sec-store-before');
    const start = vi.spyOn(ctx.server.services.jobs, 'start');
    const original = ctx.server.services.store.setMeta.bind(ctx.server.services.store);
    vi.spyOn(ctx.server.services.store, 'setMeta').mockImplementation((key, value) => {
      if (key.startsWith('assistance:verification:')) throw new Error('simulated storage failure');
      return original(key, value);
    });
    error(await call('verify_changes', args), 'INTERNAL_ERROR');
    expect(start).not.toHaveBeenCalled();
  });
  it('persistence failure after launch retains idempotency reservation and never auto-repeats', async () => {
    ctx.server.services.store.setTrustMode(ctx.server.workspaceId, 'trusted');
    const args = await runArgs('assist-sec-store-after');
    const original = ctx.server.services.store.setMeta.bind(ctx.server.services.store);
    let writes = 0;
    vi.spyOn(ctx.server.services.store, 'setMeta').mockImplementation((key, value) => {
      if (key.startsWith('assistance:verification:') && ++writes === 2) throw new Error('simulated receipt failure');
      return original(key, value);
    });
    const start = vi.spyOn(ctx.server.services.jobs, 'start');
    error(await call('verify_changes', args), 'RECOVERY_REQUIRED');
    error(await call('verify_changes', args), 'RECOVERY_REQUIRED');
    expect(start).toHaveBeenCalledTimes(1);
    const jobs = ctx.server.services.jobs.list(ctx.server.workspaceId, 20);
    await Promise.all(jobs.filter(j => j.status === 'running').map(j => ctx.server.services.jobs.waitForExit(j.id, 10000)));
  });
});
