import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ipcSocketPath } from '../../src/config/paths.js';
import { ipcCall } from '../../src/ipc/client.js';
import { AgentHypothesis, AgentIntent, AgentPlan, AgentRun, AgentSkillDetail, AgentSnapshot } from '../../src/services/agent/contracts.js';
import { RuntimeEvidence, RuntimeSession } from '../../src/services/runtime/contracts.js';
import { launch, obtainToken, type TestContext } from '../helpers/testServer.js';
import { assertOk, tool } from '../helpers/multimodal.js';

function gateway(ctx: TestContext, token: string, gatewayName: string, operation: string, args: Record<string, unknown> = {}) {
  return tool(ctx, token, gatewayName, { operation, args });
}

function owner(ctx: TestContext, command: string, args: Record<string, unknown> = {}) {
  return ipcCall(ipcSocketPath(ctx.configDir, ctx.server.workspaceId), command, args);
}

const capabilities = {
  allowedProjectIds: [], writablePaths: ['src'], allowedPrograms: ['node'], allowNetwork: false,
  allowBrowser: false, allowDesktop: false, allowMedia: false, allowWorkflow: false,
  secretAccess: false as const, maxHypotheses: 3, maxActions: 100, maxRunningJobs: 2, maxWallMinutes: 60,
};

describe('Phase 09 Advanced Agent Runtime over real HTTP + OAuth', () => {
  it('coordinates plan, parallel hypotheses, locks, managed actions, evidence judgement and snapshot rollback', async () => {
    const ctx = await launch({ toolSurface: 'compact', trust: 'trusted', fixtureFiles: { 'src/base.ts': 'export const base = true;\n' } });
    try {
      const token = await obtainToken(ctx);
      const run = AgentRun.parse(assertOk(await gateway(ctx, token.accessToken, 'dodo_assist_change', 'agent_run_open', {
        goal: 'Compare two guarded repair hypotheses', completionCriteria: ['candidate file is absent after rollback'], capabilities,
      })));
      const plan = AgentPlan.parse(assertOk(await gateway(ctx, token.accessToken, 'dodo_assist_change', 'agent_plan_set', {
        runId: run.runId, expectedRevision: 1, steps: [
          { id: 'snapshot', phase: 'observe', operation: 'agent_snapshot_create', description: 'Capture baseline metadata', completionCriterion: null, dependsOn: [] },
          { id: 'write', phase: 'act', operation: 'write_file', description: 'Apply isolated candidate', completionCriterion: null, dependsOn: ['snapshot'] },
          { id: 'verify', phase: 'verify', operation: 'runtime_snapshot', description: 'Collect current evidence', completionCriterion: 'candidate file is absent after rollback', dependsOn: ['write'] },
        ],
      })));
      expect(plan).toMatchObject({ revision: 2, immutable: true });

      const first = AgentHypothesis.parse(assertOk(await gateway(ctx, token.accessToken, 'dodo_assist_change', 'agent_hypothesis_open', {
        runId: run.runId, title: 'candidate A', probableCause: 'missing source file', expectedEvidence: ['journaled write and rollback'],
      })));
      const second = AgentHypothesis.parse(assertOk(await gateway(ctx, token.accessToken, 'dodo_assist_change', 'agent_hypothesis_open', {
        runId: run.runId, title: 'candidate B', probableCause: 'stale generated file', expectedEvidence: ['same guarded path'],
      })));
      const lock = AgentIntent.parse(assertOk(await gateway(ctx, token.accessToken, 'dodo_assist_change', 'agent_intent_acquire', {
        runId: run.runId, hypothesisId: first.hypothesisId, kind: 'path', resourceKey: 'src', ttlMinutes: 30,
      })));
      expect(lock.resourceKey).toBe('src');
      const conflict = await gateway(ctx, token.accessToken, 'dodo_assist_change', 'agent_intent_acquire', {
        runId: run.runId, hypothesisId: second.hypothesisId, kind: 'path', resourceKey: 'src/candidate.ts', ttlMinutes: 30,
      });
      expect((conflict.envelope.error as { code?: string }).code).toBe('CONFLICT');

      const snapshot = AgentSnapshot.parse(assertOk(await gateway(ctx, token.accessToken, 'dodo_assist_read', 'agent_snapshot_create', { runId: run.runId, hypothesisId: first.hypothesisId })));
      const written = assertOk(await gateway(ctx, token.accessToken, 'dodo_write', 'agent_write', {
        runId: run.runId, hypothesisId: first.hypothesisId, operation: 'write_file',
        args: { path: 'src/candidate.ts', content: 'export const candidate = true;\n' },
      })) as { changesetId: string };
      expect(fs.readFileSync(path.join(ctx.fixtureDir, 'src/candidate.ts'), 'utf8')).toContain('candidate');
      const comparison = assertOk(await gateway(ctx, token.accessToken, 'dodo_assist_read', 'agent_snapshot_compare', {
        runId: run.runId, hypothesisId: first.hypothesisId, snapshotId: snapshot.snapshotId,
      })) as { changed: boolean; rollbackCandidates: Array<{ changesetId: string }> };
      expect(comparison.changed).toBe(true);
      expect(comparison.rollbackCandidates.map((item) => item.changesetId)).toContain(written.changesetId);

      assertOk(await gateway(ctx, token.accessToken, 'dodo_write', 'agent_snapshot_rollback', {
        runId: run.runId, hypothesisId: first.hypothesisId, snapshotId: snapshot.snapshotId,
        changesetId: written.changesetId, idempotencyKey: 'agent-snapshot-rollback-001',
      }));
      expect(fs.existsSync(path.join(ctx.fixtureDir, 'src/candidate.ts'))).toBe(false);

      const runtimeSession = RuntimeSession.parse(assertOk(await gateway(ctx, token.accessToken, 'dodo_assist_change', 'runtime_session_open', { label: 'agent verification' })));
      const runtimeEvidence = RuntimeEvidence.parse(assertOk(await gateway(ctx, token.accessToken, 'dodo_assist_read', 'runtime_snapshot', { sessionId: runtimeSession.sessionId })));
      const judgement = assertOk(await gateway(ctx, token.accessToken, 'dodo_assist_change', 'agent_hypothesis_judge', {
        runId: run.runId, results: [
          { hypothesisId: first.hypothesisId, verdict: 'passed', score: 90, rationale: 'rollback restored the baseline', evidence: [{ sessionId: runtimeSession.sessionId, evidenceId: runtimeEvidence.evidenceId }] },
          { hypothesisId: second.hypothesisId, verdict: 'failed', score: 20, rationale: 'overlapping intent was unsafe', evidence: [{ sessionId: runtimeSession.sessionId, evidenceId: runtimeEvidence.evidenceId }] },
        ],
      })) as { winnerHypothesisId: string; authority: string };
      expect(judgement).toMatchObject({ winnerHypothesisId: first.hypothesisId, authority: 'evidence_only' });

      const completed = assertOk(await gateway(ctx, token.accessToken, 'dodo_assist_change', 'agent_run_control', {
        runId: run.runId, action: 'complete', criteriaResults: [{ criterion: 'candidate file is absent after rollback', passed: true, evidence: [{ sessionId: runtimeSession.sessionId, evidenceId: runtimeEvidence.evidenceId }] }],
      })) as { run: { status: string }; jobsKilled: boolean };
      expect(completed).toMatchObject({ run: { status: 'COMPLETED' }, jobsKilled: false });
    } finally { await ctx.cleanup(); }
  }, 120_000);

  it('runs explicit argv through agent_exec and recovers interrupted coordinator state after restart', async () => {
    let ctx = await launch({ toolSurface: 'compact', trust: 'trusted' });
    const token = await obtainToken(ctx);
    const run = AgentRun.parse(assertOk(await gateway(ctx, token.accessToken, 'dodo_assist_change', 'agent_run_open', {
      goal: 'survive reconnect', completionCriteria: ['process observed'], capabilities,
    })));
    const hypothesis = AgentHypothesis.parse(assertOk(await gateway(ctx, token.accessToken, 'dodo_assist_change', 'agent_hypothesis_open', {
      runId: run.runId, title: 'explicit argv', probableCause: 'none', expectedEvidence: ['exit zero'],
    })));
    const started = assertOk(await gateway(ctx, token.accessToken, 'dodo_exec', 'agent_exec', {
      runId: run.runId, hypothesisId: hypothesis.hypothesisId, operation: 'exec_command',
      args: { program: 'node', args: ['-e', 'process.exit(0)'], idempotencyKey: 'agent-exec-restart-001' },
    })) as { jobId: string };
    assertOk(await gateway(ctx, token.accessToken, 'dodo_assist_read', 'agent_read', {
      runId: run.runId, hypothesisId: hypothesis.hypothesisId, operation: 'job_wait', args: { jobId: started.jobId, waitMs: 10_000 },
    }));
    ctx.server.services.store.db.prepare(`INSERT INTO agent_actions(id,run_id,hypothesis_id,workspace_id,owner,operation,input_hash,status,result_code,result_hash,created_at,completed_at)
      SELECT 'aaction_interrupted',id,?,workspace_id,owner,'fixture','sha256:fixture','RUNNING',NULL,NULL,?,NULL FROM agent_runs WHERE id=?`).run(hypothesis.hypothesisId, Date.now(), run.runId);
    const saved = { fixtureDir: ctx.fixtureDir, configDir: ctx.configDir, port: ctx.port };
    await ctx.cleanup();
    ctx = await launch({ ...saved, toolSurface: 'compact', trust: 'trusted' });
    try {
      const status = assertOk(await gateway(ctx, token.accessToken, 'dodo_assist_read', 'agent_run_status', { runId: run.runId })) as { run: { status: string } };
      expect(status.run.status).toBe('RECOVERY_REQUIRED');
      expect(ctx.server.services.store.db.prepare('SELECT status,result_code FROM agent_actions WHERE id=?').get('aaction_interrupted')).toEqual({ status: 'INTERRUPTED', result_code: 'SERVER_RESTARTED' });
      const recovered = assertOk(await gateway(ctx, token.accessToken, 'dodo_assist_change', 'agent_run_control', { runId: run.runId, action: 'recover' })) as { run: { status: string; openedEpoch: string }; jobsKilled: boolean };
      expect(recovered).toMatchObject({ run: { status: 'ACTIVE', openedEpoch: ctx.server.epoch }, jobsKilled: false });
    } finally { await ctx.cleanup(); }
  }, 120_000);

  it('keeps skill proposals hidden until exact private owner review and versions immutable guidance', async () => {
    const ctx = await launch({ toolSurface: 'compact' });
    try {
      const token = await obtainToken(ctx, { scope: 'dodo:read dodo:write' });
      const proposal = assertOk(await gateway(ctx, token.accessToken, 'dodo_assist_change', 'agent_skill_propose', {
        key: 'verify-typescript', title: 'Verify TypeScript change', summary: 'Read source and run the approved typecheck recipe.',
        steps: ['Read affected source.', 'Run an explicitly allowed verification operation.'], requiredCapabilities: ['dodo:read', 'dodo:exec'],
      })) as { proposalId: string; digest: string; status: string; executable: boolean };
      expect(proposal).toMatchObject({ status: 'PENDING', executable: false });
      const hidden = assertOk(await gateway(ctx, token.accessToken, 'dodo_assist_read', 'agent_skill_search', { query: 'typescript' })) as { skills: unknown[] };
      expect(hidden.skills).toEqual([]);
      const pending = await owner(ctx, 'agent.skill.pending') as Array<{ proposalId: string }>;
      expect(pending.map((item) => item.proposalId)).toContain(proposal.proposalId);
      const approved = await owner(ctx, 'agent.skill.review', { id: proposal.proposalId, digest: proposal.digest, approved: true, note: 'Reviewed guidance only.' }) as { skillId: string; version: number; authority: string; executable: boolean };
      expect(approved).toMatchObject({ version: 1, authority: 'untrusted_guidance', executable: false });
      const found = assertOk(await gateway(ctx, token.accessToken, 'dodo_assist_read', 'agent_skill_search', { query: 'typescript' })) as { skills: Array<{ skillId: string; steps?: unknown }> };
      expect(found.skills).toHaveLength(1);
      expect(found.skills[0]).not.toHaveProperty('steps');
      const detail = AgentSkillDetail.parse(assertOk(await gateway(ctx, token.accessToken, 'dodo_assist_read', 'agent_skill_inspect', { skillId: approved.skillId })));
      expect(detail).toMatchObject({ version: 1, authority: 'untrusted_guidance' });
      expect(detail.steps).toHaveLength(2);
      expect(ctx.server.services.store.recentAudit(ctx.server.workspaceId, 100)).toContainEqual(expect.objectContaining({ principal: 'local-agent-owner', tool: 'local.agent.skill.approve', result: 'approved:v1' }));
    } finally { await ctx.cleanup(); }
  }, 120_000);
});
