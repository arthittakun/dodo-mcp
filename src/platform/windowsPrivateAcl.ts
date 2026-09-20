import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { envValue, windowsSystemExecutable } from './system.js';

type Helper = { directory: string; executable: string; hash: string; dev: number; ino: number; born: number };
let helper: Helper | null | undefined;
let nativeCalls = 0, bootstrapCalls = 0;
let bootstrapStage = 'not_started';
export const windowsPrivateAclDiagnostics = () => ({ nativeCalls, bootstrapCalls, backend: helper ? 'native-dotnet' : 'powershell', bootstrapStage });
const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** Caches only the compiler artifact, NEVER a path's permission decision. */
export function nativeWindowsAcl(env: NodeJS.ProcessEnv, protectDirectory: (directory: string) => void): boolean {
  if (helper === undefined) {
    helper = null;
    // Do not resolve csc from cwd/PATH or fetch executables from the network.
    const root = path.dirname(path.dirname(windowsSystemExecutable('cmd.exe')));
    const compiler = ['Framework64', 'Framework'].map(framework => path.join(root, 'Microsoft.NET', framework, 'v4.0.30319', 'csc.exe'))
      .find(file => { try { const st = fs.lstatSync(file);return st.isFile() && !st.isSymbolicLink(); } catch { return false; } });
    if (compiler) {
      let directory: string | undefined;
      try {
        bootstrapStage = 'create_private_directory';
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dodo-private-acl-'));
        bootstrapCalls++;protectDirectory(directory);
        bootstrapStage = 'read_bundled_source';
        const source = fileURLToPath(new URL('../../native/private-state-windows.cs', import.meta.url));
        const input = path.join(directory, 'private-state.cs'), executable = path.join(directory, 'private-state.exe');
        const contents = fs.readFileSync(source);
        if (contents.length > 32 * 1024) throw new Error('invalid helper source');
        fs.writeFileSync(input, contents, { flag: 'wx' });
        bootstrapStage = 'compile';
        execFileSync(compiler, ['/nologo', '/target:exe', '/optimize+', '/platform:anycpu', `/out:${executable}`, input],
          { cwd: directory, env: { SYSTEMROOT: envValue(process.env, 'SystemRoot'), WINDIR: envValue(process.env, 'windir'), TEMP: directory, TMP: directory },
            shell: false, windowsHide: true, timeout: 30000, maxBuffer: 4096, stdio: ['ignore', 'pipe', 'pipe'] });
        bootstrapStage = 'verify_artifact';
        const dir = fs.lstatSync(directory), file = fs.lstatSync(executable);
        if (!dir.isDirectory() || dir.isSymbolicLink() || !file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || file.size > 1024 * 1024) throw new Error('invalid helper artifact');
        helper = { directory, executable, hash: hash(fs.readFileSync(executable)), dev: dir.dev, ino: dir.ino, born: dir.birthtimeMs };
        bootstrapStage = 'ready';
        const owned = helper;
        process.once('exit', () => {
          try {
            const current = fs.lstatSync(owned.directory);
            if (!current.isSymbolicLink() && current.dev === owned.dev && current.ino === owned.ino && current.birthtimeMs === owned.born)
              fs.rmSync(owned.directory, { recursive: true, force: true });
          } catch { /* Private temp artifact may remain after a crash; never delete other paths. */ }
        });
      } catch {
        // Same fail-closed PowerShell ACL policy remains available when inbox
        // compilation is unavailable. No permission-result or less strict fallback.
        if (directory) { try { fs.rmSync(directory, { recursive: true, force: true }); } catch { /* private build directory only */ } }
      }
    } else bootstrapStage = 'compiler_unavailable';
  }
  if (!helper) {
    if (process.env['DODO_TEST_REQUIRE_NATIVE_ACL'] === '1') throw new Error('native ACL backend required by this fixture');
    return false;
  }
  const dir = fs.lstatSync(helper.directory), file = fs.lstatSync(helper.executable);
  if (dir.isSymbolicLink() || !dir.isDirectory() || dir.dev !== helper.dev || dir.ino !== helper.ino || dir.birthtimeMs !== helper.born
    || !file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || file.size > 1024 * 1024 || hash(fs.readFileSync(helper.executable)) !== helper.hash)
    throw new Error('private ACL helper identity changed');
  nativeCalls++;
  const output = execFileSync(helper.executable, [], { env, cwd: helper.directory, shell: false, windowsHide: true,
    timeout: 10000, maxBuffer: 4096, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (output.trim() !== 'private') throw new Error('native ACL verification failed');
  return true;
}
