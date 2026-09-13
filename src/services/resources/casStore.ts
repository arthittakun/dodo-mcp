import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Store } from '../../store/store.js';
import type { WorkspaceFS } from '../../workspace/fs.js';
import { DodoError } from '../../errors.js';
import { ensurePrivateDirectory, assertPrivatePath } from '../../platform/privateFs.js';
import { removeWithRetry } from '../../platform/fsRetry.js';

export const RESOURCE_OBJECT_MAX_BYTES = 512 * 1024 * 1024;
export const RESOURCE_STORE_MAX_BYTES = 2 * 1024 * 1024 * 1024;
export const RESOURCE_RANGE_MAX_BYTES = 256 * 1024;
const RESOURCE_ORPHAN_GRACE_MS = 60 * 60 * 1000;

export interface CasObject {
  hash: string;
  bytes: number;
  path: string;
  deduplicated: boolean;
}

function hashHex(hash: string): string {
  const match = /^sha256:([a-f0-9]{64})$/.exec(hash);
  if (!match) throw new DodoError('INVALID_INPUT', 'expectedSha256 must use sha256:<64 lowercase hex>');
  return match[1]!;
}

function sameIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

async function digestFile(file: fs.promises.FileHandle, size: number): Promise<string> {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let offset = 0;
  while (offset < size) {
    const result = await file.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
    if (result.bytesRead <= 0) throw new DodoError('FILE_CHANGED', 'resource ended while hashing');
    hash.update(buffer.subarray(0, result.bytesRead));
    offset += result.bytesRead;
  }
  return `sha256:${hash.digest('hex')}`;
}

/** Installation-private immutable object store. References and authorization live in SQLite. */
export class CasStore {
  constructor(
    readonly store: Store,
    readonly objectsDir: string,
    readonly stagingDir: string,
  ) {
    ensurePrivateDirectory(objectsDir);
    ensurePrivateDirectory(stagingDir);
    this.cleanupStaging();
    this.cleanupUnreferencedCrashObjects();
  }

  objectPath(hash: string): string {
    const hex = hashHex(hash);
    return path.join(this.objectsDir, hex.slice(0, 2), hex);
  }

  async ingestWorkspace(wfs: WorkspaceFS, inputPath: string, expectedHash?: string): Promise<CasObject> {
    const resolved = wfs.resolve(inputPath);
    const before = wfs.assertRegularFileForDirectAccess(resolved);
    if (before.size > RESOURCE_OBJECT_MAX_BYTES) throw new DodoError('FILE_TOO_LARGE', 'resource exceeds the 512 MiB object limit');
    const source = await fs.promises.open(resolved.abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stage = this.stagePath();
    let output: fs.promises.FileHandle | undefined;
    try {
      const opened = await source.stat();
      if (!opened.isFile() || opened.nlink !== 1 || !sameIdentity(before, opened)) throw new DodoError('FILE_CHANGED', 'workspace resource changed while opening');
      output = await fs.promises.open(stage, 'wx', 0o600);
      const hash = createHash('sha256');
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      let offset = 0;
      while (offset < opened.size) {
        const result = await source.read(buffer, 0, Math.min(buffer.length, opened.size - offset), offset);
        if (result.bytesRead <= 0) throw new DodoError('FILE_CHANGED', 'workspace resource ended during ingest');
        const chunk = buffer.subarray(0, result.bytesRead);
        await output.write(chunk, 0, chunk.length, offset);
        hash.update(chunk);
        offset += result.bytesRead;
      }
      await output.sync();
      await output.close(); output = undefined;
      const afterOpen = await source.stat();
      const afterPath = wfs.assertRegularFileForDirectAccess(wfs.resolve(inputPath));
      if (!sameIdentity(opened, afterOpen) || !sameIdentity(opened, afterPath)) throw new DodoError('FILE_CHANGED', 'workspace resource changed during ingest');
      const digest = `sha256:${hash.digest('hex')}`;
      if (expectedHash !== undefined && digest !== expectedHash) throw new DodoError('FILE_CHANGED', 'resource hash does not match expectedSha256', { detail: { expectedHash, actualHash: digest } });
      return await this.commitStage(stage, digest, opened.size);
    } finally {
      await output?.close().catch(() => undefined);
      await source.close().catch(() => undefined);
      if (fs.existsSync(stage)) removeWithRetry(stage);
    }
  }

  async ingestBuffer(bytes: Buffer, expectedHash?: string): Promise<CasObject> {
    if (bytes.length > RESOURCE_OBJECT_MAX_BYTES) throw new DodoError('FILE_TOO_LARGE', 'resource exceeds the 512 MiB object limit');
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    if (expectedHash !== undefined && digest !== expectedHash) throw new DodoError('FILE_CHANGED', 'resource hash does not match expectedSha256', { detail: { expectedHash, actualHash: digest } });
    const stage = this.stagePath();
    try {
      fs.writeFileSync(stage, bytes, { flag: 'wx', mode: 0o600 });
      // FlushFileBuffers on Windows requires a writable handle.
      const handle = fs.openSync(stage, 'r+');
      try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
      return await this.commitStage(stage, digest, bytes.length);
    } finally {
      if (fs.existsSync(stage)) removeWithRetry(stage);
    }
  }

  async verify(hash: string, expectedBytes?: number): Promise<{ path: string; bytes: number }> {
    const objectPath = this.objectPath(hash);
    let stat: fs.Stats;
    try { stat = assertPrivatePath(objectPath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new DodoError('INTERNAL_ERROR', 'resource object is missing from the private store');
      throw error;
    }
    if (expectedBytes !== undefined && stat.size !== expectedBytes) throw new DodoError('INTERNAL_ERROR', 'resource object size verification failed');
    const handle = await fs.promises.open(objectPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.nlink !== 1 || !sameIdentity(stat, opened)) throw new DodoError('INTERNAL_ERROR', 'resource object identity verification failed');
      const actual = await digestFile(handle, opened.size);
      if (actual !== hash) throw new DodoError('INTERNAL_ERROR', 'resource object hash verification failed');
      this.store.db.prepare('UPDATE resource_objects SET verified_at=? WHERE hash=?').run(Date.now(), hash);
      return { path: objectPath, bytes: opened.size };
    } finally { await handle.close(); }
  }

  async readRange(hash: string, expectedBytes: number, offset: number, length: number): Promise<Buffer> {
    const verified = await this.verify(hash, expectedBytes);
    const amount = Math.min(length, Math.max(0, verified.bytes - offset));
    const out = Buffer.alloc(amount);
    if (amount === 0) return out;
    const handle = await fs.promises.open(verified.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const result = await handle.read(out, 0, amount, offset);
      if (result.bytesRead !== amount) throw new DodoError('INTERNAL_ERROR', 'resource object changed during range read');
      return out;
    } finally { await handle.close(); }
  }

  removeObject(hash: string): void {
    const objectPath = this.objectPath(hash);
    if (fs.existsSync(objectPath)) removeWithRetry(objectPath);
  }

  private stagePath(): string { return path.join(this.stagingDir, `${process.pid}-${randomUUID()}.part`); }

  private async commitStage(stage: string, hash: string, bytes: number): Promise<CasObject> {
    const existing = this.store.db.prepare('SELECT bytes FROM resource_objects WHERE hash=?').get(hash) as { bytes: number } | undefined;
    if (existing) {
      // Refresh the orphan grace lease before the async verification. If GC
      // won the race and removed the row, continue through the new-object path.
      const claimed = this.store.db.prepare('UPDATE resource_objects SET verified_at=? WHERE hash=? AND bytes=?').run(Date.now(), hash, existing.bytes).changes;
      if (claimed === 1) {
        await this.verify(hash, existing.bytes);
        if (existing.bytes !== bytes) throw new DodoError('INTERNAL_ERROR', 'content hash collision or corrupt resource metadata');
        return { hash, bytes, path: this.objectPath(hash), deduplicated: true };
      }
    }
    this.assertQuota(bytes);
    const target = this.objectPath(hash);
    ensurePrivateDirectory(path.dirname(target));
    let won = false;
    let createdTarget = false;
    try {
      // Staging and objects share one private filesystem. link() has
      // create-if-absent semantics and publishes the complete fsynced inode
      // atomically; unlike rename() on POSIX it cannot overwrite a winner.
      fs.linkSync(stage, target);
      createdTarget = true;
      removeWithRetry(stage);
      if (process.platform !== 'win32') fs.chmodSync(target, 0o600);
      assertPrivatePath(target);
      won = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        if (createdTarget && fs.existsSync(target)) removeWithRetry(target);
        throw error;
      }
    }
    if (!won) {
      const verified = await this.verifyUnregistered(target, hash, bytes);
      if (!verified) throw new DodoError('INTERNAL_ERROR', 'existing CAS object failed verification');
    }
    try {
      this.store.db.prepare('INSERT OR IGNORE INTO resource_objects(hash,bytes,created_at,verified_at) VALUES (?,?,?,?)').run(hash, bytes, Date.now(), Date.now());
    } catch (error) {
      // Another process can observe the atomically published inode and commit
      // the same hash before this connection reaches SQLite. Never unlink an
      // object once any database row refers to it.
      const referenced = this.store.db.prepare('SELECT 1 FROM resource_objects WHERE hash=?').get(hash);
      if (won && !referenced && fs.existsSync(target)) removeWithRetry(target);
      if (/resource store quota exceeded/.test((error as Error).message)) throw new DodoError('RESOURCE_LIMIT', 'private resource store quota is 2 GiB; let expired references be collected before ingesting more');
      throw error;
    }
    const row = this.store.db.prepare('SELECT bytes FROM resource_objects WHERE hash=?').get(hash) as { bytes: number } | undefined;
    if (!row || row.bytes !== bytes) throw new DodoError('INTERNAL_ERROR', 'resource metadata collision');
    return { hash, bytes, path: target, deduplicated: !won };
  }

  private async verifyUnregistered(target: string, hash: string, bytes: number): Promise<boolean> {
    try {
      const stat = assertPrivatePath(target);
      if (stat.size !== bytes) return false;
      const handle = await fs.promises.open(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try { return (await digestFile(handle, bytes)) === hash; } finally { await handle.close(); }
    } catch { return false; }
  }

  private assertQuota(incoming: number): void {
    const row = this.store.db.prepare('SELECT COALESCE(SUM(bytes),0) AS bytes FROM resource_objects').get() as { bytes: number };
    if (row.bytes + incoming > RESOURCE_STORE_MAX_BYTES) throw new DodoError('RESOURCE_LIMIT', 'private resource store quota is 2 GiB; let expired references be collected before ingesting more');
  }

  private cleanupStaging(): void {
    const cutoff = Date.now() - RESOURCE_ORPHAN_GRACE_MS;
    for (const name of fs.readdirSync(this.stagingDir)) {
      if (!name.endsWith('.part')) continue;
      const target = path.join(this.stagingDir, name);
      try { if (fs.lstatSync(target).mtimeMs < cutoff) removeWithRetry(target); } catch { /* best effort; never follow */ }
    }
  }

  /**
   * Recover objects left between atomic file commit and SQLite commit. A one
   * hour grace avoids racing another live DODO process that is committing the
   * same hash; only canonical hash filenames under private real directories
   * are considered.
   */
  private cleanupUnreferencedCrashObjects(): void {
    const cutoff = Date.now() - RESOURCE_ORPHAN_GRACE_MS;
    for (const bucketName of fs.readdirSync(this.objectsDir)) {
      if (!/^[a-f0-9]{2}$/.test(bucketName)) continue;
      const bucket = path.join(this.objectsDir, bucketName);
      let bucketStat: fs.Stats;
      try { bucketStat = assertPrivatePath(bucket, true); }
      catch { throw new DodoError('PATH_DENIED', 'resource CAS bucket is not a private real directory'); }
      if (!bucketStat.isDirectory()) continue;
      for (const name of fs.readdirSync(bucket)) {
        if (!new RegExp(`^${bucketName}[a-f0-9]{62}$`).test(name)) continue;
        const target = path.join(bucket, name);
        const stat = fs.lstatSync(target);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new DodoError('PATH_DENIED', 'resource CAS contains an unexpected object');
        if (stat.mtimeMs >= cutoff) continue;
        const hash = `sha256:${name}`;
        const row = this.store.db.prepare('SELECT 1 FROM resource_objects WHERE hash=?').get(hash);
        if (!row) removeWithRetry(target);
      }
    }
  }
}
