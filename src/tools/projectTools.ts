import { z } from 'zod';
import { defineTool } from './context.js';
import { DodoError } from '../errors.js';
import { TRUST_MODE_DESCRIPTIONS } from '../security/policy.js';

const looseData = z.looseObject({});

export const projectOverviewTool = defineTool({
  name: 'project_overview',
  title: 'Project overview',
  description:
    'Bootstrap tool: returns the workspace root, workspaceId + workspaceEpoch (required by every other tool), trust policy, capabilities, detected manifests/languages, runnable task recipes, a shallow file tree, and a scoped git summary. Read-only; never executes project code. Call this first.',
  input: {},
  output: looseData,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  requiredScope: 'dodo:read',
  action: 'read',
  noWorkspaceContext: true,
  handler: async (_args, ctx) => {
    const s = ctx.services;
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
    const desktop = s.desktop.policy();
    const desktopPlatform = process.platform === 'darwin' ? 'macOS 14+' : process.platform === 'win32' ? 'Windows interactive desktop' : process.platform === 'linux' ? 'Linux X11/XWayland session' : process.platform;
    return { data: { ...data, capabilities: { ...data.capabilities, desktop: { mode: desktop.mode, persistent: desktop.persistent, setupCommand: "dodo desktop setup", permissionCommand: "dodo desktop allow --app <app-id> --mode view|control --yes", rememberCommand: "dodo desktop allow --app <app-id> --mode view|control --persist --yes", platform: desktopPlatform, scope: "dodo:exec" } } }, warnings, truncated: data.treeTruncated };
  },
});

export const listFilesTool = defineTool({
  name: 'list_files',
  title: 'List files',
  description:
    'Bounded directory tree under a workspace-relative path ("." = root). Depth and entry counts are capped; symlinks are never followed; ignored/secret paths are excluded (includeIgnored only re-adds ordinary ignores, never secrets).',
  input: {
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
    const res = ctx.services.listService.tree(args.path, opts);
    return { data: { tree: res.root, entryCount: res.entryCount }, truncated: res.truncated };
  },
});

export const readFilesTool = defineTool({
  name: 'read_files',
  title: 'Read files',
  description:
    'Read up to 10 UTF-8 text files (workspace-relative paths), optionally by 1-based line range. Returns content, exact line span, total lines, and the SHA-256 of the WHOLE file\'s raw bytes — pass that hash to preview_changes as expectedHash. Binary or non-UTF-8 files return a typed error.',
  input: {
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
    const res = ctx.services.readService.readBatch(args.files);
    return { data: { files: res.files, errors: res.errors }, truncated: res.truncated };
  },
});

export const searchCodeTool = defineTool({
  name: 'search_code',
  title: 'Search code',
  description:
    'Search file contents (grep). mode "literal" (default) or "regex"; caseSensitive; fileGlob to restrict files (e.g. "*.ts", "src/**/*.py"); contextLines (or contextBefore/contextAfter) to include surrounding lines; outputMode "content" (matches with line/column), "files" (which files match + counts), or "count". Uses ripgrep when installed, otherwise a bounded JS scan (regex runs in a time-capped worker). Use nextCursor to continue a truncated content search.',
  input: {
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
