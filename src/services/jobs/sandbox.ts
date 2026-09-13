import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DodoError } from '../../errors.js';
import { findWindowsSandbox, windowsSandboxInvocation } from '../../platform/windowsSandbox.js';
import { trustedPath } from '../../security/env.js';

/**
 * OS sandbox adapter for job execution (Codex-CLI style). Pure profile/argv
 * builders — the caller (JobManager) still performs the `spawn`; this module
 * only rewrites `program` + `args` so the child runs under an OS-enforced
 * policy:
 *
 * - file WRITES are confined to the workspace root, the system temp dirs,
 *   `/dev` (ptys, /dev/null) and an explicit list of extra writable paths
 *   (tool caches etc.). Reads are not restricted — secrets stay protected by
 *   the env whitelist (security/env.ts) and the path policy, not by this.
 * - network can be denied outright.
 *
 * macOS: `/usr/bin/sandbox-exec` with a generated seatbelt (SBPL) profile.
 *   sandbox-exec applies the profile and then execs the target in place, so
 *   the PID / process group JobManager tracks is the real program.
 * Linux: `bwrap` (bubblewrap) when found on the trusted PATH. The whole
 *   filesystem is bound read-only with read-write binds for the allowed set.
 *   bwrap stays the parent of the program; JobManager signals the whole
 *   process group and `--die-with-parent` covers the remainder.
 */
export type SandboxKind = 'macos-seatbelt' | 'linux-bwrap' | 'windows-srt';

export interface SandboxRequest {
  /** Absolute workspace root (realpath; re-resolved defensively here). */
  workspaceRoot: string;
  /** Extra absolute paths that may be written (caches etc.). Entries that do not exist are skipped. */
  writablePaths: string[];
  allowNetwork: boolean;
  ownerStateDir?: string;
  readablePaths?: string[];
  privateScript?: string;
  windowsVerbatimArguments?: boolean;
}

export interface SandboxAvailability {
  available: boolean;
  kind?: SandboxKind;
  reason?: string;
}

export interface WrappedSpawn {
  program: string;
  args: string[];
  kind: SandboxKind;
  windowsVerbatimArguments?: boolean;
  /** The generated seatbelt profile (macOS only) — useful for diagnostics. */
  profile?: string;
}

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

/**
 * `trustedPath` drops PATH entries that live inside a workspace root. When
 * locating the sandbox binary no workspace is known, so pass a root nothing
 * can live under (a character device has no children): the effect is just
 * "absolute entries only, with the system default fallback".
 */
const NO_WORKSPACE = '/dev/null/no-workspace';

function isExecutableFile(p: string): boolean {
  try {
    const st = fs.statSync(p);
    return st.isFile() && (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function findBwrap(env: NodeJS.ProcessEnv): string | undefined {
  for (const dir of trustedPath(env['PATH'], NO_WORKSPACE).split(path.delimiter)) {
    const candidate = path.join(dir, 'bwrap');
    if (isExecutableFile(candidate)) return candidate;
  }
  return undefined;
}

export function sandboxAvailability(env: NodeJS.ProcessEnv = process.env, ownerStateDir?: string, workspaceRoot = process.cwd()): SandboxAvailability {
  switch (process.platform) {
    case 'darwin':
      if (isExecutableFile(SANDBOX_EXEC)) return { available: true, kind: 'macos-seatbelt' };
      return { available: false, reason: `${SANDBOX_EXEC} is missing or not executable` };
    case 'linux':
      if (findBwrap(env) !== undefined) return { available: true, kind: 'linux-bwrap' };
      return { available: false, reason: 'bwrap (bubblewrap) not found on the trusted PATH' };
    case 'win32': {
      const runtime = findWindowsSandbox(workspaceRoot, ownerStateDir);
      return runtime?.provisioned && runtime.fence !== 'absent' && runtime.validated
        ? { available: true, kind: 'windows-srt' }
        : { available: false, reason: 'Windows sandbox needs local setup and a successful confinement probe; run dodo setup --components sandbox' };
    }
    default:
      return { available: false, reason: `no OS sandbox adapter for platform ${process.platform}` };
  }
}

function realpathIfExists(p: string): string | undefined {
  try {
    return fs.realpathSync(p);
  } catch {
    return undefined;
  }
}

function isWithin(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function resolveRoot(req: SandboxRequest): string {
  if (req.workspaceRoot.includes('\0') || !path.isAbsolute(req.workspaceRoot)) {
    throw new DodoError('INVALID_INPUT', 'workspaceRoot must be an absolute path');
  }
  const real = realpathIfExists(req.workspaceRoot);
  if (real === undefined || !fs.statSync(real).isDirectory()) {
    throw new DodoError('NOT_FOUND', `workspaceRoot is not an existing directory: ${req.workspaceRoot}`);
  }
  return real;
}

/** Extra writable paths: must be absolute; realpath'd when they exist, skipped otherwise. */
function resolveWritable(req: SandboxRequest): string[] {
  const out: string[] = [];
  for (const p of req.writablePaths) {
    if (p.includes('\0') || !path.isAbsolute(p)) {
      throw new DodoError('INVALID_INPUT', `writable path must be absolute: ${JSON.stringify(p)}`);
    }
    const real = realpathIfExists(p);
    if (real !== undefined && !out.includes(real)) out.push(real);
  }
  return out;
}

/** SBPL string literal: only `"` and `\` need escaping. */
function sbplString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Seatbelt profile: allow everything, then deny all file writes, then re-allow
 * writes under the workspace, the temp dirs, /dev and each extra writable path.
 * Later rules win in SBPL, so the order below is load-bearing.
 */
export function seatbeltProfile(req: SandboxRequest): string {
  const root = resolveRoot(req);
  const writable = new Set<string>([root, '/private/tmp', '/tmp']);
  const tmp = realpathIfExists(os.tmpdir());
  if (tmp !== undefined) writable.add(tmp); // /private/var/folders/<..>/T on macOS
  writable.add('/dev');
  for (const p of resolveWritable(req)) writable.add(p);

  const lines = ['(version 1)', '(allow default)', '(deny file-write*)'];
  for (const p of writable) lines.push(`(allow file-write* (subpath ${sbplString(p)}))`);
  lines.push(`(allow file-write* (literal ${sbplString('/dev/null')}))`);
  if (!req.allowNetwork) lines.push('(deny network*)');
  return `${lines.join('\n')}\n`;
}

/**
 * bubblewrap argv (everything after `bwrap`): the whole tree read-only, with
 * read-write binds for the workspace, /tmp (plus $TMPDIR when it lives
 * elsewhere) and each existing extra writable path. Pure — exported so the
 * shape can be unit-tested on machines without bwrap.
 */
export function bwrapArgs(req: SandboxRequest, program: string, args: string[]): string[] {
  const root = resolveRoot(req);
  const argv = ['--ro-bind', '/', '/', '--bind', root, root, '--bind', '/tmp', '/tmp', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/run'];
  const binds = new Set<string>();
  const tmp = realpathIfExists(os.tmpdir());
  if (tmp !== undefined && !isWithin('/tmp', tmp) && !isWithin(root, tmp)) binds.add(tmp);
  for (const p of resolveWritable(req)) binds.add(p);
  for (const p of binds) argv.push('--bind', p, p);
  if (!req.allowNetwork) argv.push('--unshare-net');
  argv.push('--die-with-parent', '--', program, ...args);
  return argv;
}

/** Rewrite a spawn so `program args` runs inside the OS sandbox; throws NOT_SUPPORTED when none is available. */
export function wrapInSandbox(program: string, args: string[], req: SandboxRequest): WrappedSpawn {
  const avail = sandboxAvailability(process.env, req.ownerStateDir, req.workspaceRoot);
  if (!avail.available || avail.kind === undefined) {
    throw new DodoError('NOT_SUPPORTED', `OS sandbox unavailable: ${avail.reason ?? 'unknown reason'}`, {
      recovery:
        process.platform === 'linux'
          ? 'install bubblewrap (bwrap) and make sure it is on the PATH, or run the job unsandboxed'
          : 'OS sandboxing needs macOS (sandbox-exec) or Linux (bwrap); otherwise run the job unsandboxed',
    });
  }
  if (avail.kind === 'macos-seatbelt') {
    const profile = seatbeltProfile(req);
    return { program: SANDBOX_EXEC, args: ['-p', profile, program, ...args], kind: 'macos-seatbelt', profile };
  }
  if (avail.kind === 'windows-srt') return { ...windowsSandboxInvocation(program, args, req), kind: 'windows-srt', windowsVerbatimArguments: false };
  const bwrap = findBwrap(process.env);
  if (bwrap === undefined) throw new DodoError('NOT_SUPPORTED', 'OS sandbox unavailable: bwrap vanished from the PATH');
  return { program: bwrap, args: bwrapArgs(req, program, args), kind: 'linux-bwrap' };
}
