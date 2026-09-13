import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DodoError } from '../errors.js';
import { isWithinPath } from '../platform/pathPolicy.js';
import { envValue, windowsSystemExecutable } from '../platform/system.js';

// Chromium's Windows AppContainer/LPAC network sandbox must be able to read
// and execute the installed browser image. These package SIDs receive RX only;
// they never receive write/modify/full-control rights.
const APP_PACKAGE_RX = ['S-1-15-2-1', 'S-1-15-2-2'] as const;

function regularExecutable(file: string): string {
  const absolute = path.resolve(file);
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new DodoError('PATH_DENIED', 'Chromium executable must be a regular non-linked file');
  return fs.realpathSync.native(absolute);
}

/**
 * Local-owner setup only. Grant Windows AppContainer identities read/execute
 * on the exact Playwright Chromium revision, never on DODO state or the whole
 * user profile. A custom browser location is refused rather than broadening
 * ACLs based on environment/repository input.
 */
export function prepareWindowsChromiumSandboxAcl(executable: string): string {
  if (process.platform !== 'win32') return executable;
  const localAppData = envValue(process.env, 'LOCALAPPDATA');
  if (!localAppData || !path.win32.isAbsolute(localAppData)) throw new DodoError('NOT_SUPPORTED', 'Windows Chromium sandbox setup requires LOCALAPPDATA');
  const cache = path.join(localAppData, 'ms-playwright');
  if (!fs.existsSync(cache)) throw new DodoError('NOT_FOUND', 'Playwright browser cache is missing after installation');
  const cacheReal = fs.realpathSync.native(cache);
  const exeReal = regularExecutable(executable);
  if (!isWithinPath(cacheReal, exeReal)) throw new DodoError('PATH_DENIED', 'automatic Chromium ACL setup is limited to the Playwright cache under LOCALAPPDATA');

  const relative = path.relative(cacheReal, exeReal);
  const revision = relative.split(path.sep)[0] ?? '';
  if (!/^chromium-\d+$/.test(revision)) throw new DodoError('PATH_DENIED', 'unexpected Playwright Chromium revision path');
  const revisionRoot = path.join(cacheReal, revision);
  const rootStat = fs.lstatSync(revisionRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new DodoError('PATH_DENIED', 'Playwright Chromium revision must be a real directory');

  const icacls = windowsSystemExecutable('icacls.exe');
  const args = [revisionRoot, '/grant', ...APP_PACKAGE_RX.map(sid => `*${sid}:(OI)(CI)(RX)`), '/T', '/C', '/Q'];
  const result = spawnSync(icacls, args, { shell: false, windowsHide: true, timeout: 120000, maxBuffer: 256 * 1024, encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new DodoError('NOT_SUPPORTED', 'Chromium AppContainer read/execute ACL could not be established; browser sandbox remains unavailable');
  // Re-resolve after ACL mutation so a concurrent path swap cannot be reported
  // as success. The subsequent deep probe launches Chromium with sandbox=true.
  if (fs.realpathSync.native(executable) !== exeReal) throw new DodoError('FILE_CHANGED', 'Chromium executable changed while establishing sandbox ACL');
  return revisionRoot;
}
