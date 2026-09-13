import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ensurePrivateDirectory } from '../platform/privateFs.js';
import { envValue } from '../platform/system.js';

/**
 * Global DODO state/config directory resolution (spec §5).
 * - Outside any workspace, user-owned, platform convention.
 * - `DODO_CONFIG_DIR` is the explicit override.
 * - The chosen location is always displayed to the user by the CLI.
 * - Neither variable is inherited by child jobs (see security/env.ts).
 */
export interface ConfigDirResolution {
  dir: string;
  source: 'env' | 'platform';
  envVar?: 'DODO_CONFIG_DIR';
}

function nonEmpty(value: string | undefined): string | undefined {
  return value && value.trim() !== '' ? value : undefined;
}

export function resolveConfigDir(env: NodeJS.ProcessEnv = process.env): ConfigDirResolution {
  const dodoOverride = nonEmpty(envValue(env, 'DODO_CONFIG_DIR'));
  if (dodoOverride) {
    return { dir: path.resolve(dodoOverride), source: 'env', envVar: 'DODO_CONFIG_DIR' };
  }
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return { dir: path.join(home, 'Library', 'Application Support', 'dodo'), source: 'platform' };
  }
  if (process.platform === 'win32') {
    const appData = envValue(env, 'LOCALAPPDATA') ?? path.join(home, 'AppData', 'Local');
    return { dir: path.join(appData, 'dodo'), source: 'platform' };
  }
  const xdg = env['XDG_CONFIG_HOME'];
  return { dir: path.join(xdg && xdg.trim() !== '' ? xdg : path.join(home, '.config'), 'dodo'), source: 'platform' };
}

/**
 * Fixed, platform-specific existing locations that may be imported by the
 * explicit local-owner setup flow. This function never scans a home
 * directory; callers only inspect the returned paths.
 */
export function existingConfigDirs(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string[] {
  const home = os.homedir();
  const candidates: string[] = [];
  if (platform === 'darwin') {
    candidates.push(path.join(home, 'Library', 'Application Support', 'dodo'), path.join(home, '.dodo'));
  } else if (platform === 'win32') {
    const local = nonEmpty(envValue(env, 'LOCALAPPDATA', 'win32')) ?? path.join(home, 'AppData', 'Local');
    const roaming = nonEmpty(envValue(env, 'APPDATA', 'win32')) ?? path.join(home, 'AppData', 'Roaming');
    candidates.push(path.win32.join(local, 'dodo'), path.win32.join(roaming, 'dodo'), path.win32.join(home, '.dodo'));
  } else {
    const xdg = nonEmpty(env['XDG_CONFIG_HOME']) ?? path.join(home, '.config');
    candidates.push(path.join(xdg, 'dodo'), path.join(home, '.dodo'));
  }
  const resolveForPlatform = platform === 'win32' ? path.win32.resolve : path.resolve;
  return [...new Set(candidates.map(candidate => resolveForPlatform(candidate)))];
}

/** Create the config dir tree with restrictive permissions (0700 dirs, 0600 files on POSIX). */
export function ensureConfigDir(dir: string): void {
  ensurePrivateDirectory(dir);
  for (const sub of ['keys', 'audit', 'backups', 'journal', 'jobs', 'ipc']) {
    ensurePrivateDirectory(path.join(dir, sub));
  }
}

export interface StatePaths {
  configDir: string;
  configFile: string;
  dbFile: string;
  keysDir: string;
  jwksFile: string;
  cookieKeysFile: string;
  auditDir: string;
  backupsDir: string;
  journalDir: string;
  jobsDir: string;
  ipcDir: string;
}

export function statePaths(configDir: string): StatePaths {
  return {
    configDir,
    configFile: path.join(configDir, 'config.json'),
    dbFile: path.join(configDir, 'state.db'),
    keysDir: path.join(configDir, 'keys'),
    jwksFile: path.join(configDir, 'keys', 'jwks.json'),
    cookieKeysFile: path.join(configDir, 'keys', 'cookies.json'),
    auditDir: path.join(configDir, 'audit'),
    backupsDir: path.join(configDir, 'backups'),
    journalDir: path.join(configDir, 'journal'),
    jobsDir: path.join(configDir, 'jobs'),
    ipcDir: path.join(configDir, 'ipc'),
  };
}

/**
 * IPC socket path for a workspace. Unix socket paths are limited (~104 bytes
 * on macOS), so the name is a short hash, and when even the hashed path would
 * exceed the platform limit we fall back to a per-user tmp dir (0700).
 */
export function ipcSocketPath(configDir: string, workspaceKey: string, options: { createDirectory?: boolean } = {}): string {
  const short = workspaceKey.replace(/[^a-z0-9]/gi, '').slice(0, 16);
  const candidate = path.join(configDir, 'ipc', `${short}.sock`);
  // A locator for the owner-private authentication descriptor. IPC resolves
  // this to a fresh Windows named pipe; it is never opened as a socket file.
  if (process.platform === 'win32') return candidate;
  if (Buffer.byteLength(candidate) <= 100) return candidate;
  const configHash = createHash('sha256').update(path.resolve(configDir)).digest('hex').slice(0, 10);
  const fallbackDir = path.join(os.tmpdir(), `dodo-${os.userInfo().username}-${configHash}`);
  if (options.createDirectory !== false) ensurePrivateDirectory(fallbackDir);
  return path.join(fallbackDir, `${short}.sock`);
}
