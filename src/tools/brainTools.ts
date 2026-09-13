import { z } from 'zod';
import { DodoError } from '../errors.js';
import {
  BRAIN_QUERY_MAX,
  BrainControlResult,
  BrainEdgeType,
  BrainNode,
  BrainNodeType,
  BrainQueryResult,
  BrainStatus,
} from '../services/brain/contracts.js';
import { liveAccess } from '../services/multimodal/storage.js';
import { defineTool, policyGate, type AnyToolDef, type ToolCtx } from './context.js';

const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const control = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

function use(ctx: ToolCtx) {
  const brain = ctx.services.brain;
  if (!brain) throw new DodoError('NOT_SUPPORTED', 'Project Brain is unavailable in this running build');
  return brain;
}

const brainStatusTool = defineTool({
  name: 'brain_status',
  title: 'Inspect Project Brain status',
  description: 'Return bounded Project Brain freshness, parser/schema versions, latest run state and graph counts for the active workspace. Cached index rows are evidence only and never grant source access.',
  input: {},
  output: BrainStatus,
  requiredScope: 'dodo:read',
  action: 'read',
  annotations: read,
  handler: async (_args, ctx) => { liveAccess(ctx, 'dodo:read'); return { data: use(ctx).status() }; },
});

const brainQueryTool = defineTool({
  name: 'brain_query',
  title: 'Query project structure',
  description: 'Query bounded files, symbols, routes, tests, dependencies and relationship edges from the active Project Brain. Every returned row is re-authorized and checked against the current guarded source SHA-256; stale rows are omitted by default.',
  input: {
    query: z.string().min(1).max(256).optional(),
    path: z.string().min(1).max(1024).optional(),
    nodeTypes: z.array(BrainNodeType).min(1).max(5).optional(),
    edgeTypes: z.array(BrainEdgeType).min(1).max(6).optional(),
    includeStale: z.boolean().default(false),
    limit: z.number().int().min(1).max(BRAIN_QUERY_MAX).default(50),
    cursor: z.string().max(2048).optional(),
  },
  output: BrainQueryResult,
  requiredScope: 'dodo:read',
  action: 'read',
  annotations: read,
  handler: async (args, ctx) => {
    const input: Parameters<ReturnType<typeof use>['query']>[1] = {
      includeStale: args.includeStale,
      limit: args.limit,
      ...(args.query !== undefined ? { query: args.query } : {}),
      ...(args.path !== undefined ? { path: args.path } : {}),
      ...(args.nodeTypes !== undefined ? { nodeTypes: args.nodeTypes } : {}),
      ...(args.edgeTypes !== undefined ? { edgeTypes: args.edgeTypes } : {}),
      ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
    };
    const result = await use(ctx).query(ctx, input);
    return { data: result.data, truncated: result.truncated, nextCursor: result.nextCursor };
  },
});

const brainSymbolTool = defineTool({
  name: 'brain_symbol',
  title: 'Resolve a stable Project Brain symbol',
  description: 'Resolve one symbol:// project entity URI. The stable identity survives an exact-content file move, while the result reports the current path and source freshness.',
  input: { uri: z.string().min(1).max(1024).regex(/^symbol:\/\//) },
  output: BrainNode,
  requiredScope: 'dodo:read',
  action: 'read',
  annotations: read,
  handler: async (args, ctx) => ({ data: await use(ctx).symbol(ctx, args.uri) }),
});

const brainRebuildTool = defineTool({
  name: 'brain_rebuild',
  title: 'Rebuild Project Brain',
  description: 'Start one bounded incremental or full Project Brain rebuild. Repository code, plugins and scripts are never executed. This owner-controlled maintenance action retains the active trust/approval policy.',
  input: {
    mode: z.enum(['incremental', 'full']).default('incremental'),
    waitMs: z.number().int().min(0).max(10_000).default(0),
  },
  output: BrainControlResult,
  requiredScope: 'dodo:exec',
  action: 'exec',
  annotations: control,
  handler: async (args, ctx) => {
    liveAccess(ctx, 'dodo:exec');
    policyGate(ctx, { tool: 'brain_rebuild', action: 'exec', approvalAction: { mode: args.mode }, summary: `rebuild the active Project Brain (${args.mode})` });
    const brain = use(ctx);
    const started = await brain.start(args.mode);
    const status = args.waitMs > 0 ? await brain.wait(started.runId, args.waitMs) : brain.status();
    return { data: { runId: started.runId, changed: started.changed, status } };
  },
});

const brainPauseTool = defineTool({
  name: 'brain_pause',
  title: 'Pause or resume Project Brain refresh',
  description: 'Pause or resume automatic indexing for the active workspace. Pausing cancels an in-progress uncommitted index transaction; it never changes source files or permissions.',
  input: { paused: z.boolean().default(true) },
  output: BrainControlResult,
  requiredScope: 'dodo:exec',
  action: 'exec',
  annotations: control,
  handler: async (args, ctx) => {
    liveAccess(ctx, 'dodo:exec');
    policyGate(ctx, { tool: 'brain_pause', action: 'exec', approvalAction: { paused: args.paused }, summary: `${args.paused ? 'pause' : 'resume'} automatic Project Brain indexing` });
    const brain = use(ctx);
    const result = await brain.pause(args.paused);
    return { data: { runId: null, changed: result.changed, status: brain.status() } };
  },
});

const brainCancelTool = defineTool({
  name: 'brain_cancel',
  title: 'Cancel a Project Brain rebuild',
  description: 'Cancel the active Project Brain parser run before commit. Existing committed index data stays available and source files are never modified.',
  input: { runId: z.string().min(1).max(128).optional() },
  output: BrainControlResult,
  requiredScope: 'dodo:exec',
  action: 'exec',
  annotations: control,
  handler: async (args, ctx) => {
    liveAccess(ctx, 'dodo:exec');
    policyGate(ctx, { tool: 'brain_cancel', action: 'exec', approvalAction: { runId: args.runId ?? null }, summary: 'cancel the active Project Brain rebuild' });
    const brain = use(ctx);
    const result = await brain.cancel(args.runId);
    return { data: { runId: args.runId ?? null, changed: result.changed, status: brain.status() } };
  },
});

export const BRAIN_TOOLS: AnyToolDef[] = [
  brainStatusTool,
  brainQueryTool,
  brainSymbolTool,
  brainRebuildTool,
  brainPauseTool,
  brainCancelTool,
];
