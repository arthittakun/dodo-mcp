import { isOwner } from '../../security/projectAuthority.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ToolCtx, AppServices, Principal } from '../../tools/context.js';
import { DodoError } from '../../errors.js';
import { digestOf, newId, sha256Bytes } from '../../util/hash.js';
import type { AssetMetadata } from './contracts.js';
import { ensurePrivateDirectory } from '../../platform/privateFs.js';
import { removeWithRetry } from '../../platform/fsRetry.js';

export type Actor = Pick<Principal, 'grantId' | 'clientId'>;
export function actorKey(actor: Actor): string { return digestOf({ grantId: actor.grantId, clientId: actor.clientId }); }
export function liveAccess(ctx: ToolCtx, scope: 'dodo:read' | 'dodo:write' | 'dodo:exec'): void {
  if (!ctx.principal.scopes.includes(scope)) throw new DodoError('FORBIDDEN', `requires ${scope}`);
  if (isOwner(ctx.principal)) return;
  const s = ctx.services.store, grant = s.getGrant(ctx.principal.grantId);
  if (!grant || grant.revokedAt !== null || !s.getOAuthClient(ctx.principal.clientId) || !grant.scopes.includes(scope) || !s.clientAccess(ctx.services.workspaceId, ctx.principal.clientId).includes(scope)) {
    throw new DodoError('FORBIDDEN', 'client/grant/workspace access changed; operation stopped');
  }
}
export interface StoredAsset { meta: AssetMetadata; owner: string; bytes: Buffer; guard?: () => void }
export class MediaStorage {
  readonly assets = new Map<string, StoredAsset>();
  readonly directories = new Set<string>();
  closed = false;
  private assetBytes = 0;
  private sourceBytes = 0;
  constructor(readonly services: AppServices, readonly configDir: string) {}
  check(): void { if (this.closed) throw new DodoError('STALE_WORKSPACE', 'multimodal workspace closed'); }
  sweep(): void {
    for (const [id, a] of this.assets) if (a.meta.expiresAt <= Date.now()) { this.assetBytes -= a.bytes.length; this.assets.delete(id); }
  }
  put(actor: Actor, kind: AssetMetadata['kind'], mimeType: string, bytes: Buffer, opts: { ttlMs?: number; timeSec?: number; endSec?: number; guard?: () => void } = {}): AssetMetadata {
    this.check(); this.sweep();
    if (bytes.length > 6 * 1024 * 1024 || this.assets.size >= 96 || this.assetBytes + bytes.length > 48 * 1024 * 1024) throw new DodoError('RESOURCE_LIMIT', 'media image/audio cache budget reached; close sources or let assets expire');
    opts.guard?.();
    const meta: AssetMetadata = { assetId: newId('asset'), kind, mimeType, bytes: bytes.length, sha256: sha256Bytes(bytes), createdAt: Date.now(), expiresAt: Date.now() + (opts.ttlMs ?? 600000), ...(opts.timeSec !== undefined ? { timeSec: opts.timeSec } : {}), ...(opts.endSec !== undefined ? { endSec: opts.endSec } : {}) };
    this.assets.set(meta.assetId, { meta, owner: actorKey(actor), bytes, ...(opts.guard ? { guard: opts.guard } : {}) }); this.assetBytes += bytes.length;
    return meta;
  }
  get(actor: Actor, id: string): StoredAsset {
    this.check(); this.sweep(); const a = this.assets.get(id);
    if (!a || a.owner !== actorKey(actor)) throw new DodoError('NOT_FOUND', 'unknown/expired media asset for this client');
    a.guard?.(); return a;
  }
  remove(actor: Actor, id: string): void { const a = this.get(actor, id); this.assetBytes -= a.bytes.length; this.assets.delete(id); }
  directory(): string {
    this.check(); if (this.directories.size >= 48) throw new DodoError('RESOURCE_LIMIT', 'close media handles before opening more');
    const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dodo-media-')));
    try { ensurePrivateDirectory(dir); } catch (error) { removeWithRetry(dir, true); throw error; }
    this.directories.add(dir); return dir;
  }
  removeDirectory(dir: string): void { if (this.directories.has(dir)) { removeWithRetry(dir, true); this.directories.delete(dir); } }
  /** Stream a guarded regular file into an immutable private copy. Never bypass WorkspaceFS path rules. */
  async copySource(file: string, directory: string): Promise<{ path: string; sourcePath: string; hash: string; size: number }> {
    this.check(); const resolved = this.services.wfs.resolve(file), st = this.services.wfs.assertRegularFileForDirectAccess(resolved);
    const cap = 512 * 1024 * 1024;
    if (st.size > cap || this.sourceBytes + st.size > 1024 * 1024 * 1024) throw new DodoError('FILE_TOO_LARGE', 'media source cap is 512 MiB; open-source cache cap is 1 GiB; split large movies into clips');
    const dest = path.join(directory, 'input.media');
    const input = await fs.promises.open(resolved.abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let output: fs.promises.FileHandle | undefined; let reserved = false;
    try {
      const opened = await input.stat();
      if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== st.dev || opened.ino !== st.ino || opened.size !== st.size) throw new DodoError('FILE_CHANGED', 'source changed while opening');
      this.sourceBytes += st.size; reserved = true;
      output = await fs.promises.open(dest, 'wx', 0o600);
      const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024); let readTotal = 0;
      while (readTotal < st.size) {
        this.check(); const read = await input.read(buffer, 0, Math.min(buffer.length, st.size - readTotal), readTotal);
        if (!read.bytesRead) throw new DodoError('FILE_CHANGED', 'source ended during snapshot');
        const chunk = buffer.subarray(0, read.bytesRead); hash.update(chunk);
        let written = 0; while (written < chunk.length) { const w = await output.write(chunk, written, chunk.length - written); if (!w.bytesWritten) throw new Error('short write'); written += w.bytesWritten; }
        readTotal += read.bytesRead;
      }
      const after = await input.stat();
      if (after.size !== st.size || after.mtimeMs !== st.mtimeMs || after.ctimeMs !== st.ctimeMs || after.nlink !== 1) throw new DodoError('FILE_CHANGED', 'source changed during snapshot; retry from a stable file');
      return { path: dest, sourcePath: resolved.rel, hash: `sha256:${hash.digest('hex')}`, size: st.size };
    } catch (err) {
      if (reserved) this.sourceBytes -= st.size;
      await output?.close(); output = undefined;
      try { removeWithRetry(dest); } catch { /* outer owned-directory cleanup retries */ }
      throw err;
    }
    finally { await input.close(); await output?.close(); }
  }
  releaseSource(size: number): void { this.sourceBytes = Math.max(0, this.sourceBytes - size); }
  resultFile(dir: string, basename: string, cap = 6 * 1024 * 1024): Buffer {
    if (!this.directories.has(dir) || !/^(?:result\.json|out-[0-9]+\.(?:jpg|wav|json))$/.test(basename)) throw new DodoError('PATH_DENIED', 'invalid generated artifact');
    const file = path.join(dir, basename), before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || fs.realpathSync.native(file).toLowerCase() !== path.resolve(file).toLowerCase()) throw new DodoError('PATH_DENIED', 'generated artifact must not be a link or path alias');
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try { const st = fs.fstatSync(fd); if (!st.isFile() || st.nlink !== 1 || st.dev !== before.dev || st.ino !== before.ino || st.size > cap) throw new DodoError('RESOURCE_LIMIT', 'generated artifact changed, exceeds its budget, or is not regular'); return fs.readFileSync(fd); } finally { fs.closeSync(fd); }
  }
  close(): void { this.closed = true; this.assets.clear(); this.assetBytes = 0; for (const d of [...this.directories]) this.removeDirectory(d); this.sourceBytes = 0; }
}
