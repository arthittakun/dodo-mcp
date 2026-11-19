import type fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import type { Store } from '../../store/store.js';
import type { Principal, ToolCtx } from '../../tools/context.js';
import { DodoError } from '../../errors.js';
import { digestOf, newId, sha256Bytes } from '../../util/hash.js';
import { projectAuthority } from '../../security/projectAuthority.js';
import { projectScopeCeiling } from '../../security/projectAccess.js';
import { ProjectRegistry } from '../../projects/registry.js';
import { liveAccess } from '../multimodal/storage.js';
import type { CasStore } from './casStore.js';

export const DOWNLOAD_LINK_DAYS = [1, 2, 7, 14, 30] as const;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_OWNER_LINKS = 128;
const MAX_INSTALLATION_LINKS = 1024;
// Revoking and reissuing must not grow durable metadata without a bound.
const MAX_OWNER_RETAINED_LINKS = 512;
const MAX_INSTALLATION_RETAINED_LINKS = 4096;

export interface DownloadLinkCreateInput {
  resourceId: string;
  expectedSha256: string;
  expiresInDays: typeof DOWNLOAD_LINK_DAYS[number];
  fileName?: string;
}
export interface DownloadLinkInfo {
  linkId: string;
  resourceId: string;
  fileName: string;
  mimeType: string;
  bytes: number;
  sha256: string;
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
}
export interface DownloadLinkCreated extends DownloadLinkInfo { url: string }
export interface OpenDownload {
  handle: fs.promises.FileHandle;
  bytes: number;
  mimeType: string;
  filename: string;
  expiresAt: number;
  assertActive: () => void;
}
interface LinkRow {
  id: string;
  token_hash: string;
  workspace_id: string;
  principal: string;
  authority: string;
  registry_id: string | null;
  resource_id: string;
  object_hash: string;
  mime_type: string;
  file_name: string;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
  bytes: number;
}

function actor(ctx: ToolCtx): string {
  return digestOf({ grantId: ctx.principal.grantId, clientId: ctx.principal.clientId });
}
function unavailable(): DodoError {
  // Do not distinguish invalid, expired, revoked or unauthorized capabilities.
  return new DodoError('NOT_FOUND', 'download link is unavailable');
}
function fileNameFor(value: string): string {
  if (value.length === 0 || value.length > 180 || value === '.' || value === '..' || /[\p{Cc}/\\]/u.test(value) || Buffer.from(value, 'utf8').toString('utf8') !== value) {
    throw new DodoError('INVALID_INPUT', 'fileName must be a filename of 1–180 characters without path separators or control characters');
  }
  return value;
}
function toInfo(row: LinkRow): DownloadLinkInfo {
  return { linkId: row.id, resourceId: row.resource_id, fileName: row.file_name, mimeType: row.mime_type,
    bytes: row.bytes, sha256: row.object_hash, createdAt: row.created_at, expiresAt: row.expires_at, revokedAt: row.revoked_at };
}

/** Persistent, scoped grants to immutable CAS bytes. The public token is returned only once. */
export class DownloadLinkService {
  constructor(readonly store: Store, readonly cas: CasStore) {}

  async create(ctx: ToolCtx, input: DownloadLinkCreateInput, origin: string): Promise<DownloadLinkCreated> {
    this.manageAccess(ctx, 'dodo:write'); liveAccess(ctx, 'dodo:read');
    this.assertProjectAvailable(ctx.services.workspaceId);
    if (!(DOWNLOAD_LINK_DAYS as readonly number[]).includes(input.expiresInDays) || !/^sha256:[a-f0-9]{64}$/.test(input.expectedSha256)) {
      throw new DodoError('INVALID_INPUT', 'expectedSha256 and expiresInDays (1, 2, 7, 14 or 30) are required');
    }
    let base: URL;
    try { base = new URL(origin); }
    catch { throw new DodoError('NOT_SUPPORTED', 'temporary downloads require a configured HTTP server URL'); }
    if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== '/') {
      throw new DodoError('NOT_SUPPORTED', 'temporary downloads require a configured HTTP server origin');
    }
    const resources = ctx.services.resources;
    if (!resources) throw new DodoError('NOT_SUPPORTED', 'resource store is unavailable');
    const resource = await resources.inspect(ctx, input.resourceId, input.expectedSha256);
    ctx.revalidate?.(); this.manageAccess(ctx, 'dodo:write'); liveAccess(ctx, 'dodo:read');
    const filename = fileNameFor(input.fileName ?? this.defaultFilename(resource.mimeType));
    const encodedFilename = encodeURIComponent(filename);
    const now = Date.now(), expiresAt = now + input.expiresInDays * DAY_MS;
    const token = randomBytes(32).toString('base64url'), id = newId('dl');
    // Access tokens may expire sooner than the explicitly issued link. Persist
    // their scope ceiling, but use the current grant/client/ACL on every read.
    const { expiresAt: _tokenExpiry, ...authority } = ctx.principal;
    const insert = this.store.db.transaction(() => {
      ctx.revalidate?.(); this.manageAccess(ctx, 'dodo:write'); liveAccess(ctx, 'dodo:read');
      this.assertProjectAvailable(ctx.services.workspaceId);
      const owner = actor(ctx);
      const source = this.store.db.prepare(`SELECT id FROM resource_refs WHERE id=? AND workspace_id=? AND principal=? AND object_hash=? AND expires_at>?`)
        .get(input.resourceId, ctx.services.workspaceId, owner, input.expectedSha256, now);
      if (!source) throw new DodoError('NOT_FOUND', 'resource expired or is not owned by this client/workspace');
      this.store.db.prepare('DELETE FROM resource_download_links WHERE expires_at<=?').run(now);
      const count = this.store.db.prepare(`SELECT COUNT(*) AS retained,
        COALESCE(SUM(CASE WHEN revoked_at IS NULL THEN 1 ELSE 0 END),0) AS total,
        COALESCE(SUM(CASE WHEN workspace_id=? AND principal=? THEN 1 ELSE 0 END),0) AS owned_retained,
        COALESCE(SUM(CASE WHEN workspace_id=? AND principal=? AND revoked_at IS NULL THEN 1 ELSE 0 END),0) AS owned
        FROM resource_download_links`).get(ctx.services.workspaceId, owner, ctx.services.workspaceId, owner) as { total: number; owned: number; retained: number; owned_retained: number };
      if (count.owned >= MAX_OWNER_LINKS || count.total >= MAX_INSTALLATION_LINKS) throw new DodoError('RESOURCE_LIMIT', 'active temporary download link limit reached');
      if (count.owned_retained >= MAX_OWNER_RETAINED_LINKS || count.retained >= MAX_INSTALLATION_RETAINED_LINKS) throw new DodoError('RESOURCE_LIMIT', 'temporary download history limit reached; let earlier links expire before issuing more');
      const registry = this.store.db.prepare('SELECT id FROM project_registry WHERE workspace_id=? AND removed_at IS NULL LIMIT 1').get(ctx.services.workspaceId) as { id: string } | undefined;
      this.store.db.prepare(`INSERT INTO resource_download_links
        (id,token_hash,workspace_id,principal,authority,registry_id,resource_id,object_hash,mime_type,file_name,created_at,expires_at,revoked_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL)`).run(id, sha256Bytes(token), ctx.services.workspaceId, owner, JSON.stringify(authority), registry?.id ?? null,
        input.resourceId, resource.sha256, resource.mimeType, filename, now, expiresAt);
    });
    insert.immediate();
    return { linkId: id, resourceId: resource.resourceId, fileName: filename, mimeType: resource.mimeType, bytes: resource.bytes,
      sha256: resource.sha256, createdAt: now, expiresAt, revokedAt: null,
      url: `${base.origin}/file/${token}/${encodedFilename}` };
  }

  list(ctx: ToolCtx, input: { limit?: number } = {}): DownloadLinkInfo[] {
    this.manageAccess(ctx, 'dodo:read');
    const limit = input.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_OWNER_LINKS) throw new DodoError('INVALID_INPUT', 'limit must be an integer from 1 to 128');
    const rows = this.store.db.prepare(`SELECT l.*,o.bytes FROM resource_download_links l JOIN resource_objects o ON o.hash=l.object_hash
      WHERE l.workspace_id=? AND l.principal=? AND l.expires_at>?
      ORDER BY (l.revoked_at IS NOT NULL) ASC,l.created_at DESC,l.id DESC LIMIT ?`)
      .all(ctx.services.workspaceId, actor(ctx), Date.now(), limit) as LinkRow[];
    return rows.map(toInfo);
  }

  revoke(ctx: ToolCtx, linkId: string): { linkId: string; revokedAt: number } {
    this.manageAccess(ctx, 'dodo:write');
    const row = this.store.db.prepare(`UPDATE resource_download_links SET revoked_at=COALESCE(revoked_at,?)
      WHERE id=? AND workspace_id=? AND principal=? RETURNING revoked_at`)
      .get(Date.now(), linkId, ctx.services.workspaceId, actor(ctx)) as { revoked_at: number } | undefined;
    if (!row) throw new DodoError('NOT_FOUND', 'unknown download link for this client/workspace');
    return { linkId, revokedAt: row.revoked_at };
  }

  async openDownload(token: string): Promise<OpenDownload> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token) || Buffer.from(token, 'base64url').toString('base64url') !== token) throw unavailable();
    const tokenHash = sha256Bytes(token);
    const row = this.store.db.prepare(`SELECT l.*,o.bytes FROM resource_download_links l JOIN resource_objects o ON o.hash=l.object_hash WHERE l.token_hash=?`)
      .get(tokenHash) as LinkRow | undefined;
    if (!row) throw unavailable();
    const assertActive = () => this.assertActive(row, tokenHash);
    assertActive();
    const opened = await this.cas.openVerified(row.object_hash, row.bytes);
    try {
      assertActive();
      return { handle: opened.handle, bytes: opened.bytes, mimeType: row.mime_type, filename: row.file_name, expiresAt: row.expires_at, assertActive };
    } catch (error) { await opened.handle.close(); throw error; }
  }

  private assertActive(row: LinkRow, tokenHash: string): void {
    const current = this.store.db.prepare('SELECT expires_at,revoked_at FROM resource_download_links WHERE id=? AND token_hash=?')
      .get(row.id, tokenHash) as { expires_at: number; revoked_at: number | null } | undefined;
    if (!current || current.expires_at <= Date.now() || current.revoked_at !== null) throw unavailable();
    try {
      this.assertProjectAvailable(row.workspace_id, row.registry_id);
      const principal = JSON.parse(row.authority) as Principal;
      const currentAuthority = projectAuthority(this.store, principal, row.workspace_id);
      const ceiling = projectScopeCeiling(this.store, row.workspace_id);
      if (!currentAuthority.scopes.includes('dodo:read') || !currentAuthority.scopes.includes('dodo:write') || !ceiling.includes('dodo:read') || !ceiling.includes('dodo:write')) throw unavailable();
    } catch { throw unavailable(); }
  }

  private assertProjectAvailable(workspaceId: string, registryId?: string | null): void {
    const active = this.store.db.prepare('SELECT id FROM project_registry WHERE workspace_id=? AND removed_at IS NULL LIMIT 1').get(workspaceId) as { id: string } | undefined;
    if (!active) {
      // A directly opened root need not be registered. Once it has been
      // explicitly removed, old public links must not bypass that decision.
      if (registryId || this.store.db.prepare('SELECT 1 FROM project_registry WHERE workspace_id=? LIMIT 1').get(workspaceId)) throw unavailable();
      return;
    }
    if (registryId && active.id !== registryId) throw unavailable();
    const project = new ProjectRegistry(this.store).get(active.id);
    if (project.workspaceId !== workspaceId || !project.available) throw unavailable();
  }

  private manageAccess(ctx: ToolCtx, scope: 'dodo:read' | 'dodo:write'): void {
    ctx.revalidate?.(); liveAccess(ctx, scope);
  }

  private defaultFilename(mime: string): string {
    const extension: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
      'image/svg+xml': 'svg', 'video/mp4': 'mp4', 'video/webm': 'webm', 'application/pdf': 'pdf', 'application/zip': 'zip',
      'text/plain': 'txt', 'application/json': 'json' };
    return `download.${extension[mime] ?? 'bin'}`;
  }
}
