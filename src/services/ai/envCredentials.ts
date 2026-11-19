import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { DodoError } from '../../errors.js';
import { assertPrivatePath, ensurePrivateDirectory } from '../../platform/privateFs.js';
import { removeWithRetry, renameWithRetry } from '../../platform/fsRetry.js';

const HEADER = '# DODO local API credential v1\n';
const MAX_FILE_BYTES = 32 * 1024;
const RESERVED_NAMES = new Set(['PATH', 'HOME', 'USER', 'USERNAME', 'USERPROFILE', 'LOGNAME', 'SHELL', 'COMSPEC', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'DODO_CONFIG_DIR']);

function validateId(id: string): void {
  if (!/^ai_[a-z0-9_-]{8,64}$/.test(id)) throw new DodoError('INVALID_INPUT', 'invalid provider credential identifier');
}
export function validateEnvVariable(name: string): string {
  if (!/^[A-Z][A-Z0-9_]{2,127}$/.test(name) || RESERVED_NAMES.has(name) || /^(?:NODE_|LD_|DYLD_)/.test(name)) {
    throw new DodoError('INVALID_INPUT', 'API key Env name must be an uppercase identifier of 3–128 characters, separate from OS and loader settings');
  }
  return name;
}
export function defaultEnvVariable(id: string): string {
  validateId(id);
  return `DODO_AI_KEY_${createHash('sha256').update(id).digest('hex').slice(0, 32).toUpperCase()}`;
}
export function validateCredential(key: string): void {
  if (key.length < 1 || key.length > 4096 || /[\x00-\x20\x7f]/.test(key)) throw new DodoError('INVALID_INPUT', 'API key must be a single nonempty credential without whitespace');
}
function unavailable(): DodoError {
  return new DodoError('AUTH_REQUIRED', 'saved Env credential is unavailable or its variable binding changed; reenter the API key');
}
function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}
function sameFile(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs && right.nlink === 1;
}

/** Data-only .env credentials private to this installation; never exported to child environments. */
export class EnvCredentials {
  private readonly directory: string | undefined;
  constructor(directory?: string) {
    if (directory !== undefined && (!path.isAbsolute(directory) || path.resolve(directory) === path.parse(directory).root)) throw new DodoError('INVALID_INPUT', 'Env credential storage needs a dedicated absolute directory');
    this.directory = directory === undefined ? undefined : path.resolve(directory);
  }

  has(id: string, envVar?: string, expectedFingerprint?: string): boolean {
    try {
      const key = this.get(id, envVar);
      if (!key) return false;
      if (expectedFingerprint === undefined) return true;
      if (!/^sha256:[a-f0-9]{64}$/.test(expectedFingerprint)) return false;
      return timingSafeEqual(createHash('sha256').update(key).digest(), Buffer.from(expectedFingerprint.slice(7), 'hex'));
    } catch { return false; }
  }

  get(id: string, envVar?: string): string {
    validateId(id); const name = validateEnvVariable(envVar ?? defaultEnvVariable(id));
    const owned = this.readOwned(id, name);
    if (owned !== undefined) return owned;
    const inherited = process.env[name];
    if (inherited === undefined || inherited.length === 0) return '';
    try { validateCredential(inherited); } catch { throw unavailable(); }
    return inherited;
  }

  set(id: string, key: string, envVar?: string): void {
    validateId(id); validateCredential(key);
    const name = validateEnvVariable(envVar ?? defaultEnvVariable(id));
    const directory = this.prepareDirectory();
    const target = this.file(id), stage = path.join(directory, `${id}.${randomUUID()}.tmp`);
    const payload = Buffer.from(`${HEADER}${name}=${JSON.stringify(key)}\n`, 'utf8');
    let descriptor: number | undefined;
    try {
      this.assertDirectory();
      try { assertPrivatePath(target); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      descriptor = fs.openSync(stage, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
      fs.writeFileSync(descriptor, payload); fs.fsyncSync(descriptor);
      const privateStage = assertPrivatePath(stage);
      if (!sameFile(privateStage, fs.fstatSync(descriptor)) || privateStage.size !== payload.length) throw unavailable();
      fs.closeSync(descriptor); descriptor = undefined;
      this.assertDirectory();
      renameWithRetry(stage, target);
      // Flush the replacement file too; POSIX additionally persists its directory entry.
      descriptor = fs.openSync(target, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0));
      const committed = assertPrivatePath(target);
      if (!sameFile(committed, fs.fstatSync(descriptor))) throw unavailable();
      fs.fsyncSync(descriptor); fs.closeSync(descriptor); descriptor = undefined;
      this.syncDirectory();
      const actual = Buffer.from(this.readOwned(id, name) ?? ''), expected = Buffer.from(key);
      try { if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw unavailable(); }
      finally { actual.fill(0); expected.fill(0); }
    } catch (error) {
      if (error instanceof DodoError) throw error;
      throw new DodoError('AUTH_REQUIRED', 'Env credential could not be saved; verify the local private storage and reenter the API key');
    } finally {
      payload.fill(0);
      if (descriptor !== undefined) fs.closeSync(descriptor);
      // The random staging filename is generated below the verified storage directory.
      if (fs.existsSync(stage)) {
        try { this.assertDirectory(); assertPrivatePath(stage); removeWithRetry(stage); } catch { /* retain uncertain private staging data rather than follow a changed path */ }
      }
    }
  }

  delete(id: string, envVar?: string): void {
    validateId(id); const name = validateEnvVariable(envVar ?? defaultEnvVariable(id));
    if (this.readOwned(id, name) === undefined) return;
    this.removeOwned(id);
  }

  /** Explicit connection removal owns this filename even when its payload cannot be parsed. */
  removeOwned(id: string): void {
    validateId(id);
    if (!this.directory) return;
    try { this.assertDirectory(); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    const target = this.file(id);
    let before: fs.Stats;
    try { before = assertPrivatePath(target); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    const descriptor = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      if (!sameFile(before, fs.fstatSync(descriptor))) throw unavailable();
      this.assertDirectory();
      if (!sameFile(before, assertPrivatePath(target))) throw unavailable();
      removeWithRetry(target); this.syncDirectory();
    } finally { fs.closeSync(descriptor); }
  }

  private file(id: string): string {
    if (!this.directory) throw new DodoError('NOT_SUPPORTED', 'persistent Env storage requires a local DODO configuration directory');
    return path.join(this.directory, `${id}.env`);
  }
  private prepareDirectory(): string {
    if (!this.directory) throw new DodoError('NOT_SUPPORTED', 'persistent Env storage requires a local DODO configuration directory');
    this.assertCanonicalAncestry(true);
    ensurePrivateDirectory(this.directory); this.assertDirectory(); return this.directory;
  }
  private assertDirectory(): void {
    if (!this.directory) throw new DodoError('NOT_SUPPORTED', 'persistent Env storage requires a local DODO configuration directory');
    this.assertCanonicalAncestry(false);
    assertPrivatePath(this.directory, true);
    if (!samePath(fs.realpathSync.native(this.directory), this.directory)) throw new DodoError('PATH_DENIED', 'Env credential storage must use its canonical private directory');
  }
  private assertCanonicalAncestry(allowMissing: boolean): void {
    if (!this.directory) return;
    const root = path.parse(this.directory).root;
    let prefix = root;
    for (const component of this.directory.slice(root.length).split(path.sep)) {
      prefix = path.join(prefix, component);
      let stat: fs.Stats;
      try { stat = fs.lstatSync(prefix); }
      catch (error) { if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
      if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(fs.realpathSync.native(prefix), prefix)) {
        throw new DodoError('PATH_DENIED', 'Env credential storage must use canonical directories without links');
      }
    }
  }
  private readOwned(id: string, name: string): string | undefined {
    if (!this.directory) return undefined;
    try { this.assertDirectory(); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    const target = this.file(id);
    let before: fs.Stats;
    try { before = assertPrivatePath(target); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    if (before.size > MAX_FILE_BYTES) throw unavailable();
    const descriptor = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const bytes = Buffer.alloc(before.size);
    try {
      if (!sameFile(before, fs.fstatSync(descriptor))) throw unavailable();
      let offset = 0;
      while (offset < bytes.length) {
        const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
        if (count === 0) throw unavailable();
        offset += count;
      }
      if (fs.readSync(descriptor, Buffer.alloc(1), 0, 1, offset) !== 0 || !sameFile(before, fs.fstatSync(descriptor)) || !sameFile(before, assertPrivatePath(target))) throw unavailable();
      const text = bytes.toString('utf8');
      if (!Buffer.from(text, 'utf8').equals(bytes) || !text.startsWith(HEADER)) throw unavailable();
      const match = /^([A-Z][A-Z0-9_]{2,127})=("[^\r\n]*")\n$/.exec(text.slice(HEADER.length));
      if (!match || match[1] !== name) throw unavailable();
      let value: unknown;
      try { value = JSON.parse(match[2]!); } catch { throw unavailable(); }
      if (typeof value !== 'string') throw unavailable();
      try { validateCredential(value); } catch { throw unavailable(); }
      return value;
    } finally { bytes.fill(0); fs.closeSync(descriptor); }
  }
  private syncDirectory(): void {
    if (process.platform === 'win32' || !this.directory) return;
    const directory = fs.openSync(this.directory, fs.constants.O_RDONLY);
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  }
}
