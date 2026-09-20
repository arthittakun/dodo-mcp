import { z } from 'zod';
import path from 'node:path';
import picomatch from 'picomatch';
import { MAX_FILE_BYTES } from '../config/limits.js';
import { policyGate, defineTool, type ToolCtx } from './context.js';
import { DodoError } from '../errors.js';
import { digestOf, sha256Bytes, newId } from '../util/hash.js';
import type { AnyPlanOp, StoredPlan, PlanFileChange } from '../services/changes/types.js';
import { checkReplacementSize } from '../services/changes/contentBudget.js';

/**
 * Direct coding tools — the one-call ergonomics an AI coding agent expects
 * (write / edit / delete / move / mkdir / glob), built ON TOP of the same
 * planner + journaled applier as preview_changes/apply_changes. Every direct
 * write is still hash-verified, journaled with backups, visible in
 * change_history and reversible with rollback_changes; the caller simply does
 * not have to make two calls. Path policy and secret denies apply unchanged.
 */
const looseData = z.looseObject({});

async function applyDirect(
  ctx: ToolCtx,
  tool: string,
  op: AnyPlanOp,
  summary: string,
  approvalAction: Record<string, unknown>,
): Promise<{ changesetId: string; file: { path: string; destPath?: string; beforeHash: string | null; afterHash: string | null; diff: string; diffTruncated: boolean; bytesAfter: number } }> {
  policyGate(ctx, { tool, action: 'mutate-files', approvalAction, summary });
  const s = ctx.services;
  const preview = s.planner.preview({
    ops: [op],
    workspaceId: s.workspaceId,
    epoch: s.epoch,
    principal: ctx.principal.grantId,
    trustMode: ctx.trustMode,
    source: 'direct',
  });
  const applied = await s.applier.apply({
    planId: preview.planId,
    planHash: preview.planHash,
    workspaceId: s.workspaceId,
    epoch: s.epoch,
    principal: ctx.principal.grantId,
  });
  const f = preview.files[0] as (typeof preview.files)[number];
  const file: Awaited<ReturnType<typeof applyDirect>>['file'] = {
    path: f.path,
    beforeHash: f.beforeHash,
    afterHash: f.afterHash,
    diff: f.diff,
    diffTruncated: f.diffTruncated,
    bytesAfter: f.bytesAfter,
  };
  if (f.destPath !== undefined) file.destPath = f.destPath;
  return { changesetId: applied.changesetId, file };
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let idx = 0;
  for (;;) {
    idx = haystack.indexOf(needle, idx);
    if (idx === -1) return count;
    count += 1;
    idx += needle.length;
  }
}

export const writeFileTool = defineTool({
  name: 'write_file',
  title: 'Write file',
  description:
    'Create or overwrite one UTF-8 text file in a single call (workspace-relative path; missing parent directories are created inside the workspace). The write is hash-verified (pass expectedHash from read_files to refuse overwriting a file that changed), journaled with a backup, listed in change_history, and reversible with rollback_changes. Prefer edit_file for small in-place edits.',
  input: {
    path: z.string().max(1024),
    content: z.string().max(MAX_FILE_BYTES).describe('UTF-8 source content. Prefer this tool over embedding code in shell commands. Active file/plan/request byte budgets are reported by project_overview; split larger work into files or exact edits.'),
    expectedHash: z.string().max(128).optional().describe('sha256 from read_files; refuse if the current file differs'),
    createParents: z.boolean().default(true),
  },
  output: looseData,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  requiredScope: 'dodo:write',
  action: 'mutate-files',
  handler: async (args, ctx) => {
    const wfs = ctx.services.wfs;
    const resolved = wfs.resolve(args.path, { allowMissing: true });
    if (resolved.stat && !resolved.stat.isFile()) {
      throw new DodoError('PATH_DENIED', 'target exists and is not a regular file', { detail: { path: resolved.rel } });
    }
    const exists = resolved.stat !== undefined;
    let op: AnyPlanOp;
    if (exists) {
      op = { op: 'replace_file', path: resolved.rel, content: args.content };
      if (args.expectedHash !== undefined) op.expectedHash = args.expectedHash;
    } else {
      op = { op: 'create', path: resolved.rel, content: args.content, createParents: args.createParents };
    }
    const contentHash = sha256Bytes(args.content);
    const { changesetId, file } = await applyDirect(ctx, 'write_file', op, `write ${resolved.rel} (${Buffer.byteLength(args.content, 'utf8')} bytes)`, {
      path: resolved.rel,
      contentHash,
    });
    return {
      data: { path: file.path, created: !exists, hash: file.afterHash, beforeHash: file.beforeHash, bytes: file.bytesAfter, changesetId },
    };
  },
});

const EditSchema = z
  .object({
    find: z.string().min(1).max(MAX_FILE_BYTES).describe('exact text to replace (must occur exactly expectedCount times unless replaceAll)'),
    replace: z.string().max(MAX_FILE_BYTES),
    replaceAll: z.boolean().default(false),
    expectedCount: z.number().int().min(1).max(1000).optional(),
  })
  .strict();

export const editFileTool = defineTool({
  name: 'edit_file',
  title: 'Edit file',
  description:
    'Apply one or more exact find/replace edits to a UTF-8 text file in a single call (like an editor\'s replace). Each edit\'s find text must occur exactly expectedCount times (default 1) unless replaceAll is true — otherwise the call fails with AMBIGUOUS_EDIT and nothing is written. Edits apply in order. Hash-verified, journaled, reversible. Returns the unified diff.',
  input: {
    path: z.string().max(1024),
    edits: z.array(EditSchema).min(1).max(50),
    expectedHash: z.string().max(128).optional().describe('sha256 from read_files; refuse if the current file differs'),
    dryRun: z.boolean().default(false).describe('only compute the diff and return a plan (planId/planHash) you can apply_changes later; nothing is written'),
  },
  output: looseData,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  requiredScope: 'dodo:write',
  action: 'mutate-files',
  handler: async (args, ctx) => {
    const s = ctx.services;
    const current = s.wfs.readTextFile(args.path, s.limits.readFileBytes);
    if (args.expectedHash !== undefined && args.expectedHash !== current.hash) {
      throw new DodoError('FILE_CHANGED', 'file content does not match expectedHash', {
        detail: { path: current.rel, expectedHash: args.expectedHash, actualHash: current.hash },
        recovery: 'read the file again and retry with the current hash',
      });
    }
    let text = current.text;
    for (let i = 0; i < args.edits.length; i += 1) {
      const e = args.edits[i] as z.infer<typeof EditSchema>;
      const count = countOccurrences(text, e.find);
      const expected = e.replaceAll ? Math.max(count, 1) : (e.expectedCount ?? 1);
      if (count === 0 || (!e.replaceAll && count !== expected)) {
        throw new DodoError('AMBIGUOUS_EDIT', `edit #${i + 1}: expected ${e.replaceAll ? 'at least 1' : expected} occurrence(s) of the find text, found ${count}`, {
          detail: { path: current.rel, editIndex: i, expected, found: count },
          recovery: 'read the file and use a more specific find text (include surrounding lines), the correct expectedCount, or replaceAll',
        });
      }
      checkReplacementSize(text, e.find, e.replace, count, s.limits.readFileBytes, current.rel);
      text = text.replaceAll(e.find, () => e.replace);
    }
    const op: AnyPlanOp = { op: 'replace_file', path: current.rel, content: text, expectedHash: current.hash };
    if (args.dryRun) {
      const s = ctx.services;
      const preview = s.planner.preview({ ops: [op], workspaceId: s.workspaceId, epoch: s.epoch, principal: ctx.principal.grantId, trustMode: ctx.trustMode, source: 'direct' });
      const f = preview.files[0] as (typeof preview.files)[number];
      return { data: { dryRun: true, path: current.rel, planId: preview.planId, planHash: preview.planHash, expiresAt: preview.expiresAt, editsApplied: args.edits.length, diff: f.diff }, truncated: f.diffTruncated };
    }
    const { changesetId, file } = await applyDirect(ctx, 'edit_file', op, `edit ${current.rel} (${args.edits.length} edit(s))`, {
      path: current.rel,
      beforeHash: current.hash,
      editsDigest: digestOf(args.edits),
    });
    return {
      data: { path: file.path, hash: file.afterHash, beforeHash: current.hash, editsApplied: args.edits.length, diff: file.diff, changesetId },
      truncated: file.diffTruncated,
    };
  },
});

export const deletePathTool = defineTool({
  name: 'delete_path',
  title: 'Delete file',
  description: 'Delete one regular file (workspace-relative). Journaled with a backup so rollback_changes can restore it. Directories are not deleted by this tool (use run_command for that in trusted mode).',
  input: {
    path: z.string().max(1024),
    expectedHash: z.string().max(128).optional(),
  },
  output: looseData,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  requiredScope: 'dodo:write',
  action: 'mutate-files',
  handler: async (args, ctx) => {
    const op: AnyPlanOp = { op: 'delete', path: args.path };
    if (args.expectedHash !== undefined) op.expectedHash = args.expectedHash;
    const { changesetId, file } = await applyDirect(ctx, 'delete_path', op, `delete ${args.path}`, { path: args.path, kind: 'delete' });
    return { data: { path: file.path, deleted: true, beforeHash: file.beforeHash, changesetId } };
  },
});

export const movePathTool = defineTool({
  name: 'move_path',
  title: 'Move / rename file',
  description: 'Move or rename one regular file inside the workspace. The destination parent directory must exist (make_directory first) and the destination must not exist. Journaled and reversible.',
  input: {
    path: z.string().max(1024),
    destPath: z.string().max(1024),
  },
  output: looseData,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  requiredScope: 'dodo:write',
  action: 'mutate-files',
  handler: async (args, ctx) => {
    const op: AnyPlanOp = { op: 'move', path: args.path, destPath: args.destPath };
    const { changesetId, file } = await applyDirect(ctx, 'move_path', op, `move ${args.path} → ${args.destPath}`, { path: args.path, destPath: args.destPath });
    return { data: { path: file.path, destPath: file.destPath, hash: file.afterHash, changesetId } };
  },
});

export const makeDirectoryTool = defineTool({
  name: 'make_directory',
  title: 'Make directory',
  description: 'Create a directory (and missing parents) inside the workspace. Succeeds with created=false if it already exists.',
  input: { path: z.string().max(1024) },
  output: looseData,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  requiredScope: 'dodo:write',
  action: 'mutate-files',
  handler: async (args, ctx) => {
    const wfs = ctx.services.wfs;
    const existing = wfs.resolve(args.path, { allowMissing: true });
    if (existing.stat) {
      if (!existing.stat.isDirectory()) throw new DodoError('CONFLICT', 'path exists and is not a directory', { detail: { path: existing.rel } });
      return { data: { path: existing.rel, created: false } };
    }
    policyGate(ctx, { tool: 'make_directory', action: 'mutate-files', approvalAction: { path: existing.rel }, summary: `mkdir ${existing.rel}` });
    const target = wfs.resolveForCreate(existing.rel, true);
    const dirs=[...target.missingParents,target.rel];
    const files:PlanFileChange[]=dirs.map((rel,i)=>({path:rel,action:'mkdir',beforeHash:null,afterHash:'directory',mode:0o755,createParents:dirs.slice(0,i),diff:'create directory',diffTruncated:false,bytesBefore:0,bytesAfter:0}));
    const plan:StoredPlan={version:1,workspaceId:ctx.services.workspaceId,epoch:ctx.services.epoch,principal:ctx.principal.grantId,source:'direct',files,summary:`create directory ${target.rel}`};
    const planId=newId('plan'),payload=JSON.stringify(plan),planHash=digestOf({planId,payload});
    ctx.services.store.putPlan({id:planId,workspaceId:plan.workspaceId,epoch:plan.epoch,principal:plan.principal,planHash,payload,ttlMs:ctx.services.limits.planExpiryMs});
    const result=await ctx.services.applier.apply({planId,planHash,workspaceId:plan.workspaceId,epoch:plan.epoch,principal:plan.principal});
    return {data:{path:target.rel,created:true,createdParents:target.missingParents,changesetId:result.changesetId}};
  },
});

export const globFilesTool = defineTool({
  name: 'glob_files',
  title: 'Glob files',
  description:
    'Find files by glob pattern (e.g. "**/*.ts", "src/**/*.test.js", "*.md"). A pattern without "/" matches file basenames anywhere below `path`; a pattern with "/" matches paths relative to `path`. Ignored/secret paths are excluded (includeIgnored re-adds only ordinary ignores). Bounded; truncated=true when maxResults is hit.',
  input: {
    pattern: z.string().min(1).max(512),
    path: z.string().max(1024).default('.'),
    includeIgnored: z.boolean().default(false),
    maxResults: z.number().int().min(1).max(1000).default(200),
    sortBy: z.enum(['path', 'mtime']).default('path').describe('mtime = most recently modified first'),
  },
  output: looseData,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  requiredScope: 'dodo:read',
  action: 'read',
  handler: async (args, ctx) => {
    const wfs = ctx.services.wfs;
    let isMatch: (p: string) => boolean;
    try {
      isMatch = picomatch(args.pattern, { dot: true });
    } catch {
      throw new DodoError('INVALID_INPUT', 'invalid glob pattern');
    }
    const base = wfs.normalizeRel(args.path);
    const basenameMode = !args.pattern.includes('/');
    const all: Array<{ path: string; size: number; mtimeMs: number }> = [];
    const collectCap = args.sortBy === 'mtime' ? 5000 : args.maxResults;
    let truncated = false;
    for (const f of wfs.walk({ startRel: base, includeIgnored: args.includeIgnored, maxEntries: 50_000 })) {
      const relToBase = base === '.' ? f.rel : f.rel.slice(base.length + 1);
      const hit = basenameMode ? isMatch(path.posix.basename(relToBase)) || isMatch(relToBase) : isMatch(relToBase);
      if (!hit) continue;
      if (all.length >= collectCap) {
        truncated = true;
        break;
      }
      all.push({ path: f.rel, size: f.stat.size, mtimeMs: Math.floor(f.stat.mtimeMs) });
    }
    if (args.sortBy === 'mtime') all.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const files = all.slice(0, args.maxResults);
    if (all.length > args.maxResults) truncated = true;
    return { data: { files, count: files.length }, truncated };
  },
});
