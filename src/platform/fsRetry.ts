import fs from 'node:fs';

/** Retry transient Windows sharing locks, never delete a destination or clear
 * a read-only attribute to force an overwrite. Total delay is bounded. */
export function retryWindowsFs<T>(operation: () => T, platform: NodeJS.Platform = process.platform): T {
  const pauses = [10, 25, 50, 100];
  for (let attempt = 0; ; attempt++) {
    try { return operation(); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (platform !== 'win32' || !['EPERM', 'EBUSY', 'EACCES'].includes(code ?? '') || attempt >= pauses.length) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pauses[attempt]!);
    }
  }
}
export function renameWithRetry(source: string, destination: string): void { retryWindowsFs(() => fs.renameSync(source, destination)); }
export function removeWithRetry(target: string, recursive = false): void {
  retryWindowsFs(() => fs.rmSync(target, { recursive, force: true, maxRetries: process.platform === 'win32' ? 3 : 0, retryDelay: 40 }));
}
