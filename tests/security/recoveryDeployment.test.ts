import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { platformFixture } from '../helpers/platform.js';
import { ProjectRegistry } from '../../src/projects/registry.js';
import { VerificationSchema } from '../../src/services/assistance/verification.js';
import { createIpcDispatcher } from '../../src/server/ipcDispatch.js';
import { setAccessMode } from '../../src/security/accessMode.js';

describe('R05 deployment provenance and owner targets', () => {
  let f: ReturnType<typeof platformFixture>;
  afterEach(async () => { await f?.close(); });
  const actor = { id: 'local-stdio' }, owner = { id: 'local-config-owner', owner: true };
  async function setup() {
    f = platformFixture();
    fs.writeFileSync(path.join(f.root, 'a.txt'), 'alpha');
    fs.writeFileSync(path.join(f.root, 'Dockerfile'), 'FROM scratch\nCOPY a.txt /src/a.txt\n');
    fs.writeFileSync(path.join(f.root, 'package.json'), JSON.stringify({ name: 'deploy-fixture', scripts: { test: 'node check.cjs' } }));
    fs.writeFileSync(path.join(f.root, 'check.cjs'), `console.log(JSON.stringify({numTotalTests:1,numPassedTests:1,numFailedTests:0}));`);
    new ProjectRegistry(f.ws.store).add(f.root, 'Deployment fixture');
    const r = f.ws.services.recovery!;
    await r.checkpoint('owner-checkpoint', actor.id);
    const overview = VerificationSchema.parse(await f.call('verify_changes', { mode: 'plan' }));
    const task = overview.recommendedTasks.find(t => t.taskId === 'npm:test')!;
    const requiredChecks = [{ taskId: task.taskId, recipeDigest: task.recipeDigest }];
    const verification = VerificationSchema.parse(await f.call('verify_changes', { mode: 'run', tasks: requiredChecks, sourceDigest: overview.freshness.baselineDigest, idempotencyKey: f.key(), waitMs: 10000 }));
    expect(verification.status).toBe('passed');
    const definition = { name: 'fixture', adapter: 'docker-compose', composeProject: 'dodo-fixture', service: 'web', requiredChecks,
      health: [{ id: 'http', kind: 'http', url: 'https://fixture.example/health' }] };
    const target = await r.deployments.configure({ expectedRevision: 0, enabled: true, definition, confirmDaemonAccess: true }, () => {});
    const request = { targetId: target.id, expectedTargetRevision: target.revision, verificationId: verification.verificationId!, idempotencyKey: f.key() };
    return { r, target, definition, request };
  }
  it('prepares from real passing jobs, binds exact source and checks, and same-key retry never creates a second deployment', async () => {
    const { r, request } = await setup();
    const plan = await r.deployments.prepare(request, actor, () => {});
    expect(plan.state).toBe('PREPARED'); expect(plan.imageDigest).toBeNull();
    expect(plan.plan.contextDigest).toMatch(/^sha256:/);
    expect(await r.deployments.validate(plan.plan.deploymentId, plan.planHash, actor, () => {})).toMatchObject({ state: 'PREPARED' });
    expect(await r.deployments.prepare(request, actor, () => {})).toEqual({ ...plan, replayed: true });
    await expect(r.deployments.prepare({ ...request, verificationId: 'other' }, actor, () => {})).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(r.deployments.list(actor).items).toHaveLength(1);
    expect(r.deployments.list({ id: 'other' }).items).toHaveLength(0);
    expect(() => r.deployments.inspect(plan.plan.deploymentId, { id: 'other' })).toThrow('unavailable');
    expect(r.deployments.list(owner).items).toHaveLength(1);
    expect((await r.deployments.compare(plan.plan.deploymentId, actor)).production).toBe('UNKNOWN');
  });
  it('external edits/deletions fail before build; labels or owner stable pointers never replace actual verification', async () => {
    const { r, request } = await setup();
    const plan = await r.deployments.prepare(request, actor, () => {});
    fs.writeFileSync(path.join(f.root, 'a.txt'), 'external'); fs.unlinkSync(path.join(f.root, 'Dockerfile'));
    const comparison = await r.deployments.compare(plan.plan.deploymentId, actor);
    expect(comparison.source).toMatchObject({ matches: false, changedCount: 2 });
    expect(comparison.source.changes).toEqual(expect.arrayContaining([{ path: 'Dockerfile', change: 'deleted' }, { path: 'a.txt', change: 'modified' }]));
    await r.evidence.mark('stable', plan.plan.checkpointId, 0, () => {});
    await expect(r.deployments.validate(plan.plan.deploymentId, plan.planHash, actor, () => {})).rejects.toMatchObject({ code: 'FILE_CHANGED' });
    await expect(r.deployments.prepare({ ...request, idempotencyKey: f.key() }, actor, () => {})).rejects.toThrow();
    expect(f.ws.store.db.prepare('SELECT * FROM recovery_production_pointers').all()).toEqual([]);
  });
  it('target CAS, live owner expiry, denied source and network routes stay authoritative', async () => {
    const { r, request, target, definition } = await setup();
    const edit = { targetId: target.id, expectedRevision: target.revision, enabled: true, definition, confirmDaemonAccess: true };
    const expired = () => { throw Error('owner expired'); };
    await expect(r.deployments.configure(edit, expired)).rejects.toThrow('owner expired');
    await expect(r.deployments.prepare(request, actor, expired)).rejects.toThrow('owner expired');
    expect(r.deployments.list(owner).items).toEqual([]);
    for (const dockerfile of ['.env', '../Dockerfile', 'C:/private']) await expect(r.deployments.configure({ ...edit, definition: { ...definition, dockerfile } }, () => {})).rejects.toThrow();
    for (const url of ['http://169.254.169.254/metadata', 'http://127.0.0.1:21731/', 'https://fixture.example/health?token=secret'])
      await expect(r.deployments.configure({ ...edit, definition: { ...definition, health: [{ id: 'bad', kind: 'http', url, allowPrivateNetwork: true }] } }, () => {})).rejects.toThrow();
    const plan = await r.deployments.prepare(request, actor, () => {});
    await r.deployments.configure(edit, () => {});
    await expect(r.deployments.configure(edit, () => {})).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(r.deployments.validate(plan.plan.deploymentId, plan.planHash, actor, () => {})).rejects.toMatchObject({ code: 'CONFLICT' });
  });
  it('stale epoch, forged plan hash, changed policy and expired queued authority refuse execution', async () => {
    const { r, request } = await setup();
    const p = await r.deployments.prepare(request, actor, () => {});
    await expect(r.deployments.validate(p.plan.deploymentId, 'sha256:' + '0'.repeat(64), actor, () => {})).rejects.toMatchObject({ code: 'PLAN_HASH_MISMATCH' });
    await expect(r.deployments.validate(p.plan.deploymentId, p.planHash, actor, () => { throw Error('revoked'); })).rejects.toThrow('revoked');
    const epoch = f.ws.services.epoch; f.ws.services.epoch = 'new-epoch';
    try { await expect(r.deployments.validate(p.plan.deploymentId, p.planHash, actor, () => {})).rejects.toMatchObject({ code: 'STALE_WORKSPACE' }); }
    finally { f.ws.services.epoch = epoch; }
    f.ws.store.db.prepare('INSERT OR REPLACE INTO recovery_policies VALUES (?,?)').run(f.ws.workspaceId, JSON.stringify({ ...r.policy(), dataRoots: ['a.txt'] }));
    await expect(r.deployments.validate(p.plan.deploymentId, p.planHash, actor, () => {})).rejects.toThrow();
  });
  it('provenance protects source from retention and restart converts effects in progress to UNKNOWN without replay', async () => {
    const { r, request, target, definition } = await setup();
    const p = await r.deployments.prepare(request, actor, () => {});
    await r.checkpoint('owner-checkpoint', actor.id);
    f.ws.store.db.prepare('UPDATE recovery_snapshots SET created_at=1 WHERE id=?').run(p.plan.checkpointId);
    f.ws.store.db.prepare('UPDATE recovery_sessions SET created_at=1 WHERE workspace_id=?').run(f.ws.workspaceId);
    const policy = { ...r.policy(), retainedPoints: 1, retentionDays: 1 };
    expect(r.storage.cleanupPreview(f.ws.workspaceId, policy).items.find(i => i.checkpointId === p.plan.checkpointId)).toMatchObject({ reason: 'deployment_provenance', eligible: false });
    r.storage.prune(f.ws.workspaceId, policy);
    expect(await r.storage.readVerified(p.plan.checkpointId, f.ws.workspaceId)).toBeDefined();
    f.ws.store.db.prepare("UPDATE recovery_deployments SET state='DEPLOYING' WHERE id=?").run(p.plan.deploymentId);
    r.deployments.reconcile();
    expect(await r.deployments.prepare(request, actor, () => {})).toMatchObject({ state: 'UNKNOWN', replayed: true, outcome: { retryAllowed: false } });
    await expect(r.deployments.configure({ targetId: target.id, expectedRevision: target.revision, enabled: false, definition, confirmDaemonAccess: true }, () => {})).rejects.toMatchObject({ code: 'CONFLICT' });
  });
  it('owner commands require explicit confirmation/context and cannot inject an execution recipe', async () => {
    const { target, definition } = await setup();
    const ipc = createIpcDispatcher({ ws: f.ws, transport: { kind: 'stdio', port: 0, locked: true, publicUrl: null }, requestStop: () => {}, revalidateOwner: () => {} });
    const input = { targetId: target.id, expectedRevision: target.revision, enabled: true, definition, confirmDaemonAccess: true };
    const context = { workspaceId: f.ws.workspaceId, workspaceEpoch: f.ws.epoch, confirm: true };
    await expect(ipc('deployment.configure', { input })).rejects.toThrow();
    await expect(ipc('deployment.configure', { ...context, input: { ...input, definition: { ...definition, args: ['--privileged'] } } })).rejects.toThrow();
    expect(await ipc('deployment.configure', { ...context, input })).toMatchObject({ revision: 2 });
  });
  it('read-only callers cannot build, inspect mode creates a target-bound approval, and neither starts Docker', async () => {
    const { r, request } = await setup();
    const p = await r.deployments.prepare(request, actor, () => {});
    const services = f.ws.services, principal = services.localPrincipal!;
    const jobsBefore = f.ws.store.db.prepare('SELECT COUNT(*) AS n FROM jobs').get();
    await expect(r.deployments.build(p.plan.deploymentId, p.planHash, { services, principal: { ...principal, scopes: ['dodo:read'] }, trustMode: 'trusted', revalidate: () => {} })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    setAccessMode(f.ws.store, 'managed'); f.ws.store.setTrustMode(f.ws.workspaceId, 'inspect');
    await expect(r.deployments.build(p.plan.deploymentId, p.planHash, { services, principal, trustMode: 'inspect', revalidate: () => {} })).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
    const rows = f.ws.store.db.prepare('SELECT tool FROM pending_approvals WHERE workspace_id=?').all(f.ws.workspaceId);
    expect(rows).toEqual([{ tool: 'deployment_build' }]);
    expect(f.ws.store.db.prepare('SELECT COUNT(*) AS n FROM jobs').get()).toEqual(jobsBefore);
    expect(r.deployments.inspect(p.plan.deploymentId, actor).state).toBe('PREPARED');
  });
  it('owner maintenance is absent from MCP authority and enforces current context, expiry and pin CAS', async () => {
    const {r,request}=await setup(),p=await r.deployments.prepare(request,actor,()=>{}),services=f.ws.services;
    const input={action:'pin',deploymentId:p.plan.deploymentId,pinned:true,expectedPinned:false};
    await expect(r.deployments.maintenance(input,{services,principal:services.localPrincipal!,trustMode:'trusted',revalidate:()=>{}})).rejects.toMatchObject({code:'FORBIDDEN'});
    const context={workspaceId:f.ws.workspaceId,workspaceEpoch:f.ws.epoch,confirm:true,input};
    const dispatcher=(expired=false)=>createIpcDispatcher({ws:f.ws,transport:{kind:'stdio',port:0,locked:true,publicUrl:null},requestStop:()=>{},revalidateOwner:()=>{if(expired)throw Error('expired owner');}});
    await expect(dispatcher()('deployment.maintenance',{...context,workspaceEpoch:'stale'})).rejects.toThrow();
    await expect(dispatcher(true)('deployment.maintenance',context)).rejects.toThrow('expired owner');
    expect(await dispatcher()('deployment.maintenance',context)).toMatchObject({pinned:true});
    await expect(dispatcher()('deployment.maintenance',context)).rejects.toMatchObject({code:'CONFLICT'});
    await expect(dispatcher()('deployment.maintenance',{...context,input:{action:'apply',reviewId:'forged',reviewHash:'sha256:'+'0'.repeat(64)}})).rejects.toMatchObject({code:'NOT_FOUND'});
    expect(r.deployments.inspect(p.plan.deploymentId,actor).retention.pinned).toBe(true);
    f.ws.store.db.prepare('UPDATE recovery_deployment_maintenance SET retired=1 WHERE deployment_id=?').run(p.plan.deploymentId);
    await expect(f.call('deployment_build',{deploymentId:p.plan.deploymentId,planHash:p.planHash})).rejects.toThrow('NOT_FOUND');
  });

});
