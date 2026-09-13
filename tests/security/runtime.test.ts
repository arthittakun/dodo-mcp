import { describe, expect, it } from 'vitest';
import { RuntimeSession } from '../../src/services/runtime/contracts.js';
import { launch, mcpRaw, obtainToken, rpc } from '../helpers/testServer.js';
import { assertOk, tool } from '../helpers/multimodal.js';

function code(result: Awaited<ReturnType<typeof tool>>): string | undefined {
  return (result.envelope.error as { code?: string } | null)?.code;
}

describe('Phase 08 Runtime Intelligence security boundaries', () => {
  it('requires OAuth, target scope and target-bound approval without widening a read token', async () => {
    const ctx = await launch({ toolSurface: 'compact', trust: 'inspect' });
    try {
      expect((await mcpRaw(ctx, rpc('tools/list'))).status).toBe(401);
      const reader = await obtainToken(ctx, { scope: 'dodo:read' });
      const deniedOpen = await tool(ctx, reader.accessToken, 'dodo_assist_change', { operation: 'runtime_session_open', args: { label: 'denied' } });
      expect(code(deniedOpen)).toBe('FORBIDDEN');

      const writer = await obtainToken(ctx, { scope: 'dodo:read dodo:write' });
      const session = RuntimeSession.parse(assertOk(await tool(ctx, writer.accessToken, 'dodo_assist_change', { operation: 'runtime_session_open', args: { label: 'scope fixture' } })));
      const deniedExec = await tool(ctx, writer.accessToken, 'dodo_exec', { operation: 'runtime_task_start', args: {
        sessionId: session.sessionId, kind: 'process', program: 'node', args: ['-e', 'process.exit(0)'], idempotencyKey: 'runtime-scope-001',
      } });
      expect(code(deniedExec)).toBe('FORBIDDEN');

      const executor = await obtainToken(ctx);
      const ownSession = RuntimeSession.parse(assertOk(await tool(ctx, executor.accessToken, 'dodo_assist_change', { operation: 'runtime_session_open', args: { label: 'approval fixture' } })));
      const approval = await tool(ctx, executor.accessToken, 'dodo_exec', { operation: 'runtime_task_start', args: {
        sessionId: ownSession.sessionId, kind: 'process', program: 'node', args: ['-e', 'process.exit(0)'], idempotencyKey: 'runtime-approval-001',
      } });
      expect(code(approval)).toBe('APPROVAL_REQUIRED');
      const detail = (approval.envelope.error as { detail?: { approvalId?: string } }).detail;
      expect(detail?.approvalId).toMatch(/^apr_/);
      const row = ctx.server.services.store.getApproval(detail!.approvalId!);
      expect(row).toMatchObject({ tool: 'runtime_task_start', principal: executor.grantId, status: 'pending' });
      expect(ctx.server.services.store.listJobs(ctx.server.workspaceId, 50)).toHaveLength(0);
    } finally { await ctx.cleanup(); }
  }, 120_000);

  it('isolates handles by principal, rechecks revocation, and never treats IDs as authority', async () => {
    const ctx = await launch({ toolSurface: 'compact', trust: 'trusted' });
    try {
      const owner = await obtainToken(ctx);
      const other = await obtainToken(ctx);
      const session = RuntimeSession.parse(assertOk(await tool(ctx, owner.accessToken, 'dodo_assist_change', { operation: 'runtime_session_open', args: { label: 'private runtime' } })));
      const hidden = await tool(ctx, other.accessToken, 'dodo_assist_read', { operation: 'runtime_session_status', args: { sessionId: session.sessionId } });
      expect(code(hidden)).toBe('NOT_FOUND');
      expect(JSON.stringify(hidden.envelope)).not.toContain('private runtime');

      ctx.server.services.store.setClientAccess(ctx.server.workspaceId, owner.clientId, []);
      const revoked = await tool(ctx, owner.accessToken, 'dodo_assist_read', { operation: 'runtime_session_status', args: { sessionId: session.sessionId } });
      expect(code(revoked)).toBe('WORKSPACE_ACCESS_REQUIRED');
    } finally { await ctx.cleanup(); }
  }, 120_000);

  it('keeps report paths under WorkspaceFS guards and rejects stale workspace context', async () => {
    const ctx = await launch({ toolSurface: 'compact', trust: 'trusted', fixtureFiles: { '.env': '{"success":true}', 'safe.json': '{"success":true,"numTotalTests":1,"numPassedTests":1}' } });
    try {
      const token = await obtainToken(ctx);
      const session = RuntimeSession.parse(assertOk(await tool(ctx, token.accessToken, 'dodo_assist_change', { operation: 'runtime_session_open', args: { label: 'path fixture' } })));
      const started = assertOk(await tool(ctx, token.accessToken, 'dodo_exec', { operation: 'runtime_task_start', args: {
        sessionId: session.sessionId, kind: 'test', program: 'node', args: ['-e', 'process.exit(0)'], idempotencyKey: 'runtime-path-001',
      } })) as { task: { taskId: string; jobId: string } };
      assertOk(await tool(ctx, token.accessToken, 'dodo_read', { operation: 'job_wait', args: { jobId: started.task.jobId, waitMs: 10_000 } }));
      const secret = await tool(ctx, token.accessToken, 'dodo_assist_read', { operation: 'runtime_task_observe', args: { sessionId: session.sessionId, taskId: started.task.taskId, reportPath: '.env' } });
      expect(code(secret)).toBe('SECRET_PATH_DENIED');
      const traversal = await tool(ctx, token.accessToken, 'dodo_assist_read', { operation: 'runtime_task_observe', args: { sessionId: session.sessionId, taskId: started.task.taskId, reportPath: '../safe.json' } });
      expect(code(traversal)).toBe('PATH_DENIED');

      const stale = await tool(ctx, token.accessToken, 'dodo_assist_read', {
        workspaceId: ctx.server.workspaceId, workspaceEpoch: 'old-epoch', operation: 'runtime_session_status', args: { sessionId: session.sessionId },
      });
      expect(code(stale)).toBe('STALE_WORKSPACE');
    } finally { await ctx.cleanup(); }
  }, 120_000);

  it('enforces bounded evidence retention before collecting another snapshot', async () => {
    const ctx = await launch({ toolSurface: 'compact' });
    try {
      const token = await obtainToken(ctx, { scope: 'dodo:read dodo:write' });
      const session = RuntimeSession.parse(assertOk(await tool(ctx, token.accessToken, 'dodo_assist_change', { operation: 'runtime_session_open', args: { label: 'quota fixture' } })));
      const now = Date.now(), owner = ctx.server.services.store.db.prepare('SELECT owner FROM runtime_sessions WHERE id=?').get(session.sessionId) as { owner: string };
      const insert = ctx.server.services.store.db.prepare(`INSERT INTO runtime_evidence(id,session_id,workspace_id,owner,kind,payload,source_ref,source_hash,content_hash,status,stale_reason,created_at,last_verified_at,expires_at)
        VALUES (?,?,?,?,?,'{}',?,?,?,?,NULL,?,?,?)`);
      const hash = `sha256:${'a'.repeat(64)}`;
      const tx = ctx.server.services.store.db.transaction(() => {
        for (let i = 0; i < 500; i += 1) insert.run(`runtimeev_${i.toString(32).padStart(8, '0')}`, session.sessionId, ctx.server.workspaceId, owner.owner, 'snapshot', `fixture:${i}`, hash, hash, 'CURRENT', now, now, now + 60_000);
      });
      tx();
      const limited = await tool(ctx, token.accessToken, 'dodo_assist_read', { operation: 'runtime_snapshot', args: { sessionId: session.sessionId } });
      expect(code(limited)).toBe('RESOURCE_LIMIT');
    } finally { await ctx.cleanup(); }
  }, 120_000);
});
