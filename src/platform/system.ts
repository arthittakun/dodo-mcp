import path from 'node:path';
import { DodoError } from '../errors.js';

export function envValue(env: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform = process.platform): string | undefined {
  if (platform !== 'win32') return env[name];
  const key = Object.keys(env).sort().find(k => k.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

/** Recover the machine-common data path even under an older sanitized parent. */
export function windowsProgramDataDirectory(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicit = envValue(env, 'ProgramData', 'win32');
  if (explicit && /^[a-z]:[\\/]/i.test(explicit) && !/[\u0000-\u001f]/u.test(explicit)) return path.win32.normalize(explicit);
  const configuredDrive = envValue(env, 'SystemDrive', 'win32');
  const root = envValue(env, 'SystemRoot', 'win32') ?? envValue(env, 'windir', 'win32');
  const drive = configuredDrive && /^[a-z]:$/i.test(configuredDrive)
    ? configuredDrive
    : root && /^[a-z]:[\\/]/i.test(root) ? path.win32.parse(root).root.slice(0, 2) : undefined;
  return drive ? `${drive}\\ProgramData` : undefined;
}

/** OS utilities never resolve through cwd, PATH, or repository COMSPEC. */
export function windowsSystemExecutable(name: 'cmd.exe' | 'taskkill.exe' | 'whoami.exe' | 'icacls.exe' | 'WindowsPowerShell/v1.0/powershell.exe', env: NodeJS.ProcessEnv = process.env): string {
  const root = envValue(env, 'SystemRoot', 'win32') ?? envValue(env, 'windir', 'win32');
  if (!root || !/^[a-z]:[\\/]/i.test(root) || /[\u0000-\u001f]/u.test(root)) throw new DodoError('NOT_SUPPORTED', 'a valid Windows SystemRoot is required; no cwd/PATH fallback is allowed');
  return path.win32.join(root, 'System32', ...name.split('/'));
}
