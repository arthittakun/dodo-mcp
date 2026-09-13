import { z } from 'zod';
import { DodoError, fromErrorInfo } from '../errors.js';
import { digestOf } from '../util/hash.js';
import type { McpServer } from '@modelcontextprotocol/server';
import type { OAuthScope, ActionClass } from '../security/policy.js';
import { TOOL_CATALOG } from './catalog.js';
import {
  defineTool,
  registerTool,
  invokeToolDefinition,
  toolInputShape,
  type AnyToolDef,
  type AppServices,
} from './context.js';
import { envelopeSchema } from './envelope.js';

/**
 * Compact MCP Tool Surface (ADR-029).
 *
 * Remote clients (ChatGPT connectors and similar) ingest EVERY tool schema at
 * connection time; the full catalog serializes to hundreds of KB. The
 * compact surface exposes the same capabilities through a small set of
 * domain gateways plus `dodo_discover`, while STDIO/local clients keep the
 * full per-tool catalog by default.
 *
 * A gateway NEVER grants anything: every dispatch routes through
 * `invokeToolDefinition`, the same pipeline a direct MCP call uses — live
 * principal, WORKSPACE_ACCESS_REQUIRED, the TARGET tool's required scope,
 * workspaceId/epoch context, byte budgets, the target's original strict Zod
 * input schema, trust-mode policy and local approvals inside the target
 * handler, idempotency, audit, and the target's own error codes. The target
 * tool definition stays the single authority for permissions.
 */

export type ToolSurface = 'compact' | 'full' | 'hybrid';

export type DiscoverDomain =
  | 'code'
  | 'exec'
  | 'git'
  | 'desktop'
  | 'media'
  | 'browser'
  | 'game'
  | 'workflow'
  | 'schedule'
  | 'web';

interface GatewaySpec {
  name: string;
  title: string;
  domain: DiscoverDomain;
  summary: string;
  operations: readonly string[];
}

/**
 * Operation allowlists. Every full-catalog tool except the shared
 * `project_overview` bootstrap is reachable through exactly one gateway;
 * gateways, owner controls and private state are NOT operations.
 */
const GATEWAY_SPECS: readonly GatewaySpec[] = [
  {
    name: 'dodo_read',
    title: 'Read workspace state',
    domain: 'code',
    summary: 'read-only workspace access: files, search, symbols, jobs, history and agent notes',
    operations: [
      'list_files',
      'read_files',
      'read_image',
      'read_instructions',
      'search_code',
      'glob_files',
      'symbols',
      'references',
      'diagnostics',
      'change_history',
      'approval_status',
      'environment_info',
      'todo_read',
      'handoff_read',
      'job_status',
      'job_output',
      'job_wait',
      'list_jobs',
    ],
  },
  {
    name: 'dodo_write',
    title: 'Change workspace files',
    domain: 'code',
    summary: 'hash-verified, journaled file changes: write/edit/patch, preview→apply→rollback, todos and handoff',
    operations: [
      'write_file',
      'edit_file',
      'apply_patch',
      'replace_in_files',
      'delete_path',
      'move_path',
      'make_directory',
      'preview_changes',
      'apply_changes',
      'rollback_changes',
      'preview_rename',
      'todo_write',
      'handoff_write',
    ],
  },
  {
    name: 'dodo_exec',
    title: 'Run commands and control jobs',
    domain: 'exec',
    summary: 'shell/argv commands, task recipes, and stdin/cancel for owned background jobs',
    operations: ['run_command', 'run_commands', 'run_task', 'exec_command', 'job_input', 'job_cancel'],
  },
  {
    name: 'dodo_git_read',
    title: 'Inspect git state',
    domain: 'git',
    summary: 'git status, diff and log for the workspace repository',
    operations: ['git_status', 'git_diff', 'git_log'],
  },
  {
    name: 'dodo_git_write',
    title: 'Commit to git',
    domain: 'git',
    summary: 'create a git commit from staged DODO changes (never pushes)',
    operations: ['git_commit'],
  },
  {
    name: 'dodo_desktop_view',
    title: 'View permitted desktop windows',
    domain: 'desktop',
    summary: 'status, window list, capture and accessibility text for owner-permitted apps only',
    operations: ['desktop_status', 'desktop_windows', 'desktop_capture', 'desktop_accessibility'],
  },
  {
    name: 'dodo_desktop_control',
    title: 'Act in a permitted desktop window',
    domain: 'desktop',
    summary: 'one bounded input action (focus/click/type/key/scroll/drag) in an owner-permitted window',
    operations: ['desktop_action'],
  },
  {
    name: 'dodo_assist_read',
    title: 'Coding-task analysis',
    domain: 'code',
    summary: 'task context, static impact analysis and single-symbol reads',
    operations: ['context_for_task', 'analyze_impact', 'read_symbol'],
  },
  {
    name: 'dodo_assist_change',
    title: 'Refactor previews and verification',
    domain: 'code',
    summary: 'preview-only symbol-body refactors and explicit verification plan/run/report',
    operations: ['preview_refactor', 'verify_changes'],
  },
  {
    name: 'dodo_media',
    title: 'Screen, image, media and speech',
    domain: 'media',
    summary: 'bounded screen/image views, local video/audio evidence, transcription, subtitles and local speech synthesis',
    operations: [
      'multimodal_status',
      'screen_observe',
      'image_view',
      'media_open',
      'media_extract',
      'media_transcribe',
      'media_subtitles',
      'media_search',
      'media_read',
      'media_job',
      'media_close',
      'speech_synthesize',
      'resource_inspect',
      'resource_read',
      'resource_read_range',
      'resource_preview',
      'resource_extract',
      'resource_transform',
    ],
  },
  {
    name: 'dodo_browser',
    title: 'Isolated browser',
    domain: 'browser',
    summary: 'open/observe/act in the isolated local Chromium session',
    operations: ['browser_session', 'browser_observe', 'browser_action'],
  },
  {
    name: 'dodo_game',
    title: 'Turn-based visual game',
    domain: 'game',
    summary: 'step-based visual game sessions with fresh observations per move',
    operations: ['game_session', 'game_step'],
  },
  {
    name: 'dodo_workflow_read',
    title: 'Find remembered procedures',
    domain: 'workflow',
    summary: 'search or read revisioned demonstration workflows',
    operations: ['workflow_search'],
  },
  {
    name: 'dodo_workflow_write',
    title: 'Save a demonstrated procedure',
    domain: 'workflow',
    summary: 'save or revise a demonstration workflow (never executes it)',
    operations: ['workflow_save'],
  },
  {
    name: 'dodo_workflow_run',
    title: 'Run a remembered procedure',
    domain: 'workflow',
    summary: 'apply a saved workflow one checked step at a time',
    operations: ['workflow_run'],
  },
  {
    name: 'dodo_schedule',
    title: 'Propose a scheduled command',
    domain: 'schedule',
    summary: 'propose an immutable scheduled command; the owner approves it locally before it ever runs',
    operations: ['schedule_propose'],
  },
  {
    name: 'dodo_web',
    title: 'Fetch a public URL',
    domain: 'web',
    summary: 'SSRF-guarded outbound HTTPS fetch (only when the owner enabled allowWebFetch)',
    operations: ['fetch_url'],
  },
] as const;

const SCOPE_RANK: Record<OAuthScope, number> = { 'dodo:read': 0, 'dodo:write': 1, 'dodo:exec': 2 };

const byName = new Map<string, AnyToolDef>(TOOL_CATALOG.map((d) => [d.name, d]));

function targetOf(operation: string): AnyToolDef {
  const def = byName.get(operation);
  /* istanbul ignore next -- construction invariant, validated at module load */
  if (!def) throw new Error(`compact surface references unknown operation ${operation}`);
  return def;
}

// ---- construction-time invariants (fail the build/tests, never runtime) ----
{
  const seen = new Set<string>();
  for (const spec of GATEWAY_SPECS) {
    for (const op of spec.operations) {
      if (op === 'project_overview' || op.startsWith('dodo_')) throw new Error(`gateway ${spec.name} must not expose ${op}`);
      if (seen.has(op)) throw new Error(`operation ${op} is exposed by two gateways`);
      if (!byName.has(op)) throw new Error(`gateway ${spec.name} references unknown tool ${op}`);
      seen.add(op);
    }
  }
  for (const def of TOOL_CATALOG) {
    if (def.name !== 'project_overview' && !seen.has(def.name)) {
      throw new Error(`full-catalog tool ${def.name} is not reachable from any compact gateway`);
    }
  }
}

/** operation → gateway lookup used by discover and tests. */
export const OPERATION_TO_GATEWAY: ReadonlyMap<string, string> = new Map(
  GATEWAY_SPECS.flatMap((spec) => spec.operations.map((op) => [op, spec.name] as const)),
);

const looseData = z.looseObject({});

function minScope(operations: readonly string[]): OAuthScope {
  let min: OAuthScope = 'dodo:exec';
  for (const op of operations) {
    const scope = targetOf(op).requiredScope;
    if (SCOPE_RANK[scope] < SCOPE_RANK[min]) min = scope;
  }
  return min;
}

function dominantAction(operations: readonly string[]): ActionClass {
  const actions = new Set(operations.map((op) => targetOf(op).action));
  if (actions.has('exec')) return 'exec';
  if (actions.has('mutate-files')) return 'mutate-files';
  if (actions.has('plan')) return 'plan';
  if (actions.has('job-control')) return 'job-control';
  return 'read';
}

function buildGateway(spec: GatewaySpec): AnyToolDef {
  const operations = [...spec.operations] as [string, ...string[]];
  const scope = minScope(spec.operations);
  const targets = spec.operations.map((op) => targetOf(op));
  return defineTool({
    name: spec.name,
    title: spec.title,
    description:
      `Gateway: ${spec.summary}. Set operation to one of: ${spec.operations.join(', ')}. ` +
      `Put that operation's own arguments in args (never workspaceId/workspaceEpoch — they come from the top level only). ` +
      `Identical authorization to calling the operation directly: its own OAuth scope, workspace access, trust policy, local approvals, path/secret guards, hash checks and audit all apply. ` +
      `Call dodo_discover with operation="<name>" for the exact input schema.`,
    input: {
      operation: z.enum(operations).describe('Target operation to invoke'),
      args: z
        .record(z.string(), z.unknown())
        .default({})
        .describe("The selected operation's own arguments, exactly as its schema defines (dodo_discover returns it). Never include workspaceId/workspaceEpoch here."),
    },
    output: looseData,
    annotations: {
      readOnlyHint: targets.every((t) => t.annotations.readOnlyHint === true),
      destructiveHint: targets.some((t) => t.annotations.destructiveHint === true),
      idempotentHint: false,
      openWorldHint: targets.some((t) => t.annotations.openWorldHint === true),
    },
    requiredScope: scope,
    action: dominantAction(spec.operations),
    handler: async (args, ctx) => {
      const target = targetOf(args.operation);
      const raw = (args.args ?? {}) as Record<string, unknown>;
      if ('workspaceId' in raw || 'workspaceEpoch' in raw) {
        throw new DodoError('INVALID_INPUT', 'args must not carry workspaceId/workspaceEpoch; the gateway takes them from its top-level fields', {
          recovery: 'remove workspaceId and workspaceEpoch from args; keep them only at the top level of the gateway call',
        });
      }
      const merged: Record<string, unknown> = target.noWorkspaceContext
        ? { ...raw }
        : { ...raw, workspaceId: (args as Record<string, unknown>)['workspaceId'], workspaceEpoch: (args as Record<string, unknown>)['workspaceEpoch'] };
      const { envelope, extraBlocks } = await invokeToolDefinition({
        def: target,
        services: ctx.services,
        principal: ctx.principal,
        args: merged,
      });
      if (!envelope.ok) throw fromErrorInfo(envelope.error as NonNullable<typeof envelope.error>);
      return {
        data: envelope.data,
        warnings: envelope.warnings,
        truncated: envelope.truncated,
        nextCursor: envelope.nextCursor,
        ...(extraBlocks.length > 0 ? { contentBlocks: extraBlocks } : {}),
      };
    },
  });
}

// --------------------------------------------------------------- discover --
const DISCOVER_DOMAINS = ['code', 'exec', 'git', 'desktop', 'media', 'browser', 'game', 'workflow', 'schedule', 'web'] as const;

interface OperationIndexEntry {
  operation: string;
  gateway: string;
  domain: DiscoverDomain;
  requiredScope: OAuthScope;
  action: ActionClass;
  description: string;
  haystack: string;
  order: number;
}

let operationIndex: OperationIndexEntry[] | undefined;
function index(): OperationIndexEntry[] {
  if (!operationIndex) {
    const order = new Map(TOOL_CATALOG.map((d, i) => [d.name, i]));
    operationIndex = GATEWAY_SPECS.flatMap((spec) =>
      spec.operations.map((op) => {
        const def = targetOf(op);
        return {
          operation: op,
          gateway: spec.name,
          domain: spec.domain,
          requiredScope: def.requiredScope,
          action: def.action,
          description: def.description.slice(0, 200),
          haystack: `${op} ${def.title} ${def.description}`.toLowerCase(),
          order: order.get(op) ?? 999,
        };
      }),
    ).sort((a, b) => a.order - b.order);
  }
  return operationIndex;
}

const schemaCache = new Map<string, { inputSchema: Record<string, unknown>; schemaHash: string }>();

/** Deterministic JSON Schema + hash for one tool's full registered input contract. */
export function operationSchema(def: AnyToolDef): { inputSchema: Record<string, unknown>; schemaHash: string } {
  let cached = schemaCache.get(def.name);
  if (!cached) {
    const inputSchema = z.toJSONSchema(z.object(toolInputShape(def) as z.ZodRawShape).strict(), { target: 'draft-2020-12' }) as Record<string, unknown>;
    cached = { inputSchema, schemaHash: digestOf(inputSchema) };
    schemaCache.set(def.name, cached);
  }
  return cached;
}

const argsSchemaCache = new Map<string, { argsSchema: Record<string, unknown>; schemaHash: string }>();

/**
 * Deterministic JSON Schema + hash for the operation's `args` payload as the
 * GATEWAY accepts it: the tool's own fields WITHOUT workspaceId/workspaceEpoch
 * (those travel at the gateway's top level and are rejected inside args).
 */
export function operationArgsSchema(def: AnyToolDef): { argsSchema: Record<string, unknown>; schemaHash: string } {
  let cached = argsSchemaCache.get(def.name);
  if (!cached) {
    const argsSchema = z.toJSONSchema(z.object(def.input as z.ZodRawShape).strict(), { target: 'draft-2020-12' }) as Record<string, unknown>;
    cached = { argsSchema, schemaHash: digestOf(argsSchema) };
    argsSchemaCache.set(def.name, cached);
  }
  return cached;
}

function usageNotes(def: AnyToolDef): string[] {
  const notes: string[] = [`requires the ${def.requiredScope} scope`];
  switch (def.action) {
    case 'mutate-files':
      notes.push('file mutation: journaled with backups; in inspect trust mode each call needs a local owner approval');
      break;
    case 'exec':
      notes.push('effectful: local trust policy applies (owner approval unless trusted mode) and runs with OS-user privileges unless sandboxed');
      break;
    case 'plan':
      notes.push('creates a preview/plan only; nothing is written until apply');
      break;
    default:
      break;
  }
  const shape = toolInputShape(def) as Record<string, unknown>;
  if ('idempotencyKey' in shape) {
    notes.push('supports idempotencyKey: reuse the SAME key when retrying the SAME arguments; never auto-repeat an uncertain effect with a fresh key');
  }
  if ('expectedHash' in shape) {
    notes.push('pass expectedHash from read_files so a concurrently changed file fails closed (FILE_CHANGED)');
  }
  return notes;
}

const discoverTool = defineTool({
  name: 'dodo_discover',
  title: 'Discover operations behind the compact gateways',
  description:
    'Find which gateway operation covers a capability. With query/domain it returns matching operations (name, gateway, scope, short description — no schemas). With operation="<name>" it returns that operation\'s full input JSON Schema, deterministic schemaHash, required scope, action class and usage notes. Discovery never grants permissions and never reveals tokens, grants or owner state.',
  input: {
    query: z.string().max(200).optional().describe('Free-text capability search, e.g. "edit a TypeScript file"'),
    domain: z.enum(DISCOVER_DOMAINS).optional().describe('Restrict matches to one capability domain'),
    operation: z.string().max(64).optional().describe('Exact operation name for full schema detail'),
    limit: z.number().int().min(1).max(25).default(8),
    cursor: z.string().max(32).optional().describe('nextCursor from a previous dodo_discover result'),
  },
  output: looseData,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  requiredScope: 'dodo:read',
  action: 'read',
  handler: async (args) => {
    if (args.operation !== undefined) {
      const entry = index().find((e) => e.operation === args.operation);
      if (!entry) {
        throw new DodoError('NOT_FOUND', `unknown operation ${args.operation}`, {
          recovery: 'call dodo_discover with a query (no operation) to list available operations',
        });
      }
      const def = targetOf(entry.operation);
      const { argsSchema, schemaHash } = operationArgsSchema(def);
      return {
        data: {
          operation: entry.operation,
          gateway: entry.gateway,
          domain: entry.domain,
          requiredScope: entry.requiredScope,
          action: entry.action,
          description: def.description,
          // The schema of the gateway's args payload for this operation.
          // workspaceId/workspaceEpoch are intentionally NOT part of it.
          inputSchema: argsSchema,
          schemaHash,
          callShape: {
            gateway: entry.gateway,
            example: { workspaceId: '<from project_overview>', workspaceEpoch: '<from project_overview>', operation: entry.operation, args: '<object matching inputSchema>' },
          },
          notes: [`pass workspaceId/workspaceEpoch at the TOP LEVEL of the ${entry.gateway} call, never inside args`, ...usageNotes(def)],
        },
      };
    }
    const tokens = (args.query ?? '')
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((t) => t.length > 1);
    let entries = index().filter((e) => args.domain === undefined || e.domain === args.domain);
    if (tokens.length > 0) {
      const scored = entries
        .map((e) => {
          let score = 0;
          for (const t of tokens) {
            if (e.operation.includes(t)) score += 3;
            if (e.haystack.includes(t)) score += 1;
          }
          return { e, score };
        })
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score || a.e.order - b.e.order);
      entries = scored.map((s) => s.e);
    }
    let offset = 0;
    if (args.cursor !== undefined) {
      const m = /^c(\d{1,6})$/.exec(args.cursor);
      if (!m) throw new DodoError('INVALID_INPUT', 'invalid cursor');
      offset = Number(m[1]);
    }
    const page = entries.slice(offset, offset + args.limit);
    const next = offset + args.limit < entries.length ? `c${offset + args.limit}` : null;
    return {
      data: {
        matches: page.map((e) => ({
          operation: e.operation,
          gateway: e.gateway,
          domain: e.domain,
          requiredScope: e.requiredScope,
          action: e.action,
          description: e.description,
        })),
        totalMatches: entries.length,
      },
      truncated: next !== null,
      nextCursor: next,
    };
  },
});

// ------------------------------------------------------ compact overview --
const fullOverview = targetOf('project_overview');

function overviewFor(surface: 'compact' | 'hybrid'): AnyToolDef {
  const hint =
    surface === 'compact'
      ? ' This connection uses the COMPACT tool surface: capabilities are invoked through dodo_* gateway tools; call dodo_discover to find an operation and its exact schema.'
      : ' This connection uses the HYBRID tool surface: common coding tools are available directly, and every other capability is invoked through the dodo_* gateway tools; call dodo_discover to find an operation and its exact schema.';
  return defineTool({
    ...fullOverview,
    description: fullOverview.description + hint,
    handler: async (args, ctx) => {
      const result = await fullOverview.handler(args, ctx);
      return {
        ...result,
        data: {
          ...(result.data as Record<string, unknown>),
          toolSurface: surface,
          // Public compact-surface field names are stable protocol contract.
          compactToolCount: COMPACT_CATALOG.length,
          fullToolCount: TOOL_CATALOG.length,
          ...(surface === 'hybrid' ? { hybridToolCount: HYBRID_CATALOG.length } : {}),
        },
      };
    },
  } as Parameters<typeof defineTool>[0]);
}

const GATEWAYS: AnyToolDef[] = GATEWAY_SPECS.map(buildGateway);

/** The compact catalog in a fixed, stable order (overview → discover → gateways). */
export const COMPACT_CATALOG: AnyToolDef[] = [overviewFor('compact'), discoverTool, ...GATEWAYS];

/**
 * Hybrid surface (ADR-029 addendum): for clients that cap the tool
 * count near ~50, the coverage core comes FIRST (overview, discover, all 17
 * gateways — identical to compact, so any client-side truncation can only
 * drop direct-tool duplicates, never capabilities), followed by the 30 most
 * used direct coding tools with their original names and schemas. 49 tools
 * total; permissions unchanged in every path.
 */
export const HYBRID_DIRECT_OPERATIONS: readonly string[] = [
  'list_files',
  'read_files',
  'read_instructions',
  'search_code',
  'glob_files',
  'write_file',
  'edit_file',
  'apply_patch',
  'replace_in_files',
  'delete_path',
  'move_path',
  'make_directory',
  'symbols',
  'references',
  'preview_changes',
  'apply_changes',
  'rollback_changes',
  'git_status',
  'git_diff',
  'git_log',
  'git_commit',
  'run_command',
  'run_commands',
  'run_task',
  'exec_command',
  'job_status',
  'job_output',
  'job_wait',
  'job_cancel',
  'list_jobs',
] as const;

export const HYBRID_CATALOG: AnyToolDef[] = [overviewFor('hybrid'), discoverTool, ...GATEWAYS, ...HYBRID_DIRECT_OPERATIONS.map(targetOf)];

{
  const names = new Set(HYBRID_CATALOG.map((d) => d.name));
  if (names.size !== HYBRID_CATALOG.length) throw new Error('hybrid surface has duplicate tool names');
  if (HYBRID_CATALOG.length > 49) throw new Error(`hybrid surface exceeds the 49-tool budget (${HYBRID_CATALOG.length})`);
  for (const op of HYBRID_DIRECT_OPERATIONS) {
    if (!OPERATION_TO_GATEWAY.has(op)) throw new Error(`hybrid direct tool ${op} is not gateway-covered`);
  }
}

// ------------------------------------------------------------- surface API --
export function surfaceCatalog(surface: ToolSurface): AnyToolDef[] {
  if (surface === 'compact') return COMPACT_CATALOG;
  if (surface === 'hybrid') return HYBRID_CATALOG;
  return TOOL_CATALOG;
}

export function registerSurface(server: McpServer, services: AppServices, surface: ToolSurface): void {
  for (const def of surfaceCatalog(surface)) registerTool(server, services, def);
}

const statsCache = new Map<ToolSurface, { toolCount: number; schemaBytes: number }>();

/**
 * Deterministic size evidence for one surface: tool count plus the UTF-8 byte
 * length of the serialized tools/list-equivalent payload — name, title,
 * description, annotations, input schema AND the envelope output schema of
 * every tool, matching what the MCP SDK serves a client at connection time.
 * Never includes request data or tokens.
 */
export function surfaceStats(surface: ToolSurface): { toolCount: number; schemaBytes: number } {
  let cached = statsCache.get(surface);
  if (!cached) {
    const tools = surfaceCatalog(surface).map((def) => ({
      name: def.name,
      title: def.title,
      description: def.description,
      annotations: def.annotations,
      inputSchema: operationSchema(def).inputSchema,
      outputSchema: z.toJSONSchema(envelopeSchema(def.output), { target: 'draft-2020-12' }),
    }));
    cached = { toolCount: tools.length, schemaBytes: Buffer.byteLength(JSON.stringify(tools), 'utf8') };
    statsCache.set(surface, cached);
  }
  return cached;
}

/** Gateway specs exported for schema emission and tests (names + allowlists only). */
export const GATEWAY_OPERATIONS: ReadonlyArray<{ name: string; domain: DiscoverDomain; operations: readonly string[] }> = GATEWAY_SPECS.map(
  (s) => ({ name: s.name, domain: s.domain, operations: s.operations }),
);
