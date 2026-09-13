import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DodoError } from '../errors.js';
import { ensurePrivateDirectory } from '../platform/privateFs.js';
import { windowsSystemExecutable, envValue } from '../platform/system.js';
import { isWithinPath } from '../platform/pathPolicy.js';
import { renameWithRetry } from '../platform/fsRetry.js';

const Manifest = z.object({ version: z.literal(1), paths: z.array(z.string().min(1).max(1024)).max(40) }).strict();
const FILE = 'managed-tools.json';
const ACL_PROBE = String.raw`
$ErrorActionPreference='Stop'
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$sid=$identity.User.Value
$admin=[Security.Principal.WindowsPrincipal]::new($identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
foreach($p in (ConvertFrom-Json $env:DODO_SETUP_PATHS)) {
  $item=Get-Item -LiteralPath $p -Force
  if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'reparse'}
  $a=Get-Acl -LiteralPath $p
  $owner=$a.GetOwner([Security.Principal.SecurityIdentifier]).Value
  if($owner -ne $sid -and -not ($admin -and $owner -eq 'S-1-5-32-544')){throw 'owner'}
  $found=$false
  foreach($r in $a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
    if($r.AccessControlType -eq 'Allow') {
      if(@($sid,'S-1-5-18','S-1-5-32-544') -notcontains $r.IdentityReference.Value){throw 'DACL'}
      if($r.IdentityReference.Value -eq $sid){$found=$true}
    }
  }
  if(-not $found){throw 'owner access'}
}
[Console]::Write('private')
`;

export function assertSetupPrivatePaths(objects: string[]): void {
  for (const object of objects) {
    const st = fs.lstatSync(object);
    if (st.isSymbolicLink() || (!st.isDirectory() && (!st.isFile() || st.nlink !== 1))) throw new DodoError('PATH_DENIED', 'unsafe managed-tool path');
    if (process.platform !== 'win32' && (st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0)) throw new DodoError('PATH_DENIED', 'managed tool manifest/directory must be owner-private');
  }
  if (process.platform === 'win32') {
    const result = spawnSync(windowsSystemExecutable('WindowsPowerShell/v1.0/powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ACL_PROBE, 'utf16le').toString('base64')], { shell: false, windowsHide: true, timeout: 15000, maxBuffer: 4096, encoding: 'utf8', env: { ...process.env, DODO_SETUP_PATHS: JSON.stringify(objects) } });
    if (result.error || result.status !== 0 || result.stdout.trim() !== 'private') throw new DodoError('PATH_DENIED', 'managed-tool ACL verification failed; no tool PATH entries were loaded');
  }
}

/** Read-only even on Windows: verification never repairs ACLs or creates state. */
export function readManagedPaths(configDir: string, workspaceRoot: string): string[] {
  const file = path.join(configDir, FILE);
  if (!fs.existsSync(file)) return [];
  if (fs.lstatSync(configDir).isSymbolicLink()) throw new DodoError('PATH_DENIED', 'managed tool state cannot be a directory link');
  const config = fs.realpathSync.native(configDir), tools = path.join(config, 'tools');
  assertSetupPrivatePaths([config, tools, file]);
  if (fs.statSync(file).size > 65536) throw new DodoError('RESOURCE_LIMIT', 'managed tool manifest is oversized');
  const value = Manifest.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
  return value.paths.map(rel => {
    if (!/^tools\//.test(rel) || rel.includes('\\') || rel.split('/').some(s => !s || s === '.' || s === '..' || s.includes(':'))) throw new DodoError('PATH_DENIED', 'managed tool paths must stay below the private tools directory');
    const absolute = path.join(config, rel);
    let current = config;
    for (const segment of rel.split('/')) {
      current = path.join(current, segment);
      const st = fs.lstatSync(current);
      if (!st.isDirectory() || st.isSymbolicLink()) throw new DodoError('PATH_DENIED', 'managed tools cannot follow directory links');
    }
    const real = fs.realpathSync.native(absolute);
    if (!isWithinPath(tools, real) || isWithinPath(workspaceRoot, real)) throw new DodoError('PATH_DENIED', 'managed tool directory is not outside the workspace');
    return real;
  });
}

/** Process-local PATH only; does not edit OS PATH, shell profiles or live services. */
export function activateManagedTools(configDir: string, workspaceRoot: string): void {
  const paths = readManagedPaths(configDir, workspaceRoot);
  if (!paths.length) return;
  const previous = envValue(process.env, 'PATH') ?? '';
  if (process.platform === 'win32') for (const key of Object.keys(process.env)) if (key.toUpperCase() === 'PATH' && key !== 'PATH') delete process.env[key];
  process.env['PATH'] = [...new Set([...paths, ...previous.split(path.delimiter).filter(Boolean)])].join(path.delimiter);
}

/** Called under the setup lock. Refuses concurrent mtime/content changes before atomic replacement. */
export function registerManagedPath(configDir: string, directory: string): void {
  ensurePrivateDirectory(configDir);
  ensurePrivateDirectory(path.join(configDir, 'tools'));
  const file = path.join(configDir, FILE);
  if (fs.existsSync(file)) {
    assertSetupPrivatePaths([file]);
    if (fs.statSync(file).size > 65536) throw new DodoError('RESOURCE_LIMIT', 'managed tool manifest is oversized');
  }
  const before = fs.existsSync(file) ? { bytes: fs.readFileSync(file), mtime: fs.statSync(file, { bigint: true }).mtimeNs } : undefined;
  const paths = before ? Manifest.parse(JSON.parse(before.bytes.toString('utf8'))).paths : [];
  const rel = path.relative(configDir, directory).split(path.sep).join('/');
  if (!rel.startsWith('tools/') || rel.split('/').includes('..')) throw new DodoError('PATH_DENIED', 'tools must be installed in the managed directory');
  const data = JSON.stringify(Manifest.parse({ version: 1, paths: [...new Set([...paths, rel])] }), null, 2) + '\n';
  const temporary = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, data, { flag: 'wx', mode: 0o600 });
  try {
    if (before ? !fs.existsSync(file) || fs.statSync(file, { bigint: true }).mtimeNs !== before.mtime || !fs.readFileSync(file).equals(before.bytes) : fs.existsSync(file)) throw new DodoError('FILE_CHANGED', 'managed tool manifest changed concurrently');
    renameWithRetry(temporary, file);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
