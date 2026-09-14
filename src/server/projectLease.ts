import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { DodoError } from '../errors.js';
/** Exclusive pre-bootstrap lease. A live/reused PID fails closed; never terminate it. */
export function acquireProjectLease(configDir: string, root: string): () => void {
  const dir = path.join(configDir, 'runtime-leases');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, createHash('sha256').update(root).digest('hex') + '.json');
  const value = JSON.stringify({ pid: process.pid, nonce: randomBytes(24).toString('hex') });
  for (let attempt = 0; attempt < 2; attempt++) {
    try { fs.writeFileSync(file, value, { flag: 'wx', mode: 0o600 }); return () => { try { if (fs.readFileSync(file, 'utf8') === value) fs.unlinkSync(file); } catch { /* absent */ } }; }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      try {
        const st = fs.lstatSync(file);
        if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size > 1024) throw new Error('invalid lease');
        const lease = JSON.parse(fs.readFileSync(file, 'utf8')) as { pid: number };
        if (!Number.isSafeInteger(lease.pid) || lease.pid <= 0) throw new Error('invalid pid');
        try { process.kill(lease.pid, 0); } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ESRCH') { fs.unlinkSync(file); continue; }
        }
      } catch { /* uncertain lease is never stolen */ }
      throw new DodoError('CONFLICT', 'another DODO runtime holds this project; close it before opening another');
    }
  }
  throw new DodoError('CONFLICT', 'could not acquire project runtime lease');
}
