import { z } from 'zod';
import { defineTool } from './context.js';
import { DodoError } from '../errors.js';
import { TRUST_MODE_DESCRIPTIONS } from '../security/policy.js';
import { accessMode } from '../security/accessMode.js';

const looseData = z.looseObject({});
const projectIdInput = z.string().regex(/^prj_[0-9a-hjkmnp-tv-z]{8,64}$/).optional()
  .describe('Optional owner-registered project ID for read-only federation; omit to use the active workspace');

export const projectOverviewTool = defineTool({
  name: 'project_overview',
  title: 'Project overview',
  description:
    'Bootstrap tool: returns the active workspace root, workspaceId + workspaceEpoch (required by every other tool), trust policy, capabilities, detected manifests/languages, runnable task recipes, a shallow file tree, and a scoped git summary. It also lists owner-registered projects this client may read under the current personal/managed access mode. Pass projectId for a read-only federated overview without switching the active workspace. Never executes project code. Call this first.',
  input: { projectId: projectIdInput },
  output: looseData,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  requiredScope: 'dodo:read',
  action: 'read',
  noWorkspaceContext: true,
  handler: async (args, ctx) => {
    const s = ctx.services;
    if (args.projectId !== undefined) {
      return await s.federation.overview(args.projectId, ctx.principal, { workspaceId: s.workspaceId, workspaceEpoch: s.epoch });
    }
    const data = await s.overview.build({
      workspaceId: s.workspaceId,
      epoch: s.epoch,
      trustMode: ctx.trustMode,
      modeDescription: TRUST_MODE_DESCRIPTIONS[ctx.trustMode],
      projectConfig: s.projectConfig,
      searchBackend: s.search.rgAvailable() ? 'ripgrep' : 'js',
      semanticAvailable: s.intel.available().ok,
    });
    const warnings: string[] = [];
    if (data.projectConfigNote) warnings.push(data.projectConfigNote);
    let brain: Record<string, unknown>;
    try {
      brain = s.brain ? { available: true, ...s.brain.status() } : { available: false, status: 'unavailable' };
    } catch {
      brain = { available: false, status: 'recovery_required' };
      warnings.push('Project Brain status needs recovery; use brain_status or brain_rebuild after checking the active workspace.');
    }
    let contextEngine: Record<string, unknown>;
    try {
      const status = s.contextEngine?.status(ctx);
      contextEngine = status ? { available: true, ...status } : { available: false, status: 'unavailable' };
    } catch {
      contextEngine = { available: false, status: 'recovery_required' };
      warnings.push('Context Engine diagnostics need recovery; retry context_status after checking the active workspace.');
    }
    let memory: Record<string, unknown>;
    try {
      const status = s.memory?.status(ctx);
      memory = status ? { available: true, ...status } : { available: false, status: 'unavailable' };
    } catch {
      memory = { available: false, status: 'recovery_required' };
      warnings.push('Memory diagnostics need recovery; inspect owner state before creating new proposals.');
    }
    let runtime: Record<string, unknown>;
    try {
      runtime = s.runtime ? s.runtime.diagnostics(ctx) : { available: false, status: 'unavailable' };
    } catch {
      runtime = { available: false, status: 'recovery_required' };
      warnings.push('Runtime Intelligence diagnostics need recovery; retry after checking this workspace and client access.');
    }
    let agentRuntime: Record<string, unknown>;
    try {
      agentRuntime = s.agentRuntime ? s.agentRuntime.diagnostics(ctx) : { available: false, status: 'unavailable' };
    } catch {
      agentRuntime = { available: false, status: 'recovery_required' };
      warnings.push('Advanced Agent Runtime diagnostics need recovery; inspect this caller workspace state.');
    }
    const desktop = s.desktop.policy();
    const personal = accessMode(s.store) === 'personal';
    const desktopPlatform = process.platform === 'darwin' ? 'macOS 14+' : process.platform === 'win32' ? 'Windows interactive desktop' : process.platform === 'linux' ? 'Linux X11/XWayland session' : process.platform;
    const federation = s.federation.listAuthorized(ctx.principal);
    return {
      data: {
        ...data,
        brain,
        contextEngine,
        memory,
        runtime,
        agentRuntime,
        accessMode: personal ? 'personal' : 'managed',
        ai: { available: Boolean(s.installation), profiles: s.installation?.ai.availableProfiles(s.workspaceId,ctx.principal) ?? [], note: personal ? 'Enabled profiles are ready on every owner-registered project. Spawn still requires dodo:exec and every action keeps its live scope, context, path, secret and sandbox checks.' : 'Only currently authorized profiles are listed; spawn requires dodo:exec, project/provider permission and live action policy. Discover subagent_spawn for its schema.' },
        capabilities: { ...data.capabilities, desktop: { mode: desktop.mode, persistent: desktop.persistent, setupCommand: "dodo desktop setup", permissionCommand: "dodo desktop allow --app <app-id> --mode view|control --yes", rememberCommand: "dodo desktop allow --app <app-id> --mode view|control --persist --yes", platform: desktopPlatform, scope: "dodo:exec" }, android: { mode: ctx.services.android.policy().mode, persistent: ctx.services.android.policy().persistent, allowedDevices: ctx.services.android.policy().allowedDevices.length, setupCommand: "dodo android devices", permissionCommand: "dodo android allow --device <serial> --mode view|control --persist --yes", scope: "dodo:exec" } },
        federation: {
          mode: 'read-only',
          projects: federation.projects,
          maxProjectsPerSearch: 8,
          note: personal ? 'Owner-registered projects allowed by the live OAuth read scope are listed. Pass projectId for read federation; use targetProjectId plus its workspace context for writes or commands.' : 'Only owner-registered projects with live read ACL are listed. Pass projectId for read federation; use targetProjectId plus its workspace context for writes or commands.',
        },
      },
      warnings,
      truncated: data.treeTruncated || federation.truncated,
    };
  },
});

export const listFilesTool = defineTool({
  name: 'list_files',
  title: 'List files',
  description:
    'Bounded directory tree under a workspace-relative path ("." = root). Pass an owner-registered projectId for read-only federation without switching the active workspace. Depth and entry counts are capped; symlinks are never followed; ignored/secret paths are excluded (includeIgnored only re-adds ordinary ignores, never secrets).',
  input: {
    projectId: projectIdInput,
    path: z.string().max(1024).default('.'),
    depth: z.number().int().min(1).max(10).optional(),
    includeIgnored: z.boolean().default(false),
    maxEntries: z.number().int().min(1).max(2000).optional(),
  },
  output: looseData,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  requiredScope: 'dodo:read',
  action: 'read',
  handler: async (args, ctx) => {
    const opts: { depth?: number; includeIgnored?: boolean; maxEntries?: number } = { includeIgnored: args.includeIgnored };
    if (args.depth !== undefined) opts.depth = args.depth;
    if (args.maxEntries !== undefined) opts.maxEntries = args.maxEntries;
    if (args.projectId !== undefined) {
      const res = ctx.services.federation.listFiles(args.projectId, ctx.principal, args.path, opts);
      return { data: { tree: res.tree, entryCount: res.entryCount, project: res.project }, truncated: res.truncated };
    }
    const res = ctx.services.listService.tree(args.path, opts);
    return { data: { tree: res.root, entryCount: res.entryCount }, truncated: res.truncated };
  },
});

export const readFilesTool = defineTool({
  name: 'read_files',
  title: 'Read files',
  description:
    'Read up to 10 UTF-8 text files (workspace-relative paths), optionally by 1-based line range. Pass an owner-registered projectId for read-only federation without switching the active workspace. Returns content, exact line span, total lines, and the SHA-256 of the WHOLE file\'s raw bytes. A federated hash is evidence only: switch that project into the active workspace and re-read before editing. Binary or non-UTF-8 files return a typed error.',
  input: {
    projectId: projectIdInput,
    files: z
      .array(
        z
          .object({
            path: z.string().max(1024),
            startLine: z.number().int().min(1).optional(),
            endLine: z.number().int().min(1).optional(),
            numbered: z.boolean().optional().describe('prefix lines with their 1-based number (cat -n style)'),
          })
          .strict(),
      )
      .min(1)
      .max(10),
  },
  output: looseData,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  requiredScope: 'dodo:read',
  action: 'read',
  handler: async (args, ctx) => {
    if (args.projectId !== undefined) {
      const res = ctx.services.federation.readFiles(args.projectId, ctx.principal, args.files);
      return { data: { files: res.files, errors: res.errors, project: res.project }, truncated: res.truncated };
    }
    const res = ctx.services.readService.readBatch(args.files);
    return { data: { files: res.files, errors: res.errors }, truncated: res.truncated };
  },
});

export const searchCodeTool = defineTool({
  name: 'search_code',
  title: 'Search code',
  description:
    'Search file contents (grep). Pass projectId for one owner-registered project or projectIds for a bounded concurrent read across up to 8 authorized projects; this never switches the active workspace. mode "literal" (default) or "regex"; caseSensitive; fileGlob to restrict files; context lines; outputMode "content", "files", or "count". Uses ripgrep when installed, otherwise a bounded JS scan. A cursor is supported for one target only.',
  input: {
    projectId: projectIdInput,
    projectIds: z.array(z.string().regex(/^prj_[0-9a-hjkmnp-tv-z]{8,64}$/)).min(1).max(8).optional()
      .describe('Search up to 8 owner-registered projects concurrently; unavailable authorized projects are reported as partial failures'),
    query: z.string().min(1).max(512),
    mode: z.enum(['literal', 'regex']).default('literal'),
    caseSensitive: z.boolean().default(true),
    paths: z.array(z.string().max(1024)).max(20).optional(),
    fileGlob: z.string().min(1).max(256).optional(),
    includeIgnored: z.boolean().default(false),
    maxResults: z.number().int().min(1).max(100).default(50),
    contextLines: z.number().int().min(0).max(10).default(0),
    contextBefore: z.number().int().min(0).max(10).optional(),
    contextAfter: z.number().int().min(0).max(10).optional(),
    outputMode: z.enum(['content', 'files', 'count']).default('content'),
    cursor: z.string().max(256).optional(),
  },
  output: looseData,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  requiredScope: 'dodo:read',
  action: 'read',
  handler: async (args, ctx) => {
    if (args.projectId !== undefined && args.projectIds !== undefined) {
      throw new DodoError('INVALID_INPUT', 'use either projectId or projectIds, not both');
    }
    const q: Parameters<typeof ctx.services.search.search>[0] = {
      query: args.query,
      mode: args.mode,
      caseSensitive: args.caseSensitive,
      includeIgnored: args.includeIgnored,
      maxResults: args.maxResults,
      contextBefore: args.contextBefore ?? args.contextLines,
      contextAfter: args.contextAfter ?? args.contextLines,
      outputMode: args.outputMode,
    };
    if (args.paths !== undefined) q.paths = args.paths;
    if (args.fileGlob !== undefined) q.fileGlob = args.fileGlob;
    const federatedIds = args.projectIds ?? (args.projectId !== undefined ? [args.projectId] : undefined);
    if (federatedIds !== undefined) {
      const federated = await ctx.services.federation.searchMany(federatedIds, ctx.principal, q, args.cursor);
      if (args.projectIds === undefined && federated.results.length === 1) {
        const item = federated.results[0] as (typeof federated.results)[number];
        return {
          data: {
            matches: item.result.matches,
            files: item.result.files,
            totalMatches: item.result.totalMatches,
            backend: item.result.backend,
            filesScanned: item.result.filesScanned,
            project: item.project,
            sources: item.sources,
            failures: federated.failures,
          },
          truncated: federated.truncated,
          nextCursor: federated.nextCursor ?? null,
        };
      }
      return {
        data: {
          projects: federated.results.map((item) => ({
            project: item.project,
            matches: item.result.matches,
            files: item.result.files,
            totalMatches: item.result.totalMatches,
            backend: item.result.backend,
            filesScanned: item.result.filesScanned,
            sources: item.sources,
          })),
          failures: federated.failures,
          projectCount: federated.results.length,
          totalMatches: federated.results.reduce((sum, item) => sum + item.result.totalMatches, 0),
        },
        truncated: federated.truncated,
      };
    }
    const c: { principal: string; epoch: string; cursor?: string } = { principal: ctx.principal.grantId, epoch: ctx.services.epoch };
    if (args.cursor !== undefined) c.cursor = args.cursor;
    const res = await ctx.services.search.search(q, c);
    return {
      data: { matches: res.matches, files: res.files, totalMatches: res.totalMatches, backend: res.backend, filesScanned: res.filesScanned },
      truncated: res.truncated,
      nextCursor: res.nextCursor ?? null,
    };
  },
});

export function requireOneOf(cond: boolean, message: string): void {
  if (!cond) throw new DodoError('INVALID_INPUT', message);
}
