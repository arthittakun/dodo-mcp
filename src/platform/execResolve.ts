import fs from 'node:fs';
import path from 'node:path';
import { DodoError } from '../errors.js';
import { buildChildEnv } from '../security/env.js';
import { isWithinPath } from './pathPolicy.js';

export function executableNames(name: string, pathext: string | undefined, platform: NodeJS.Platform = process.platform, allowBatch = true): string[] {
  if (!name || /[\\/:\u0000-\u001f]/u.test(name)) throw new DodoError('INVALID_INPUT', 'expected a bare executable name');
  if (platform !== 'win32') return [name];
  const allowed = allowBatch ? ['.EXE', '.COM', '.CMD', '.BAT'] : ['.EXE', '.COM'];
  const ext = path.win32.extname(name).toUpperCase();
  if (ext) return allowed.includes(ext) ? [name] : [];
  const extensions = (pathext ?? '.COM;.EXE;.BAT;.CMD').split(';').map(e => e.toUpperCase()).filter(e => allowed.includes(e));
  return [...new Set(extensions.length ? extensions : allowed)].map(e => name + e);
}

/** A repository may never supply an implicit helper (git, rg, node, LSP...). */
export function trustedExecutable(abs: string, workspaceRoot: string, allowBatch = true): string | undefined {
  try {
    if (!path.isAbsolute(abs) || isWithinPath(workspaceRoot, abs)) return undefined;
    const real = fs.realpathSync.native(abs);
    if (isWithinPath(fs.realpathSync.native(workspaceRoot), real)) return undefined;
    const st = fs.statSync(real);
    if (!st.isFile()) return undefined;
    if (process.platform === 'win32') {
      if (!/\.(?:exe|com)$/i.test(real) && !(allowBatch && /\.(?:cmd|bat)$/i.test(real))) return undefined;
    } else if ((st.mode & 0o111) === 0) return undefined;
    return real;
  } catch { return undefined; }
}

export function resolveTrustedExecutable(name: string, workspaceRoot: string, opts: { allowBatch?: boolean; allowAbsolute?: boolean; env?: NodeJS.ProcessEnv } = {}): string {
  const allowBatch = opts.allowBatch ?? true;
  if (opts.allowAbsolute && path.isAbsolute(name)) {
    const resolved = trustedExecutable(name, workspaceRoot, allowBatch);
    if (resolved) return resolved;
    throw new DodoError('PATH_DENIED', 'executable must be a supported regular file outside the workspace');
  }
  const env = buildChildEnv({ parentEnv: opts.env ?? process.env, workspaceRoot, extraAllowlist: [] });
  const names = executableNames(name, env['PATHEXT'], process.platform, allowBatch);
  for (const directory of (env['PATH'] ?? '').split(path.delimiter)) {
    if (!directory || !path.isAbsolute(directory)) continue;
    for (const candidate of names) {
      const resolved = trustedExecutable(path.join(directory, candidate), workspaceRoot, allowBatch);
      if (resolved) return resolved;
    }
  }
  throw new DodoError('NOT_FOUND', `program not found on trusted PATH: ${name}`, {
    recovery: 'Install outside the workspace and add the directory to PATH. Windows LSP batch shims are refused; register node.exe with the server JavaScript path instead.',
  });
}
