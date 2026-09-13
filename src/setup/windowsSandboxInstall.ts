import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { DodoError } from '../errors.js';
import { SRT_VERSION, findWindowsSandbox } from '../platform/windowsSandbox.js';
import { windowsSystemExecutable } from '../platform/system.js';
import { activateManagedTools, registerManagedPath, assertSetupPrivatePaths } from './managedTools.js';
import { verifySandbox } from './sandboxProbe.js';

interface NativeStatus { user: { provisioned: boolean; credPresent: boolean; groupSid?: string }; wfp: { state: string } }
interface SrtWinSpawn { exe: string; prependArgs: readonly string[] }
interface SandboxPackage {
  VENDORED_SRT_WIN_EXE: string;
  resolveSrtWin(config: { path: string }): SrtWinSpawn;
  checkWindowsSandboxStatusAsync(opts: { srtWin: SrtWinSpawn }): Promise<NativeStatus>;
  installWindowsSandboxAsync(opts: { timeoutMs: number; force: boolean; srtWin: SrtWinSpawn }): Promise<NativeStatus & { cancelled?: boolean }>;
}
export const RUNTIME_ACL_VERIFY = String.raw`
$ErrorActionPreference='Stop'
$sid=[Security.Principal.SecurityIdentifier]::new($env:DODO_SRT_GROUP_SID)
$required=[Security.AccessControl.FileSystemRights]::ReadAndExecute
# Composite rights such as FullControl/Modify contain read bits, so they cannot
# be used as a forbidden bitmask. Reject only atomic write/delete/ACL authority.
$forbidden=[Security.AccessControl.FileSystemRights]::WriteData -bor [Security.AccessControl.FileSystemRights]::AppendData -bor [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor [Security.AccessControl.FileSystemRights]::WriteAttributes -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
$paths=@($env:DODO_SRT_RUNTIME_DIR,(Join-Path $env:DODO_SRT_RUNTIME_DIR 'srt-win.exe'))
foreach($p in $paths){
  $item=Get-Item -LiteralPath $p -Force
  if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'runtime reparse'}
  $rules=(Get-Acl -LiteralPath $p).GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])
  $ours=@($rules|Where-Object{$_.IdentityReference.Value -eq $sid.Value -and $_.AccessControlType -eq 'Allow'})
  if($ours.Count -eq 0){throw 'missing runtime RX'}
  foreach($r in $ours){
    if(($r.FileSystemRights -band $required) -ne $required){throw 'runtime group missing read/execute'}
    if(($r.FileSystemRights -band $forbidden) -ne 0){throw 'runtime group received write authority'}
  }
}
[Console]::Write('rx-only')
`;
export function sandboxRuntimeAclArgs(directory: string, groupSid: string): string[] {
  if (!/^S-1-5-(?:\d+-)+\d+$/.test(groupSid)) throw new DodoError('INVALID_INPUT', 'sandbox runtime returned an invalid local group SID');
  return [directory, '/grant', `*${groupSid}:(OI)(CI)(RX)`, '/T', '/C', '/Q'];
}
function grantSandboxRuntimeReadExecute(directory: string, groupSid: string): void {
  const grant = spawnSync(windowsSystemExecutable('icacls.exe'), sandboxRuntimeAclArgs(directory, groupSid), { shell: false, windowsHide: true, timeout: 120000, maxBuffer: 256 * 1024, encoding: 'utf8' });
  if (grant.error || grant.status !== 0) throw new Error('sandbox helper read/execute ACL could not be established');
  const verify = spawnSync(windowsSystemExecutable('WindowsPowerShell/v1.0/powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(RUNTIME_ACL_VERIFY, 'utf16le').toString('base64')], {
    shell: false, windowsHide: true, timeout: 30000, maxBuffer: 16384, encoding: 'utf8',
    env: { ...process.env, DODO_SRT_GROUP_SID: groupSid, DODO_SRT_RUNTIME_DIR: directory },
  });
  if (verify.error || verify.status !== 0 || verify.stdout.trim() !== 'rx-only') throw new Error('sandbox helper ACL verification failed; no confinement success is claimed');
}

/** Local CLI only. The dependency itself is installed using the reviewed npm recipe in setup.ts. */
export async function provisionWindowsSandbox(configDir: string, workspaceRoot: string, packageRoot: string, log: (text: string) => void): Promise<void> {
  if (process.platform !== 'win32') throw new DodoError('NOT_SUPPORTED', 'Windows provisioning was requested on another OS');
  const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as { name: string; version: string };
  if (pkg.name !== '@anthropic-ai/sandbox-runtime' || pkg.version !== SRT_VERSION) throw new Error('sandbox runtime pin mismatch');
  const directory = path.join(packageRoot, 'vendor', 'srt-win', process.arch);
  const expectedExecutable = path.join(directory, 'srt-win.exe');
  // package JS stays owner-private. The native helper directory gets a narrow
  // RX grant to the dedicated sandbox group after provisioning, so it is not
  // checked with the generic owner-only ACL predicate on repeat setup runs.
  assertSetupPrivatePaths([configDir, path.join(configDir, 'tools'), packageRoot]);
  if (!fs.existsSync(expectedExecutable)) throw new Error('reviewed runtime does not contain this Windows architecture');
  const executableStat = fs.lstatSync(expectedExecutable);
  if (!executableStat.isFile() || executableStat.isSymbolicLink() || executableStat.nlink !== 1) throw new Error('reviewed Windows sandbox executable is not a regular private file');
  registerManagedPath(configDir, directory); activateManagedTools(configDir, workspaceRoot);
  const api = await import(pathToFileURL(path.join(packageRoot, 'dist', 'index.js')).href) as SandboxPackage;
  if (typeof api.resolveSrtWin !== 'function' || typeof api.checkWindowsSandboxStatusAsync !== 'function' || typeof api.installWindowsSandboxAsync !== 'function') throw new Error('sandbox runtime API contract mismatch');
  if (fs.realpathSync.native(api.VENDORED_SRT_WIN_EXE) !== fs.realpathSync.native(expectedExecutable)) throw new Error('sandbox runtime exported an unexpected Windows helper path');
  const srtWin = api.resolveSrtWin({ path: expectedExecutable });
  let status = await api.checkWindowsSandboxStatusAsync({ srtWin });
  if (!status.user.provisioned || !status.user.credPresent || status.wfp.state === 'absent') {
    log('[setup] Windows sandbox: provisioning a dedicated srt-sandbox account and SID-scoped WFP network rules. Approve the native UAC prompt; cancellation is not bypassed.');
    const result = await api.installWindowsSandboxAsync({ timeoutMs: 180000, force: false, srtWin });
    if (result.cancelled) throw new DodoError('FORBIDDEN', 'Windows sandbox installation was canceled by the owner; no successful installation is claimed');
    status = result;
  }
  if (!status.user.provisioned || !status.user.credPresent || status.wfp.state === 'absent') throw new Error('Windows sandbox provisioning is incomplete');
  if (!status.user.groupSid) throw new Error('Windows sandbox group SID is unavailable after provisioning');
  // srt-win is launched AS srt-sandbox via CreateProcessWithLogonW. Grant the
  // dedicated sandbox group read+execute only on this architecture's native
  // helper subtree; no write rights and no access to DODO owner state/JS.
  grantSandboxRuntimeReadExecute(directory, status.user.groupSid);
  log('[setup] Windows sandbox: verifying real file/network confinement and ACL cleanup.');
  await verifySandbox(configDir, workspaceRoot);
  if (!findWindowsSandbox(workspaceRoot, configDir)?.validated) throw new Error('sandbox verification receipt did not validate');
}
