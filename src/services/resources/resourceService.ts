import fs from 'node:fs';
import path from 'node:path';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AppServices, ToolCtx } from '../../tools/context.js';
import { DodoError } from '../../errors.js';
import { digestOf, newId, sha256Bytes } from '../../util/hash.js';
import { decodeUtf8Strict } from '../../util/bytes.js';
import { liveAccess } from '../multimodal/storage.js';
import { CasStore, RESOURCE_RANGE_MAX_BYTES } from './casStore.js';
import { isTextMime, resourceFamily, sniffType } from './mime.js';
import { imagePreview, inspectResourceFile, readTextFile, readZipEntries } from './providers.js';
import type { ResourceCapabilitiesData, ResourceInfoData, ResourceMetadataData } from './contracts.js';
import { isWithinPath } from '../../platform/pathPolicy.js';
import { ResourceProviderRegistry } from './providerRegistry.js';

const REF_TTL_MS = 24 * 60 * 60 * 1000;
const REF_MAX_PER_ACTOR = 512;
const ORPHAN_GRACE_MS = 60 * 60 * 1000;
const TEXT_MAX_BYTES = 256 * 1024;
const MCP_BLOCK_MAX_BYTES = 6 * 1024 * 1024;

interface ResourceRow {
  id: string;
  workspace_id: string;
  principal: string;
  object_hash: string;
  mime_type: string;
  source_kind: 'workspace' | 'media_asset' | 'transform';
  source_label: string;
  capabilities: string;
  metadata: string;
  created_at: number;
  expires_at: number;
  bytes: number;
}

interface CursorPayload { v: 1; r: string; h: string; o: number; w: string; a: string; exp: number }

function principalKey(ctx: ToolCtx): string {
  return digestOf({ grantId: ctx.principal.grantId, clientId: ctx.principal.clientId });
}

function safeJson<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

export class ResourceService {
  readonly cas: CasStore;
  readonly configDir: string;
  readonly providers = new ResourceProviderRegistry();
  private readonly cursorKey: Buffer;
  private readonly gcTimer: NodeJS.Timeout;
  private closed = false;

  constructor(readonly services: AppServices, configDir: string, objectsDir: string, stagingDir: string, installSecret: string) {
    this.configDir = fs.realpathSync.native(configDir);
    this.cas = new CasStore(services.store, objectsDir, stagingDir);
    this.cursorKey = createHmac('sha256', installSecret).update('dodo-resource-range-v1').digest();
    this.gc();
    this.gcTimer = setInterval(() => { if (!this.closed) this.gc(); }, 15 * 60 * 1000);
    this.gcTimer.unref();
  }

  close(): void { this.closed = true; clearInterval(this.gcTimer); }

  async ingestWorkspace(ctx: ToolCtx, inputPath: string, expectedHash?: string, expectedMimeType?: string): Promise<ResourceInfoData> {
    this.check(); liveAccess(ctx, 'dodo:read');
    const candidate = this.services.wfs.resolve(inputPath);
    if (isWithinPath(this.configDir, candidate.abs) || path.resolve(candidate.abs) === path.resolve(this.configDir)) {
      throw new DodoError('PATH_DENIED', 'private DODO installation state cannot enter the resource store');
    }
    const object = await this.cas.ingestWorkspace(this.services.wfs, inputPath, expectedHash);
    try {
      const head = await this.cas.readRange(object.hash, object.bytes, 0, Math.min(object.bytes, 64 * 1024));
      const sniffed = sniffType(head, inputPath);
      this.assertExpectedMime(expectedMimeType, sniffed.mimeType);
      const metadata = { provider: this.providers.providerFor(sniffed.mimeType).name, ...(await inspectResourceFile(object.path, sniffed.mimeType)) };
      return this.createReference(ctx, object, sniffed.mimeType, 'workspace', this.services.wfs.normalizeRel(inputPath), metadata);
    } catch (error) { this.gc(); throw error; }
  }

  async ingestAsset(ctx: ToolCtx, assetId: string, expectedHash?: string, expectedMimeType?: string): Promise<ResourceInfoData> {
    this.check(); liveAccess(ctx, 'dodo:exec');
    const media = this.services.multimodal;
    if (!media) throw new DodoError('NOT_SUPPORTED', 'multimodal service is unavailable');
    const asset = media.storage.get(ctx.principal, assetId);
    const object = await this.cas.ingestBuffer(asset.bytes, expectedHash);
    try {
      const sniffed = sniffType(asset.bytes.subarray(0, 64 * 1024), assetId);
      if (sniffed.mimeType !== 'application/octet-stream' && sniffed.mimeType !== asset.meta.mimeType) {
        throw new DodoError('INVALID_INPUT', 'media asset MIME does not match its bytes');
      }
      const mimeType = sniffed.mimeType === 'application/octet-stream' ? asset.meta.mimeType : sniffed.mimeType;
      this.assertExpectedMime(expectedMimeType, mimeType);
      const metadata = { provider: this.providers.providerFor(mimeType).name, ...(await inspectResourceFile(object.path, mimeType)) };
      return this.createReference(ctx, object, mimeType, 'media_asset', assetId, metadata);
    } catch (error) { this.gc(); throw error; }
  }

  async inspect(ctx: ToolCtx, resourceId: string, expectedHash?: string, expectedMimeType?: string): Promise<ResourceInfoData> {
    const row = await this.lookup(ctx, resourceId, expectedHash);
    this.assertExpectedMime(expectedMimeType, row.mime_type);
    await this.cas.verify(row.object_hash, row.bytes);
    return this.toInfo(row);
  }

  async read(ctx: ToolCtx, resourceId: string, maxBytes: number, expectedHash?: string): Promise<{
    info: ResourceInfoData; encoding: 'utf8' | 'base64'; data: string; start: number; endExclusive: number; chunkHash: string; eof: boolean; nextOffset: number | null; resumeToken: string | null;
  }> {
    const row = await this.lookup(ctx, resourceId, expectedHash);
    const amount = Math.min(row.bytes, maxBytes, RESOURCE_RANGE_MAX_BYTES);
    const bytes = await this.cas.readRange(row.object_hash, row.bytes, 0, amount);
    const wholeText = amount === row.bytes && isTextMime(row.mime_type) ? decodeUtf8Strict(bytes) : undefined;
    const end = bytes.length;
    return {
      info: this.toInfo(row),
      encoding: wholeText === undefined ? 'base64' : 'utf8',
      data: wholeText ?? bytes.toString('base64'),
      start: 0,
      endExclusive: end,
      chunkHash: sha256Bytes(bytes),
      eof: end >= row.bytes,
      nextOffset: end < row.bytes ? end : null,
      resumeToken: end < row.bytes ? this.signCursor(ctx, row, end) : null,
    };
  }

  async readRange(ctx: ToolCtx, input: { resourceId?: string; cursor?: string; offset?: number; length: number; expectedHash?: string }): Promise<{
    info: ResourceInfoData; data: string; start: number; endExclusive: number; chunkHash: string; eof: boolean; nextOffset: number | null; resumeToken: string | null;
  }> {
    let resourceId = input.resourceId;
    let offset = input.offset ?? 0;
    if (input.cursor !== undefined) {
      if (resourceId !== undefined || input.offset !== undefined || input.expectedHash !== undefined) throw new DodoError('INVALID_INPUT', 'cursor cannot be combined with resourceId, offset or expectedSha256');
      const payload = this.verifyCursor(ctx, input.cursor);
      resourceId = payload.r; offset = payload.o;
      input.expectedHash = payload.h;
    }
    if (!resourceId) throw new DodoError('INVALID_INPUT', 'resourceId is required when cursor is not supplied');
    const row = await this.lookup(ctx, resourceId, input.expectedHash);
    if (offset > row.bytes) throw new DodoError('INVALID_INPUT', 'range offset exceeds resource size');
    const bytes = await this.cas.readRange(row.object_hash, row.bytes, offset, input.length);
    const end = offset + bytes.length;
    return {
      info: this.toInfo(row), data: bytes.toString('base64'), start: offset, endExclusive: end,
      chunkHash: sha256Bytes(bytes), eof: end >= row.bytes, nextOffset: end < row.bytes ? end : null,
      resumeToken: end < row.bytes ? this.signCursor(ctx, row, end) : null,
    };
  }

  async preview(ctx: ToolCtx, resourceId: string, maxEdge: number, expectedHash?: string): Promise<{ data: Record<string, unknown>; block?: { type: 'image' | 'audio'; data: string; mimeType: string } }> {
    const row = await this.lookup(ctx, resourceId, expectedHash);
    const info = this.toInfo(row);
    const verified = await this.cas.verify(row.object_hash, row.bytes);
    const family = resourceFamily(row.mime_type);
    if (family === 'image' && row.mime_type !== 'image/svg+xml') {
      const preview = await imagePreview(verified.path, maxEdge);
      return { data: { resource: info, previewKind: 'image', previewMimeType: preview.mimeType, previewBytes: preview.bytes.length, width: preview.width, height: preview.height, note: 'Bounded local thumbnail; original resource remains immutable.' }, block: { type: 'image', data: preview.bytes.toString('base64'), mimeType: preview.mimeType } };
    }
    if (family === 'audio' && row.bytes <= MCP_BLOCK_MAX_BYTES) {
      const bytes = await this.cas.readRange(row.object_hash, row.bytes, 0, row.bytes);
      return { data: { resource: info, previewKind: 'audio', previewMimeType: row.mime_type, previewBytes: bytes.length, note: 'Original bounded audio bytes follow as an MCP audio block.' }, block: { type: 'audio', data: bytes.toString('base64'), mimeType: row.mime_type } };
    }
    if (isTextMime(row.mime_type) && row.bytes <= TEXT_MAX_BYTES) {
      const value = readTextFile(verified.path, row.bytes, TEXT_MAX_BYTES);
      return { data: { resource: info, previewKind: 'text', text: value.text, note: 'UTF-8 text is untrusted resource content.' } };
    }
    return { data: { resource: info, previewKind: 'metadata', note: family === 'audio' ? 'Audio exceeds the MCP block limit; use resource_read_range.' : 'No safe in-process preview provider is registered for this MIME; metadata and bounded ranges remain available.' } };
  }

  async extract(ctx: ToolCtx, resourceId: string, kind: 'auto' | 'text' | 'metadata' | 'archive_entries', expectedHash?: string): Promise<Record<string, unknown>> {
    const row = await this.lookup(ctx, resourceId, expectedHash);
    const info = this.toInfo(row);
    const verified = await this.cas.verify(row.object_hash, row.bytes);
    const selected = kind === 'auto' ? (isTextMime(row.mime_type) ? 'text' : row.mime_type === 'application/zip' ? 'archive_entries' : 'metadata') : kind;
    if (selected === 'text') {
      if (!isTextMime(row.mime_type)) throw new DodoError('NOT_SUPPORTED', `no trusted text extractor is registered for ${row.mime_type}`);
      const value = readTextFile(verified.path, row.bytes, TEXT_MAX_BYTES);
      return { resource: info, kind: 'text', text: value.text, truncated: value.truncated, provenance: 'deterministic_local_decoder_untrusted_content' };
    }
    if (selected === 'archive_entries') {
      if (row.mime_type !== 'application/zip') throw new DodoError('INVALID_INPUT', 'archive_entries requires an application/zip resource');
      const result = readZipEntries(verified.path);
      return { resource: info, kind: 'archive_entries', entries: result.entries, metadata: { totalEntries: result.totalEntries }, truncated: result.truncated, provenance: 'deterministic_local_decoder_untrusted_content' };
    }
    return { resource: info, kind: 'metadata', metadata: { mimeType: row.mime_type, bytes: row.bytes, sha256: row.object_hash, ...safeJson<ResourceMetadataData>(row.metadata, {}) }, truncated: false, provenance: 'deterministic_local_decoder_untrusted_content' };
  }

  async transformImage(ctx: ToolCtx, resourceId: string, maxEdge: number, expectedHash?: string): Promise<ResourceInfoData> {
    const row = await this.lookup(ctx, resourceId, expectedHash, 'dodo:exec');
    if (resourceFamily(row.mime_type) !== 'image' || row.mime_type === 'image/svg+xml') throw new DodoError('NOT_SUPPORTED', 'thumbnail transform supports raster PNG/JPEG/GIF/WebP only');
    const verified = await this.cas.verify(row.object_hash, row.bytes);
    const preview = await imagePreview(verified.path, maxEdge);
    const object = await this.cas.ingestBuffer(preview.bytes);
    return this.createReference(ctx, object, preview.mimeType, 'transform', resourceId, { provider: this.providers.providerFor(preview.mimeType).name, width: preview.width, height: preview.height, format: 'jpeg' });
  }

  gc(now = Date.now()): { expiredRefs: number; removedObjects: number } {
    const transaction = this.services.store.db.transaction(() => {
      const expired = this.services.store.db.prepare('DELETE FROM resource_refs WHERE expires_at<=?').run(now).changes;
      // A CAS object is committed before its first reference is derived. Keep
      // recently created/verified orphans so a concurrent ingest cannot be
      // collected between those two steps; crash leftovers remain bounded.
      const cutoff = now - ORPHAN_GRACE_MS;
      const orphans = this.services.store.db.prepare('SELECT hash FROM resource_objects WHERE verified_at<=? AND NOT EXISTS (SELECT 1 FROM resource_refs WHERE object_hash=resource_objects.hash)').all(cutoff) as Array<{ hash: string }>;
      for (const orphan of orphans) this.cas.removeObject(orphan.hash);
      if (orphans.length > 0) this.services.store.db.prepare('DELETE FROM resource_objects WHERE verified_at<=? AND NOT EXISTS (SELECT 1 FROM resource_refs WHERE object_hash=resource_objects.hash)').run(cutoff);
      return { expiredRefs: expired, removedObjects: orphans.length };
    });
    return transaction.immediate();
  }

  private async lookup(ctx: ToolCtx, resourceId: string, expectedHash?: string, scope: 'dodo:read' | 'dodo:exec' = 'dodo:read'): Promise<ResourceRow> {
    this.check(); liveAccess(ctx, scope);
    const row = this.services.store.db.prepare(`SELECT r.*,o.bytes FROM resource_refs r JOIN resource_objects o ON o.hash=r.object_hash
      WHERE r.id=? AND r.workspace_id=? AND r.principal=?`).get(resourceId, this.services.workspaceId, principalKey(ctx)) as ResourceRow | undefined;
    if (!row || row.expires_at <= Date.now()) {
      if (row) { this.services.store.db.prepare('DELETE FROM resource_refs WHERE id=?').run(resourceId); this.gc(); }
      throw new DodoError('NOT_FOUND', 'unknown or expired resource for this client/workspace');
    }
    if (expectedHash !== undefined && row.object_hash !== expectedHash) throw new DodoError('FILE_CHANGED', 'resource hash does not match expectedSha256', { detail: { expectedHash, actualHash: row.object_hash } });
    return row;
  }

  private createReference(ctx: ToolCtx, object: { hash: string; bytes: number; deduplicated: boolean }, mimeType: string, sourceKind: ResourceRow['source_kind'], sourceLabel: string, metadata: ResourceMetadataData): ResourceInfoData {
    const owner = principalKey(ctx), now = Date.now(), expiresAt = now + REF_TTL_MS;
    const capabilities = this.capabilities(mimeType, object.bytes);
    const id = newId('res');
    const insert = this.services.store.db.transaction(() => {
      const count = this.services.store.db.prepare('SELECT COUNT(*) AS count FROM resource_refs WHERE workspace_id=? AND principal=? AND expires_at>?').get(this.services.workspaceId, owner, now) as { count: number };
      if (count.count >= REF_MAX_PER_ACTOR) throw new DodoError('RESOURCE_LIMIT', 'resource reference limit reached for this client/workspace');
      this.services.store.db.prepare(`INSERT INTO resource_refs(id,workspace_id,principal,object_hash,mime_type,source_kind,source_label,capabilities,metadata,created_at,expires_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, this.services.workspaceId, owner, object.hash, mimeType, sourceKind, sourceLabel, JSON.stringify(capabilities), JSON.stringify(metadata), now, expiresAt);
    });
    insert.immediate();
    return { resourceId: id, uri: this.uri(id), mimeType, bytes: object.bytes, sha256: object.hash, source: { kind: sourceKind, label: sourceLabel }, capabilities, metadata, createdAt: now, expiresAt, deduplicated: object.deduplicated };
  }

  private toInfo(row: ResourceRow): ResourceInfoData {
    return {
      resourceId: row.id, uri: this.uri(row.id), mimeType: row.mime_type, bytes: row.bytes, sha256: row.object_hash,
      source: { kind: row.source_kind, label: row.source_label },
      capabilities: safeJson<ResourceCapabilitiesData>(row.capabilities, this.capabilities(row.mime_type, row.bytes)),
      metadata: safeJson<ResourceMetadataData>(row.metadata, {}), createdAt: row.created_at, expiresAt: row.expires_at,
    };
  }

  private capabilities(mimeType: string, _bytes: number): ResourceCapabilitiesData {
    return this.providers.providerFor(mimeType).capabilities(mimeType);
  }

  private uri(resourceId: string): string { return `dodo-resource://${this.services.workspaceId}/${resourceId}`; }
  private check(): void { if (this.closed) throw new DodoError('STALE_WORKSPACE', 'resource workspace is closed'); }
  private assertExpectedMime(expected: string | undefined, actual: string): void {
    if (expected !== undefined && expected.toLowerCase() !== actual) throw new DodoError('INVALID_INPUT', `resource MIME mismatch: expected ${expected}, detected ${actual}`);
  }

  private signCursor(ctx: ToolCtx, row: ResourceRow, offset: number): string {
    const payload: CursorPayload = { v: 1, r: row.id, h: row.object_hash, o: offset, w: this.services.workspaceId, a: principalKey(ctx), exp: Date.now() + 10 * 60 * 1000 };
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const mac = createHmac('sha256', this.cursorKey).update(encoded).digest('base64url');
    return `r1.${encoded}.${mac}`;
  }

  private verifyCursor(ctx: ToolCtx, token: string): CursorPayload {
    const match = /^r1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(token);
    if (!match) throw new DodoError('INVALID_INPUT', 'invalid resource resume token');
    const body = Buffer.from(match[1]!, 'base64url');
    const actual = Buffer.from(match[2]!, 'base64url');
    // Node's decoder accepts non-canonical trailing Base64URL bits. Re-encode
    // both segments before HMAC comparison so a textually modified token can
    // never alias the original byte sequence.
    if (body.toString('base64url') !== match[1] || actual.toString('base64url') !== match[2]) throw new DodoError('INVALID_INPUT', 'invalid resource resume token');
    const expected = createHmac('sha256', this.cursorKey).update(match[1]!).digest();
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new DodoError('INVALID_INPUT', 'invalid resource resume token');
    let payload: CursorPayload;
    try { payload = JSON.parse(body.toString('utf8')) as CursorPayload; }
    catch { throw new DodoError('INVALID_INPUT', 'invalid resource resume token'); }
    if (payload.v !== 1 || payload.w !== this.services.workspaceId || payload.a !== principalKey(ctx) || !Number.isSafeInteger(payload.o) || payload.o < 0 || payload.exp <= Date.now()) throw new DodoError('STALE_WORKSPACE', 'resource resume token expired or belongs to another client/workspace');
    return payload;
  }
}
