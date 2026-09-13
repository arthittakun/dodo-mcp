import { z } from 'zod';
import { defineTool, policyGate } from './context.js';

const looseData = z.looseObject({});

export const gitStatusTool = defineTool({
  name: 'git_status',
  title: 'Git status (scoped)',
  description:
    'Read-only git status scoped to the workspace root (even when the repository root is a parent directory — sibling packages never appear). Helpers, hooks, fsmonitor and external tools are disabled. In a non-git folder returns isRepo=false, not an error.',
  input: {},
  output: looseData,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  requiredScope: 'dodo:read',
  action: 'read',
  handler: async (_args, ctx) => {
    const res = await ctx.services.git.status();
    const warnings: string[] = [];
    if (res.filteredSecretPaths > 0) warnings.push(`${res.filteredSecretPaths} path(s) hidden by secret policy`);
    return { data: res, warnings, truncated: res.truncated };
  },
});

export const gitDiffTool = defineTool({
  name: 'git_diff',
  title: 'Git diff (scoped)',
  description:
    'Read-only unified diff of the working tree (or staged with staged=true), scoped to the workspace root and optional workspace-relative paths. External diff drivers and textconv are disabled; secret-denied files are filtered out of the output even when tracked.',
  input: {
    paths: z.array(z.string().max(1024)).max(20).optional(),
    staged: z.boolean().default(false),
    contextLines: z.number().int().min(0).max(20).default(3),
  },
  output: looseData,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  requiredScope: 'dodo:read',
  action: 'read',
  handler: async (args, ctx) => {
    const opts: { paths?: string[]; staged?: boolean; contextLines?: number } = { staged: args.staged, contextLines: args.contextLines };
    if (args.paths !== undefined) opts.paths = args.paths;
    const res = await ctx.services.git.diff(opts);
    const warnings: string[] = [];
    if (res.filteredSecretPaths > 0) warnings.push(`${res.filteredSecretPaths} file(s) hidden by secret policy`);
    return { data: { isRepo: res.isRepo, diff: res.diff }, warnings, truncated: res.truncated };
  },
});

export const gitLogTool = defineTool({
  name: 'git_log',
  title: 'Git log (scoped)',
  description: 'Recent commits touching the workspace root (or one workspace-relative path). Read-only; returns sha, author, ISO date and subject.',
  input: {
    limit: z.number().int().min(1).max(200).default(20),
    path: z.string().max(1024).optional(),
  },
  output: looseData,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  requiredScope: 'dodo:read',
  action: 'read',
  handler: async (args, ctx) => {
    const opts: { limit: number; path?: string } = { limit: args.limit };
    if (args.path !== undefined) opts.path = args.path;
    const res = await ctx.services.git.log(opts);
    return { data: res };
  },
});

export const gitCommitTool = defineTool({
  name: 'git_commit',
  title: 'Git commit (scoped)',
  description:
    'Stage and commit changes inside the workspace. Give `paths` to stage specific files, or `all: true` to stage every changed path the scoped, secret-filtered status shows (a stray .env is never staged). Runs the repository\'s commit hooks, so it is gated like running a command (trusted mode or a local approval). Never pushes.',
  input: {
    message: z.string().min(1).max(4000),
    paths: z.array(z.string().max(1024)).max(200).optional(),
    all: z.boolean().default(false),
    noVerify: z.boolean().default(false).describe('skip commit hooks'),
  },
  output: looseData,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  requiredScope: 'dodo:exec',
  action: 'exec',
  handler: async (args, ctx) => {
    policyGate(ctx, {
      tool: 'git_commit',
      action: 'exec',
      approvalAction: { message: args.message, paths: args.paths ?? null, all: args.all, noVerify: args.noVerify },
      summary: `git commit: ${args.message.split('\n')[0]}`.slice(0, 200),
    });
    const opts: Parameters<typeof ctx.services.git.commit>[0] = { message: args.message, all: args.all, noVerify: args.noVerify };
    if (args.paths !== undefined) opts.paths = args.paths;
    const res = await ctx.services.git.commit(opts);
    return { data: res };
  },
});
