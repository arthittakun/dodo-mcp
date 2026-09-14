import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

/** Capture every subprocess stream, including launch failures. Never print a
 * child diagnostic to CI. Callers publish only the numeric status/step ID. */
export function privateCommand(program, args, { cwd, env, timeout, logFile }) {
  const started = Date.now();
  fs.appendFileSync(logFile, `\n[${new Date().toISOString()}] ${program} ${args.join(' ')}\n`, { mode: 0o600 });
  const result = spawnSync(program, args, { cwd, env, timeout, encoding: 'utf8', stdio: 'pipe', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  fs.appendFileSync(logFile, `${result.stdout ?? ''}${result.stderr ?? ''}${result.error ? `\n${result.error.message}\n` : ''}`, { mode: 0o600 });
  return { ...result, status: result.status ?? 1, durationMs: Date.now() - started };
}
