import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DodoError } from '../errors.js';
import { resolveTrustedExecutable } from './execResolve.js';
import { isWithinPath } from './pathPolicy.js';
import { resolveConfigDir } from '../config/paths.js';
import { assertSetupPrivatePaths } from '../setup/managedTools.js';
import { buildChildEnv } from '../security/env.js';
import { windowsProgramDataDirectory } from './system.js';

export const SRT_VERSION = '0.0.75';
export const SANDBOX_RECEIPT = 'windows-sandbox-validation.json';
export const SANDBOX_CHECKS = ['workspace-write', 'outside-write-denied', 'owner-read-denied', 'direct-network-denied', 'cleanup'] as const;
/**
 * A Windows sandbox process must not execute its launcher from the owner's
 * private profile: the dedicated srt-sandbox account cannot traverse that
 * profile before session ACL grants apply. ProgramData is machine-common and
 * traversable; each actual scratch directory created below it is still made
 * owner-private before any content is written, then receives a scoped SRT
 * session grant that is removed during reset().
 */
export function windowsSandboxScratchParent(): string {
  if (process.platform !== 'win32') throw new DodoError('NOT_SUPPORTED', 'Windows sandbox scratch was requested on another OS');
  const raw = windowsProgramDataDirectory(process.env);
  if (!raw || !path.win32.isAbsolute(raw) || raw.startsWith('\\\\') || raw.includes('\0')) throw new DodoError('NOT_SUPPORTED', 'Windows sandbox requires a local ProgramData directory');
  const stat = fs.lstatSync(raw);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new DodoError('PATH_DENIED', 'ProgramData sandbox scratch parent must be a real directory');
  return fs.realpathSync.native(raw);
}
export interface WindowsSandboxRuntime {
  executable: string; packageRoot: string; provisioned: boolean;
  fence: 'installed' | 'absent' | 'cannot-read'; validated: boolean;
}
export interface SandboxValidationReceipt {
  version: 1; runtimeVersion: string; fingerprint: string; checks: string[];
  passed: boolean; checkedAt: string; platform: 'win32';
}
interface RawWindowsSandboxStatus {
  user?: {
    cred_present?: boolean; marker_version?: number; marker_user_sid?: string;
    user?: { exists?: boolean; group_exists?: boolean; in_builtin_users?: boolean; in_sandbox_group?: boolean; hidden_from_logon?: boolean; sid?: string };
  };
  wfp?: { state?: string; user_sid?: string };
}
/** Parse the exact JSON contract emitted by pinned srt-win 0.0.75. */
export function parseWindowsSandboxStatus(value: unknown): { provisioned: boolean; fence: WindowsSandboxRuntime['fence'] } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const status = value as RawWindowsSandboxStatus;
  const fence = status.wfp?.state;
  if (!['installed', 'absent', 'cannot-read'].includes(fence ?? '')) return undefined;
  const outer = status.user, account = outer?.user, sid = account?.sid;
  const provisioned = outer?.cred_present === true
    && Number.isInteger(outer.marker_version) && (outer.marker_version ?? 0) >= 1
    && typeof sid === 'string' && /^S-1-5-(?:\d+-)+\d+$/.test(sid)
    && outer.marker_user_sid === sid
    && account?.exists === true && account.group_exists === true
    && account.in_builtin_users === true && account.in_sandbox_group === true
    && account.hidden_from_logon === true
    && (fence !== 'installed' || status.wfp?.user_sid === sid);
  return { provisioned, fence: fence as WindowsSandboxRuntime['fence'] };
}
function regularBytes(file: string): Buffer {
  const s = fs.lstatSync(file);
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.size > 64 * 1024 * 1024) throw new Error('unsafe sandbox file');
  return fs.readFileSync(file);
}
/** A receipt becomes stale after changing the runtime, launcher, architecture or Node ABI. */
export function sandboxFingerprint(executable: string): string {
  const hash = createHash('sha256').update(`${SRT_VERSION}:${process.arch}:${process.versions.node}`);
  for (const file of [executable, fileURLToPath(new URL('../services/jobs/windowsSandboxWorker.js', import.meta.url)), fileURLToPath(new URL('../services/jobs/windowsSandboxChild.js', import.meta.url))]) {
    hash.update(file); hash.update(regularBytes(file));
  }
  return hash.digest('hex');
}
export function validSandboxReceipt(value: unknown, fingerprint: string): value is SandboxValidationReceipt {
  if (!value || typeof value !== 'object') return false;
  const r = value as Partial<SandboxValidationReceipt>;
  return r.version === 1 && r.platform === 'win32' && r.runtimeVersion === SRT_VERSION && r.passed === true && r.fingerprint === fingerprint
    && Array.isArray(r.checks) && SANDBOX_CHECKS.every(check => r.checks!.includes(check)) && typeof r.checkedAt === 'string' && Number.isFinite(Date.parse(r.checkedAt));
}
export function hasSandboxReceipt(executable: string, ownerStateDir: string): boolean {
  try {
    const receipt = path.join(ownerStateDir, SANDBOX_RECEIPT);
    assertSetupPrivatePaths([ownerStateDir, receipt]);
    if (fs.statSync(receipt).size > 16384) return false;
    return validSandboxReceipt(JSON.parse(regularBytes(receipt).toString('utf8')), sandboxFingerprint(executable));
  } catch { return false; }
}
/** Read-only native status; never installs, repairs ACLs, prompts for UAC or trusts a marker alone. */
export function findWindowsSandbox(root: string, ownerStateDir = resolveConfigDir(process.env).dir): WindowsSandboxRuntime | undefined {
  if (process.platform !== 'win32') return undefined;
  try {
    const executable = resolveTrustedExecutable('srt-win.exe', root, { allowBatch: false });
    let directory = path.dirname(executable);
    for (let depth = 0; depth < 5; depth++, directory = path.dirname(directory)) {
      const manifest = path.join(directory, 'package.json');
      if (!fs.existsSync(manifest)) continue;
      const pkg = JSON.parse(regularBytes(manifest).toString('utf8')) as { name?: string; version?: string };
      if (pkg.name !== '@anthropic-ai/sandbox-runtime' || pkg.version !== SRT_VERSION) continue;
      if (isWithinPath(root, directory)) return undefined;
      const probe = spawnSync(executable, ['status'], { cwd: directory, env: buildChildEnv({ parentEnv: process.env, workspaceRoot: root, extraAllowlist: [] }), shell: false, windowsHide: true, encoding: 'utf8', timeout: 10000, maxBuffer: 65536 });
      if (probe.error || probe.status !== 0) return undefined;
      const status = parseWindowsSandboxStatus(JSON.parse(probe.stdout));
      if (!status) return undefined;
      return { executable, packageRoot: directory, provisioned: status.provisioned,
        fence: status.fence, validated: hasSandboxReceipt(executable, ownerStateDir) };
    }
  } catch { /* No readiness claim; execution fails closed and setup reports the missing prerequisite. */ }
  return undefined;
}
export interface WindowsSandboxRequest {
  runtimeRoot: string; program: string; args: string[]; windowsVerbatimArguments: boolean;
  workspaceRoot: string; writablePaths: string[]; readablePaths: string[]; privateScript?: string;
  allowNetwork: boolean; ownerStateDir: string;
}
export function windowsSandboxInvocation(program: string, args: string[], options: {
  workspaceRoot: string; writablePaths?: string[]; allowNetwork?: boolean; ownerStateDir?: string;
  windowsVerbatimArguments?: boolean; readablePaths?: string[]; privateScript?: string;
}, validating = false): { program: string; args: string[] } {
  if (!options.ownerStateDir) throw new DodoError('NOT_SUPPORTED', 'Windows sandbox requires an explicit owner-state boundary');
  const runtime = findWindowsSandbox(options.workspaceRoot, options.ownerStateDir);
  if (!runtime?.provisioned || runtime.fence === 'absent' || (!validating && !runtime.validated))
    throw new DodoError('NOT_SUPPORTED', 'Windows sandbox requires local installation and successful confinement checks; run dodo setup --components sandbox');
  const request: WindowsSandboxRequest = { runtimeRoot: runtime.packageRoot, program, args, windowsVerbatimArguments: options.windowsVerbatimArguments ?? false,
    workspaceRoot: options.workspaceRoot, writablePaths: options.writablePaths ?? [], readablePaths: options.readablePaths ?? [],
    ...(options.privateScript ? { privateScript: options.privateScript } : {}),
    allowNetwork: options.allowNetwork ?? true, ownerStateDir: options.ownerStateDir };
  return { program: process.execPath, args: [fileURLToPath(new URL('../services/jobs/windowsSandboxWorker.js', import.meta.url)), Buffer.from(JSON.stringify(request), 'utf8').toString('base64')] };
}
