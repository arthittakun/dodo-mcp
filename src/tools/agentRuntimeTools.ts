import { z } from 'zod';
import { DodoError, fromErrorInfo, toDodoError } from '../errors.js';
import {
  AgentCapabilities,
  AgentHypothesis,
  AgentHypothesisId,
  AgentIntent,
  AgentIntentId,
  AgentPlan,
  AgentPlanStep,
  AgentRun,
  AgentRunId,
  AgentSkillDetail,
  AgentSkillId,
  AgentSkillSummary,
  AgentSnapshot,
  AgentSnapshotId,
} from '../services/agent/contracts.js';
import type { AgentOperationTicket } from '../services/agent/agentService.js';
import { digestOf } from '../util/hash.js';
import { rollbackChangesTool } from './changeTools.js';
import { CORE_TOOL_CATALOG } from './coreCatalog.js';
import { defineTool, invokeToolDefinition, type AnyToolDef, type ExtraContentBlock, type HandlerResult, type ToolCtx } from './context.js';

const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const plan = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const effect = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
const looseData = z.looseObject({});
const IdempotencyKey = z.string().min(8).max(128);
const EvidenceRef = z.object({ sessionId: z.string().regex(/^runtime_[0-9a-hjkmnp-tv-z]{8,64}$/), evidenceId: z.string().regex(/^runtimeev_[0-9a-hjkmnp-tv-z]{8,64}$/) }).strict();

function service(ctx: ToolCtx) {
  const value = ctx.services.agentRuntime;
  if (!value) throw new DodoError('NOT_SUPPORTED', 'Advanced Agent Runtime is unavailable in this running build');
  return value;
}

const targetByName = new Map(CORE_TOOL_CATALOG.map((definition) => [definition.name, definition]));
const readTargets = CORE_TOOL_CATALOG.filter((definition) => definition.name !== 'project_overview' && definition.requiredScope === 'dodo:read');
const writeTargets = CORE_TOOL_CATALOG.filter((definition) => definition.requiredScope === 'dodo:write' && definition.name !== 'rollback_changes');
const execTargets = CORE_TOOL_CATALOG.filter((definition) => definition.requiredScope === 'dodo:exec' && !['run_command', 'run_commands', 'schedule_propose', 'job_input', 'job_cancel'].includes(definition.name));

function namesOf(targets: AnyToolDef[]): [string, ...string[]] {
  if (targets.length === 0) throw new Error('agent operation target list must not be empty');
  return targets.map((definition) => definition.name) as [string, ...string[]];
}

async function dispatch(
  args: Record<string, unknown> & { runId: string; hypothesisId: string; operation: string; args?: Record<string, unknown> },
  ctx: ToolCtx,
  targets: AnyToolDef[],
): Promise<HandlerResult> {
  const target = targetByName.get(args.operation);
  if (!target || !targets.includes(target)) throw new DodoError('INVALID_INPUT', `operation ${args.operation} is outside this managed agent dispatcher`);
  const raw = args.args ?? {};
  if ('workspaceId' in raw || 'workspaceEpoch' in raw) throw new DodoError('INVALID_INPUT', 'nested agent args must not contain workspaceId/workspaceEpoch');
  let ticket: AgentOperationTicket | undefined;
  try {
    ticket = service(ctx).beginOperation(ctx, args.runId, args.hypothesisId, target.name, raw, target.requiredScope);
    const merged = target.noWorkspaceContext ? { ...raw } : {
      ...raw,
      workspaceId: args['workspaceId'],
      workspaceEpoch: args['workspaceEpoch'],
    };
    const result = await invokeToolDefinition({ def: target, services: ctx.services, principal: ctx.principal, args: merged });
    service(ctx).finishOperation(ticket, { ok: result.envelope.ok, ...(result.envelope.error?.code ? { code: result.envelope.error.code } : {}), digest: digestOf(result.envelope) });
    if (!result.envelope.ok) throw fromErrorInfo(result.envelope.error as NonNullable<typeof result.envelope.error>);
    return {
      data: result.envelope.data,
      warnings: result.envelope.warnings,
      truncated: result.envelope.truncated,
      nextCursor: result.envelope.nextCursor,
      ...(result.extraBlocks.length > 0 ? { contentBlocks: result.extraBlocks as ExtraContentBlock[] } : {}),
    };
  } catch (error) {
    if (ticket) {
      const converted = toDodoError(error);
      service(ctx).finishOperation(ticket, { ok: false, code: converted.code, digest: digestOf(converted.toInfo()) });
    }
    throw error;
  }
}

const agentRunOpenTool = defineTool({
  name: 'agent_run_open', title: 'Open an advanced agent run',
  description: 'Create a durable coordination run with explicit goal, completion criteria and capabilities that only narrow the caller. It grants no project, path, command, network, secret or owner permission.',
  input: {
    goal: z.string().min(1).max(2000), completionCriteria: z.array(z.string().min(1).max(500)).min(1).max(20),
    capabilities: AgentCapabilities.default({
      allowedProjectIds: [], writablePaths: [], allowedPrograms: [], allowNetwork: false, allowBrowser: false,
      allowDesktop: false, allowMedia: false, allowWorkflow: false, secretAccess: false,
      maxHypotheses: 3, maxActions: 100, maxRunningJobs: 2, maxWallMinutes: 60,
    }),
  },
  output: AgentRun, requiredScope: 'dodo:write', action: 'plan', annotations: plan,
  handler: async (args, ctx) => ({ data: service(ctx).open(ctx, args) }),
});

const agentRunStatusTool = defineTool({
  name: 'agent_run_status', title: 'Inspect an advanced agent run',
  description: 'Return durable run, immutable latest plan, hypotheses, active intents, snapshots and latest evidence judgement for this caller/workspace.',
  input: { runId: AgentRunId }, output: looseData, requiredScope: 'dodo:read', action: 'read', annotations: read,
  handler: async (args, ctx) => ({ data: service(ctx).status(ctx, args.runId) }),
});

const agentPlanSetTool = defineTool({
  name: 'agent_plan_set', title: 'Save an immutable agent plan revision',
  description: 'Append a strict acyclic plan revision using expectedRevision. A plan is coordination data and never executes or grants an operation.',
  input: { runId: AgentRunId, expectedRevision: z.number().int().positive(), steps: z.array(AgentPlanStep).min(1).max(100) },
  output: AgentPlan, requiredScope: 'dodo:write', action: 'plan', annotations: plan,
  handler: async (args, ctx) => ({ data: service(ctx).setPlan(ctx, args.runId, args.expectedRevision, args.steps) }),
});

const agentHypothesisOpenTool = defineTool({
  name: 'agent_hypothesis_open', title: 'Open a bounded hypothesis',
  description: 'Register one probable cause and its expected evidence under a run. Parallel hypotheses share no implicit permission and conflicting path intents are refused.',
  input: { runId: AgentRunId, title: z.string().min(1).max(200), probableCause: z.string().min(1).max(1000), expectedEvidence: z.array(z.string().min(1).max(500)).min(1).max(20) },
  output: AgentHypothesis, requiredScope: 'dodo:write', action: 'plan', annotations: plan,
  handler: async (args, ctx) => ({ data: service(ctx).openHypothesis(ctx, args.runId, args) }),
});

const agentIntentAcquireTool = defineTool({
  name: 'agent_intent_acquire', title: 'Acquire a hypothesis intent lock',
  description: 'Acquire a bounded path/symbol/resource intent. Overlapping path locks across active hypotheses are refused. An intent is not filesystem authority.',
  input: { runId: AgentRunId, hypothesisId: AgentHypothesisId, kind: z.enum(['path', 'symbol', 'resource']), resourceKey: z.string().min(1).max(1024), ttlMinutes: z.number().int().min(1).max(240).default(30) },
  output: AgentIntent, requiredScope: 'dodo:write', action: 'plan', annotations: plan,
  handler: async (args, ctx) => ({ data: service(ctx).acquireIntent(ctx, args.runId, args.hypothesisId, args.kind, args.resourceKey, args.ttlMinutes) }),
});

const agentIntentReleaseTool = defineTool({
  name: 'agent_intent_release', title: 'Release a hypothesis intent lock',
  description: 'Release one caller-owned intent. It does not alter files, jobs or another hypothesis.',
  input: { runId: AgentRunId, hypothesisId: AgentHypothesisId, intentId: AgentIntentId }, output: AgentIntent,
  requiredScope: 'dodo:write', action: 'plan', annotations: { ...plan, idempotentHint: true },
  handler: async (args, ctx) => ({ data: service(ctx).releaseIntent(ctx, args.runId, args.hypothesisId, args.intentId) }),
});

function dispatcherTool(name: 'agent_read' | 'agent_write' | 'agent_exec', targets: AnyToolDef[], scope: 'dodo:read' | 'dodo:write' | 'dodo:exec'): AnyToolDef {
  const operations = namesOf(targets);
  return defineTool({
    name,
    title: name === 'agent_read' ? 'Read through an agent capability boundary' : name === 'agent_write' ? 'Write through an agent capability boundary' : 'Execute through an agent capability boundary',
    description: `Dispatch one ${scope} target through the normal invocation pipeline plus run/hypothesis capability, quota and intent checks. Target OAuth scope, ACL, trust, approval, path guards, expected hashes, sandbox, idempotency, audit and content blocks remain authoritative. Supported operations: ${operations.join(', ')}.`,
    input: {
      runId: AgentRunId, hypothesisId: AgentHypothesisId, operation: z.enum(operations),
      args: z.record(z.string(), z.unknown()).default({}).describe('Exact target arguments without workspaceId/workspaceEpoch.'),
    },
    output: looseData, requiredScope: scope, action: scope === 'dodo:read' ? 'read' : scope === 'dodo:write' ? 'mutate-files' : 'exec',
    annotations: scope === 'dodo:read' ? read : effect,
    handler: async (args, ctx) => dispatch(args as never, ctx, targets),
  });
}

const agentReadTool = dispatcherTool('agent_read', readTargets, 'dodo:read');
const agentWriteTool = dispatcherTool('agent_write', writeTargets, 'dodo:write');
const agentExecTool = dispatcherTool('agent_exec', execTargets, 'dodo:exec');

const agentSnapshotCreateTool = defineTool({
  name: 'agent_snapshot_create', title: 'Create a metadata-only agent snapshot',
  description: 'Capture guarded path/size/time metadata and the current changeset baseline. Stores no file contents and performs no rollback.',
  input: { runId: AgentRunId, hypothesisId: AgentHypothesisId }, output: AgentSnapshot,
  requiredScope: 'dodo:read', action: 'read', annotations: read,
  handler: async (args, ctx) => ({ data: service(ctx).createSnapshot(ctx, args.runId, args.hypothesisId) }),
});

const agentSnapshotCompareTool = defineTool({
  name: 'agent_snapshot_compare', title: 'Compare an agent snapshot',
  description: 'Compare current guarded metadata to a caller-owned snapshot and list only caller-owned committed changesets created afterward as rollback candidates.',
  input: { runId: AgentRunId, hypothesisId: AgentHypothesisId, snapshotId: AgentSnapshotId }, output: looseData,
  requiredScope: 'dodo:read', action: 'read', annotations: read,
  handler: async (args, ctx) => ({ data: service(ctx).compareSnapshot(ctx, args.runId, args.hypothesisId, args.snapshotId) }),
});

const agentSnapshotRollbackTool = defineTool({
  name: 'agent_snapshot_rollback', title: 'Rollback one post-snapshot changeset',
  description: 'Rollback one exact caller-owned changeset listed by agent_snapshot_compare. Requires covering path intents and invokes rollback_changes through its original conflict, approval, journal and idempotency pipeline.',
  input: { runId: AgentRunId, hypothesisId: AgentHypothesisId, snapshotId: AgentSnapshotId, changesetId: z.string().min(1).max(128), idempotencyKey: IdempotencyKey },
  output: looseData, requiredScope: 'dodo:write', action: 'mutate-files', annotations: { ...effect, openWorldHint: false, idempotentHint: true },
  handler: async (args, ctx) => {
    service(ctx).assertSnapshotRollback(ctx, args.runId, args.hypothesisId, args.snapshotId, args.changesetId);
    const targetArgs = { workspaceId: (args as Record<string, unknown>)['workspaceId'], workspaceEpoch: (args as Record<string, unknown>)['workspaceEpoch'], changesetId: args.changesetId, idempotencyKey: args.idempotencyKey };
    const ticket = service(ctx).beginOperation(ctx, args.runId, args.hypothesisId, rollbackChangesTool.name, { changesetId: args.changesetId, idempotencyKey: args.idempotencyKey }, 'dodo:write');
    const result = await invokeToolDefinition({ def: rollbackChangesTool, services: ctx.services, principal: ctx.principal, args: targetArgs });
    service(ctx).finishOperation(ticket, { ok: result.envelope.ok, ...(result.envelope.error?.code ? { code: result.envelope.error.code } : {}), digest: digestOf(result.envelope) });
    if (!result.envelope.ok) throw fromErrorInfo(result.envelope.error as NonNullable<typeof result.envelope.error>);
    return { data: result.envelope.data, warnings: result.envelope.warnings, truncated: result.envelope.truncated };
  },
});

const JudgeResult = z.object({
  hypothesisId: AgentHypothesisId, verdict: z.enum(['passed', 'failed', 'inconclusive']), score: z.number().min(0).max(100),
  rationale: z.string().min(1).max(1000), evidence: z.array(EvidenceRef).min(1).max(16),
}).strict();
const agentHypothesisJudgeTool = defineTool({
  name: 'agent_hypothesis_judge', title: 'Judge hypotheses from current evidence',
  description: 'Persist a deterministic ranking from caller-owned CURRENT runtime evidence. The result is evidence-only and never applies a solution or changes permission.',
  input: { runId: AgentRunId, results: z.array(JudgeResult).min(1).max(8) }, output: looseData,
  requiredScope: 'dodo:write', action: 'plan', annotations: plan,
  handler: async (args, ctx) => ({ data: await service(ctx).judge(ctx, args.runId, args.results) }),
});

const agentSkillSearchTool = defineTool({
  name: 'agent_skill_search', title: 'Search owner-reviewed agent skills',
  description: 'Progressive disclosure search over current owner-approved skill metadata. Returns no steps; skill guidance is untrusted and non-executable.',
  input: { query: z.string().max(500).default(''), limit: z.number().int().min(1).max(20).default(8) }, output: z.object({ skills: z.array(AgentSkillSummary) }).passthrough(),
  requiredScope: 'dodo:read', action: 'read', annotations: read,
  handler: async (args, ctx) => ({ data: service(ctx).searchSkills(ctx, args.query, args.limit) }),
});

const agentSkillInspectTool = defineTool({
  name: 'agent_skill_inspect', title: 'Inspect one owner-reviewed agent skill',
  description: 'Read the exact reviewed version and steps of a workspace skill. It remains untrusted guidance and cannot execute or authorize target tools.',
  input: { skillId: AgentSkillId, version: z.number().int().positive().optional() }, output: AgentSkillDetail,
  requiredScope: 'dodo:read', action: 'read', annotations: read,
  handler: async (args, ctx) => ({ data: service(ctx).inspectSkill(ctx, args.skillId, args.version) }),
});

const agentSkillProposeTool = defineTool({
  name: 'agent_skill_propose', title: 'Propose a reusable agent skill',
  description: 'Create an immutable untrusted proposal. It is invisible to skill search until the owner reviews the exact digest over private IPC. Approval stores guidance only and never installs code or grants capabilities.',
  input: {
    key: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/), title: z.string().min(1).max(160), summary: z.string().min(1).max(1000),
    steps: z.array(z.string().min(1).max(2000)).min(1).max(32), requiredCapabilities: z.array(z.string().min(1).max(128)).max(32), baseVersion: z.number().int().positive().optional(),
  }, output: looseData, requiredScope: 'dodo:write', action: 'plan', annotations: plan,
  handler: async (args, ctx) => ({ data: service(ctx).proposeSkill(ctx, {
    key: args.key, title: args.title, summary: args.summary, steps: args.steps,
    requiredCapabilities: args.requiredCapabilities,
    ...(args.baseVersion !== undefined ? { baseVersion: args.baseVersion } : {}),
  }) }),
});

const CriteriaResult = z.object({ criterion: z.string().min(1).max(500), passed: z.boolean(), evidence: z.array(EvidenceRef).max(16) }).strict();
const agentRunControlTool = defineTool({
  name: 'agent_run_control', title: 'Pause, resume, recover, complete or cancel a run',
  description: 'Control durable coordinator state. Cancel/pause never kill jobs. Complete requires every exact criterion to pass with current caller-owned runtime evidence. Recover is explicit after restart.',
  input: { runId: AgentRunId, action: z.enum(['pause', 'resume', 'cancel', 'recover', 'complete']), criteriaResults: z.array(CriteriaResult).max(20).optional() },
  output: looseData, requiredScope: 'dodo:write', action: 'plan', annotations: plan,
  handler: async (args, ctx) => ({ data: await service(ctx).control(ctx, args.runId, {
    action: args.action,
    ...(args.criteriaResults !== undefined ? { criteriaResults: args.criteriaResults } : {}),
  }) }),
});

export const AGENT_RUNTIME_TOOLS: AnyToolDef[] = [
  agentRunOpenTool, agentRunStatusTool, agentPlanSetTool, agentHypothesisOpenTool,
  agentIntentAcquireTool, agentIntentReleaseTool, agentReadTool, agentWriteTool, agentExecTool,
  agentSnapshotCreateTool, agentSnapshotCompareTool, agentSnapshotRollbackTool,
  agentHypothesisJudgeTool, agentSkillSearchTool, agentSkillInspectTool, agentSkillProposeTool,
  agentRunControlTool,
];
