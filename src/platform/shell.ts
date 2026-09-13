import path from 'node:path';
import { DodoError } from '../errors.js';
import { resolveTrustedExecutable, trustedExecutable } from './execResolve.js';
import { envValue, windowsSystemExecutable } from './system.js';

export interface ShellSpec { kind: 'posix' | 'cmd'; executable: string; extension: '.sh' | '.cmd' }
export interface Invocation { program: string; args: string[]; windowsVerbatimArguments: boolean }

export function shellSpec(workspaceRoot: string): ShellSpec {
  if (process.platform !== 'win32') {
    for (const file of ['/bin/bash', '/usr/bin/bash', '/bin/sh']) {
      const executable = trustedExecutable(file, workspaceRoot, false);
      if (executable) return { kind: 'posix', executable, extension: '.sh' };
    }
    throw new DodoError('NOT_FOUND', 'no trusted POSIX shell found');
  }
  const candidates: string[] = [];
  try {
    const git = resolveTrustedExecutable('git', workspaceRoot, { allowBatch: false });
    for (const parent of [path.dirname(git), path.resolve(path.dirname(git), '..'), path.resolve(path.dirname(git), '../..')]) candidates.push(path.join(parent, 'bin', 'bash.exe'), path.join(parent, 'usr', 'bin', 'bash.exe'));
  } catch { /* cmd is the fallback when Git for Windows is absent. */ }
  for (const key of ['ProgramFiles', 'ProgramFiles(x86)']) {
    const base = envValue(process.env, key);
    if (base) candidates.push(path.join(base, 'Git', 'bin', 'bash.exe'));
  }
  for (const file of candidates) {
    const executable = trustedExecutable(file, workspaceRoot, false);
    if (executable) return { kind: 'posix', executable, extension: '.sh' };
  }
  const executable = trustedExecutable(windowsSystemExecutable('cmd.exe'), workspaceRoot, false);
  if (!executable) throw new DodoError('NOT_SUPPORTED', 'trusted Windows cmd.exe is unavailable');
  return { kind: 'cmd', executable, extension: '.cmd' };
}

/** Strict batch argv, not an escaping promise for arbitrary cmd.exe input. */
export function quoteBatchArgument(argument: string): string {
  if (/[\u0000-\u001f%!"&|<>^()]/u.test(argument)) throw new DodoError('INVALID_INPUT', 'Windows batch arguments cannot contain control characters, %, !, quotes, or shell metacharacters; use a native executable or saved script');
  return `"${argument}"`;
}
export function batchInvocation(program: string, args: string[], workspaceRoot: string): Invocation {
  const command = `"${[program, ...args].map(quoteBatchArgument).join(' ')}"`;
  if (command.length > 8000) throw new DodoError('RESOURCE_LIMIT', 'Windows batch command exceeds the cmd.exe budget; pass short file paths');
  const executable = trustedExecutable(windowsSystemExecutable('cmd.exe'), workspaceRoot, false);
  if (!executable) throw new DodoError('NOT_SUPPORTED', 'trusted Windows cmd.exe is unavailable');
  return { program: executable, args: ['/d', '/s', '/v:off', '/c', command], windowsVerbatimArguments: true };
}
export function shellInvocation(spec: ShellSpec, command: string, scriptPath?: string): Invocation {
  if (spec.kind === 'posix') return { program: spec.executable, args: scriptPath ? ['--', process.platform === 'win32' ? scriptPath.replace(/\\/g, '/') : scriptPath] : ['-c', command], windowsVerbatimArguments: false };
  if (command.split(/\r?\n/u).some(line => line.length > 8000)) throw new DodoError('RESOURCE_LIMIT', 'a cmd.exe script line exceeds 8000 characters; install Git for Windows or use separate source files');
  const source = scriptPath ? quoteBatchArgument(scriptPath) : command;
  return { program: spec.executable, args: ['/d', '/s', '/v:off', '/c', `"${source}"`], windowsVerbatimArguments: true };
}

/** libuv-style quoting length counted in UTF-16 units including the final NUL. */
export function windowsCommandLineLength(program: string, args: string[], verbatim = false): number {
  const quote = (value: string): string => {
    if (value !== '' && !/[\s"]/u.test(value)) return value;
    return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';
  };
  return quote(program).length + 1 + args.map(a => verbatim ? a : quote(a)).join(' ').length + 1;
}
export function assertWindowsArgv(program: string, args: string[], verbatim = false): void {
  if ([program, ...args].some(a => a.includes('\0'))) throw new DodoError('INVALID_INPUT', 'native argv contains NUL');
  if (windowsCommandLineLength(program, args, verbatim) > 32767) throw new DodoError('RESOURCE_LIMIT', 'Windows native command line exceeds 32767 UTF-16 units; save source/data to files and pass short paths');
}
