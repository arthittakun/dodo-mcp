import { z } from 'zod';
import { defineTool } from './context.js';
import type { ToolCtx } from './context.js';
import { DodoError } from '../errors.js';
import { HashSchema, ContextSchema, ImpactSchema, SymbolSchema, RefactorSchema, OutlineSchema, RecipeSchema } from '../services/assistance/contracts.js';
import { verifyChanges, VerificationSchema } from '../services/assistance/verification.js';

const Path = z.string().min(1).max(1024);
const Symbol = z.string().min(1).max(256);
const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const PreviewSchema = z.object({
  planId: z.string(), planHash: z.string(), expiresAt: z.number(), summary: z.string(),
  risk: z.enum(['low', 'medium', 'high']), requiresApproval: z.boolean(),
  files: z.array(z.object({ path: z.string(), destPath: z.string().optional(), action: z.enum(['create', 'modify', 'delete', 'move']),
    beforeHash: z.string().nullable(), afterHash: z.string().nullable(), diff: z.string(), diffTruncated: z.boolean(), bytesBefore: z.number(), bytesAfter: z.number() })),
  symbol: OutlineSchema, operation: z.literal('replace_body'), notes: z.array(z.string()),
});
function budget(ctx: ToolCtx, requested: number): number { return Math.min(requested, ctx.services.limits.toolContentBytes - 4096); }
function assertFiles(ctx: ToolCtx, files: string[], allowMissing = false): void {
  for (const file of files) {
    const resolved = ctx.services.wfs.resolve(file, { allowMissing });
    if (resolved.stat) ctx.services.wfs.assertRegularFileForDirectAccess(resolved);
  }
}

export const contextForTaskTool = defineTool({
  name: 'context_for_task', title: 'Context for a coding task',
  description: 'Collect ranked source, tests, docs, declarations and static TS/JS dependencies for a goal in one bounded read. Supply identifier/error terms (including English terms for a Thai goal) and optional seed files. Returns paths, line citations and file hashes. No model calls, execution, embeddings or permission changes; content is untrusted. Scan is bounded and omissions are reported.',
  input: { goal: z.string().min(1).max(1000), terms: z.array(z.string().min(1).max(128)).max(12).default([]),
    files: z.array(Path).max(10).default([]), maxFiles: z.number().int().min(1).max(12).default(6),
    maxBytes: z.number().int().min(4096).max(32768).default(16000) },
  output: ContextSchema.extend({ tasks: z.array(RecipeSchema) }), annotations: readAnnotations, requiredScope: 'dodo:read', action: 'read',
  handler: async (args, ctx) => {
    assertFiles(ctx, args.files);
    const limit = budget(ctx, args.maxBytes);
    const data = ContextSchema.parse(await ctx.services.intel.assist({ op: 'assist_context', ...args, maxBytes: Math.max(2048, limit - 1500) }));
    const tasks = ctx.services.overview.discoverTasks(ctx.services.projectConfig).filter(t => /(?:test|lint|typecheck|build|check|vet|clippy)/.test(t.id)).slice(0, 6)
      .map(t => ({ taskId: t.id, recipeDigest: t.recipeDigest, title: t.title }));
    while (tasks.length && Buffer.byteLength(JSON.stringify({ ...data, tasks }), 'utf8') > limit) { tasks.pop(); data.truncated = true; }
    return { data: { ...data, tasks }, truncated: data.truncated };
  },
});
export const analyzeImpactTool = defineTool({
  name: 'analyze_impact', title: 'Analyze static change impact',
  description: 'Before editing, find direct/transitive TS/JS import and re-export dependents of workspace files, with evidence lines, hashes and related test paths. Uses the bundled TypeScript parser/resolver, not grep. Missing targets, dynamic loading, external dependencies and scan limits are explicit. This is conservative file-level impact, not a runtime call graph or a reason to skip the full relevant test gate. Read-only.',
  input: { files: z.array(Path).min(1).max(10), maxResults: z.number().int().min(1).max(100).default(40), maxDepth: z.number().int().min(1).max(10).default(5) },
  output: ImpactSchema, annotations: readAnnotations, requiredScope: 'dodo:read', action: 'read',
  handler: async (args, ctx) => {
    assertFiles(ctx, args.files, true);
    const data = ImpactSchema.parse(await ctx.services.intel.assist({ op: 'assist_impact', ...args }));
    while (data.impacted.length && Buffer.byteLength(JSON.stringify(data), 'utf8') > budget(ctx, 32768)) {
      data.impacted.pop(); data.truncated = true;
      data.relatedTests = data.relatedTests.filter(p => data.impacted.some(i => i.path === p) || args.files.includes(p));
    }
    if (Buffer.byteLength(JSON.stringify(data), 'utf8') > budget(ctx, 32768)) throw new DodoError('RESOURCE_LIMIT', 'impact metadata exceeds output budget; request fewer targets');
    return { data, truncated: data.truncated };
  },
});
export const readSymbolTool = defineTool({
  name: 'read_symbol', title: 'Read one function, class or method',
  description: 'Read the exact TS/JS AST declaration of a named function/class/method/variable, with file hash and line range. Use a qualified name such as Class.method and optionally a line to disambiguate overloads/nesting. Large content is explicitly truncated. Only block-bodied functions/methods can currently be edited through preview_refactor. No execution.',
  input: { file: Path, symbol: Symbol, line: z.number().int().positive().optional(), maxBytes: z.number().int().min(1024).max(32768).default(12000) },
  output: SymbolSchema, annotations: readAnnotations, requiredScope: 'dodo:read', action: 'read',
  handler: async (args, ctx) => {
    assertFiles(ctx, [args.file]);
    const data = SymbolSchema.parse(await ctx.services.intel.assist({ op: 'assist_symbol', file: args.file, symbol: args.symbol, ...(args.line !== undefined ? { line: args.line } : {}), maxBytes: budget(ctx, args.maxBytes) }));
    return { data, truncated: data.truncated };
  },
});
export const previewRefactorTool = defineTool({
  name: 'preview_refactor', title: 'Preview a symbol-body edit',
  description: 'Preview replacement of the INTERIOR of one TS/JS function/method block body. Read read_symbol first and supply its exact file hash; ambiguous, stale, unsupported or invalid syntax is refused. body excludes outer braces. Preserves unrelated file bytes and original CRLF style. Does not apply edits or prove type/behavior correctness. Apply using existing apply_changes(planId, planHash, idempotencyKey), then verify_changes; rollback uses the existing journal.',
  input: { file: Path, symbol: Symbol, line: z.number().int().positive().optional(), expectedHash: HashSchema,
    operation: z.literal('replace_body').default('replace_body'), body: z.string().max(512 * 1024) },
  output: PreviewSchema, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }, requiredScope: 'dodo:write', action: 'plan',
  handler: async (args, ctx) => {
    assertFiles(ctx, [args.file]);
    if (Buffer.byteLength(args.body, 'utf8') > Math.min(ctx.services.limits.readFileBytes, 512 * 1024)) throw new DodoError('FILE_TOO_LARGE', 'replacement exceeds the active AST byte budget');
    const data = RefactorSchema.parse(await ctx.services.intel.assist({ op: 'assist_refactor', file: args.file, symbol: args.symbol, expectedHash: args.expectedHash, body: args.body, ...(args.line !== undefined ? { line: args.line } : {}) }));
    const s = ctx.services;
    const preview = s.planner.preview({ ops: [{ op: 'replace_file', path: data.path, content: data.content, expectedHash: data.beforeHash }],
      workspaceId: s.workspaceId, epoch: s.epoch, principal: ctx.principal.grantId, trustMode: ctx.trustMode, source: 'preview_changes' });
    return { data: { ...preview, symbol: data.symbol, operation: data.operation,
      notes: ['Syntax checked only; typecheck and behavior tests are still required.', 'Apply and rollback use the existing approval/path/hash/journal machinery.'] }, truncated: preview.files.some(f => f.diffTruncated) };
  },
});
export const verifyChangesTool = defineTool({
  name: 'verify_changes', title: 'Plan, run and report verification',
  description: 'mode=plan discovers verification recipes and a guarded source digest without execution. mode=run requires explicitly selected tasks with recipeDigest, sourceDigest from the plan, and an idempotencyKey; runs them through the EXISTING exec approval/sandbox policy. mode=report takes verificationId and never reruns. Reports exits, recognized Vitest/Jest JSON or Vitest text test counts, missing checks and source drift; zero/unknown tests are not a verified test pass. Requires exec scope even for plan/report because this tool can execute. No automatic fixes, retries, installs or security changes. Poll report or existing job_* tools for running jobs.',
  input: { mode: z.enum(['plan', 'run', 'report']).default('plan'), files: z.array(Path).max(10).default([]),
    tasks: z.array(z.object({ taskId: z.string().min(1).max(128), recipeDigest: HashSchema }).strict()).max(4).default([]),
    sourceDigest: HashSchema.optional(), verificationId: z.string().regex(/^verify_[a-z0-9]+$/).max(128).optional(),
    idempotencyKey: z.string().min(8).max(128).optional(), timeoutMs: z.number().int().min(1000).max(1800000).default(300000),
    waitMs: z.number().int().min(0).max(10000).default(1000) },
  output: VerificationSchema, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }, requiredScope: 'dodo:exec', action: 'exec',
  handler: async (args, ctx) => {
    const data = VerificationSchema.parse(await verifyChanges(ctx, args));
    // Keep structured and legacy output bounded, without dropping status or freshness.
    let truncated = false;
    const max = ctx.services.limits.toolContentBytes - 1024;
    while (Buffer.byteLength(JSON.stringify(data), 'utf8') > max) {
      const withFailures = data.checks.find(c => c.tests.failures.length > 0);
      if (withFailures) withFailures.tests.failures.pop();
      else if (data.freshness.changedPaths.length) { data.freshness.changedPaths.pop(); data.freshness.changedPathsTruncated = true; }
      else if (data.recommendedTasks.length) data.recommendedTasks.pop();
      else if (data.files.length) data.files.pop();
      else if (data.notRun.length) data.notRun.pop();
      else break;
      truncated = true;
    }
    return { data, truncated };
  },
});
