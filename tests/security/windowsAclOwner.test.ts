import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensurePrivateDirectory, assertPrivatePath } from '../../src/platform/privateFs.js';
import { windowsSystemExecutable } from '../../src/platform/system.js';
import { removeWithRetry } from '../../src/platform/fsRetry.js';
import { ipcSocketPath } from '../../src/config/paths.js';
import { credentialPath } from '../../src/ipc/authentication.js';
import { startIpcServer } from '../../src/ipc/server.js';
import { ipcCall } from '../../src/ipc/client.js';
import { windowsPrivateAclDiagnostics } from '../../src/platform/windowsPrivateAcl.js';

const ADMIN = 'S-1-5-32-544';
const FOREIGN = 'S-1-5-18'; // SYSTEM is permitted as a trustee, NOT as an initial owner.
const T = 120000;

// These tests change ONLY disposable fixtures. Native Windows + an enabled
// Administrators token are required. POSIX skips are never Windows evidence.
function powershell(source: string, target = ''): string {
  return execFileSync(windowsSystemExecutable('WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from("$ErrorActionPreference = 'Stop'\n" + source, 'utf16le').toString('base64')],
    { env: { ...process.env, DODO_ACL_TEST_PATH: target }, shell: false, windowsHide: true, timeout: 15000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function setOwner(target: string, sid: string): void {
  execFileSync(windowsSystemExecutable('icacls.exe'), [target, '/setowner', `*${sid}`, '/q'],
    { shell: false, windowsHide: true, timeout: 15000, stdio: 'pipe' });
  expect(security(target).owner, 'fixture owner must really change on NTFS').toBe(sid);
}
function security(target: string): { owner: string; dacl: string; allowed: string[] } {
  return JSON.parse(powershell(`
$a = Get-Acl -LiteralPath $env:DODO_ACL_TEST_PATH
$rules = $a.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
$allow = @($rules | Where-Object { $_.AccessControlType -eq 'Allow' } | ForEach-Object { $_.IdentityReference.Value })
@{ owner = $a.GetOwner([Security.Principal.SecurityIdentifier]).Value; dacl = $a.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access); allowed = $allow } | ConvertTo-Json -Compress
`, target)) as { owner: string; dacl: string; allowed: string[] };
}
const close = (server: net.Server) => new Promise<void>(resolve => server.close(() => resolve()));

describe.skipIf(process.platform !== 'win32')('native Windows Administrators-owned state regression', () => {
  let base: string, sid: string, serial = 0;
  beforeAll(() => {
    const identity = JSON.parse(powershell(`
$i = [Security.Principal.WindowsIdentity]::GetCurrent()
$p = [Security.Principal.WindowsPrincipal]::new($i)
@{ sid = $i.User.Value; admin = $p.IsInRole([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')) } | ConvertTo-Json -Compress
`)) as { sid: string; admin: boolean };
    // Do not silently skip owner-fixture failures on a native runner.
    expect(identity.admin, 'run native ACL owner tests with an enabled Administrators token').toBe(true);
    sid = identity.sid;
    base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dodo-acl081-')));
    ensurePrivateDirectory(base);
  }, T);
  afterAll(() => { if (base) removeWithRetry(base, true); }, T);

  function directory(): string {
    const dir = path.join(base, `case-${++serial}-ไทย space`);
    fs.mkdirSync(dir);
    return dir;
  }
  function expectPrivate(target: string): void {
    const actual = security(target);
    expect(actual.owner).toBe(sid);
    expect(actual.allowed).toContain(sid);
    expect(actual.allowed.every(value => [sid, ADMIN, FOREIGN].includes(value))).toBe(true);
  }

  it('rereads every DACL using the compiled inbox helper, without starting PowerShell for each check', () => {
    const dir = directory();ensurePrivateDirectory(dir);
    const file = path.join(dir,'fresh-dacl.txt');fs.writeFileSync(file,'fixture');
    const before = windowsPrivateAclDiagnostics(), started = Date.now();
    for(let n=0;n<20;n++)assertPrivatePath(file);
    const after = windowsPrivateAclDiagnostics();
    expect(after.backend, JSON.stringify(after)).toBe('native-dotnet');
    expect(after.nativeCalls-before.nativeCalls).toBe(20);
    expect(after.bootstrapCalls).toBe(before.bootstrapCalls);
    console.log(JSON.stringify({privateAclProbe:{checks:20,elapsedMs:Date.now()-started,backend:after.backend}}));
    // The next call must notice changed permissions immediately, not a TTL cache.
    const icacls=windowsSystemExecutable('icacls.exe');
    execFileSync(icacls,[file,'/grant','*S-1-1-0:(R)','/q'],{stdio:'pipe',timeout:15000});
    try{expect(()=>assertPrivatePath(file)).toThrow(/ACL could not be established or verified/);}
    finally{execFileSync(icacls,[file,'/remove:g','*S-1-1-0','/q'],{stdio:'pipe',timeout:15000});}
    assertPrivatePath(file);
  }, T);

  it('protect normalizes an initial Administrators owner and establishes the private DACL', () => {
    const dir = directory();
    setOwner(dir, ADMIN);
    ensurePrivateDirectory(dir);
    expectPrivate(dir);
    ensurePrivateDirectory(dir); // current-user owner and repeat bootstrap still work
    expectPrivate(dir);
  }, T);

  it('repeated protection preserves a canonical ACL and still repairs newly permissive permissions', () => {
    const dir = directory();ensurePrivateDirectory(dir);
    const before = security(dir);
    ensurePrivateDirectory(dir);
    expect(security(dir)).toEqual(before);
    const icacls = windowsSystemExecutable('icacls.exe');
    execFileSync(icacls, [dir, '/grant', '*S-1-1-0:(R)', '/q'], {stdio:'pipe',timeout:15000});
    expect(()=>assertPrivatePath(dir,true)).toThrow(/ACL could not be established or verified/);
    ensurePrivateDirectory(dir);
    expectPrivate(dir);
    expect(security(dir).dacl).toBe(before.dacl);
  }, T);

  it('the PowerShell fallback uses the same fresh canonical policy and rejects widened ACLs', () => {
    const source = fs.readFileSync(new URL('../../src/platform/privateFs.ts', import.meta.url), 'utf8');
    const script = /const ACL_SCRIPT = String\.raw`([\s\S]*?)`;/u.exec(source)?.[1];
    expect(script).toBeTruthy();
    const dir = directory();
    const run = (mode: 'protect' | 'verify') => execFileSync(windowsSystemExecutable('WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script!, 'utf16le').toString('base64')],
      {env:{...process.env,DODO_PRIVATE_PATH:dir,DODO_PRIVATE_MODE:mode},stdio:'pipe',encoding:'utf8',timeout:15000});
    expect(run('protect')).toBe('private');
    const before = security(dir);
    expect(run('protect')).toBe('private');
    expect(security(dir)).toEqual(before);
    const icacls = windowsSystemExecutable('icacls.exe');
    execFileSync(icacls,[dir,'/grant','*S-1-1-0:(R)','/q'],{stdio:'pipe',timeout:15000});
    expect(()=>run('verify')).toThrow();
    expect(run('protect')).toBe('private');
    expectPrivate(dir);
    expect(security(dir).dacl).toBe(before.dacl);
  }, T);

  it.each(['directory', 'file'] as const)('verify repairs an Administrators-owned %s without changing its DACL', kind => {
    const dir = directory(); ensurePrivateDirectory(dir);
    const target = kind === 'directory' ? dir : path.join(dir, "credential 'ไทย'; $data.auth");
    if (kind === 'file') fs.writeFileSync(target, 'synthetic fixture', { flag: 'wx' });
    setOwner(target, ADMIN);
    const before = security(target);
    const verified = assertPrivatePath(target, kind === 'directory');
    // Set-Acl's owner repair may update ctime; consumers must receive the
    // post-verification metadata used by journal integrity comparisons.
    const live = fs.lstatSync(target);
    expect({ dev: verified.dev, ino: verified.ino, ctimeMs: verified.ctimeMs, mtimeMs: verified.mtimeMs, size: verified.size })
      .toEqual({ dev: live.dev, ino: live.ino, ctimeMs: live.ctimeMs, mtimeMs: live.mtimeMs, size: live.size });
    expectPrivate(target);
    expect(security(target).dacl).toBe(before.dacl);
    assertPrivatePath(target, kind === 'directory'); // idempotent verification
    if (kind === 'file') expect(fs.readFileSync(target, 'utf8')).toBe('synthetic fixture');
  }, T);

  it('authenticated IPC works after both directory and newly created descriptor get the group owner', async () => {
    const dir = directory(); ensurePrivateDirectory(dir);
    const locator = ipcSocketPath(dir, 'owner081');
    const server = await startIpcServer(locator, async (cmd, args) => ({ cmd, args }));
    try {
      setOwner(path.dirname(locator), ADMIN);
      setOwner(credentialPath(locator), ADMIN);
      expect(await ipcCall(locator, 'status', { fixture: true }, 20000)).toEqual({ cmd: 'status', args: { fixture: true } });
      expectPrivate(path.dirname(locator));
      expectPrivate(credentialPath(locator));
    } finally { await close(server); }
    expect(fs.existsSync(credentialPath(locator))).toBe(false);
  }, T);

  it.each(['protect', 'verify-directory', 'verify-file'] as const)('%s rejects a foreign owner even with an otherwise private DACL', mode => {
    const dir = directory(); ensurePrivateDirectory(dir);
    const target = mode === 'verify-file' ? path.join(dir, 'foreign.auth') : dir;
    if (mode === 'verify-file') fs.writeFileSync(target, 'synthetic fixture', { flag: 'wx' });
    try {
      setOwner(target, FOREIGN);
      const before = security(target);
      expect(() => mode === 'protect' ? ensurePrivateDirectory(target) : assertPrivatePath(target, mode === 'verify-directory')).toThrow(/ACL could not be established or verified/);
      expect(security(target)).toEqual(before); // no repair/takeover of a foreign object
    } finally { setOwner(target, sid); }
  }, T);

  it('verify rejects a permissive DACL before repairing an Administrators owner', () => {
    const dir = directory(); ensurePrivateDirectory(dir);
    const target = path.join(dir, 'not-private.auth');
    fs.writeFileSync(target, 'synthetic fixture', { flag: 'wx' });
    setOwner(target, ADMIN);
    const icacls = windowsSystemExecutable('icacls.exe');
    try {
      execFileSync(icacls, [target, '/grant', '*S-1-1-0:(R)', '/q'], { shell: false, windowsHide: true, timeout: 15000, stdio: 'pipe' });
      const before = security(target);
      expect(before.allowed).toContain('S-1-1-0');
      expect(() => assertPrivatePath(target)).toThrow(/ACL could not be established or verified/);
      expect(security(target)).toEqual(before); // neither owner nor DACL is silently repaired
    } finally {
      execFileSync(icacls, [target, '/remove:g', '*S-1-1-0', '/q'], { shell: false, windowsHide: true, timeout: 15000, stdio: 'pipe' });
      setOwner(target, sid);
    }
  }, T);

  it('does not follow a junction while protecting or verifying private state', () => {
    const target = directory(); ensurePrivateDirectory(target);
    const junction = path.join(base, `junction-${++serial}`);
    fs.symlinkSync(target, junction, 'junction');
    try {
      const before = security(target);
      expect(() => ensurePrivateDirectory(junction)).toThrow();
      expect(() => assertPrivatePath(junction, true)).toThrow();
      expect(security(target)).toEqual(before);
    } finally { fs.unlinkSync(junction); }
  }, T);
});
