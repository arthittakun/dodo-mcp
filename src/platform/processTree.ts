import { execFileSync, type ChildProcess } from 'node:child_process';
import { DodoError } from '../errors.js';
import { windowsSystemExecutable } from './system.js';

/** Only accepts a live owned ChildProcess, never a saved PID. Windows v1 is
 * hard-kill only; Job Objects/escaped-descendant confinement are not claimed. */
export function signalOwnedProcess(child: ChildProcess, signal: NodeJS.Signals, processGroup = false): void {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    try {
      execFileSync(windowsSystemExecutable('taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, timeout: 5000, stdio: 'ignore' });
    } catch { throw new DodoError('INTERNAL_ERROR', 'Windows owned-process tree termination failed; termination was not confirmed'); }
    return;
  }
  try {
    if (processGroup) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch { try { child.kill(signal); } catch { /* already closed */ } }
}
