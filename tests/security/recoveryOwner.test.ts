import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { launch, obtainToken, callToolLegacy, wsArgs, type TestContext } from '../helpers/testServer.js';
import { ProjectRegistry } from '../../src/projects/registry.js';

describe('R00 rollback ownership over real HTTP/OAuth and private admin', () => {
  let ctx: TestContext;
  beforeEach(async () => { ctx = await launch({ toolSurface: 'full', trust: 'edit', configPort: 0, fixtureFiles: { 'a.txt': 'before' } }); }, 120000);
  afterEach(async () => { await ctx?.cleanup(); });
  const call = (token: string, name: string, args: Record<string, unknown>) => callToolLegacy(ctx, token, name, { ...wsArgs(ctx), ...args });
  const read = () => fs.readFileSync(path.join(ctx.fixtureDir, 'a.txt'), 'utf8');

  it('denies cross-caller rollback in direct and compact paths; allows caller-owned rollback', async () => {
    const a = await obtainToken(ctx), b = await obtainToken(ctx);
    const written = await call(a.accessToken, 'edit_file', { path: 'a.txt', edits: [{ find: 'before', replace: 'after' }] });
    expect(written.isError, JSON.stringify(written.envelope.error)).toBe(false);
    const changesetId = (written.envelope.data as { changesetId: string }).changesetId;
    const denied = await call(b.accessToken, 'rollback_changes', { changesetId, idempotencyKey: 'other-caller-rb' });
    expect(denied.envelope.error).toMatchObject({ code: 'FORBIDDEN' }); expect(read()).toBe('after');
    // Compact gateway goes through exactly the same target invocation pipeline.
    const { invokeToolDefinition } = await import('../../src/tools/context.js');
    const { COMPACT_CATALOG } = await import('../../src/tools/surface.js');
    const gateway = COMPACT_CATALOG.find(t => t.name === 'dodo_write')!;
    const compact = await invokeToolDefinition({ def: gateway, services: ctx.server.services, principal: { grantId: b.grantId, clientId: b.clientId, sub: 'owner', scopes: ['dodo:read','dodo:write'] }, args: { ...wsArgs(ctx), operation: 'rollback_changes', args: { changesetId, idempotencyKey: 'other-compact-rb' } } });
    expect(compact.envelope.error).toMatchObject({ code: 'FORBIDDEN' });
    const allowed = await call(a.accessToken, 'rollback_changes', { changesetId, idempotencyKey: 'own-caller-rb' });
    expect(allowed.isError, JSON.stringify(allowed.envelope.error)).toBe(false); expect(read()).toBe('before');
    const retry = await call(a.accessToken, 'rollback_changes', { changesetId, idempotencyKey: 'own-caller-rb' });
    expect(retry.envelope.data).toMatchObject({ replayed: true, changesetId: (allowed.envelope.data as {changesetId:string}).changesetId });
  });

  it('private owner rollback requires owner authentication and current context, emits audit and replays receipt', async () => {
    const token = await obtainToken(ctx);
    const edited = await call(token.accessToken, 'edit_file', { path: 'a.txt', edits: [{ find: 'before', replace: 'after' }] });
    expect(edited.isError).toBe(false);
    const changesetId = (edited.envelope.data as {changesetId:string}).changesetId;
    const project = new ProjectRegistry(ctx.server.services.store).add(ctx.fixtureDir, 'Recovery fixture').project;
    expect(project).toBeTruthy(); const url = new URL(ctx.configUrl!);
    const payload = { projectId: project.projectId, operation: 'recover.rollback', args: { changesetId, idempotencyKey: 'owner-restore-key', ...wsArgs(ctx) } };
    const headers = { 'content-type': 'application/json', 'x-dodo-workspace': ctx.server.workspaceId, 'x-dodo-epoch': ctx.server.epoch };
    const post = (auth?: string, epoch = ctx.server.epoch, origin = url.origin) => fetch(`${origin}/api/admin/action`, { method: 'POST', headers: { ...headers, 'x-dodo-epoch': epoch, ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: JSON.stringify(payload) });
    expect((await post()).status).toBe(401); expect((await post(token.accessToken)).status).toBe(401);
    expect((await post(url.hash.slice(1), 'stale')).status).toBe(409);
    expect((await post(token.accessToken, ctx.server.epoch, ctx.baseUrl)).status).toBe(404);
    expect(read()).toBe('after');
    const result = await post(url.hash.slice(1)); expect(result.status).toBe(200);
    const body = await result.json() as {data:{changesetId:string;replayed:boolean}};
    expect(body.data.replayed).toBe(false); expect(read()).toBe('before');
    const again = await (await post(url.hash.slice(1))).json() as {data:unknown};
    expect(again.data).toMatchObject({ changesetId: body.data.changesetId, replayed: true });
    expect(ctx.server.services.store.recentAudit(ctx.server.workspaceId, 30)).toEqual(expect.arrayContaining([expect.objectContaining({ tool: 'owner.rollback', principal: 'local-recovery-owner', result: 'ok' })]));
  });

  it('agent snapshots cannot turn another caller changeset into rollback authority', async () => {
    const a = await obtainToken(ctx), b = await obtainToken(ctx);
    const checked = async (name: string, args: Record<string, unknown>) => {
      const result = await call(b.accessToken, name, args);
      expect(result.isError, JSON.stringify(result.envelope.error)).toBe(false);
      return result.envelope.data as Record<string, unknown>;
    };
    const run = await checked('agent_run_open', { goal: 'Review source recovery', completionCriteria: ['preserve other caller work'], capabilities: {
      allowedProjectIds: [], writablePaths: ['.'], allowedPrograms: [], allowNetwork: false,
      allowBrowser: false, allowDesktop: false, allowMedia: false, allowWorkflow: false,
      secretAccess: false, maxHypotheses: 2, maxActions: 10, maxRunningJobs: 1, maxWallMinutes: 5,
    } });
    const hypothesis = await checked('agent_hypothesis_open', { runId: run.runId, title: 'Recovery boundary', probableCause: 'fixture', expectedEvidence: ['caller-owned candidates only'] });
    const ids = { runId: run.runId, hypothesisId: hypothesis.hypothesisId };
    await checked('agent_intent_acquire', { ...ids, kind: 'path', resourceKey: '.', ttlMinutes: 5 });
    const snapshot = await checked('agent_snapshot_create', ids);
    const edited = await call(a.accessToken, 'edit_file', { path: 'a.txt', edits: [{ find: 'before', replace: 'after' }] });
    expect(edited.isError).toBe(false);
    const result = await call(b.accessToken, 'agent_snapshot_rollback', { ...ids, snapshotId: snapshot.snapshotId, changesetId: (edited.envelope.data as {changesetId:string}).changesetId, idempotencyKey: 'foreign-agent-rollback' });
    expect(result.envelope.error).toMatchObject({ code: 'CONFLICT' }); expect(read()).toBe('after');
  });

  it('revocation while rollback waits in the mutation queue prevents the restore', async () => {
    const token = await obtainToken(ctx);
    const edited = await call(token.accessToken, 'edit_file', { path: 'a.txt', edits: [{ find: 'before', replace: 'after' }] });
    expect(edited.isError).toBe(false);
    let release!: () => void;
    const queue = ctx.server.services.mutations!;
    const held = queue.run(() => new Promise<void>(r => { release = r; }));
    const pending = call(token.accessToken, 'rollback_changes', { changesetId: (edited.envelope.data as {changesetId:string}).changesetId, idempotencyKey: 'revoke-queued-rb' });
    try {
      const until = Date.now() + 5000; while (queue.pending === 0 && Date.now() < until) await new Promise(r => setTimeout(r, 10));
      expect(queue.pending).toBe(1); ctx.server.services.store.revokeGrant(token.grantId);
    } finally { release(); await held; }
    const result = await pending; expect(result.isError).toBe(true); expect(read()).toBe('after');
  });
});
