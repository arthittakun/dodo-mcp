import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DodoError } from '../errors.js';
import { assertLocalWindowsRoot } from '../platform/pathPolicy.js';
import { encodeFileIdentity, type FileIdentity } from '../platform/fileIdentity.js';

/**
 * Workspace root rules (spec §4.2):
 * - the CLI entrypoint captures process.cwd() BEFORE anything can chdir;
 * - fs.realpath of that value is the authoritative root;
 * - never derived from __dirname / package dir / npm cache / home / Git root;
 * - no automatic climb to a monorepo root;
 * - filesystem root and home are rejected by default (explicit local
 *   override flag required, with a warning).
 */
export interface RootInfo {
  root: string; // realpath, absolute
  dev: FileIdentity;
  ino: FileIdentity;
  /** Stable directory-generation marker where the filesystem exposes birth time. */
  birthtimeNs: string | null;
}

export function resolveWorkspaceRoot(candidate: string, opts: { allowUnsafe?: boolean } = {}): RootInfo {
  if (process.platform === 'win32') assertLocalWindowsRoot(path.resolve(candidate));
  let real: string;
  try {
    real = fs.realpathSync.native(candidate);
  } catch {
    throw new DodoError('NOT_FOUND', `workspace root does not exist: ${candidate}`);
  }
  if (process.platform === 'win32') assertLocalWindowsRoot(real);
  let st: fs.BigIntStats;
  try {
    st = fs.statSync(real, { bigint: true });
  } catch {
    throw new DodoError('NOT_FOUND', `workspace root is not accessible: ${candidate}`);
  }
  if (!st.isDirectory()) {
    throw new DodoError('PATH_DENIED', 'workspace root must be a directory');
  }
  if (!opts.allowUnsafe) {
    const home = safeRealpath(os.homedir());
    const parsed = path.parse(real);
    if (real === parsed.root) {
      throw new DodoError('PATH_DENIED', 'refusing to use the filesystem root as a workspace (use --allow-unsafe-root only if you really mean it)');
    }
    if (home && (process.platform === 'win32' ? real.toLowerCase() === home.toLowerCase() : real === home)) {
      throw new DodoError('PATH_DENIED', 'refusing to use the home directory as a workspace (cd into a project first; --allow-unsafe-root overrides)');
    }
    // Suspiciously broad roots: direct children of / like /Users, /home, /Volumes.
    const rel = path.relative(parsed.root, real);
    if (rel !== '' && !rel.includes(path.sep) && ['users', 'home', 'volumes', 'mnt', 'media', 'windows', 'program files', 'program files (x86)'].includes(rel.toLowerCase())) {
      throw new DodoError('PATH_DENIED', `refusing unusually broad workspace root ${real} (--allow-unsafe-root overrides)`);
    }
  }
  return {
    root: real,
    dev: encodeFileIdentity(st.dev),
    ino: encodeFileIdentity(st.ino),
    birthtimeNs: st.birthtimeNs > 0n ? st.birthtimeNs.toString() : null,
  };
}

function safeRealpath(p: string): string | undefined {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return undefined;
  }
}
