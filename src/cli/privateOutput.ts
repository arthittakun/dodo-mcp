import fs from 'node:fs';
import path from 'node:path';
import { ensurePrivateDirectory, assertPrivatePath } from '../platform/privateFs.js';
import { DodoError } from '../errors.js';

const samePath = (left: string, right: string) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;

export function requirePrivateOutput(file?: string): void {
  if (!file && !process.stdout.isTTY) throw new DodoError('FORBIDDEN', 'private access links are not printed to redirected output; use --output-file <new-private-file>');
  if (file) {
    const target = path.resolve(file), parent = path.dirname(target);
    if (!samePath(fs.realpathSync.native(parent), parent) || !fs.statSync(parent).isDirectory()) throw new DodoError('PATH_DENIED', 'private output parent must be a canonical directory');
    try {
      fs.lstatSync(target);
      throw new DodoError('CONFLICT', 'private output file already exists; choose a new filename');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

/** An explicitly requested new file; never chmod a user's parent directory or overwrite a link. */
export function writePrivateOutput(file: string, value: unknown): string {
  const target = path.resolve(file), parent = fs.realpathSync.native(path.dirname(target));
  if (!samePath(parent, path.resolve(path.dirname(target)))) throw new DodoError('PATH_DENIED', 'private output parent must be a canonical directory');
  const directory = fs.mkdtempSync(path.join(parent, '.dodo-owner-link-'));
  let published = false;
  try {
    ensurePrivateDirectory(directory);
    const staging = path.join(directory, 'link.json');
    const fd = fs.openSync(staging, 'wx', 0o600);
    try { fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    assertPrivatePath(staging);
    // link() is exclusive, unlike rename() which could overwrite a raced destination.
    fs.linkSync(staging, target); published = true;
    fs.unlinkSync(staging);
    assertPrivatePath(target);
    return target;
  } catch (error) {
    if (published) { try { fs.unlinkSync(target); } catch { /* preserve the original failure */ } }
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new DodoError('CONFLICT', 'private output file already exists; choose a new filename');
    throw error;
  } finally {
    for (const entry of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, entry));
    fs.rmdirSync(directory);
  }
}
