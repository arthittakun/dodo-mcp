import { z } from 'zod';
import { defineTool } from './context.js';
import { DodoError } from '../errors.js';
import type { SpanEditOp } from '../services/changes/types.js';
import type { ToolCtx } from './context.js';

const looseData = z.looseObject({});
const TS_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i;

/** Route a file to the built-in TypeScript provider or an owner-registered LSP. */
export function providerFor(ctx: ToolCtx, file: string): { kind: 'ts' } | { kind: 'lsp'; language: string } {
  const rel = ctx.services.wfs.normalizeRel(file);
  if (TS_EXT.test(rel)) return { kind: 'ts' };
  const language = ctx.services.lsp?.languageFor(rel);
  if (language) {
    const avail = ctx.services.lsp?.available(language);
    if (avail && !avail.ok) {
      throw new DodoError('UNSUPPORTED_LANGUAGE', `language server for ${language} is registered but unavailable: ${avail.reason ?? 'unknown'}`);
    }
    return { kind: 'lsp', language };
  }
  throw new DodoError('UNSUPPORTED_LANGUAGE', 'semantic tools cover TypeScript/JavaScript built-in; other languages need an owner-registered language server', {
    recovery: 'on the server machine: dodo lsp add <language> --command <server> --args ... --ext .py (see docs/LSP.md)',
  });
}

export const symbolsTool = defineTool({
  name: 'symbols',
  title: 'Symbols (TS/JS semantic)',
  description:
    'Semantic symbol declarations. TypeScript/JavaScript use the bundled language service; other languages use an owner-registered language server (dodo lsp add python/go/rust…). Provide either "file" (workspace-relative file → its declarations) or "query" (project-wide symbol search; set language for a non-TS server). Unregistered languages return UNSUPPORTED_LANGUAGE — this is a real semantic provider, not grep.',
  input: {
    file: z.string().max(1024).optional(),
    query: z.string().min(1).max(256).optional(),
    language: z.string().max(32).optional().describe('for query mode: a registered LSP language id (default: TypeScript/JavaScript)'),
    maxResults: z.number().int().min(1).max(500).default(100),
  },
  output: looseData,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  requiredScope: 'dodo:read',
  action: 'read',
  handler: async (args, ctx) => {
    if ((args.file === undefined) === (args.query === undefined)) {
      throw new DodoError('INVALID_INPUT', 'provide exactly one of "file" or "query"');
    }
    if (args.file !== undefined) {
      const p = providerFor(ctx, args.file);
      if (p.kind === 'lsp') {
        const r = await (ctx.services.lsp as NonNullable<typeof ctx.services.lsp>).symbolsInFile(args.file, args.maxResults);
        return { data: { symbols: r.symbols, provider: r.meta.server, language: r.meta.language }, warnings: r.meta.degraded ? [r.meta.degradedReason ?? 'degraded'] : [] };
      }
      const res = await ctx.services.intel.symbolsInFile(args.file, args.maxResults);
      const warnings: string[] = [];
      if (res.meta?.degraded) warnings.push(res.meta.degradedReason ?? 'semantic analysis is degraded (project size limits)');
      return { data: { symbols: res.symbols, projectFiles: res.meta?.projectFiles ?? 0, provider: 'typescript' }, warnings };
    }
    if (args.language !== undefined && !/^(typescript|javascript)$/i.test(args.language)) {
      if (!ctx.services.lsp) throw new DodoError('UNSUPPORTED_LANGUAGE', 'no language servers registered (dodo lsp add ...)');
      const r = await ctx.services.lsp.symbolsQuery(args.language, args.query as string, args.maxResults);
      return { data: { symbols: r.symbols, provider: r.meta.server, language: r.meta.language }, warnings: r.meta.degraded ? [r.meta.degradedReason ?? 'degraded'] : [] };
    }
    const res = await ctx.services.intel.symbolsQuery(args.query as string, args.maxResults);
    const warnings: string[] = [];
    if (res.meta?.degraded) warnings.push(res.meta.degradedReason ?? 'semantic analysis is degraded (project size limits)');
    return { data: { symbols: res.symbols, projectFiles: res.meta?.projectFiles ?? 0, provider: 'typescript' }, warnings };
  },
});

export const referencesTool = defineTool({
  name: 'references',
  title: 'References (TS/JS semantic)',
  description:
    'Actual semantic references (not text matches) for the symbol at file/line/column (1-based line; 1-based UTF-16 column, as returned by read_files/search_code). Includes definition flags and per-reference line text. References outside the workspace are counted but never disclosed.',
  input: {
    file: z.string().max(1024),
    line: z.number().int().min(1),
    column: z.number().int().min(1),
    maxResults: z.number().int().min(1).max(500).default(200),
  },
  output: looseData,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  requiredScope: 'dodo:read',
  action: 'read',
  handler: async (args, ctx) => {
    const p = providerFor(ctx, args.file);
    if (p.kind === 'lsp') {
      const r = await (ctx.services.lsp as NonNullable<typeof ctx.services.lsp>).references(args.file, { line: args.line, column: args.column }, args.maxResults);
      const w: string[] = [];
      if (r.outOfScopeCount > 0) w.push(`${r.outOfScopeCount} reference(s) are outside the workspace scope and were not listed`);
      if (r.meta.degraded) w.push(r.meta.degradedReason ?? 'degraded');
      return { data: { references: r.references, outOfScopeCount: r.outOfScopeCount, provider: r.meta.server, language: r.meta.language }, warnings: w };
    }
    const res = await ctx.services.intel.references(args.file, { line: args.line, column: args.column }, args.maxResults);
    const warnings: string[] = [];
    if (res.outOfScopeCount > 0) warnings.push(`${res.outOfScopeCount} reference(s) are outside the workspace scope and were not listed`);
    if (res.meta?.degraded) warnings.push(res.meta.degradedReason ?? 'semantic analysis is degraded');
    return { data: { references: res.references, outOfScopeCount: res.outOfScopeCount }, warnings };
  },
});

export const previewRenameTool = defineTool({
  name: 'preview_rename',
  title: 'Preview rename (TS/JS semantic)',
  description:
    'Build an immutable change plan that renames the symbol at file/line/column to newName using semantic rename locations (string/comment homonyms untouched). Nothing is applied — review the returned diffs, then call apply_changes with planId + planHash. Refused when the rename would need edits outside the workspace or inside dependencies.',
  input: {
    file: z.string().max(1024),
    line: z.number().int().min(1),
    column: z.number().int().min(1),
    newName: z.string().min(1).max(128),
  },
  output: looseData,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  requiredScope: 'dodo:write',
  action: 'plan',
  handler: async (args, ctx) => {
    const p = providerFor(ctx, args.file);
    const { result } =
      p.kind === 'lsp'
        ? await (ctx.services.lsp as NonNullable<typeof ctx.services.lsp>).rename(args.file, { line: args.line, column: args.column }, args.newName)
        : await ctx.services.intel.rename(args.file, { line: args.line, column: args.column }, args.newName);
    if (result.outOfScopeCount > 0) {
      throw new DodoError(
        'CONFLICT',
        `rename would change ${result.outOfScopeCount} location(s) outside the workspace scope (e.g. ${result.outOfScopeSample.join(', ')}); a partial rename would break the code, so it is refused`,
        { detail: { outOfScopeCount: result.outOfScopeCount } },
      );
    }
    if (result.locations.length === 0) {
      throw new DodoError('NOT_FOUND', 'no rename locations found');
    }
    const ops: SpanEditOp[] = result.locations.map((f) => ({
      op: 'span_edit',
      path: f.path,
      edits: f.edits.map((e) => ({ start: e.start, end: e.end, newText: e.newText })),
    }));
    const preview = ctx.services.planner.preview({
      ops,
      workspaceId: ctx.services.workspaceId,
      epoch: ctx.services.epoch,
      principal: ctx.principal.grantId,
      trustMode: ctx.trustMode,
      source: 'preview_rename',
    });
    return { data: { ...preview, symbolName: result.symbolName, renamedTo: args.newName } };
  },
});
