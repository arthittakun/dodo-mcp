// Runs INSIDE the SRT sandbox account. Only builtin modules: target arguments
// are data from a bounded private manifest, never command-shell interpolation.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

try {
  const file = process.argv[2];
  if (!file || !path.isAbsolute(file)) throw new Error('missing sandbox job manifest');
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 256 * 1024) throw new Error('unsafe sandbox job manifest');
  const value = JSON.parse(fs.readFileSync(file, 'utf8')) as { program?: unknown; args?: unknown; cwd?: unknown; windowsVerbatimArguments?: unknown };
  if (typeof value.program !== 'string' || !path.isAbsolute(value.program) || typeof value.cwd !== 'string' || !path.isAbsolute(value.cwd) || !Array.isArray(value.args) || value.args.some(a => typeof a !== 'string' || a.includes('\0'))) throw new Error('invalid sandbox job');
  const child = spawn(value.program, value.args as string[], { cwd: value.cwd, env: process.env, shell: false, windowsHide: true, windowsVerbatimArguments: value.windowsVerbatimArguments === true, stdio: 'inherit' });
  child.once('error', () => { console.error('[dodo] sandbox target could not start'); process.exitCode = 1; });
  child.once('close', code => { process.exitCode = code ?? 1; });
} catch {
  console.error('[dodo] sandbox target manifest rejected'); process.exitCode = 1;
}
