import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { chromium } from 'playwright';
import { ContextQueryResult } from '../../src/services/context/contracts.js';
import { RuntimeDiagnosis, RuntimeEvidence, RuntimeSession, RuntimeSessionStatus } from '../../src/services/runtime/contracts.js';
import { launch, obtainToken, type TestContext } from '../helpers/testServer.js';
import { assertOk, blocks, BROWSER_FIXTURE, tool } from '../helpers/multimodal.js';

const browserAvailable = fs.existsSync(chromium.executablePath());

async function gateway(ctx: TestContext, token: string, name: string, operation: string, args: Record<string, unknown> = {}) {
  return tool(ctx, token, name, { operation, args });
}

describe('Phase 08 Runtime Intelligence over real HTTP + OAuth', () => {
  it('runs a durable task, stores hashes rather than output, diagnoses it, and invalidates changed snapshots', async () => {
    const secretOutput = 'password=runtime-secret-must-not-persist';
    const ctx = await launch({ toolSurface: 'compact', trust: 'trusted', fixtureFiles: {
      'src/app.ts': 'export const value = 1;\n',
      'test-report.json': JSON.stringify({ success: true, numTotalTests: 4, numPassedTests: 3, numFailedTests: 0, numPendingTests: 1, testResults: [{ title: secretOutput }] }),
    } });
    try {
      const token = await obtainToken(ctx);
      const session = RuntimeSession.parse(assertOk(await gateway(ctx, token.accessToken, 'dodo_assist_change', 'runtime_session_open', { label: 'integration runtime' })));
      const started = assertOk(await gateway(ctx, token.accessToken, 'dodo_exec', 'runtime_task_start', {
        sessionId: session.sessionId, kind: 'test', program: 'node', args: ['-e', `console.log(${JSON.stringify(secretOutput)})`],
        idempotencyKey: 'runtime-task-integration-001',
      })) as { task: { taskId: string; jobId: string }; replayed: boolean };
      const replay = assertOk(await gateway(ctx, token.accessToken, 'dodo_exec', 'runtime_task_start', {
        sessionId: session.sessionId, kind: 'test', program: 'node', args: ['-e', `console.log(${JSON.stringify(secretOutput)})`],
        idempotencyKey: 'runtime-task-integration-001',
      })) as { task: { taskId: string; jobId: string }; replayed: boolean };
      expect(replay).toMatchObject({ replayed: true, task: { taskId: started.task.taskId, jobId: started.task.jobId } });
      assertOk(await gateway(ctx, token.accessToken, 'dodo_read', 'job_wait', { jobId: started.task.jobId, waitMs: 10_000 }));

      const observed = assertOk(await gateway(ctx, token.accessToken, 'dodo_assist_read', 'runtime_task_observe', {
        sessionId: session.sessionId, taskId: started.task.taskId, reportPath: 'test-report.json',
      })) as { evidence: unknown; task: { status: string; exitCode: number } };
      const evidence = RuntimeEvidence.parse(observed.evidence);
      expect(observed.task).toMatchObject({ status: 'exited', exitCode: 0 });
      expect(evidence.payload).toMatchObject({
        stdout: { bytes: expect.any(Number), sampleSha256: expect.stringMatching(/^sha256:/) },
        testReport: { path: 'test-report.json', total: 4, passed: 3, failed: 0, skipped: 1, success: true, hash: expect.stringMatching(/^sha256:/) },
      });
      expect(JSON.stringify(evidence)).not.toContain(secretOutput);
      const persisted = ctx.server.services.store.db.prepare('SELECT payload FROM runtime_evidence WHERE id=?').get(evidence.evidenceId) as { payload: string };
      expect(persisted.payload).not.toContain(secretOutput);

      const diagnosis = RuntimeDiagnosis.parse(assertOk(await gateway(ctx, token.accessToken, 'dodo_assist_read', 'runtime_diagnose', {
        sessionId: session.sessionId, evidenceIds: [evidence.evidenceId],
      })));
      expect(diagnosis.facts).toHaveLength(1);
      expect(diagnosis.inferences).toContainEqual(expect.objectContaining({ confidence: 'high', evidenceIds: [evidence.evidenceId] }));

      const snapshot = RuntimeEvidence.parse(assertOk(await gateway(ctx, token.accessToken, 'dodo_assist_read', 'runtime_snapshot', { sessionId: session.sessionId })));
      fs.writeFileSync(path.join(ctx.fixtureDir, 'src/app.ts'), 'export const value = 2;\n');
      const stale = RuntimeEvidence.parse(assertOk(await gateway(ctx, token.accessToken, 'dodo_assist_read', 'runtime_evidence', {
        sessionId: session.sessionId, evidenceId: snapshot.evidenceId,
      })));
      expect(stale).toMatchObject({ status: 'STALE', sourceHash: snapshot.sourceHash, contentHash: snapshot.contentHash });

      const context = ContextQueryResult.parse(assertOk(await gateway(ctx, token.accessToken, 'dodo_assist_read', 'context_query', {
        goal: 'test runtime evidence', terms: ['test'], maxItems: 50,
      })));
      expect(context.sourceStatus).toContainEqual(expect.objectContaining({ source: 'runtime', status: 'available' }));
      expect(context.evidence.OBSERVATION.some((item) => item.source.resource === `dodo-runtime://${evidence.evidenceId}`)).toBe(true);

      const status = RuntimeSessionStatus.parse(assertOk(await gateway(ctx, token.accessToken, 'dodo_assist_read', 'runtime_session_status', { sessionId: session.sessionId })));
      expect(status).toMatchObject({ reconnectable: true, session: { status: 'OPEN' } });
      expect(status.tasks).toHaveLength(1);
      const closed = RuntimeSession.parse(assertOk(await gateway(ctx, token.accessToken, 'dodo_assist_change', 'runtime_session_close', { sessionId: session.sessionId })));
      expect(closed.status).toBe('CLOSED');
    } finally { await ctx.cleanup(); }
  }, 120_000);

  it('reconnects after server restart without repeating a completed task side effect', async () => {
    let ctx = await launch({ toolSurface: 'compact', trust: 'trusted' });
    const token = await obtainToken(ctx);
    const session = RuntimeSession.parse(assertOk(await gateway(ctx, token.accessToken, 'dodo_assist_change', 'runtime_session_open', { label: 'restart fixture' })));
    const started = assertOk(await gateway(ctx, token.accessToken, 'dodo_exec', 'runtime_task_start', {
      sessionId: session.sessionId, kind: 'process', program: 'node', args: ['-e', 'process.exit(0)'], idempotencyKey: 'runtime-restart-001',
    })) as { task: { taskId: string; jobId: string } };
    assertOk(await gateway(ctx, token.accessToken, 'dodo_read', 'job_wait', { jobId: started.task.jobId, waitMs: 10_000 }));
    const saved = { fixtureDir: ctx.fixtureDir, configDir: ctx.configDir, port: ctx.port };
    await ctx.cleanup();
    ctx = await launch({ ...saved, toolSurface: 'compact', trust: 'trusted' });
    try {
      const status = RuntimeSessionStatus.parse(assertOk(await gateway(ctx, token.accessToken, 'dodo_assist_read', 'runtime_session_status', { sessionId: session.sessionId })));
      expect(status.tasks[0]).toMatchObject({ taskId: started.task.taskId, jobId: started.task.jobId, status: 'exited' });
      const replay = assertOk(await gateway(ctx, token.accessToken, 'dodo_exec', 'runtime_task_start', {
        sessionId: session.sessionId, kind: 'process', program: 'node', args: ['-e', 'process.exit(0)'], idempotencyKey: 'runtime-restart-001',
      })) as { task: { jobId: string }; replayed: boolean };
      expect(replay).toMatchObject({ replayed: true, task: { jobId: started.task.jobId } });
    } finally { await ctx.cleanup(); }
  }, 120_000);

  it('refuses close while a task runs, cancels the owned task, and reports timeout without blocking MCP', async () => {
    const ctx = await launch({ toolSurface: 'compact', trust: 'trusted' });
    try {
      const token = await obtainToken(ctx);
      const session = RuntimeSession.parse(assertOk(await gateway(ctx, token.accessToken, 'dodo_assist_change', 'runtime_session_open', { label: 'cancel fixture' })));
      const started = assertOk(await gateway(ctx, token.accessToken, 'dodo_exec', 'runtime_task_start', {
        sessionId: session.sessionId, kind: 'process', program: 'node', args: ['-e', 'setInterval(()=>{},1000)'],
        timeoutMs: 30_000, idempotencyKey: 'runtime-cancel-001',
      })) as { task: { taskId: string; jobId: string } };
      const refused = await gateway(ctx, token.accessToken, 'dodo_assist_change', 'runtime_session_close', { sessionId: session.sessionId });
      expect((refused.envelope.error as { code?: string }).code).toBe('CONFLICT');
      const canceled = assertOk(await gateway(ctx, token.accessToken, 'dodo_exec', 'runtime_task_cancel', { sessionId: session.sessionId, taskId: started.task.taskId })) as { status: string };
      expect(canceled.status).toBe('canceling');
      assertOk(await gateway(ctx, token.accessToken, 'dodo_read', 'job_wait', { jobId: started.task.jobId, waitMs: 10_000 }));
      expect(RuntimeSession.parse(assertOk(await gateway(ctx, token.accessToken, 'dodo_assist_change', 'runtime_session_close', { sessionId: session.sessionId }))).status).toBe('CLOSED');

      const timedSession = RuntimeSession.parse(assertOk(await gateway(ctx, token.accessToken, 'dodo_assist_change', 'runtime_session_open', { label: 'timeout fixture' })));
      const timed = assertOk(await gateway(ctx, token.accessToken, 'dodo_exec', 'runtime_task_start', {
        sessionId: timedSession.sessionId, kind: 'process', program: 'node', args: ['-e', 'setInterval(()=>{},1000)'],
        timeoutMs: 1000, idempotencyKey: 'runtime-timeout-001',
      })) as { task: { taskId: string; jobId: string } };
      assertOk(await gateway(ctx, token.accessToken, 'dodo_read', 'job_wait', { jobId: timed.task.jobId, waitMs: 10_000 }));
      const observed = assertOk(await gateway(ctx, token.accessToken, 'dodo_assist_read', 'runtime_task_observe', { sessionId: timedSession.sessionId, taskId: timed.task.taskId })) as { task: { status: string } };
      expect(observed.task.status).toBe('timed_out');
    } finally { await ctx.cleanup(); }
  }, 120_000);
});

describe.skipIf(!browserAvailable)('Phase 08 browser runtime evidence', () => {
  it('passes through a real image but persists only safe hashes and counts', async () => {
    const ctx = await launch({ toolSurface: 'compact', trust: 'trusted', fixtureFiles: { 'index.html': BROWSER_FIXTURE } });
    try {
      const token = await obtainToken(ctx);
      const session = RuntimeSession.parse(assertOk(await gateway(ctx, token.accessToken, 'dodo_assist_change', 'runtime_session_open', { label: 'browser evidence' })));
      const opened = assertOk(await gateway(ctx, token.accessToken, 'dodo_browser', 'browser_session', {
        source: 'workspace', path: 'index.html', idempotencyKey: 'runtime-browser-open-001',
      })) as { sessionId: string };
      const collected = await gateway(ctx, token.accessToken, 'dodo_browser', 'runtime_browser_collect', { sessionId: session.sessionId, browserSessionId: opened.sessionId });
      const data = assertOk(collected) as { evidence: unknown; observation: { observationId: string; text: string; asset: { sha256: string } } };
      const evidence = RuntimeEvidence.parse(data.evidence);
      expect(blocks(collected).some((block) => block.type === 'image' && typeof block.data === 'string')).toBe(true);
      expect(data.observation.text).toContain('Ready');
      expect(evidence.payload).toMatchObject({
        browserSessionId: opened.sessionId, screenshotHash: data.observation.asset.sha256,
        elementCount: expect.any(Number), webSocketPolicy: 'blocked',
        timing: { navigationCount: expect.any(Number), domContentLoadedMs: expect.anything() },
      });
      const stored = ctx.server.services.store.db.prepare('SELECT payload FROM runtime_evidence WHERE id=?').get(evidence.evidenceId) as { payload: string };
      expect(stored.payload).not.toContain('NEVER_READ_PASSWORD');
      expect(stored.payload).not.toContain('Ready');
      expect(stored.payload).not.toContain('saved fixture');
      expect(stored.payload).not.toMatch(/cookie|authorization/i);
      assertOk(await gateway(ctx, token.accessToken, 'dodo_browser', 'browser_action', {
        sessionId: opened.sessionId, observationId: data.observation.observationId,
        action: { kind: 'click', selector: '#change' }, idempotencyKey: 'runtime-browser-change-001',
      }));
      const stale = RuntimeEvidence.parse(assertOk(await gateway(ctx, token.accessToken, 'dodo_assist_read', 'runtime_evidence', {
        sessionId: session.sessionId, evidenceId: evidence.evidenceId,
      })));
      expect(stale.status).toBe('STALE');
      assertOk(await gateway(ctx, token.accessToken, 'dodo_browser', 'browser_session', { mode: 'close', sessionId: opened.sessionId, idempotencyKey: 'runtime-browser-close-001' }));
    } finally { await ctx.cleanup(); }
  }, 180_000);
});
