import fs from 'node:fs';
import path from 'node:path';
import { isWithinPath } from '../platform/pathPolicy.js';
import { envValue, windowsProgramDataDirectory } from '../platform/system.js';

/** Child jobs receive a whitelist, not the server's OAuth/config/loader state. */
const BASE_ALLOWED = ['HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TZ', 'USER', 'LOGNAME', 'SHELL', 'COLORTERM'];
const WINDOWS_ALLOWED = ['SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'TEMP', 'TMP', 'USERNAME', 'USERDOMAIN', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'COMMONPROGRAMFILES', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS'];
const ALWAYS_DENIED = new Set(['NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'LD_LIBRARY_PATH', 'PATH', 'TERM', 'COMSPEC', 'PATHEXT', 'NODE_PATH']);

export function trustedPath(parentPath: string | undefined, workspaceRoot: string, platform: NodeJS.Platform = process.platform): string {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const real = (value: string) => {
    try { return platform === process.platform ? fs.realpathSync.native(value) : value; }
    catch { return value; }
  };
  const root = real(workspaceRoot);
  const entries = (parentPath ?? '').split(p.delimiter).filter(entry => {
    if (!entry || !p.isAbsolute(entry) || (platform === 'win32' && !/^[a-z]:[\\/]/i.test(entry))) return false;
    return !isWithinPath(workspaceRoot, entry, platform) && !isWithinPath(root, real(entry), platform);
  });
  if (entries.length > 0) return [...new Set(entries)].join(p.delimiter);
  if (platform === 'win32') {
    const systemRoot = envValue(process.env, 'SystemRoot', 'win32') ?? 'C:\\Windows';
    return [p.join(systemRoot, 'System32'), systemRoot].filter(entry => !isWithinPath(root, entry, platform)).join(';');
  }
  return ['/usr/bin', '/bin', '/usr/sbin', '/sbin'].filter(entry => !isWithinPath(root, real(entry), platform)).join(':');
}

export function buildChildEnv(opts: { parentEnv: NodeJS.ProcessEnv; workspaceRoot: string; extraAllowlist: string[]; platform?: NodeJS.Platform }): NodeJS.ProcessEnv {
  const platform = opts.platform ?? process.platform;
  const out: NodeJS.ProcessEnv = { PATH: trustedPath(envValue(opts.parentEnv, 'PATH', platform), opts.workspaceRoot, platform), TERM: 'dumb' };
  const names = new Set([...BASE_ALLOWED, ...(platform === 'win32' ? WINDOWS_ALLOWED : []), ...opts.extraAllowlist]);
  for (const name of names) {
    const upper = name.toUpperCase();
    if (ALWAYS_DENIED.has(upper) || upper.startsWith('DODO_')) continue;
    const value = envValue(opts.parentEnv, name, platform);
    if (value !== undefined) out[platform === 'win32' ? upper : name] = value;
  }
  if (platform === 'win32') {
    if (!out['PROGRAMDATA']) {
      const programData = windowsProgramDataDirectory(opts.parentEnv);
      if (programData) out['PROGRAMDATA'] = programData;
    }
    const extensions = (envValue(opts.parentEnv, 'PATHEXT', platform) ?? '.COM;.EXE;.BAT;.CMD').split(';').map(e => e.toUpperCase()).filter(e => ['.EXE', '.COM', '.CMD', '.BAT'].includes(e));
    out['PATHEXT'] = [...new Set(extensions.length ? extensions : ['.EXE', '.COM', '.CMD', '.BAT'])].join(';');
    out['NoDefaultCurrentDirectoryInExePath'] = '1';
  }
  return out;
}
