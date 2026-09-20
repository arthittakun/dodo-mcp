import { afterEach, describe, expect, it } from 'vitest';
import { launch, obtainToken, callToolLegacy, mcpRaw, rpc, wsArgs, type TestContext } from '../helpers/testServer.js';
import { ProjectRegistry } from '../../src/projects/registry.js';
import { VerificationSchema } from '../../src/services/assistance/verification.js';
import { setAccessMode } from '../../src/security/accessMode.js';

describe('deployment through the real OAuth compact invocation pipeline', () => {
  let c: TestContext;
  afterEach(async () => c?.cleanup());
  it('binds real verification, enforces target scope/ACL/epoch/ownership, and asks approval before any Docker command', async () => {
    c = await launch({ trust: 'trusted', configPort: 0, fixtureFiles: {
      'Dockerfile': 'FROM scratch\n', 'package.json': JSON.stringify({ name: 'gateway-deploy-fixture', scripts: { test: 'node check.cjs' } }),
      'check.cjs': 'console.log(JSON.stringify({numTotalTests:1,numPassedTests:1,numFailedTests:0}));',
    } });
    new ProjectRegistry(c.server.services.store).add(c.fixtureDir, 'Gateway deployment fixture');
    const s = c.server.services, r = s.recovery!; setAccessMode(s.store, 'managed');
    const a = await obtainToken(c), b = await obtainToken(c), read = await obtainToken(c, { scope: 'dodo:read offline_access' });
    const call = (token: string, gateway: string, operation: string, args: Record<string, unknown> = {}, context = wsArgs(c)) =>
      callToolLegacy(c, token, gateway, { ...context, operation, args });
    const invoke = async (gateway: string, operation: string, args: Record<string, unknown> = {}) => {
      const result = await call(a.accessToken, gateway, operation, args);
      expect(result.envelope.ok, JSON.stringify(result.envelope.error)).toBe(true); return result.envelope.data;
    };
    await invoke('dodo_write', 'checkpoint_create', { idempotencyKey: 'gateway-checkpoint-one' });
    const view = VerificationSchema.parse(await invoke('dodo_assist_change', 'verify_changes', { mode: 'plan' }));
    const recipe = view.recommendedTasks.find(t => t.taskId === 'npm:test')!;
    const checks = [{ taskId: recipe.taskId, recipeDigest: recipe.recipeDigest }];
    const v = VerificationSchema.parse(await invoke('dodo_assist_change', 'verify_changes', { mode: 'run', tasks: checks, sourceDigest: view.freshness.baselineDigest, idempotencyKey: 'gateway-verify-one', waitMs: 10000 }));
    expect(v.status).toBe('passed');
    const target = await r.deployments.configure({ expectedRevision: 0, enabled: true, confirmDaemonAccess: true,
      definition: { name: 'fixture', adapter: 'docker-compose', composeProject: 'dodo-gateway-fixture', service: 'web', requiredChecks: checks,
        health: [{ id: 'ready', kind: 'http', url: 'https://fixture.example/health' }] } }, () => {});
    const input = { targetId: target.id, expectedTargetRevision: target.revision, verificationId: v.verificationId, idempotencyKey: 'gateway-prepare-one' };
    const plan = await invoke('dodo_exec', 'deployment_prepare', input) as { plan: { deploymentId: string }; planHash: string };
    expect(await invoke('dodo_exec', 'deployment_prepare', input)).toMatchObject({ ...plan, replayed: true });
    const effect = { deploymentId: plan.plan.deploymentId, planHash: plan.planHash };
    for (const [operation, args] of [['deployment_prepare', input], ['deployment_build', effect], ['deployment_observe',{deploymentId:effect.deploymentId}], ['deployment_source_preview',{deploymentId:effect.deploymentId}], ['deployment_rollback_prepare',{deploymentId:effect.deploymentId,idempotencyKey:'read-only-rollback'}], ['deployment_apply', { ...effect, imageDigest: 'sha256:' + '0'.repeat(64) }]] as const) {
      expect((await call(read.accessToken, 'dodo_exec', operation, args)).envelope.error).toMatchObject({ code: 'FORBIDDEN' });
    }
    expect((await call(b.accessToken, 'dodo_read', 'deployment_inspect', { deploymentId: effect.deploymentId })).envelope.error).toMatchObject({ code: 'NOT_FOUND' });
    expect((await call(a.accessToken, 'dodo_exec', 'deployment_build', { ...effect, targetProjectId: 'nested' })).envelope.error).toMatchObject({ code: 'INVALID_INPUT' });
    expect((await call(a.accessToken, 'dodo_exec', 'deployment_build', effect, { ...wsArgs(c), workspaceEpoch: 'stale' })).envelope.error).toMatchObject({ code: 'STALE_WORKSPACE' });
    s.store.setTrustMode(s.workspaceId, 'inspect');
    const before = s.store.db.prepare('SELECT COUNT(*) AS n FROM jobs').get();
    expect((await call(a.accessToken, 'dodo_exec', 'deployment_build', effect)).envelope.error).toMatchObject({ code: 'APPROVAL_REQUIRED' });
    expect(s.store.db.prepare('SELECT tool FROM pending_approvals WHERE workspace_id=?').all(s.workspaceId)).toEqual([{ tool: 'deployment_build' }]);
    expect(s.store.db.prepare('SELECT COUNT(*) AS n FROM jobs').get()).toEqual(before);
    s.store.setClientAccess(s.workspaceId, a.clientId, []);
    expect((await call(a.accessToken, 'dodo_read', 'deployment_inspect', { deploymentId: effect.deploymentId })).envelope.error).toMatchObject({ code: 'WORKSPACE_ACCESS_REQUIRED' });
    s.store.revokeGrant(a.grantId);s.store.oauthRevokeByGrantId(a.grantId);
    const revoked = await mcpRaw(c, rpc('tools/call',{name:'dodo_read',arguments:{...wsArgs(c),operation:'deployment_targets',args:{}}}), a.accessToken);
    expect(revoked.status).toBe(401);
    expect(r.deployments.inspect(effect.deploymentId, { id: a.grantId }).state).toBe('PREPARED');
  }, 60000);
});
