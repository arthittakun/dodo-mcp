import type { MutationQueue } from '../../security/mutationQueue.js';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DodoError } from '../../errors.js';
import type { WorkspaceFS } from '../../workspace/fs.js';
import type { Limits } from '../../config/limits.js';
import type { Store, JobRow } from '../../store/store.js';
import { buildChildEnv } from '../../security/env.js';
import { newId } from '../../util/hash.js';
import { SegmentedSpool } from './spool.js';
import type { SandboxWrapper } from './sandboxWiring.js';
import { INLINE_COMMAND_BYTES, validateExecArgs, validateShellCommand } from './commandInput.js';
import { resolveTrustedExecutable } from '../../platform/execResolve.js';
import { shellSpec, shellInvocation, batchInvocation, assertWindowsArgv } from '../../platform/shell.js';
import { signalOwnedProcess } from '../../platform/processTree.js';
import { removeWithRetry } from '../../platform/fsRetry.js';

/**
 * Job execution service (spec §13).
 * - `spawn` with shell:false and argv arrays — no shell-string interpolation
 *   by DODO itself. `run_command` deliberately hands a command STRING to the
 *   user's POSIX shell binary (inline or a private script); that is the same capability a
 *   trusted caller already has via exec_command(program:'sh'), exposed
 *   ergonomically, and it is gated by the same exec policy.
 * - child env is a whitelist (security/env.ts); OAuth material and
 *   DODO_CONFIG_DIR never reaches children.
 * - jobs live in this service, NOT in any MCP session: reconnects poll by
 *   jobId; a dropped HTTP connection never kills a job.
 * - cancellation targets only process groups this process spawned and still
 *   holds a live handle for. After a restart, old PIDs are NEVER killed
 *   (identity cannot be verified — PID reuse); jobs from previous epochs are
 *   marked interrupted_on_restart and not re-run.
 */
interface LiveJob {
  child: ChildProcess;
  stdout: SegmentedSpool;
  stderr: SegmentedSpool;
  timeout: NodeJS.Timeout | undefined;
  exitDrainTimer?: NodeJS.Timeout;
  stdinOpen: boolean;
  scriptPath: string | undefined;
}

export interface StartJobRequest {
  workspaceId: string;
  epoch: string;
  principal: string;
  kind: 'exec' | 'task';
  /** Program name/path — or, when `shell` is true, the full command string. */
  program: string;
  args: string[];
  cwdRel: string;
  recipeId?: string;
  /** Scheduled jobs have no interactive input channel. */
  stdin?: boolean;
  timeoutMs?: number;
  /** Run `program` through the POSIX shell (private script for long source). */
  shell?: boolean;
  /** OS sandbox request: true = require, false = never, undefined = global config default. */
  sandbox?: boolean | undefined;
  /** Allow outbound network inside the sandbox (default true). */
  network?: boolean | undefined;
  /** Internal service grants; these fields are not in the public tool schemas. */
  sandboxReadablePaths?: string[];
  sandboxWritablePaths?: string[];
  /** Backend-only bounded archive input/output. Never exposed in a public tool schema. */
  inputBytes?: Buffer;
  privateOutput?: boolean;
}

export interface InlineOutput {
  content: string;
  totalBytes: number;
  truncated: boolean;
  /** Last ~4 KiB when truncated — where test summaries usually live. */
  tail?: string;
}

export class JobManager {
  mutations?: MutationQueue;
  withRecovery?: <T>(principal:string,fn:()=>Promise<T>)=>Promise<T>;
  onRecorded?: (jobId:string) => void;
  beforeStart?: (req: StartJobRequest) => Promise<void>;
  afterFinished?: (jobId:string) => Promise<unknown>;
  requiresPreparation?: () => boolean;
  private readonly prepared = new WeakSet<StartJobRequest>();

  async startProtected(req: StartJobRequest, revalidate?: () => void | Promise<void>): Promise<{ jobId: string; pid: number; sandboxed: string | null }> {
    const run = async () => {
      await this.beforeStart?.(req);
      await revalidate?.();
      this.prepared.add(req);
      try { return this.start(req); } finally { this.prepared.delete(req); }
    };
    const protectedRun=()=>this.withRecovery?this.withRecovery(req.principal,run):run();
    return this.mutations ? this.mutations.run(protectedRun) : protectedRun();
  }

  private shutdownPromise: Promise<void> | undefined;
  private readonly live = new Map<string, LiveJob>();
  private readonly finishedSpools = new Map<string, { stdout: SegmentedSpool; stderr: SegmentedSpool }>();
  private readonly exitWaiters = new Map<string, Array<() => void>>();

  constructor(
    private readonly wfs: WorkspaceFS,
    private readonly limits: Limits,
    private readonly store: Store,
    private readonly jobsDir: string,
    private readonly extraEnvAllowlist: string[],
    private readonly sandboxWrap?: SandboxWrapper,
  ) {}

  runningCount(): number {
    return this.live.size;
  }

  /** Resolve a bare program name on the trusted PATH; path-y programs resolve inside the workspace. */
  resolveProgram(program: string, _cwdAbs: string): string {
    if (program.includes('\0')) throw new DodoError('INVALID_INPUT', 'program contains NUL');
    if (program.includes('/') || program.includes('\\')) {
      // Explicit path: must stay inside the workspace (project scripts).
      const rel = this.wfs.normalizeRel(program.replace(/\\/g, '/'));
      const resolved = this.wfs.resolve(rel);
      const st = resolved.stat;
      if (!st?.isFile()) throw new DodoError('NOT_FOUND', `program not found in workspace: ${rel}`);
      return resolved.abs;
    }
    return resolveTrustedExecutable(program, this.wfs.root);
  }

  /** The POSIX shell used for `run_command` — a fixed system binary, never from the repo. */
  shellPath(): string {
    return shellSpec(this.wfs.root).executable;
  }

  start(req: StartJobRequest): { jobId: string; pid: number; sandboxed: string | null } {
    if (req.inputBytes && (req.inputBytes.length > 32 * 1024 * 1024 || req.stdin === false))
      throw new DodoError('RESOURCE_LIMIT', 'invalid internal job input budget');
    if (this.requiresPreparation?.() && !this.prepared.has(req)) throw new DodoError('RECOVERY_REQUIRED', 'job requires a source backup before spawn');
    this.mutations?.assertCanStart();
    if (this.shutdownPromise) throw new DodoError('CONFLICT', 'job manager is shutting down');
    if (this.live.size >= this.limits.jobsConcurrentMax) {
      throw new DodoError('RESOURCE_LIMIT', `at most ${this.limits.jobsConcurrentMax} concurrent jobs`, { retryable: true });
    }
    const cwdResolved = this.wfs.resolve(req.cwdRel === '' ? '.' : req.cwdRel);
    if (!cwdResolved.stat?.isDirectory()) throw new DodoError('PATH_DENIED', 'cwd is not a directory in the workspace');
    const jobId = newId('job');
    const jobDir = path.join(this.jobsDir, jobId);
    let scriptPath: string | undefined;
    let programAbs: string;
    let spawnArgs: string[];
    let windowsVerbatimArguments = false;
    let scriptContent = req.program;
    if (req.shell) {
      validateShellCommand(req.program, this.limits.commandBytes);
      const spec = shellSpec(this.wfs.root);
      spec.executable = this.shellPath();
      if (spec.kind === 'cmd' || Buffer.byteLength(req.program, 'utf8') > INLINE_COMMAND_BYTES || (process.platform === 'win32' && req.program.length > 12000)) {
        scriptPath = path.join(jobDir, `command${spec.extension}`);
      }
      if (spec.kind === 'cmd') scriptContent = '@echo off\r\nchcp 65001 >nul\r\n' + req.program.replace(/\r?\n/g, '\r\n') + '\r\n';
      const invocation = shellInvocation(spec, req.program, scriptPath);
      programAbs = invocation.program; spawnArgs = invocation.args; windowsVerbatimArguments = invocation.windowsVerbatimArguments;
    } else {
      validateExecArgs(req.program, req.args);
      programAbs = this.resolveProgram(req.program, cwdResolved.abs);
      spawnArgs = req.args;
      if (process.platform === 'win32') {
        if (/\.(cmd|bat)$/i.test(programAbs)) {
          const invocation = batchInvocation(programAbs, spawnArgs, this.wfs.root);
          programAbs = invocation.program; spawnArgs = invocation.args; windowsVerbatimArguments = true;
        } else if (!/\.(exe|com)$/i.test(programAbs)) throw new DodoError('NOT_SUPPORTED', 'Windows exec requires .exe/.com or a guarded .cmd/.bat; use node.exe to run JavaScript files');
      }
    }
    // Optional OS sandbox (macOS seatbelt / Linux bwrap) around the spawn.
    let sandboxed: string | null = null;
    if (this.sandboxWrap) {
      const wrapped = this.sandboxWrap(programAbs, spawnArgs, {
        allowNetwork: req.network ?? true, requested: req.sandbox, windowsVerbatimArguments,
        ...(scriptPath ? { privateScript: scriptPath } : {}),
        readablePaths: req.sandboxReadablePaths ?? [], writablePaths: req.sandboxWritablePaths ?? [],
      });
      if (wrapped) {
        programAbs = wrapped.program;
        spawnArgs = wrapped.args;
        sandboxed = wrapped.kind;
        windowsVerbatimArguments = wrapped.windowsVerbatimArguments ?? windowsVerbatimArguments;
      }
    }
    if (process.platform === 'win32') assertWindowsArgv(programAbs, spawnArgs, windowsVerbatimArguments);
    const timeoutMs = Math.min(req.timeoutMs ?? this.limits.jobWallTimeoutDefaultMs, this.limits.jobWallTimeoutMaxMs);
    const stdout = new SegmentedSpool(jobDir, 'stdout', this.limits.jobLogBytesPerJob);
    const stderr = new SegmentedSpool(jobDir, 'stderr', this.limits.jobLogBytesPerJob);
    const env = buildChildEnv({ parentEnv: process.env, workspaceRoot: this.wfs.root, extraAllowlist: this.extraEnvAllowlist });

    // Record ownership before launching: a failed state write must not leave
    // an untracked process or a private source file behind.
    this.store.createJob({
      id: jobId, workspaceId: req.workspaceId, epoch: req.epoch,
      principal: req.principal, kind: req.kind,
      program: req.shell ? programAbs : req.program, args: spawnArgs,
      cwd: cwdResolved.rel, recipeId: req.recipeId ?? null, timeoutMs,
    });

    if (req.privateOutput) this.store.setMeta(`private-job-output:${jobId}`, '1');

    this.onRecorded?.(jobId);
    const releaseMutation = this.mutations?.retainJob();
    let child: ChildProcess;
    let scriptCreated = false;
    try {
      if (scriptPath !== undefined) {
        // Source never enters native argv or the workspace. Keep stdin free
        // for job_input. Exclusive private files are removed when jobs close.
        fs.writeFileSync(scriptPath, scriptContent, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        scriptCreated = true;
      }
      child = spawn(programAbs, spawnArgs, {
        cwd: cwdResolved.abs,
        env,
        shell: false,
        detached: process.platform !== 'win32', // Windows cancellation uses the live owned tree
        windowsHide: true,
        windowsVerbatimArguments,
        stdio: [req.stdin === false ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      releaseMutation?.();
      if (scriptCreated && scriptPath) fs.rmSync(scriptPath, { force: true });
      stdout.close();
      stderr.close();
      this.store.updateJob(jobId, { status: 'failed_to_start', endedAt: Date.now() });
      if ((err as NodeJS.ErrnoException).code === 'E2BIG') throw new DodoError('RESOURCE_LIMIT', 'native argv/environment exceeds the OS limit; save code/data to files and pass short paths');
      throw new DodoError('INTERNAL_ERROR', `spawn failed: ${(err as Error).message}`);
    }

    let completion:Promise<unknown>|undefined;
    const observed=()=>{completion??=(this.afterFinished?.(jobId)??Promise.resolve()).catch(()=>undefined).finally(()=>releaseMutation?.());};
    child.once('close', observed);
    child.once('error', observed);
    const liveJob: LiveJob = { child, stdout, stderr, timeout: undefined, stdinOpen: req.stdin !== false, scriptPath };
    this.live.set(jobId, liveJob);

    // A process may close stdin before an asynchronous write is flushed.
    // EPIPE on that optional input channel must never crash the MCP server.
    child.stdin?.on('error', () => { const job = this.live.get(jobId); if (job) job.stdinOpen = false; });
    child.on('error', (err) => {
      stderr.write(Buffer.from(`\n[dodo] spawn error: ${err.message}\n`));
      this.finish(jobId, 'failed_to_start', null, null);
    });
    child.once('spawn', () => {
      this.store.updateJob(jobId, { pid: child.pid ?? null, startedAt: Date.now() });
    });
    child.stdout?.on('data', (chunk: Buffer) => stdout.write(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.write(chunk));
    child.on('exit', (code, signal) => {
      // Descendants can keep inherited stdio open after the parent exits.
      // Reclaim the job slot after a bounded drain instead of waiting forever.
      liveJob.exitDrainTimer = setTimeout(() => {
        if (!this.live.has(jobId)) return;
        stderr.write(Buffer.from('\n[dodo] parent exited; inherited output pipes exceeded the 2s drain budget and were closed\n'));
        child.stdout?.destroy(); child.stderr?.destroy(); child.stdin?.destroy();
        const row = this.store.getJob(jobId);
        if (row?.status === 'running') this.finish(jobId, 'exited', code, signal);
        else this.closeSpools(jobId);
      }, 2000);
      liveJob.exitDrainTimer.unref();
    });
    child.on('close', (code, signal) => {
      if (!this.live.has(jobId)) return; // an exit-drain/error handler already finalized it
      const row = this.store.getJob(jobId);
      if (row && row.status === 'running') {
        this.finish(jobId, 'exited', code, signal);
      } else {
        this.closeSpools(jobId);
      }
    });
    liveJob.timeout = setTimeout(() => {
      const row = this.store.getJob(jobId);
      if (row?.status === 'running') {
        stderr.write(Buffer.from(`\n[dodo] wall timeout after ${timeoutMs} ms; terminating\n`));
        try { this.terminate(jobId, 'timed_out'); }
        catch { stderr.write(Buffer.from('[dodo] termination failed; job is still running and requires owner attention\n')); }
      }
    }, timeoutMs);
    liveJob.timeout.unref();

    if (req.inputBytes) { liveJob.stdinOpen = false; child.stdin?.end(req.inputBytes); }

    return { jobId, pid: child.pid ?? -1, sandboxed };
  }

  /**
   * Wait until the job's process closes, or `waitMs` elapses. Resolves true
   * when the job finished within the window. The job keeps running (under its
   * own wall timeout) if the wait expires — callers then poll job_output.
   */
  waitForExit(jobId: string, waitMs: number): Promise<boolean> {
    if (!this.live.has(jobId)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const list = this.exitWaiters.get(jobId);
        if (list) {
          const idx = list.indexOf(cb);
          if (idx !== -1) list.splice(idx, 1);
        }
        resolve(false);
      }, waitMs);
      timer.unref();
      const cb = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const list = this.exitWaiters.get(jobId) ?? [];
      list.push(cb);
      this.exitWaiters.set(jobId, list);
    });
  }

  private finish(jobId: string, status: JobRow['status'], exitCode: number | null, signal: NodeJS.Signals | string | null): void {
    const row = this.store.getJob(jobId);
    if (row && (row.status === 'running' || status === 'failed_to_start')) {
      this.store.updateJob(jobId, { status, exitCode, signal: signal === null ? null : String(signal), endedAt: Date.now() });
    }
    this.closeSpools(jobId);
  }

  private closeSpools(jobId: string): void {
    const live = this.live.get(jobId);
    if (live) {
      if (live.timeout) clearTimeout(live.timeout);
      if (live.exitDrainTimer) clearTimeout(live.exitDrainTimer);
      if (live.scriptPath) {
        try { removeWithRetry(live.scriptPath); } catch { /* private crash residue is never executed on restart */ }
      }
      live.stdout.close();
      live.stderr.close();
      this.live.delete(jobId);
      this.finishedSpools.set(jobId, { stdout: live.stdout, stderr: live.stderr });
      this.enforceTotalSpoolBudget();
    }
    const waiters = this.exitWaiters.get(jobId);
    if (waiters) {
      this.exitWaiters.delete(jobId);
      for (const w of waiters) w();
    }
  }

  private enforceTotalSpoolBudget(): void {
    // Drop oldest finished spools beyond the global cap.
    let total = 0;
    const entries = [...this.finishedSpools.entries()];
    for (const [, s] of entries) total += s.stdout.totalWritten + s.stderr.totalWritten;
    while (total > this.limits.jobLogBytesTotal && entries.length > 0) {
      const [id, s] = entries.shift() as [string, { stdout: SegmentedSpool; stderr: SegmentedSpool }];
      total -= s.stdout.totalWritten + s.stderr.totalWritten;
      s.stdout.removeFiles();
      s.stderr.removeFiles();
      this.finishedSpools.delete(id);
    }
  }

  getJobChecked(jobId: string, workspaceId: string): JobRow {
    const row = this.store.getJob(jobId);
    if (!row || row.workspaceId !== workspaceId) {
      throw new DodoError('JOB_NOT_FOUND', 'unknown jobId', { detail: { jobId } });
    }
    return row;
  }

  private spoolsOf(jobId: string): { stdout: SegmentedSpool; stderr: SegmentedSpool } | undefined {
    return this.live.get(jobId) ?? this.finishedSpools.get(jobId);
  }

  output(jobId: string, workspaceId: string, stream: 'stdout' | 'stderr', offset: number, maxBytes: number): {
    content: string;
    nextOffset: number;
    truncatedBeforeOffset: number;
    endOfStream: boolean;
    status: JobRow['status'];
  } {
    const row = this.getJobChecked(jobId, workspaceId);
    this.assertPublicOutput(jobId);
    const spools = this.spoolsOf(jobId);
    if (!spools) {
      return { content: '', nextOffset: offset, truncatedBeforeOffset: 0, endOfStream: true, status: row.status };
    }
    const spool = stream === 'stdout' ? spools.stdout : spools.stderr;
    const res = spool.read(offset, Math.min(maxBytes, this.limits.toolContentBytes));
    return { ...res, endOfStream: res.endOfStream || row.status !== 'running', status: row.status };
  }

  /** Head of a stream (bounded) plus a small tail when it does not fit — for inline command results. */
  inlineOutput(jobId: string, workspaceId: string, stream: 'stdout' | 'stderr', maxBytes: number): InlineOutput {
    this.getJobChecked(jobId, workspaceId);
    this.assertPublicOutput(jobId);
    const spools = this.spoolsOf(jobId);
    if (!spools) return { content: '', totalBytes: 0, truncated: false };
    const spool = stream === 'stdout' ? spools.stdout : spools.stderr;
    const total = spool.totalWritten;
    const head = spool.read(0, maxBytes);
    const truncated = head.nextOffset < total;
    const out: InlineOutput = { content: head.content, totalBytes: total, truncated };
    if (truncated) {
      const tailBytes = 4096;
      out.tail = spool.read(Math.max(head.nextOffset, total - tailBytes), tailBytes).content;
    }
    return out;
  }

  private assertPublicOutput(jobId: string): void {
    if (this.store.getMeta(`private-job-output:${jobId}`)) throw new DodoError('FORBIDDEN', 'this job carries private adapter bytes; inspect its sanitized deployment receipt');
  }

  /** Backend-only read: completed, caller-owned and complete output; never reconstruct lost output after restart. */
  binaryOutput(jobId: string, workspaceId: string, principal: string, maxBytes: number): Buffer {
    const row = this.getJobChecked(jobId, workspaceId);
    if (row.principal !== principal) throw new DodoError('FORBIDDEN', 'private adapter job belongs to another caller');
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 32 * 1024 * 1024) throw new DodoError('RESOURCE_LIMIT', 'invalid adapter output budget');
    const spool = this.spoolsOf(jobId)?.stdout;
    if (row.status !== 'exited' || row.exitCode !== 0 || !spool) throw new DodoError('CONFLICT', 'adapter output is unavailable or incomplete; do not repeat effects');
    if (spool.totalWritten > maxBytes || spool.truncatedBeforeOffset) throw new DodoError('RESOURCE_LIMIT', 'adapter output was truncated or exceeded its budget');
    const result = spool.readBytes(0, maxBytes);
    if (!result.endOfStream || result.nextOffset !== spool.totalWritten) throw new DodoError('RECOVERY_REQUIRED', 'adapter output did not close completely');
    return result.bytes;
  }

  writeInput(jobId: string, workspaceId: string, data: string, closeStdin: boolean): { bytesWritten: number; stdinOpen: boolean } {
    const row = this.getJobChecked(jobId, workspaceId);
    if (row.status !== 'running') throw new DodoError('JOB_NOT_RUNNING', `job is ${row.status}`);
    const live = this.live.get(jobId);
    if (!live || !live.child.stdin || !live.stdinOpen) {
      throw new DodoError('JOB_NOT_RUNNING', 'job stdin is not available (pipe closed)');
    }
    const buf = Buffer.from(data, 'utf8');
    if (buf.length > 64 * 1024) throw new DodoError('RESOURCE_LIMIT', 'stdin chunk exceeds 64 KiB');
    if (buf.length > 0) live.child.stdin.write(buf);
    if (closeStdin) {
      live.child.stdin.end();
      live.stdinOpen = false;
    }
    return { bytesWritten: buf.length, stdinOpen: live.stdinOpen };
  }

  /** TERM → grace → KILL on the process group we own (spec §13). */
  cancel(jobId: string, workspaceId: string, graceMs = 5000): { status: string } {
    const row = this.getJobChecked(jobId, workspaceId);
    if (row.status !== 'running') {
      return { status: row.status };
    }
    const live = this.live.get(jobId);
    if (!live || live.child.pid === undefined) {
      // No live handle (e.g. after restart): never signal a stored PID.
      this.store.updateJob(jobId, { status: 'interrupted_on_restart', endedAt: Date.now() });
      return { status: 'interrupted_on_restart' };
    }
    this.terminate(jobId, 'canceled', graceMs);
    return { status: 'canceling' };
  }

  private terminate(jobId: string, finalStatus: 'canceled' | 'timed_out', graceMs = 5000): void {
    const live = this.live.get(jobId);
    if (!live || !live.child.pid) return;
    signalOwnedProcess(live.child, 'SIGTERM', true);
    this.store.updateJob(jobId, { status: finalStatus, endedAt: Date.now() });
    if (process.platform === 'win32') return; // explicitly hard-kill only
    const killTimer = setTimeout(() => {
      if (live.child.exitCode === null && live.child.signalCode === null) signalOwnedProcess(live.child, 'SIGKILL', true);
    }, graceMs);
    killTimer.unref();
  }

  list(workspaceId: string, limit: number): JobRow[] {
    return this.store.listJobs(workspaceId, limit);
  }

  /** Graceful shutdown: signal owned groups, bounded wait. */
  shutdown(graceMs = 3000): Promise<void> {
    if (!this.shutdownPromise) this.shutdownPromise = (async () => {
      for (const [jobId] of this.live) this.terminate(jobId, 'canceled', Math.min(graceMs, 2000));
      const deadline = Date.now() + graceMs;
      while (this.live.size > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    })();
    return this.shutdownPromise;
  }
}
