import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DodoError } from '../errors.js';
import { envValue, windowsSystemExecutable } from './system.js';

// Constant PowerShell/.NET code: the path is data in the child's environment,
// never interpolated into source. Only the current SID, SYSTEM and local
// administrators may access state. A failed/unsupported ACL is a hard error.
const ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$p = $env:DODO_PRIVATE_PATH
$item = Get-Item -LiteralPath $p -Force
if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'reparse point' }
$currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$sid = $currentIdentity.User
$administratorsSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
$principal = [Security.Principal.WindowsPrincipal]::new($currentIdentity)
$allowed = @($sid.Value, 'S-1-5-18', $administratorsSid.Value)

function Assert-PrivateDacl($candidate) {
  $rules = $candidate.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
  $ownerAllowed = $false
  foreach ($rule in $rules) {
    if ($rule.AccessControlType -eq 'Allow') {
      if ($allowed -notcontains $rule.IdentityReference.Value) { throw 'non-private DACL' }
      if ($rule.IdentityReference.Value -eq $sid.Value) { $ownerAllowed = $true }
    }
  }
  if (-not $ownerAllowed) { throw 'owner access missing' }
}

$acl = Get-Acl -LiteralPath $p
$owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
# An enabled Administrators token may normalize Windows' default group owner.
# IsInRole checks the effective token; a UAC deny-only group does not qualify.
$repairAdminOwner = ($owner -eq $administratorsSid.Value) -and $principal.IsInRole($administratorsSid)
if ($owner -ne $sid.Value -and -not $repairAdminOwner) { throw 'unexpected owner' }
if ($env:DODO_PRIVATE_MODE -eq 'protect') {
  if (-not $item.PSIsContainer) { throw 'expected directory' }
  $acl = New-Object Security.AccessControl.DirectorySecurity
  $acl.SetOwner($sid)
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($id in $allowed) {
    $identity = New-Object Security.Principal.SecurityIdentifier($id)
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $p -AclObject $acl
} elseif ($env:DODO_PRIVATE_MODE -eq 'verify') {
  # Verify may repair ONLY the admitted group owner, never a permissive DACL.
  # New files (notably IPC descriptors) can receive that default owner too.
  Assert-PrivateDacl $acl
  if ($repairAdminOwner) {
    $beforeDacl = $acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)
    $acl.SetOwner($sid)
    Set-Acl -LiteralPath $p -AclObject $acl
    $acl = Get-Acl -LiteralPath $p
    if ($acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access) -ne $beforeDacl) { throw 'DACL changed during owner repair' }
  }
} else { throw 'invalid private ACL mode' }
# Do not trust Set-Acl succeeding: re-read the object and enforce the final
# user-SID owner and the same private DACL in BOTH modes, after any repair.
$item = Get-Item -LiteralPath $p -Force
if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'reparse point' }
$acl = Get-Acl -LiteralPath $p
if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'unexpected owner after ACL operation' }
Assert-PrivateDacl $acl
[Console]::Write('private')
`;

function windowsAcl(target: string, protect: boolean): void {
  const env: NodeJS.ProcessEnv = {
    SYSTEMROOT: envValue(process.env, 'SystemRoot'),
    WINDIR: envValue(process.env, 'windir'),
    USERPROFILE: envValue(process.env, 'USERPROFILE'),
    TEMP: envValue(process.env, 'TEMP'),
    TMP: envValue(process.env, 'TMP'),
    DODO_PRIVATE_PATH: target,
    DODO_PRIVATE_MODE: protect ? 'protect' : 'verify',
  };
  try {
    const output = execFileSync(windowsSystemExecutable('WindowsPowerShell/v1.0/powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ACL_SCRIPT, 'utf16le').toString('base64')], { env, shell: false, windowsHide: true, timeout: 10000, maxBuffer: 4096, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (output.trim() !== 'private') throw new Error('ACL not verified');
  } catch {
    throw new DodoError('PATH_DENIED', 'private Windows state ACL could not be established or verified; use a local NTFS directory owned by your user');
  }
}

export function ensurePrivateDirectory(directory: string): void {
  if (!path.isAbsolute(directory) || directory === path.parse(directory).root) throw new DodoError('PATH_DENIED', 'private state must use a dedicated absolute directory');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new DodoError('PATH_DENIED', 'private state directory must not be a link');
  if (process.platform === 'win32') windowsAcl(directory, true);
  else {
    if (stat.uid !== process.getuid?.()) throw new DodoError('PATH_DENIED', 'private state directory has a different owner');
    fs.chmodSync(directory, 0o700);
  }
}

/** Verify private access; on Windows, normalize an Administrators default owner
 * only for an enabled admin token and an already-private DACL. Never widen ACLs. */
export function assertPrivatePath(target: string, directory = false): fs.Stats {
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) throw new DodoError('PATH_DENIED', 'refusing non-private or unexpected IPC path');
  if (process.platform === 'win32') windowsAcl(target, false);
  else if (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new DodoError('PATH_DENIED', 'refusing non-private or unexpected IPC path');
  return stat;
}
