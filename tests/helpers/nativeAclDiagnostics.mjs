// Optional CI observer for real CLI subprocesses. Never changes a result,
// retries a call, or prints child arguments/environment/error text.
import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

const directory = process.env.DODO_TEST_REPORT_DIR;
if (process.platform === 'win32' && directory) {
  const original = childProcess.execFileSync;
  childProcess.execFileSync = function (program, ...args) {
    try { return original.call(this, program, ...args); }
    catch (error) {
      const name = path.basename(String(program)).toLowerCase();
      if (['private-state.exe', 'powershell.exe', 'csc.exe'].includes(name)) {
        const options = args.find(value => value && typeof value === 'object' && !Array.isArray(value));
        const match = String(error.stderr ?? '').match(/private ACL verification failed; stage=([a-z-]+); hresult=(-?\d+)/);
        const stages = ['input','attributes','read','owner','protect-write','verify-dacl','repair-owner','final-attributes','final-read','final-owner','final-dacl'];
        const record = {
          program: name,
          mode: ['protect', 'verify'].includes(options?.env?.DODO_PRIVATE_MODE) ? options.env.DODO_PRIVATE_MODE : null,
          code: ['ENOENT','EPERM','EACCES','ETIMEDOUT','ENOBUFS'].includes(error.code) ? error.code : null,
          status: Number.isInteger(error.status) ? error.status : null,
          stage: stages.includes(match?.[1]) ? match[1] : null,
          hresult: match && Number.isSafeInteger(Number(match[2])) ? Number(match[2]) : null,
        };
        try { fs.appendFileSync(path.join(directory,'native-acl-observer.jsonl'), JSON.stringify(record)+'\n', {mode:0o600}); } catch { /* Original failure remains authoritative. */ }
      }
      throw error;
    }
  };
  syncBuiltinESMExports();
}
