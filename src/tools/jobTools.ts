import { isOwner } from '../security/projectAuthority.js';
import { z } from 'zod';
import { policyGate, defineTool } from './context.js';
import { withIdempotency } from './changeTools.js';
import { DodoError } from '../errors.js';
import { MAX_COMMAND_BYTES } from '../config/limits.js';
import { EXEC_ARG_BYTES, validateExecArgs, validateShellCommand } from '../services/jobs/commandInput.js';
import { truncateUtf8 } from '../util/bytes.js';

const looseData = z.looseObject({});
const IdempotencyKey = z.string().min(8).max(128);

export const execCommandTool = defineTool({
  name: 'exec_command',
  title: 'Execute command',
  description:
    'Start a process with an explicit program + argv (NO shell interpretation; quoting/metacharacters are passed through literally). cwd is workspace-relative. Returns a jobId immediately — poll job_status/job_output. Outside trusted mode every distinct command needs a local owner approval first (the error carries the approval id). Programs run with the OS user\'s real privileges: the workspace directory guard is NOT a sandbox.',
  input: {
    program: z.string().min(1).max(512).describe('Bare name resolved on the trusted PATH, or a workspace-relative script path'),
    args: z.array(z.string().max(EXEC_ARG_BYTES)).max(128).default([]).describe('UTF-8 limits: 64 KiB per argument, 128 KiB combined. Save large code/data to a file and pass its path.'),
    cwd: z.string().max(1024).default('.'),
    timeoutMs: z.number().int().min(1000).max(30 * 60 * 1000).optional(),
    idempotencyKey: IdempotencyKey,
  },
  output: looseData,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  requiredScope: 'dodo:exec',
  action: 'exec',
  handler: async (args, ctx) => {
    validateExecArgs(args.program, args.args);
    policyGate(ctx, {
      tool: 'exec_command',
      action: 'exec',
      approvalAction: { program: args.program, args: args.args, cwd: args.cwd, timeoutMs: args.timeoutMs ?? null },
      summary: `run: ${args.program} ${args.args.join(' ')}`.slice(0, 200),
    });
    const { result, replayed } = await withIdempotency(
      ctx,
      'exec_command',
      args.idempotencyKey,
      { program: args.program, args: args.args, cwd: args.cwd, timeoutMs: args.timeoutMs ?? null },
      async () => {
        const req: Parameters<typeof ctx.services.jobs.start>[0] = {
          workspaceId: ctx.services.workspaceId,
          epoch: ctx.services.epoch,
          principal: ctx.principal.grantId,
          kind: 'exec',
          program: args.program,
          args: args.args,
          cwdRel: args.cwd,
        };
        if (args.timeoutMs !== undefined) req.timeoutMs = args.timeoutMs;
        return ctx.services.jobs.start(req);
      },
    );
    return { data: { jobId: result.jobId, replayed } };
  },
});

export const runTaskTool = defineTool({
  name: 'run_task',
  title: 'Run task recipe',
  description:
    'Run a task recipe discovered by project_overview (e.g. npm scripts or .dodo.json tasks). Requires the recipe\'s current recipeDigest — if the underlying manifest changed, the digest changes and a fresh overview + approval is needed. The server runs the RECIPE\'s program/args (data), never caller-supplied command strings. Returns a jobId immediately.',
  input: {
    taskId: z.string().min(1).max(128),
    recipeDigest: z.string().min(8).max(128),
    timeoutMs: z.number().int().min(1000).max(30 * 60 * 1000).optional(),
    idempotencyKey: IdempotencyKey,
  },
  output: looseData,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  requiredScope: 'dodo:exec',
  action: 'exec',
  handler: async (args, ctx) => {
    const recipes = ctx.services.overview.discoverTasks(ctx.services.projectConfig);
    const recipe = recipes.find((r) => r.id === args.taskId);
    if (!recipe) {
      throw new DodoError('NOT_FOUND', `unknown taskId ${args.taskId}; call project_overview for current recipes`);
    }
    if (recipe.recipeDigest !== args.recipeDigest) {
      throw new DodoError('CONFLICT', 'recipe changed since it was listed (manifest edited); call project_overview and re-approve', {
        recovery: 'call project_overview, use the fresh recipeDigest',
      });
    }
    policyGate(ctx, {
      tool: 'run_task',
      action: 'exec',
      approvalAction: { taskId: recipe.id, recipeDigest: recipe.recipeDigest },
      summary: `run task ${recipe.id}: ${recipe.program} ${recipe.args.join(' ')}`.slice(0, 200),
    });
    const { result, replayed } = await withIdempotency(
      ctx,
      'run_task',
      args.idempotencyKey,
      { taskId: recipe.id, recipeDigest: recipe.recipeDigest, timeoutMs: args.timeoutMs ?? null },
      async () => {
        const req: Parameters<typeof ctx.services.jobs.start>[0] = {
          workspaceId: ctx.services.workspaceId,
          epoch: ctx.services.epoch,
          principal: ctx.principal.grantId,
          kind: 'task',
          program: recipe.program,
          args: recipe.args,
          cwdRel: recipe.cwd,
          recipeId: recipe.id,
        };
        if (args.timeoutMs !== undefined) req.timeoutMs = args.timeoutMs;
        return ctx.services.jobs.start(req);
      },
    );
    return { data: { jobId: result.jobId, taskId: recipe.id, replayed } };
  },
});

export const jobStatusTool = defineTool({
  name: 'job_status',
  title: 'Job status',
  description:
    'Status of a job by jobId: running/exited/canceled/timed_out/failed_to_start/interrupted_on_restart, exit code and signal, timestamps. Works across reconnects — jobs are not tied to any protocol session.',
  input: { jobId: z.string().max(128) },
  output: looseData,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  requiredScope: 'dodo:read',
  action: 'read',
  handler: async (args, ctx) => {
    const j = ctx.services.jobs.getJobChecked(args.jobId, ctx.services.workspaceId);
    let budget = Math.floor(ctx.services.limits.toolContentBytes / 4);
    let argsTruncated = false;
    const displayedArgs = j.args.map(arg => {
      const part = truncateUtf8(arg, budget);
      budget = Math.max(0, budget - Buffer.byteLength(part.text, 'utf8'));
      argsTruncated ||= part.truncated;
      return part.text;
    });
    return {
      data: {
        jobId: j.id,
        status: j.status,
        kind: j.kind,
        program: j.program,
        args: displayedArgs,
        argsTruncated,
        cwd: j.cwd,
        exitCode: j.exitCode,
        signal: j.signal,
        createdAt: j.createdAt,
        startedAt: j.startedAt,
        endedAt: j.endedAt,
        timeoutMs: j.timeoutMs,
      },
      truncated: argsTruncated,
    };
  },
});

export const jobOutputTool = defineTool({
  name: 'job_output',
  title: 'Job output',
  description:
    'Read a job\'s stdout or stderr from the bounded spool by UTF-8-safe byte offset. Returns content, nextOffset for polling, and truncatedBeforeOffset (bytes dropped from the front when the per-job log cap rolled over).',
  input: {
    jobId: z.string().max(128),
    stream: z.enum(['stdout', 'stderr']).default('stdout'),
    offset: z.number().int().min(0).default(0),
    maxBytes: z.number().int().min(1).max(1024 * 1024).default(32 * 1024),
  },
  output: looseData,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  requiredScope: 'dodo:read',
  action: 'read',
  handler: async (args, ctx) => {
    const res = ctx.services.jobs.output(args.jobId, ctx.services.workspaceId, args.stream, args.offset, args.maxBytes);
    return { data: res };
  },
});

export const jobInputTool = defineTool({
  name: 'job_input',
  title: 'Job input (stdin)',
  description:
    'Write UTF-8 data to a running job\'s stdin pipe (plain pipe — NOT a full PTY; programs that require a TTY may behave differently). Optionally close stdin. Classified as an exec-level action.',
  input: {
    jobId: z.string().max(128),
    data: z.string().max(64 * 1024),
    closeStdin: z.boolean().default(false),
  },
  output: looseData,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  requiredScope: 'dodo:exec',
  action: 'exec',
  handler: async (args, ctx) => {
    policyGate(ctx, {
      tool: 'job_input',
      action: 'exec',
      approvalAction: { jobId: args.jobId, data: args.data, closeStdin: args.closeStdin },
      summary: `send ${Buffer.byteLength(args.data, 'utf8')} bytes to stdin of ${args.jobId}`,
    });
    const res = ctx.services.jobs.writeInput(args.jobId, ctx.services.workspaceId, args.data, args.closeStdin);
    return { data: res };
  },
});

export const jobCancelTool = defineTool({
  name: 'job_cancel',
  title: 'Cancel job',
  description:
    'Cancel a running job owned by this server: SIGTERM to the job\'s own process group, then SIGKILL after a grace period. Never kills by bare PID or port; jobs from before a server restart are marked interrupted, not signaled. Grandchildren that left the process group can survive — that limitation is reported, not hidden.',
  input: { jobId: z.string().max(128) },
  output: looseData,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  requiredScope: 'dodo:exec',
  action: 'job-control',
  handler: async (args, ctx) => {
    const res = ctx.services.jobs.cancel(args.jobId, ctx.services.workspaceId);
    return {
      data: res,
      warnings: ['processes that detached from the job\'s process group (daemons) are not signaled'],
    };
  },
});

export const listJobsTool = defineTool({
  name: 'list_jobs',
  title: 'List jobs',
  description: 'Recent jobs for this workspace with status and timing.',
  input: { limit: z.number().int().min(1).max(100).default(20) },
  output: looseData,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  requiredScope: 'dodo:read',
  action: 'read',
  handler: async (args, ctx) => {
    const jobs = ctx.services.jobs.list(ctx.services.workspaceId, 100).filter(j => isOwner(ctx.principal) || j.principal === ctx.principal.grantId).slice(0,args.limit).map((j) => ({
      jobId: j.id,
      status: j.status,
      kind: j.kind,
      program: j.program,
      createdAt: j.createdAt,
      endedAt: j.endedAt,
      exitCode: j.exitCode,
    }));
    return { data: { jobs } };
  },
});

export const runCommandTool = defineTool({
  name: 'run_command',
  title: 'Run shell command',
  description:
    'Run a shell command string (bash -c) in the workspace and WAIT for it, returning exit code, stdout and stderr inline — the everyday tool for `npm test`, `npm install <pkg>`, `pytest`, build scripts, `git status`, etc. Pipes, &&, redirects work. If the command is still running after waitMs (default 90s) the call returns status "running" with a jobId: poll job_output / job_status or job_cancel. Output is bounded (head + tail); use job_output(jobId, offset) for the full log. Outside trusted mode every distinct command needs a local owner approval first. Commands run with the OS user\'s real privileges — the workspace guard is NOT a sandbox.',
  input: {
    command: z.string().min(1).max(MAX_COMMAND_BYTES).describe('Shell source; active UTF-8 byte budget is project_overview.policy.limits.commandBytes. Long commands run through a private script file. Prefer write_file/edit_file for source code, then a short build/test command.'),
    cwd: z.string().max(1024).default('.').describe('workspace-relative working directory'),
    waitMs: z.number().int().min(1000).max(300_000).default(90_000).describe('how long to wait inline before returning a running jobId'),
    timeoutMs: z.number().int().min(1000).max(30 * 60 * 1000).optional().describe('wall-clock limit after which the job is terminated (default 10 min)'),
    background: z.boolean().default(false).describe('return immediately with the jobId (dev servers, watchers); poll job_output / job_wait'),
    sandbox: z.boolean().optional().describe('run inside the OS sandbox (writes limited to the workspace + caches). Default from global config commandSandbox'),
    network: z.boolean().default(true).describe('allow outbound network inside the sandbox'),
    idempotencyKey: z.string().min(8).max(128).optional().describe('optional: reuse to make a retried call return the same job instead of running twice'),
  },
  output: looseData,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  requiredScope: 'dodo:exec',
  action: 'exec',
  handler: async (args, ctx) => {
    validateShellCommand(args.command, ctx.services.limits.commandBytes);
    policyGate(ctx, {
      tool: 'run_command',
      action: 'exec',
      approvalAction: { command: args.command, cwd: args.cwd, timeoutMs: args.timeoutMs ?? null, sandbox: args.sandbox ?? null, network: args.network },
      summary: `run: ${args.command}`.slice(0, 200),
    });
    const s = ctx.services;
    let sandboxed: string | null = null;
    const startJob = async () => {
      const req: Parameters<typeof s.jobs.start>[0] = {
        workspaceId: s.workspaceId,
        epoch: s.epoch,
        principal: ctx.principal.grantId,
        kind: 'exec',
        program: args.command,
        args: [],
        cwdRel: args.cwd,
        shell: true,
        sandbox: args.sandbox,
        network: args.network,
      };
      if (args.timeoutMs !== undefined) req.timeoutMs = args.timeoutMs;
      const started = s.jobs.start(req);
      sandboxed = started.sandboxed;
      return started;
    };
    const startedAt = Date.now();
    let jobId: string;
    let replayed = false;
    if (args.idempotencyKey !== undefined) {
      const r = await withIdempotency(ctx, 'run_command', args.idempotencyKey, { command: args.command, cwd: args.cwd, timeoutMs: args.timeoutMs ?? null, sandbox: args.sandbox ?? null, network: args.network }, startJob);
      jobId = r.result.jobId;
      replayed = r.replayed;
    } else {
      jobId = (await startJob()).jobId;
    }
    if (args.background) {
      return { data: { jobId, status: 'running', background: true, sandboxed, replayed }, warnings: ['background job started; poll job_output / job_wait, stop with job_cancel'] };
    }
    const exited = await s.jobs.waitForExit(jobId, args.waitMs);
    const row = s.jobs.getJobChecked(jobId, s.workspaceId);
    const cap = Math.max(4 * 1024, Math.floor(s.limits.toolContentBytes * 0.4));
    const out = s.jobs.inlineOutput(jobId, s.workspaceId, 'stdout', cap);
    const err = s.jobs.inlineOutput(jobId, s.workspaceId, 'stderr', cap);
    const warnings: string[] = [];
    if (!exited) warnings.push(`command still running after ${args.waitMs} ms; poll job_status/job_output(jobId) or job_cancel(jobId)`);
    if (out.truncated || err.truncated) warnings.push('output truncated inline; read the full log with job_output(jobId, stream, offset)');
    const data: Record<string, unknown> = {
      jobId,
      status: row.status,
      exitCode: row.exitCode,
      signal: row.signal,
      stdout: out.content,
      stderr: err.content,
      stdoutBytes: out.totalBytes,
      stderrBytes: err.totalBytes,
      stdoutTruncated: out.truncated,
      stderrTruncated: err.truncated,
      durationMs: Date.now() - startedAt,
      sandboxed,
      replayed,
    };
    if (out.tail !== undefined) data['stdoutTail'] = out.tail;
    if (err.tail !== undefined) data['stderrTail'] = err.tail;
    return { data, warnings, truncated: out.truncated || err.truncated };
  },
});

export const runCommandsTool = defineTool({
  name: 'run_commands',
  title: 'Run commands in parallel',
  description:
    'Start several independent shell commands AT ONCE (e.g. lint + typecheck + unit tests) and wait for all of them, returning one result per command (exit code, bounded stdout/stderr). Same semantics and policy as run_command; the batch counts against the concurrent-job limit and needs one approval outside trusted mode. Commands still running after waitMs are returned with status "running" and their jobId.',
  input: {
    commands: z
      .array(
        z
          .object({
            name: z.string().max(64).optional(),
            command: z.string().min(1).max(MAX_COMMAND_BYTES).describe('Same UTF-8 byte budget and private-script support as run_command; total call must fit requestBodyBytes.'),
            cwd: z.string().max(1024).default('.'),
          })
          .strict(),
      )
      .min(1)
      .max(8),
    waitMs: z.number().int().min(1000).max(300_000).default(90_000),
    timeoutMs: z.number().int().min(1000).max(30 * 60 * 1000).optional(),
    sandbox: z.boolean().optional(),
    network: z.boolean().default(true),
  },
  output: looseData,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  requiredScope: 'dodo:exec',
  action: 'exec',
  handler: async (args, ctx) => {
    const s = ctx.services;
    // Validate the entire batch before launching its first process.
    for (const c of args.commands) validateShellCommand(c.command, s.limits.commandBytes);
    const free = s.limits.jobsConcurrentMax - s.jobs.runningCount();
    if (args.commands.length > free) {
      throw new DodoError('RESOURCE_LIMIT', `only ${free} of ${s.limits.jobsConcurrentMax} job slots are free; run fewer commands or wait`, { retryable: true });
    }
    policyGate(ctx, {
      tool: 'run_commands',
      action: 'exec',
      approvalAction: { commands: args.commands.map((c) => ({ command: c.command, cwd: c.cwd })), sandbox: args.sandbox ?? null, network: args.network },
      summary: `run ${args.commands.length} commands: ${args.commands.map((c) => c.command).join(' | ')}`.slice(0, 200),
    });
    const startedAt = Date.now();
    const started: Array<{ name: string; command: string; jobId: string; sandboxed: string | null }> = [];
    for (const c of args.commands) {
      const req: Parameters<typeof s.jobs.start>[0] = {
        workspaceId: s.workspaceId,
        epoch: s.epoch,
        principal: ctx.principal.grantId,
        kind: 'exec',
        program: c.command,
        args: [],
        cwdRel: c.cwd,
        shell: true,
        sandbox: args.sandbox,
        network: args.network,
      };
      if (args.timeoutMs !== undefined) req.timeoutMs = args.timeoutMs;
      const r = s.jobs.start(req);
      started.push({ name: c.name ?? `cmd${started.length + 1}`, command: c.command, jobId: r.jobId, sandboxed: r.sandboxed });
    }
    const exits = await Promise.all(started.map((j) => s.jobs.waitForExit(j.jobId, args.waitMs)));
    const cap = Math.max(2 * 1024, Math.floor((s.limits.toolContentBytes * 0.7) / Math.max(1, started.length * 2)));
    const results = started.map((j, i) => {
      const row = s.jobs.getJobChecked(j.jobId, s.workspaceId);
      const out = s.jobs.inlineOutput(j.jobId, s.workspaceId, 'stdout', cap);
      const err = s.jobs.inlineOutput(j.jobId, s.workspaceId, 'stderr', cap);
      const command = truncateUtf8(j.command, 1024);
      const r: Record<string, unknown> = {
        name: j.name,
        command: command.text,
        commandTruncated: command.truncated,
        jobId: j.jobId,
        status: row.status,
        exitCode: row.exitCode,
        signal: row.signal,
        stdout: out.content,
        stderr: err.content,
        stdoutTruncated: out.truncated,
        stderrTruncated: err.truncated,
        exited: exits[i] ?? false,
        sandboxed: j.sandboxed,
      };
      if (out.tail !== undefined) r['stdoutTail'] = out.tail;
      if (err.tail !== undefined) r['stderrTail'] = err.tail;
      return r;
    });
    const stillRunning = results.filter((r) => r['exited'] !== true).map((r) => r['jobId']);
    const warnings: string[] = [];
    if (stillRunning.length > 0) warnings.push(`${stillRunning.length} command(s) still running after ${args.waitMs} ms: ${stillRunning.join(', ')} (job_wait / job_output / job_cancel)`);
    if (results.some((r) => r['stdoutTruncated'] || r['stderrTruncated'])) warnings.push('some output truncated inline; use job_output(jobId, stream, offset)');
    if (results.some((r) => r['commandTruncated'])) warnings.push('long command source omitted from summaries; the submitted command ran in full');
    return {
      data: { results, allExited: stillRunning.length === 0, allSucceeded: results.every((r) => r['status'] === 'exited' && r['exitCode'] === 0), durationMs: Date.now() - startedAt },
      warnings,
      truncated: results.some((r) => r['stdoutTruncated'] || r['stderrTruncated'] || r['commandTruncated']),
    };
  },
});

export const jobWaitTool = defineTool({
  name: 'job_wait',
  title: 'Wait for job',
  description: 'Block until a job exits (or waitMs elapses) and return its status plus bounded stdout/stderr — the follow-up to a background run_command.',
  input: {
    jobId: z.string().max(128),
    waitMs: z.number().int().min(1000).max(300_000).default(60_000),
  },
  output: looseData,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  requiredScope: 'dodo:read',
  action: 'read',
  handler: async (args, ctx) => {
    const s = ctx.services;
    s.jobs.getJobChecked(args.jobId, s.workspaceId);
    const exited = await s.jobs.waitForExit(args.jobId, args.waitMs);
    const row = s.jobs.getJobChecked(args.jobId, s.workspaceId);
    const cap = Math.max(4 * 1024, Math.floor(s.limits.toolContentBytes * 0.4));
    const out = s.jobs.inlineOutput(args.jobId, s.workspaceId, 'stdout', cap);
    const err = s.jobs.inlineOutput(args.jobId, s.workspaceId, 'stderr', cap);
    const data: Record<string, unknown> = {
      jobId: args.jobId,
      status: row.status,
      exitCode: row.exitCode,
      signal: row.signal,
      exited,
      stdout: out.content,
      stderr: err.content,
      stdoutTruncated: out.truncated,
      stderrTruncated: err.truncated,
    };
    if (out.tail !== undefined) data['stdoutTail'] = out.tail;
    if (err.tail !== undefined) data['stderrTail'] = err.tail;
    return { data, warnings: exited ? [] : [`still running after ${args.waitMs} ms`], truncated: out.truncated || err.truncated };
  },
});
