import type { InstallationRuntime } from '../server/installationRuntime.js';
import type { MutationQueue } from '../security/mutationQueue.js';
import { isOwner, projectAuthority } from '../security/projectAuthority.js';
import { accessMode } from '../security/accessMode.js';
import type { MultimodalService } from '../services/multimodal/multimodalService.js';
import type { ResourceService } from '../services/resources/resourceService.js';
import type { FederationService } from '../projects/federation.js';
import type { ProjectBrainService } from '../services/brain/brainService.js';
import type { ContextEngineService } from '../services/context/contextEngine.js';
import type { MemoryService } from '../services/memory/memoryService.js';
import type { RuntimeService } from '../services/runtime/runtimeService.js';
import type { AgentRuntimeService } from '../services/agent/agentService.js';
import type { ScheduleService } from '../services/schedules/scheduleService.js';
import type { RecoveryService } from '../services/recovery/recoveryService.js';
import { z } from 'zod';
import type { DesktopService } from '../services/desktop/desktopService.js';
import type { AndroidService } from '../services/android/androidService.js';
import type { McpServer, ServerContext, CallToolResult, ToolAnnotations } from '@modelcontextprotocol/server';
import { DodoError, toDodoError } from '../errors.js';
import type { GlobalConfig } from '../config/globalConfig.js';
import type { Limits } from '../config/limits.js';
import type { Store, TrustMode } from '../store/store.js';
import type { WorkspaceFS } from '../workspace/fs.js';
import type { ProjectConfigResult } from '../config/projectConfig.js';
import type { ReadService, ListService } from '../services/files/readService.js';
import type { SearchService } from '../services/search/searchService.js';
import type { Planner } from '../services/changes/planner.js';
import type { Applier } from '../services/changes/applier.js';
import type { JobManager } from '../services/jobs/jobManager.js';
import type { GitService } from '../services/git/gitService.js';
import type { IntelService } from '../services/intelligence/intelService.js';
import type { OverviewService } from '../services/overview.js';
import type { SymbolInfo, ReferenceInfo, RenameResultData, DiagnosticInfo, Position } from '../services/intelligence/protocol.js';
import { decide, scopeSatisfied, type ActionClass, type OAuthScope } from '../security/policy.js';
import { okEnvelope, errorEnvelope, envelopeSchema, envelopeText, type Envelope } from './envelope.js';
import { digestOf } from '../util/hash.js';
import { requireLocalApproval } from '../security/approvals.js';

export interface Principal {
  grantId: string;
  clientId: string;
  sub: string;
  scopes: string[];
  /** Verified token ceiling; never caller-supplied. */
  tokenScopes?: string[];
  projectRestriction?: string;
  identityGrant?: boolean;
  expiresAt?: number;
}

export interface AppServices {
  installation?: InstallationRuntime;
  mutations?: MutationQueue;
  recovery?: RecoveryService;
  federation: FederationService;
  /** Durable, incrementally refreshed project structure index. */
  brain?: ProjectBrainService;
  /** Goal-driven, source-verifying retrieval and evidence cache. */
  contextEngine?: ContextEngineService;
  /** Owner-reviewed, evidence-backed durable memory and learning proposals. */
  memory?: MemoryService;
  /** Durable, caller-scoped runtime sessions and source-verifiable evidence. */
  runtime?: RuntimeService;
  /** Durable capability-narrowing plans, hypotheses, intents, snapshots and reviewed skills. */
  agentRuntime?: AgentRuntimeService;
  multimodal?: MultimodalService;
  /** Installation CAS with workspace/principal-scoped references. */
  resources?: ResourceService;
  schedules: ScheduleService;
  version: string;
  config: GlobalConfig;
  limits: Limits;
  store: Store;
  wfs: WorkspaceFS;
  readService: ReadService;
  listService: ListService;
  search: SearchService;
  planner: Planner;
  applier: Applier;
  jobs: JobManager;
  git: GitService;
  intel: IntelService;
  overview: OverviewService;
  desktop: DesktopService;
  android: AndroidService;
  projectConfig: ProjectConfigResult;
  workspaceId: string;
  epoch: string;
  trustMode: () => TrustMode;
  beginTool?: () => () => void;
  /**
   * Set ONLY by the stdio entry (`dodo stdio`): the local client process is
   * the principal. Never set for the HTTP server, so HTTP requests without a
   * verified bearer token can never inherit it.
   */
  localPrincipal?: Principal;
  /** Owner-installed language servers for non-TS languages (optional capability). */
  lsp?: LspProvider;
}

/** Structural contract for the LSP adapter (src/services/lsp) so tools stay decoupled from it. */
export interface LspProvider {
  languageFor(rel: string): string | undefined;
  available(language: string): { ok: boolean; reason?: string };
  symbolsInFile(rel: string, maxItems: number): Promise<{ symbols: SymbolInfo[]; meta: { language: string; server: string; degraded: boolean; degradedReason?: string } }>;
  symbolsQuery(language: string, query: string, maxItems: number): Promise<{ symbols: SymbolInfo[]; meta: { language: string; server: string; degraded: boolean; degradedReason?: string } }>;
  references(rel: string, position: Position, maxItems: number): Promise<{ references: ReferenceInfo[]; outOfScopeCount: number; meta: { language: string; server: string; degraded: boolean; degradedReason?: string } }>;
  rename(rel: string, position: Position, newName: string): Promise<{ result: RenameResultData; meta: { language: string; server: string; degraded: boolean; degradedReason?: string } }>;
  diagnostics(rels: string[], maxItems: number): Promise<{ diagnostics: DiagnosticInfo[]; meta: { language: string; server: string; degraded: boolean; degradedReason?: string } }>;
  shutdown(): Promise<void>;
}

export interface ToolCtx {
  services: AppServices;
  principal: Principal;
  trustMode: TrustMode;
  /** Backend-only live authorization callback for multi-step operations. */
  revalidate?: () => void;
}

export type ExtraContentBlock = { type: 'image'; data: string; mimeType: string } | { type: 'audio'; data: string; mimeType: string };

export interface HandlerResult {
  data: unknown;
  warnings?: string[];
  truncated?: boolean;
  nextCursor?: string | null;
  /** Extra MCP content blocks (e.g. an image) appended after the text fallback. */
  contentBlocks?: ExtraContentBlock[];
}

export interface ToolDef<In extends z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  /** Tool-specific input fields (workspace context fields are added automatically). */
  input: In;
  /** Schema for envelope.data. */
  output: z.ZodType;
  annotations: ToolAnnotations;
  requiredScope: OAuthScope;
  action: ActionClass;
  /** Set for the bootstrap tool that does not take workspace context. */
  noWorkspaceContext?: boolean;
  handler: (args: z.infer<z.ZodObject<In>>, ctx: ToolCtx) => Promise<HandlerResult>;
}

const TARGET_PROJECT = {
  targetProjectId: z.string().regex(/^prj_[0-9a-hjkmnp-tv-z]{8,64}$/).optional().describe("Explicit owner-registered target; use its project_overview context"),
  /**
   * The owner-facing project name. Owners say "แก้โปรเจกต์ auto-upload", not a
   * `prj_…` id, so a name is accepted anywhere the id is. It resolves to
   * exactly one registered project the caller may see, or fails — it never
   * guesses between same-named projects.
   */
  targetProject: z.string().min(1).max(120).optional().describe('Owner-registered project NAME to target (alternative to targetProjectId; must match exactly one project)'),
};
const WORKSPACE_CONTEXT_FIELDS = {
  workspaceId: z.string().min(1).max(128).describe('Workspace id from project_overview'),
  workspaceEpoch: z.string().min(1).max(128).describe('Workspace epoch from project_overview (changes on server restart or workspace switch)'),
};

/** The catalog is assembled once and registered in a stable, fixed order (spec §7). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToolDef = ToolDef<any>;

/** Identity helper preserving input-shape inference at the definition site. */
export function defineTool<In extends z.ZodRawShape>(def: ToolDef<In>): AnyToolDef {
  return def as AnyToolDef;
}

export function toolInputShape(def: AnyToolDef): z.ZodRawShape {
  return { recoverySessionId: z.string().min(1).max(128).optional().describe('Explicit caller-owned recovery session for this operation; never an authorization grant'), ...TARGET_PROJECT, ...(def.noWorkspaceContext ? {} : WORKSPACE_CONTEXT_FIELDS), ...def.input };
}

/**
 * The single tool-invocation pipeline (spec §7/§9): principal → workspace
 * access → required scope → workspace/epoch context → input byte budget →
 * input schema (when the transport has not already validated) → handler →
 * envelope → audit. BOTH the direct MCP registration below and the compact
 * gateway route through this function, so a gateway call can never skip a
 * check a direct call would have made.
 */
export interface InvokeToolOptions {
  def: AnyToolDef;
  services: AppServices;
  /** A resolved principal (gateway) or a resolver that may throw (transport). */
  principal: Principal | (() => Principal);
  args: Record<string, unknown>;
  /** True only when the MCP SDK already validated args against this tool's input schema. */
  validated?: boolean;
  signal?: AbortSignal;
}

export interface InvokeToolResult {
  envelope: Envelope;
  extraBlocks: ExtraContentBlock[];
}

/**
 * Fields that choose WHICH workspace/project a call runs against. They are only
 * ever read from the top level. A nested `args` object carrying one is an
 * attempt to re-route a call past the checks its gateway already performed, so
 * every dispatcher rejects them through this one list.
 */
export const ROUTING_CONTEXT_KEYS = ['workspaceId', 'workspaceEpoch', 'targetProjectId', 'targetProject', 'recoverySessionId'] as const;

export function assertNoNestedRoutingContext(raw: Record<string, unknown>, what = 'args'): void {
  const found = ROUTING_CONTEXT_KEYS.filter((key) => key in raw);
  if (found.length === 0) return;
  throw new DodoError('INVALID_INPUT', `${what} must not carry ${found.join('/')}; the caller takes routing and workspace context from its top-level fields`, {
    recovery: `remove ${found.join(' and ')} from ${what}; keep them only at the top level of the call`,
  });
}

/** True when a call explicitly routes to another registered project. */
export function hasExplicitProjectTarget(args: Record<string, unknown> | undefined): boolean {
  return typeof args?.['targetProjectId'] === 'string' || typeof args?.['targetProject'] === 'string';
}

/**
 * Resolve the explicit project target of a call to a single project id.
 *
 * Accepts `targetProjectId` (stable id) and/or `targetProject` (the owner-facing
 * NAME). Resolution is deterministic and fail-closed:
 *  - a name matches case-insensitively after trimming, against ONLY the projects
 *    this principal may already read, so it can never confirm the existence of a
 *    project the caller is not allowed to see;
 *  - two projects sharing a name is an error listing the visible candidates,
 *    never a guess — picking wrong would route an edit into another repository;
 *  - supplying both an id and a name that disagree is an error.
 */
function resolveTargetProject(args: Record<string, unknown>, services: AppServices, principal: Principal): string | undefined {
  const byId = args['targetProjectId'];
  const byName = args['targetProject'];
  if (byName === undefined) return byId as string | undefined;
  if (typeof byName !== 'string' || byName.trim().length === 0) throw new DodoError('INVALID_INPUT', 'targetProject must be a non-empty project name');
  if (!services.installation) throw new DodoError('NOT_SUPPORTED', 'explicit project routing is unavailable');
  const wanted = byName.trim().toLowerCase();
  const visible = services.installation.list(principal);
  const matches = visible.filter((p) => p.displayName.trim().toLowerCase() === wanted);
  if (matches.length === 0) {
    throw new DodoError('NOT_FOUND', `no registered project named "${byName.trim()}" is available to this client`, {
      recovery: 'call project_overview to list the projects this client may use, then use the exact name or its targetProjectId',
    });
  }
  if (matches.length > 1) {
    throw new DodoError('CONFLICT', `"${byName.trim()}" matches ${matches.length} registered projects`, {
      recovery: 'rename the projects in Local Config so each name is unique, or pass the exact targetProjectId',
      detail: { candidates: matches.map((p) => ({ projectId: p.projectId, displayName: p.displayName })) },
    });
  }
  const resolved = matches[0]!.projectId;
  if (byId !== undefined && byId !== resolved) {
    throw new DodoError('INVALID_INPUT', 'targetProjectId and targetProject refer to different projects', {
      recovery: 'send only one of them',
    });
  }
  return resolved;
}

export async function invokeToolDefinition(opts: InvokeToolOptions): Promise<InvokeToolResult> {
  const { def } = opts;
  let services = opts.services;
  let targetRelease: (() => void) | undefined;
  const started = Date.now();
  let ws = { workspaceId: services.workspaceId, epoch: services.epoch };
  let envelope: Envelope;
  let principal: Principal | undefined;
  let workspaceAccess = false;
  let extraBlocks: ExtraContentBlock[] = [];
  try {
    principal = typeof opts.principal === 'function' ? opts.principal() : opts.principal;
    // A name is resolved to an id BEFORE any routing happens, so everything
    // downstream (lease acquisition, authority, audit) sees one canonical id.
    const targetId = resolveTargetProject(opts.args, services, principal);
    if (targetId !== undefined) {
      if (typeof targetId !== 'string' || 'projectId' in opts.args || 'projectIds' in opts.args || (opts.args['args'] && typeof opts.args['args'] === 'object' && ('projectId' in opts.args['args'] || 'projectIds' in opts.args['args']))) throw new DodoError('INVALID_INPUT', 'ambiguous project routing');
      if (!services.installation) throw new DodoError('NOT_SUPPORTED', 'explicit project routing is unavailable');
      const lease = await services.installation.acquire(targetId, principal);
      services = lease.services; targetRelease = lease.release;
      ws = { workspaceId: services.workspaceId, epoch: services.epoch };
      principal = projectAuthority(services.store, principal, services.workspaceId);
    } else if (principal.tokenScopes) principal = projectAuthority(services.store, principal, services.workspaceId);
    if (!principal.scopes.includes('dodo:read') && def.name === 'project_overview' && targetId === undefined && services.installation) {
      const projects = services.installation.list(principal);
      if (projects.length) {
        services.store.audit({principal:principal.grantId,workspaceId:services.workspaceId,tool:def.name,result:'ok',inputDigest:digestOf(opts.args).slice(0,24)});
        return { envelope: { ...okEnvelope(ws, { selectProjectRequired: true, projects }), workspaceId: null, workspaceEpoch: null }, extraBlocks: [] };
      }
    }
    if (principal.scopes.length === 0) {
      // Personal mode never asks the owner to assign a per-workspace ACL; an
      // empty scope set there means the OAuth grant itself carries no usable
      // scope for this project, or the project's access level removed them.
      throw new DodoError('WORKSPACE_ACCESS_REQUIRED', accessMode(services.store) === 'personal'
        ? 'This client has no usable scope for this project. Check the project access level in Local Config > Projects, or reconnect the client with the scopes you need; OAuth login is retained'
        : 'Owner must allow this client for the active workspace in private Local Config; OAuth login is retained');
    }
    if (!scopeSatisfied(def.requiredScope, principal.scopes)) {
      throw new DodoError('FORBIDDEN', `this tool requires the ${def.requiredScope} scope`, {
        detail: { requiredScope: def.requiredScope },
      });
    }
    workspaceAccess = true;
    if (!def.noWorkspaceContext) {
      const wsArg = opts.args['workspaceId'];
      const epochArg = opts.args['workspaceEpoch'];
      if (wsArg !== services.workspaceId) {
        throw new DodoError('WORKSPACE_MISMATCH', 'workspaceId does not match this server instance; call project_overview', {
          recovery: 'call project_overview and use the returned workspaceId/workspaceEpoch',
        });
      }
      if (epochArg !== services.epoch) {
        throw new DodoError('STALE_WORKSPACE', 'the server restarted or switched workspace since this workspaceEpoch; call project_overview again', {
          recovery: 'call project_overview and use the fresh workspaceEpoch',
        });
      }
    }
    // Shared application budget, including STDIO. HTTP and STDIO also
    // bound their raw message buffers before JSON/schema processing.
    const inputBytes = Buffer.byteLength(JSON.stringify(opts.args), 'utf8');
    if (inputBytes > services.limits.requestBodyBytes) {
      throw new DodoError('RESOURCE_LIMIT', `tool arguments exceed ${services.limits.requestBodyBytes} UTF-8 JSON bytes`, {
        recovery: 'Split this call into smaller file edits. Use write_file/edit_file for source code; check dodo limits for owner-configured budgets.',
      });
    }
    const args = opts.validated === true ? opts.args : parseToolInput(def, opts.args);
    const execute = async () => {
      if (typeof opts.principal === 'function') principal = opts.principal();
      if (principal!.tokenScopes) principal = projectAuthority(services.store, principal!, services.workspaceId);
      if (!scopeSatisfied(def.requiredScope, principal!.scopes)) throw new DodoError('FORBIDDEN', 'target permission changed while queued');
      if (def.name.startsWith('job_') && typeof args['jobId'] === 'string' && !isOwner(principal!)) {
        const job = services.jobs.getJobChecked(args['jobId'],services.workspaceId);
        if (job.principal !== principal!.grantId) throw new DodoError('FORBIDDEN','job belongs to another caller');
      }
      const trustAtStart = services.trustMode();
      const revalidate = () => {
        if (typeof opts.principal === 'function') principal = opts.principal();
        if (principal!.tokenScopes) principal = projectAuthority(services.store, principal!, services.workspaceId);
        if (!scopeSatisfied(def.requiredScope, principal!.scopes) || services.trustMode() !== trustAtStart) throw new DodoError('FORBIDDEN', 'authority changed during source backup');
      };
      const runHandler = async () => {
        const result=await def.handler(args as never, { services, principal: principal!, trustMode: trustAtStart, revalidate });
        const data=result.data as {verificationId?:unknown}|null;
        if(def.name==='verify_changes'&&typeof data?.verificationId==='string')services.recovery?.history.record('verification',data.verificationId);
        return result;
      };
      const track = !def.name.startsWith('dodo_') && !def.name.startsWith('recovery_') && !def.name.startsWith('checkpoint_') && !def.name.startsWith('restore_') && (def.action === 'mutate-files' || def.action === 'exec');
      const handle = () => services.recovery && track ? services.recovery.history.around(principal!.grantId, args['recoverySessionId'] as string|undefined, runHandler) : runHandler();
      const result=await (services.recovery ? services.recovery.withAuthority(revalidate, handle) : handle());
      revalidate();
      return result;
    };
    const control = ['job_input', 'job_cancel', 'subagent_spawn', 'subagent_control'].includes(def.name);
    const gateway = def.name.startsWith('dodo_');
    const result = services.mutations && !gateway && !control && (def.action === 'mutate-files' || def.action === 'exec')
      ? await services.mutations.run(execute,opts.signal) : await execute();
    if (!def.output.safeParse(result.data).success) throw new DodoError('INTERNAL_ERROR','target returned an invalid output; review its receipt before retrying');
    extraBlocks = result.contentBlocks ?? [];
    envelope = okEnvelope(ws, result.data, {
      warnings: result.warnings ?? [],
      truncated: result.truncated ?? false,
      nextCursor: result.nextCursor ?? null,
    });
  } catch (err) {
    const je = toDodoError(err);
    envelope = errorEnvelope(workspaceAccess ? ws : null, je.toInfo());
  }
  // The audit row must never turn into a raw (unscrubbed) remote error and a
  // hostile input must never be able to suppress it: digest defensively
  // (deeply nested gateway args could overflow the recursive canonicalizer),
  // and surface an audit-write failure as a typed INTERNAL_ERROR envelope
  // instead of letting the call pass un-audited.
  let inputDigest: string;
  try {
    inputDigest = digestOf(opts.args).slice(0, 24);
  } catch {
    inputDigest = 'undigestable';
  }
  try {
    services.store.audit({
      principal: principal?.grantId ?? 'unknown',
      workspaceId: services.workspaceId,
      tool: def.name,
      inputDigest,
      durationMs: Date.now() - started,
      result: envelope.ok ? 'ok' : (envelope.error?.code ?? 'error'),
    });
  } catch {
    envelope = errorEnvelope(workspaceAccess ? ws : null, new DodoError('INTERNAL_ERROR', 'audit write failed; the call result was discarded', { retryable: true }).toInfo());
    extraBlocks = [];
  }
  targetRelease?.();
  return { envelope, extraBlocks };
}

/** Validate raw (gateway-supplied) args against the target's ORIGINAL Zod schema. */
function parseToolInput(def: AnyToolDef, raw: Record<string, unknown>): Record<string, unknown> {
  const schema = z.object(toolInputShape(def) as z.ZodRawShape).strict();
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new DodoError('INVALID_INPUT', `invalid arguments for ${def.name}: ${issues}`.slice(0, 600), {
      recovery: `call dodo_discover with operation="${def.name}" for the exact input schema`,
    });
  }
  return parsed.data as Record<string, unknown>;
}

export function registerTool(server: McpServer, services: AppServices, def: AnyToolDef): void {
  const inputShape = toolInputShape(def);
  const inputSchema = z.object(inputShape as z.ZodRawShape).strict();
  const outputSchema = envelopeSchema(def.output);

  server.registerTool(
    def.name,
    {
      title: def.title,
      description: def.description,
      inputSchema,
      outputSchema,
      annotations: def.annotations,
    },
    async (args: Record<string, unknown>, ctx: ServerContext): Promise<CallToolResult> => {
      // A beginTool refusal (workspace switching mid-request) must still honor
      // the envelope contract instead of surfacing as a raw SDK text error.
      let release: (() => void) | undefined;
      try {
        if (!hasExplicitProjectTarget(args as Record<string, unknown>)) release = services.beginTool?.();
      } catch (err) {
        const envelope = errorEnvelope(null, toDodoError(err).toInfo());
        return {
          content: [{ type: 'text', text: envelopeText(envelope, services.limits.toolContentBytes) }],
          structuredContent: envelope as unknown as Record<string, unknown>,
          isError: true,
        };
      }
      try {
        const { envelope, extraBlocks } = await invokeToolDefinition({
          def,
          services,
          principal: () => principalFrom(ctx, services.localPrincipal),
          args,
          validated: true,
        });
        const text = envelopeText(envelope, services.limits.toolContentBytes);
        const res: CallToolResult = {
          content: [{ type: 'text', text }, ...extraBlocks],
          structuredContent: envelope as unknown as Record<string, unknown>,
        };
        if (!envelope.ok) res.isError = true;
        return res;
      } finally { release?.(); }
    },
  );
}

function principalFrom(ctx: ServerContext, localPrincipal: Principal | undefined): Principal {
  const auth = ctx.http?.authInfo;
  if (!auth && localPrincipal) return { ...localPrincipal, scopes: [...localPrincipal.scopes] };
  const extra = (auth?.extra ?? {}) as Record<string, unknown>;
  const grantId = typeof extra['grantId'] === 'string' ? (extra['grantId'] as string) : undefined;
  if (!auth || !grantId) {
    // Defense in depth: transport-level auth should have refused already.
    throw new DodoError('AUTH_REQUIRED', 'no authenticated principal');
  }
  return {
    grantId,
    clientId: auth.clientId,
    sub: typeof extra['sub'] === 'string' ? (extra['sub'] as string) : 'owner',
    scopes: auth.scopes,
    ...(Array.isArray(extra['tokenScopes']) ? { tokenScopes: extra['tokenScopes'] as string[] } : {}),
    identityGrant: extra['identityGrant'] === true,
    ...(auth.expiresAt !== undefined ? { expiresAt: auth.expiresAt } : {}),
  };
}

/** Gate used by mutating tool handlers: local trust-mode policy + approvals. */
export function policyGate(
  ctx: ToolCtx,
  opts: { tool: string; action: ActionClass; approvalAction: Record<string, unknown>; summary: string },
): void {
  const decision = decide(opts.action, ctx.trustMode);
  if (decision === 'allow') return;
  // Throws APPROVAL_REQUIRED unless an approved matching approval is consumed.
  requireLocalApproval(ctx.services.store, {
    workspaceId: ctx.services.workspaceId,
    epoch: ctx.services.epoch,
    principal: ctx.principal.grantId,
    tool: opts.tool,
    action: opts.approvalAction,
    summary: opts.summary,
    ttlMs: ctx.services.limits.approvalExpiryMs,
  });
}
