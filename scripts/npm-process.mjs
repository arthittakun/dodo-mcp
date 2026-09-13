import fs from 'node:fs';
import path from 'node:path';

/**
 * Return a shell-free npm invocation. Node cannot spawn npm.cmd directly on
 * Windows, so release scripts reuse the npm CLI that launched `npm run`.
 */
export function npmInvocation(args, env = process.env) {
  if (process.platform !== 'win32') return { program: 'npm', args };
  const npmCli = env['npm_execpath'];
  if (!npmCli || !path.isAbsolute(npmCli)) {
    throw new Error('Windows release verification must be launched through an npm script so npm_execpath is available');
  }
  const stat = fs.statSync(npmCli);
  if (!stat.isFile()) throw new Error('npm_execpath does not identify a regular file');
  return { program: process.execPath, args: [npmCli, ...args] };
}
