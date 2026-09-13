import { z } from 'zod';
import { DodoError } from '../errors.js';
import { EXEC_ARG_BYTES, validateExecArgs } from '../services/jobs/commandInput.js';
import {
  RuntimeDiagnosis, RuntimeEvidence, RuntimeEvidenceId, RuntimeSession, RuntimeSessionId,
  RuntimeSessionStatus, RuntimeTask, RuntimeTaskId, RuntimeTaskKind,
} from '../services/runtime/contracts.js';
import { defineTool, policyGate, type AnyToolDef, type ExtraContentBlock, type ToolCtx } from './context.js';
import { withIdempotency } from './changeTools.js';

const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const plan = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const execute = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true };
const IdempotencyKey = z.string().min(8).max(128);

function use(ctx: ToolCtx) {
  const runtime = ctx.services.runtime;
  if (!runtime) throw new DodoError('NOT_SUPPORTED', 'Runtime Intelligence is unavailable in this running build');
  return runtime;
}

const runtimeSessionOpenTool = defineTool({
  name: 'runtime_session_open', title: 'Open a durable runtime evidence session',
  description: 'Open a caller/workspace-scoped runtime session that persists across MCP reconnects and server restarts. This opens no process, browser, network, desktop, microphone or system audio by itself. Handles expire and live OAuth/workspace ACL is rechecked on every use.',
  input: { label: z.string().min(1).max(160), ttlMinutes: z.number().int().min(1).max(24 * 60).default(60) }, output: RuntimeSession,
  requiredScope: 'dodo:write', action: 'plan', annotations: plan,
  handler: async (args, ctx) => ({ data: use(ctx).open(ctx, args.label, args.ttlMinutes) }),
});

const runtimeSessionStatusTool = defineTool({
  name: 'runtime_session_status', title: 'Inspect a runtime session',
  description: 'Return caller-owned session, task and evidence status after rechecking live access. Process metadata is reconnectable; raw command output and browser secrets are never persisted in Runtime Intelligence.',
  input: { sessionId: RuntimeSessionId }, output: RuntimeSessionStatus,
  requiredScope: 'dodo:read', action: 'read', annotations: read,
  handler: async (args, ctx) => ({ data: use(ctx).status(ctx, args.sessionId) }),
});

const runtimeSessionCloseTool = defineTool({
  name: 'runtime_session_close', title: 'Close a runtime session',
  description: 'Close one owned runtime session. Refuses while attached tasks are running and never kills work silently. Jobs remain governed by runtime_task_cancel and the existing owned-process rules.',
  input: { sessionId: RuntimeSessionId }, output: RuntimeSession,
  requiredScope: 'dodo:write', action: 'plan', annotations: { ...plan, idempotentHint: true },
  handler: async (args, ctx) => ({ data: use(ctx).closeSession(ctx, args.sessionId) }),
});

const runtimeTaskStartTool = defineTool({
  name: 'runtime_task_start', title: 'Start a reconnectable runtime task',
  description: 'Start an explicit program+argv process as process/test/container runtime evidence. No shell string is accepted. Uses the existing trusted executable resolver, execution approval, owner command-sandbox policy, environment allowlist, timeout and durable idempotency. Returns immediately; observe or cancel by runtime task handle.',
  input: {
    sessionId: RuntimeSessionId, kind: RuntimeTaskKind,
    program: z.string().min(1).max(512), args: z.array(z.string().max(EXEC_ARG_BYTES)).max(128).default([]),
    cwd: z.string().max(1024).default('.'), timeoutMs: z.number().int().min(1000).max(30 * 60 * 1000).optional(),
    sandbox: z.boolean().optional(), network: z.boolean().default(false), idempotencyKey: IdempotencyKey,
  },
  output: z.object({ task: RuntimeTask, sandboxed: z.string().nullable(), replayed: z.boolean() }).strict(),
  requiredScope: 'dodo:exec', action: 'exec', annotations: execute,
  handler: async (args, ctx) => {
    validateExecArgs(args.program, args.args);
    use(ctx).prepareTask(ctx, args.sessionId);
    policyGate(ctx, {
      tool: 'runtime_task_start', action: 'exec',
      approvalAction: { sessionId: args.sessionId, kind: args.kind, program: args.program, args: args.args, cwd: args.cwd, timeoutMs: args.timeoutMs ?? null, sandbox: args.sandbox ?? null, network: args.network },
      summary: `runtime ${args.kind}: ${args.program} ${args.args.join(' ')}`.slice(0, 200),
    });
    const { result, replayed } = await withIdempotency(ctx, 'runtime_task_start', args.idempotencyKey, {
      sessionId: args.sessionId, kind: args.kind, program: args.program, args: args.args, cwd: args.cwd,
      timeoutMs: args.timeoutMs ?? null, sandbox: args.sandbox ?? null, network: args.network,
    }, async () => {
      const request: Parameters<typeof ctx.services.jobs.start>[0] = {
        workspaceId: ctx.services.workspaceId, epoch: ctx.services.epoch, principal: ctx.principal.grantId,
        kind: 'exec', program: args.program, args: args.args, cwdRel: args.cwd, sandbox: args.sandbox, network: args.network,
      };
      if (args.timeoutMs !== undefined) request.timeoutMs = args.timeoutMs;
      const job = ctx.services.jobs.start(request);
      try { return { task: use(ctx).attachTask(ctx, args.sessionId, job.jobId, args.kind), sandboxed: job.sandboxed }; }
      catch (error) { ctx.services.jobs.cancel(job.jobId, ctx.services.workspaceId, 0); throw error; }
    });
    return { data: { ...result, replayed } };
  },
});

const runtimeTaskObserveTool = defineTool({
  name: 'runtime_task_observe', title: 'Record safe process or test evidence',
  description: 'Observe an owned runtime task and persist only status, exit metadata, byte counts and SHA-256 samples. Raw stdout/stderr is not stored. Optional reportPath is read through WorkspaceFS and retains only aggregate JSON test counts plus its source hash.',
  input: { sessionId: RuntimeSessionId, taskId: RuntimeTaskId, reportPath: z.string().max(1024).optional() },
  output: z.object({ task: RuntimeTask, evidence: RuntimeEvidence }).strict(),
  requiredScope: 'dodo:read', action: 'read', annotations: read,
  handler: async (args, ctx) => ({ data: use(ctx).observeTask(ctx, args.sessionId, args.taskId, args.reportPath) }),
});

const runtimeTaskCancelTool = defineTool({
  name: 'runtime_task_cancel', title: 'Cancel an owned runtime task',
  description: 'Cancel only the live owned process tree attached to this caller/workspace runtime task. Never signals a stored PID after restart and never broadens owner command policy.',
  input: { sessionId: RuntimeSessionId, taskId: RuntimeTaskId },
  output: z.object({ taskId: RuntimeTaskId, jobId: z.string(), status: z.string() }).strict(),
  requiredScope: 'dodo:exec', action: 'job-control', annotations: { ...execute, openWorldHint: false },
  handler: async (args, ctx) => ({ data: use(ctx).cancelTask(ctx, args.sessionId, args.taskId) }),
});

function imageBlock(ctx: ToolCtx, assetId: string): ExtraContentBlock {
  const asset = ctx.services.multimodal?.storage.get(ctx.principal, assetId);
  if (!asset || asset.meta.kind !== 'image') throw new DodoError('NOT_FOUND', 'browser screenshot asset expired before response');
  return { type: 'image', data: asset.bytes.toString('base64'), mimeType: asset.meta.mimeType };
}

const runtimeBrowserCollectTool = defineTool({
  name: 'runtime_browser_collect', title: 'Collect bounded evidence from an existing browser',
  description: 'Observe an already owner-created browser_session and attach bounded screenshot/DOM/console/network evidence to a runtime session. It never opens a browser or enables public web. Persisted evidence contains hashes, counts and query-free safe URL only; no cookie, authorization header, input value or raw console/DOM text is stored.',
  input: { sessionId: RuntimeSessionId, browserSessionId: z.string().regex(/^browser_[0-9a-hjkmnp-tv-z]{8,64}$/) },
  output: z.looseObject({ evidence: RuntimeEvidence }), requiredScope: 'dodo:read', action: 'read', annotations: read,
  handler: async (args, ctx) => {
    const result = await use(ctx).collectBrowser(ctx, args.sessionId, args.browserSessionId);
    return { data: result, contentBlocks: [imageBlock(ctx, result.observation.asset.assetId)] };
  },
});

const runtimeSnapshotTool = defineTool({
  name: 'runtime_snapshot', title: 'Record a guarded workspace snapshot',
  description: 'Record a bounded hash of guarded file metadata plus caller-owned committed changesets eligible to be considered for rollback. It stores no file content and performs no rollback. Actual rollback remains rollback_changes with existing journal and conflict checks.',
  input: { sessionId: RuntimeSessionId }, output: RuntimeEvidence,
  requiredScope: 'dodo:read', action: 'read', annotations: read,
  handler: async (args, ctx) => ({ data: use(ctx).snapshot(ctx, args.sessionId) }),
});

const runtimeEvidenceTool = defineTool({
  name: 'runtime_evidence', title: 'Inspect and revalidate runtime evidence',
  description: 'Read one caller/workspace/session-scoped evidence record. By default rechecks the current guarded process, browser observation or workspace snapshot and marks changed/unavailable sources stale. An evidence ID never grants access.',
  input: { sessionId: RuntimeSessionId, evidenceId: RuntimeEvidenceId, refresh: z.boolean().default(true) }, output: RuntimeEvidence,
  requiredScope: 'dodo:read', action: 'read', annotations: read,
  handler: async (args, ctx) => ({ data: await use(ctx).evidence(ctx, args.sessionId, args.evidenceId, args.refresh) }),
});

const runtimeDiagnoseTool = defineTool({
  name: 'runtime_diagnose', title: 'Diagnose bounded runtime evidence',
  description: 'Produce deterministic facts, observations and clearly labeled inferences from current caller-owned runtime evidence. It never reads hidden output, executes a fix, changes code, grants permission or claims that process exit alone proves user-visible success.',
  input: { sessionId: RuntimeSessionId, evidenceIds: z.array(RuntimeEvidenceId).min(1).max(16) }, output: RuntimeDiagnosis,
  requiredScope: 'dodo:read', action: 'read', annotations: read,
  handler: async (args, ctx) => ({ data: await use(ctx).diagnose(ctx, args.sessionId, args.evidenceIds) }),
});

export const RUNTIME_TOOLS: AnyToolDef[] = [
  runtimeSessionOpenTool, runtimeSessionStatusTool, runtimeSessionCloseTool,
  runtimeTaskStartTool, runtimeTaskObserveTool, runtimeTaskCancelTool,
  runtimeBrowserCollectTool, runtimeSnapshotTool, runtimeEvidenceTool, runtimeDiagnoseTool,
];
