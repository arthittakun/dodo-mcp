import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { DodoError } from '../errors.js';
import { ensurePrivateDirectory } from '../platform/privateFs.js';
import { renameWithRetry, removeWithRetry } from '../platform/fsRetry.js';
import { windowsSystemExecutable } from '../platform/system.js';
import { signalOwnedProcess } from '../platform/processTree.js';
import { buildChildEnv } from '../security/env.js';
import { wrapInSandbox } from '../services/jobs/sandbox.js';
import { windowsSandboxInvocation, windowsSandboxScratchParent, findWindowsSandbox, sandboxFingerprint, SANDBOX_RECEIPT, SANDBOX_CHECKS, type SandboxValidationReceipt } from '../platform/windowsSandbox.js';

/** Fixed synthetic test. No owner files are discovered or read. */
const PROBE = String.raw`
const fs = require('node:fs'), net = require('node:net');
const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
(async () => {
  const checks = {};
  fs.writeFileSync('workspace-write.txt', 'DODO sandbox fixture', { flag: 'wx' });
  checks['workspace-write'] = fs.readFileSync('workspace-write.txt', 'utf8') === 'DODO sandbox fixture';
  try { fs.writeFileSync(spec.outside, 'must be denied', { flag: 'wx' }); checks['outside-write-denied'] = false; }
  catch (e) { checks['outside-write-denied'] = ['EACCES', 'EPERM', 'EROFS'].includes(e.code); }
  try { fs.readFileSync(spec.owner); checks['owner-read-denied'] = false; }
  catch (e) { checks['owner-read-denied'] = ['EACCES', 'EPERM'].includes(e.code); }
  // A live host listener was checked before launching this child. Timeouts
  // are NOT evidence of confinement; only deterministic OS denial counts.
  const networkCode = await new Promise(resolve => {
    const s = net.createConnection({host:'127.0.0.1',port:spec.port});
    s.setTimeout(4000, () => { s.destroy(); resolve('TIMEOUT'); });
    s.once('connect', () => { s.destroy(); resolve('CONNECTED'); });
    s.once('error', e => resolve(e.code));
  });
  checks['direct-network-denied'] = (process.platform === 'win32' ? ['EACCES','EPERM'] : ['EACCES','EPERM','ENETUNREACH','ECONNREFUSED']).includes(networkCode);
  console.log('DODO_SANDBOX_PROBE ' + JSON.stringify({checks,networkCode}));
  // POSIX adapter explicitly limits writes/network, not reads. Do not
  // pretend it enforces the stronger Windows owner-profile isolation.
  const required = process.platform === 'win32' ? Object.values(checks) : Object.entries(checks).filter(([k]) => k !== 'owner-read-denied').map(([,v]) => v);
  process.exitCode = required.every(Boolean) ? 0 : 1;
})().catch(() => { process.exitCode = 1; });
`;
const ACL_SNAPSHOT = String.raw`
$ErrorActionPreference='Stop'
$r=@(); foreach($p in (ConvertFrom-Json $env:DODO_PROBE_PATHS)) {
  $a=Get-Acl -LiteralPath $p
  $r+= $a.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)
}
ConvertTo-Json -InputObject $r -Compress
`;
function aclSnapshot(paths: string[]): string {
  if (process.platform !== 'win32') return JSON.stringify(paths.map(p => ({ mode: fs.statSync(p).mode, uid: fs.statSync(p).uid })));
  const r = spawnSync(windowsSystemExecutable('WindowsPowerShell/v1.0/powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ACL_SNAPSHOT, 'utf16le').toString('base64')], {
    shell: false, windowsHide: true, encoding: 'utf8', timeout: 15000, maxBuffer: 65536,
    env: { ...buildChildEnv({ parentEnv: process.env, workspaceRoot: os.tmpdir(), extraAllowlist: [] }), DODO_PROBE_PATHS: JSON.stringify(paths) },
  });
  if (r.error || r.status !== 0) throw new Error('sandbox fixture ACL could not be inspected');
  return JSON.stringify(JSON.parse(r.stdout));
}
async function run(program: string, args: string[], cwd: string, timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32', env: buildChildEnv({ parentEnv: process.env, workspaceRoot: cwd, extraAllowlist: [] }), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', failure: Error | undefined;
    const stop = () => { try { signalOwnedProcess(child, 'SIGKILL'); } catch { /* reject the probe, never retry without confinement */ } };
    const timer = setTimeout(() => { failure = new Error('sandbox verification timed out'); stop(); }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); if (stdout.length > 65536) { failure = new Error('sandbox probe output exceeded limit'); stop(); } });
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-8000); });
    child.once('error', e => { clearTimeout(timer); reject(e); });
    child.once('close', code => { clearTimeout(timer); if (failure) reject(failure); else resolve({ code, stdout, stderr }); });
  });
}
export interface ConfinementResult { platform: string; checkedAt: string; checks: string[]; networkCode: string; passed: true }
/** Run the real adapter in disposable directories; a failed probe cannot create a success receipt. */
export async function verifySandbox(configDir: string, workspaceRoot = process.cwd()): Promise<ConfinementResult> {
  ensurePrivateDirectory(configDir);
  const id = randomUUID();
  const scratchParent = process.platform === 'win32' ? windowsSandboxScratchParent() : os.tmpdir();
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(scratchParent, 'dodo-confinement-')));
  const outside = process.platform === 'win32'
    ? fs.realpathSync.native(fs.mkdtempSync(path.join(scratchParent, 'dodo-confinement-outside-')))
    : path.join(os.homedir(), `.dodo-confinement-${id}`);
  const owner = path.join(configDir, `sandbox-probe-${id}.txt`);
  // On Windows the project must be a direct child of a machine-common,
  // traversable parent. The leaf itself is still owner-private until SRT
  // applies the temporary allowWrite grant used by the real adapter.
  const project = process.platform === 'win32' ? base : path.join(base, 'project');
  ensurePrivateDirectory(project);
  if (process.platform !== 'win32') fs.mkdirSync(outside, { mode: 0o700 });
  fs.writeFileSync(owner, 'synthetic DODO fixture; not a credential', { flag: 'wx', mode: 0o600 });
  const listener = net.createServer(socket => socket.end());
  let listening = false, success: ConfinementResult | undefined;
  try {
    await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); }); listening = true;
    const address = listener.address(); if (!address || typeof address === 'string') throw new Error('probe listener has no address');
    if (address.port >= 60080 && address.port <= 60089) throw new Error('probe randomly selected a reserved proxy port; rerun setup');
    // Positive control: the same destination must be reachable without the sandbox.
    await new Promise<void>((resolve, reject) => {
      const s = net.createConnection(address.port, '127.0.0.1');
      s.setTimeout(3000, () => { s.destroy(); reject(new Error('positive network control timed out')); });
      s.once('error', reject); s.once('connect', () => { s.destroy(); resolve(); });
    });
    const script = path.join(project, 'probe.cjs'), spec = path.join(project, 'input.json');
    fs.writeFileSync(script, PROBE, { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(spec, JSON.stringify({ owner, outside: path.join(outside, 'forbidden.txt'), port: address.port }), { flag: 'wx', mode: 0o600 });
    const watched = [project, script, spec, configDir, owner];
    const before = aclSnapshot(watched);
    const wrapped = process.platform === 'win32'
      ? windowsSandboxInvocation(process.execPath, [script, spec], { workspaceRoot: project, ownerStateDir: configDir, allowNetwork: false }, true)
      : wrapInSandbox(process.execPath, [script, spec], { workspaceRoot: project, ownerStateDir: configDir, writablePaths: [], allowNetwork: false });
    const result = await run(wrapped.program, wrapped.args, project, 120000);
    const record = result.stdout.split(/\r?\n/).find(line => line.startsWith('DODO_SANDBOX_PROBE '));
    if (result.code !== 0 || !record) throw new DodoError('NOT_SUPPORTED', `sandbox confinement probe failed (exit ${result.code}); ${result.stderr.slice(-2000)}`);
    const parsed = JSON.parse(record.slice('DODO_SANDBOX_PROBE '.length)) as { checks: Record<string, boolean>; networkCode: string };
    const required = process.platform === 'win32' ? SANDBOX_CHECKS.filter(c => c !== 'cleanup') : ['workspace-write', 'outside-write-denied', 'direct-network-denied'];
    if (!required.every(check => parsed.checks[check] === true)) throw new Error('sandbox result did not prove every required check');
    if (fs.existsSync(path.join(outside, 'forbidden.txt'))) throw new Error('sandbox allowed an outside write');
    if (aclSnapshot(watched) !== before) throw new Error('sandbox cleanup did not restore fixture/owner ACLs');
    success = { platform: process.platform, checkedAt: new Date().toISOString(), checks: [...required, 'cleanup'], networkCode: parsed.networkCode, passed: true };
  } finally {
    if (listening) await new Promise<void>(resolve => listener.close(() => resolve()));
    // Delete only this invocation's synthetic files, never owner state itself.
    fs.unlinkSync(owner); removeWithRetry(base, true); removeWithRetry(outside, true);
  }
  if (!success) throw new Error('sandbox verification produced no result');
  if (process.platform === 'win32') {
    const runtime = findWindowsSandbox(workspaceRoot, configDir); if (!runtime) throw new Error('sandbox runtime disappeared after verification');
    const receipt: SandboxValidationReceipt = { version: 1, runtimeVersion: '0.0.75', fingerprint: sandboxFingerprint(runtime.executable), checks: success.checks, passed: true, checkedAt: success.checkedAt, platform: 'win32' };
    const target = path.join(configDir, SANDBOX_RECEIPT), temp = `${target}.${id}.tmp`;
    if (fs.existsSync(target)) { const s = fs.lstatSync(target); if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1) throw new Error('unsafe sandbox receipt target'); }
    fs.writeFileSync(temp, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    try { renameWithRetry(temp, target); } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  }
  return success;
}
