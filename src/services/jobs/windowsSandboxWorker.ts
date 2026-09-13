import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { SRT_VERSION, windowsSandboxScratchParent } from '../../platform/windowsSandbox.js';
import { ensurePrivateDirectory } from '../../platform/privateFs.js';
import { removeWithRetry } from '../../platform/fsRetry.js';
import { assertWindowsArgv } from '../../platform/shell.js';
import { isWithinPath } from '../../platform/pathPolicy.js';
import { envValue } from '../../platform/system.js';
import { assertSetupPrivatePaths } from '../../setup/managedTools.js';

const Request = z.object({
  runtimeRoot: z.string().min(1), program: z.string().min(1), args: z.array(z.string()).max(128),
  workspaceRoot: z.string().min(1), writablePaths: z.array(z.string()).max(100),
  readablePaths: z.array(z.string()).max(100).default([]), privateScript: z.string().optional(),
  windowsVerbatimArguments: z.boolean().default(false), allowNetwork: z.boolean(), ownerStateDir: z.string().min(1),
}).strict();
interface Runtime {
  SandboxManager: {
    initialize(config: unknown): Promise<void>;
    wrapWithSandboxArgv(command: string, shell: { exe: string; args: string[] }, custom?: undefined, signal?: AbortSignal, cwd?: string): Promise<{ argv: string[]; env: NodeJS.ProcessEnv }>;
    reset(): Promise<void>;
  };
}
function existingPath(value: string): string {
  if (!/^[a-z]:[\\/]/i.test(value) || value.includes('\0')) throw new Error('sandbox paths require local absolute drive paths');
  const normalized = path.resolve(value), parsed = path.parse(normalized);
  let current = parsed.root;
  for (const part of normalized.slice(parsed.root.length).split(path.sep)) {
    if (!part) continue;
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('sandbox path cannot traverse a directory link');
  }
  return fs.realpathSync.native(normalized);
}
function regular(file: string, cap = 16 * 1024 * 1024): void {
  const s = fs.lstatSync(file);
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.size > cap) throw new Error('sandbox input is not a bounded regular file');
}
async function main(): Promise<void> {
  if (process.platform !== 'win32') throw new Error('Windows sandbox worker requires Windows');
  const raw = process.argv[2] ?? '';
  if (raw.length > 200000) throw new Error('sandbox request exceeds limit');
  const request = Request.parse(JSON.parse(Buffer.from(raw, 'base64').toString('utf8')));
  const root = existingPath(request.workspaceRoot), cwd = existingPath(process.cwd());
  if (!isWithinPath(root, cwd)) throw new Error('sandbox cwd is outside the workspace');
  const ownerState = existingPath(request.ownerStateDir), runtimeRoot = existingPath(request.runtimeRoot);
  if (isWithinPath(root, runtimeRoot) || isWithinPath(root, ownerState)) throw new Error('sandbox runtime and owner state must be outside the workspace');
  regular(path.join(runtimeRoot, 'package.json'), 65536);
  const pkg = JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'package.json'), 'utf8')) as { name: string; version: string };
  if (pkg.name !== '@anthropic-ai/sandbox-runtime' || pkg.version !== SRT_VERSION) throw new Error('sandbox runtime version mismatch');
  const program = existingPath(request.program);
  const systemRoot = envValue(process.env, 'SystemRoot'); if (systemRoot) process.env['SystemRoot'] = systemRoot;
  // SRT uses one sandbox SID. Serialize DODO sessions across this OS user's
  // workspaces/config directories so their temporary ACL grants cannot overlap.
  // SQLite releases its OS lock on process death; no stale PID is ever killed.
  const serialDir = path.join(envValue(process.env, 'LOCALAPPDATA') ?? os.homedir(), 'dodo-sandbox-serialization');
  ensurePrivateDirectory(serialDir);
  const serialFile = path.join(serialDir, 'execution.db');
  if (fs.existsSync(serialFile)) assertSetupPrivatePaths([serialFile]);
  const serial = new Database(serialFile, { timeout: 120000 });
  let stage: string | undefined, runtime: Runtime | undefined;
  try {
    serial.exec('BEGIN EXCLUSIVE');
    runtime = await import(pathToFileURL(path.join(runtimeRoot, 'dist', 'index.js')).href) as Runtime;
    if (typeof runtime.SandboxManager?.initialize !== 'function' || typeof runtime.SandboxManager.wrapWithSandboxArgv !== 'function') throw new Error('sandbox API contract unavailable');
    // Do not place the sandbox launcher under the owner's private profile:
    // srt-sandbox must traverse the parent path before session ACL grants are
    // useful. ProgramData is a common traversable parent; this random leaf is
    // immediately made owner-private and granted only for this SRT session.
    stage = fs.realpathSync.native(fs.mkdtempSync(path.join(windowsSandboxScratchParent(), 'dodo-sandbox-job-')));
    ensurePrivateDirectory(stage);
    const childLauncher = path.join(stage, 'launcher.mjs');
    fs.copyFileSync(fileURLToPath(new URL('./windowsSandboxChild.js', import.meta.url)), childLauncher, fs.constants.COPYFILE_EXCL);
    let args = request.args;
    // cmd jobs are deliberately stored in private owner state. Copy ONLY the
    // current, server-selected command file, rather than granting state access.
    if (request.privateScript) {
      const source = existingPath(request.privateScript);
      const relative = path.relative(ownerState, source).replace(/\\/g, '/');
      if (!/^jobs\/job_[a-z0-9]+\/command\.(cmd|sh)$/.test(relative)) throw new Error('invalid private job source');
      regular(source);
      const copy = path.join(stage, path.basename(source)); fs.copyFileSync(source, copy, fs.constants.COPYFILE_EXCL);
      args = args.map(arg => arg.split(source).join(copy).split(source.replace(/\\/g, '/')).join(copy.replace(/\\/g, '/')));
    }
    const manifest = path.join(stage, 'command.json');
    fs.writeFileSync(manifest, JSON.stringify({ program, args, cwd, windowsVerbatimArguments: request.windowsVerbatimArguments }), { flag: 'wx', mode: 0o600 });
    const writable = [root, ...request.writablePaths.filter(p => fs.existsSync(p)).map(existingPath)];
    if (writable.some(p => [ownerState, serialDir].some(s => isWithinPath(p, s) || isWithinPath(s, p)))) throw new Error('sandbox write grants cannot include owner/control state');
    const helperDir = path.join(runtimeRoot, 'vendor', 'srt-win', process.arch);
    const srtWin = existingPath(path.join(helperDir, 'srt-win.exe')); regular(srtWin, 16 * 1024 * 1024);
    // System programs (cmd.exe, node.exe, Program Files tools) already carry
    // normal Users read/execute ACLs. Do not try to mutate protected system
    // directories. Private managed executables need an explicit service-level
    // readablePaths grant only when that service actually executes them.
    const readable = [root, stage, ...request.readablePaths.map(existingPath)];
    if (readable.some(p => p === ownerState || isWithinPath(p, ownerState) || isWithinPath(p, serialDir))) throw new Error('sandbox read grants cannot expose all owner/control state');
    // SRT performs a live WFP egress denial test before it launches a target.
    // It also reconciles stale ACL receipts after a killed previous worker.
    await runtime.SandboxManager.initialize({
      network: { allowedDomains: request.allowNetwork ? ['*'] : [], deniedDomains: [], allowLocalBinding: false },
      filesystem: { denyRead: [ownerState, serialDir], denyWrite: [], allowWrite: [...new Set(writable)], allowRead: [...new Set(readable)] },
      windows: { srtWin: { path: srtWin } },
    });
    const wrapped = await runtime.SandboxManager.wrapWithSandboxArgv('DODO_NATIVE_ARGV', { exe: process.execPath, args: [childLauncher, manifest] }, undefined, AbortSignal.timeout(30000), cwd);
    const [executable, ...brokerArgs] = wrapped.argv;
    if (!executable || !path.isAbsolute(executable) || isWithinPath(root, executable)) throw new Error('sandbox returned an unsafe broker executable');
    assertWindowsArgv(executable, brokerArgs);
    process.exitCode = await new Promise<number>((resolve, reject) => {
      const child = spawn(executable, brokerArgs, { cwd, env: wrapped.env, shell: false, windowsHide: true, stdio: 'inherit' });
      child.once('error', reject); child.once('close', code => resolve(code ?? 1));
    });
  } finally {
    try { await runtime?.SandboxManager.reset(); }
    catch { process.exitCode = 1; console.error('[dodo] sandbox ACL cleanup failed; inspect runtime recovery before another run'); }
    try { if (stage) removeWithRetry(stage, true); }
    catch { process.exitCode = 1; console.error('[dodo] sandbox private job cleanup failed'); }
    if (serial.inTransaction) serial.exec('ROLLBACK');
    serial.close();
  }
}
main().catch(error => {
  process.exitCode = 1;
  console.error(`[dodo] Windows sandbox refused execution: ${error instanceof Error ? error.message.slice(0, 500) : 'runtime failure'}`);
});
