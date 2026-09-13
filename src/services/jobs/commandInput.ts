import { DodoError } from '../../errors.js';

// Keep native argv below common POSIX execve limits. Large shell source is
// supplied as a private script file instead; it is never put into argv.
export const EXEC_ARG_BYTES = 64 * 1024;
export const EXEC_ARGV_BYTES = 128 * 1024;
export const INLINE_COMMAND_BYTES = 16 * 1024;

export function validateShellCommand(command: string, maxBytes: number): void {
  if (command.includes('\0')) throw new DodoError('INVALID_INPUT', 'command contains NUL');
  const bytes = Buffer.byteLength(command, 'utf8');
  if (bytes > maxBytes) throw new DodoError('RESOURCE_LIMIT', `command is ${bytes} UTF-8 bytes; limit is ${maxBytes}`, {
    detail: { bytes, maxBytes, limit: 'commandBytes' },
    recovery: 'Use write_file/edit_file for source code, then run the saved script with a short command. The local owner can run dodo limits --profile large and restart DODO.',
  });
}

export function validateExecArgs(program: string, args: string[]): void {
  let total = 0;
  for (const arg of [program, ...args]) {
    if (arg.includes('\0')) throw new DodoError('INVALID_INPUT', 'program or argument contains NUL');
    const bytes = Buffer.byteLength(arg, 'utf8');
    if (bytes > EXEC_ARG_BYTES) throw new DodoError('RESOURCE_LIMIT', `one argument exceeds ${EXEC_ARG_BYTES} UTF-8 bytes`, {
      recovery: 'Use write_file to save code/data and pass its path to the program; native argv has OS limits.',
    });
    total += bytes + 1;
  }
  if (total > EXEC_ARGV_BYTES) throw new DodoError('RESOURCE_LIMIT', `program and arguments exceed ${EXEC_ARGV_BYTES} bytes combined`, {
    recovery: 'Save code/data with write_file and pass file paths instead of embedding it in arguments.',
  });
}
