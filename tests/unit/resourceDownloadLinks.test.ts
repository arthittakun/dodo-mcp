import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../../src/store/db.js';
import { Store } from '../../src/store/store.js';
import { WorkspaceFS } from '../../src/workspace/fs.js';
import { IgnoreEngine } from '../../src/workspace/ignores.js';
import { resolveWorkspaceRoot } from '../../src/workspace/root.js';
import { mintWorkspaceId } from '../../src/workspace/identity.js';
import { ensurePrivateDirectory } from '../../src/platform/privateFs.js';
import { removeWithRetry } from '../../src/platform/fsRetry.js';
import { ResourceService } from '../../src/services/resources/resourceService.js';
import { CasStore } from '../../src/services/resources/casStore.js';
import { DownloadLinkService, type DownloadLinkCreated, type DownloadLinkCreateInput } from '../../src/services/resources/downloadLinkService.js';
import { ProjectRegistry } from '../../src/projects/registry.js';
import type { AppServices, ToolCtx } from '../../src/tools/context.js';
import { newId, sha256Bytes } from '../../src/util/hash.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const ORIGIN = 'https://downloads.example.test';
const tokenOf = (link: DownloadLinkCreated) => new URL(link.url).pathname.split('/')[2]!;

describe('persistent temporary resource downloads', () => {
  let directory: string, root: string, configDir: string, dbFile: string, objectsDir: string, stagingDir: string;
  let store: Store, services: AppServices, resources: ResourceService, owner: ToolCtx;

  beforeAll(() => {
    directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dodo-download-unit-')));
    root = path.join(directory, 'workspace'); configDir = path.join(directory, 'private');
    fs.mkdirSync(root); ensurePrivateDirectory(configDir);
    dbFile = path.join(configDir, 'state.db'); objectsDir = path.join(configDir, 'objects'); stagingDir = path.join(configDir, 'staging');
    store = new Store(openDatabase(dbFile));
    const identity = resolveWorkspaceRoot(root), workspaceId = mintWorkspaceId(store.installSecret(), identity.root);
    store.upsertWorkspace({ id: workspaceId, ...identity, epoch: 'boot_downloadtest' });
    services = { store, workspaceId, wfs: new WorkspaceFS(root, new IgnoreEngine({ root })) } as AppServices;
    resources = new ResourceService(services, configDir, objectsDir, stagingDir, store.installSecret());
    services.resources = resources;
    owner = { services, trustMode: 'trusted', principal: { grantId: 'local-stdio', clientId: 'stdio', sub: 'owner', scopes: ['dodo:read', 'dodo:write', 'dodo:exec'] } };
  });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
  afterAll(() => { resources?.close(); store?.db.close(); if (directory) removeWithRetry(directory, true); });

  async function source(ctx = owner, bytes = `snapshot ${newId('sample')}`) {
    const name = `${newId('fixture')}.txt`;
    fs.writeFileSync(path.join(root, name), bytes);
    const resource = await resources.ingestWorkspace(ctx, name);
    return { name, bytes, resource };
  }
  async function create(ctx = owner, days: DownloadLinkCreateInput['expiresInDays'] = 7) {
    const fixture = await source(ctx);
    const link = await resources.downloads.create(ctx, { resourceId: fixture.resource.resourceId, expectedSha256: fixture.resource.sha256, expiresInDays: days }, ORIGIN);
    return { ...fixture, link };
  }
  async function read(downloads: DownloadLinkService, link: DownloadLinkCreated) {
    const opened = await downloads.openDownload(tokenOf(link));
    try { opened.assertActive(); return await opened.handle.readFile('utf8'); }
    finally { await opened.handle.close(); }
  }
  function client(scopes = ['dodo:read', 'dodo:write']): ToolCtx {
    const clientId = newId('client'), grantId = newId('grant');
    store.setMeta('owner-access-mode', 'managed');
    store.putOAuthClient(clientId, { client_id: clientId });
    store.putGrant({ id: grantId, clientId, workspaceId: services.workspaceId, accountId: 'test-account', scopes });
    store.setClientAccess(services.workspaceId, clientId, scopes);
    return { services, trustMode: 'trusted', principal: { clientId, grantId, sub: 'test-account', scopes, expiresAt: Date.now() / 1000 + 60 } };
  }

  it('creates each supported TTL with a one-time random token and lists metadata only', async () => {
    const fixture = await source();
    for (const expiresInDays of [1, 2, 7, 14, 30] as const) {
      const link = await resources.downloads.create(owner, { resourceId: fixture.resource.resourceId, expectedSha256: fixture.resource.sha256, expiresInDays, fileName: 'ภาพ ทดสอบ.txt' }, ORIGIN);
      expect(link.expiresAt - link.createdAt).toBe(expiresInDays * DAY_MS);
      expect(tokenOf(link)).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(decodeURIComponent(new URL(link.url).pathname.split('/')[3]!)).toBe('ภาพ ทดสอบ.txt');
      const row = store.db.prepare('SELECT * FROM resource_download_links WHERE id=?').get(link.linkId) as Record<string, unknown>;
      expect(row['token_hash']).toBe(sha256Bytes(tokenOf(link)));
      expect(JSON.stringify(row)).not.toContain(tokenOf(link));
      const listed = resources.downloads.list(owner).find(item => item.linkId === link.linkId)!;
      expect(listed).toMatchObject({ resourceId: fixture.resource.resourceId, fileName: 'ภาพ ทดสอบ.txt', sha256: fixture.resource.sha256, revokedAt: null });
      expect(listed).not.toHaveProperty('url'); expect(listed).not.toHaveProperty('token');
    }
  });

  it('pins immutable bytes beyond reference expiry and opens them through a fresh installation service', async () => {
    const fixture = await create();
    fs.writeFileSync(path.join(root, fixture.name), 'replacement source must never be shared');
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000);
    resources.gc();
    expect(store.db.prepare('SELECT 1 FROM resource_refs WHERE id=?').get(fixture.resource.resourceId)).toBeUndefined();
    const restartedStore = new Store(openDatabase(dbFile));
    try {
      const restarted = new DownloadLinkService(restartedStore, new CasStore(restartedStore, objectsDir, stagingDir));
      expect(await read(restarted, fixture.link)).toBe(fixture.bytes);
      expect(store.db.prepare('SELECT 1 FROM resource_objects WHERE hash=?').get(fixture.resource.sha256)).toBeDefined();
    } finally { restartedStore.db.close(); }
  });

  it('revokes idempotently, immediately rejects the token and releases its independent CAS pin', async () => {
    const fixture = await create();
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000);
    resources.gc();
    const revoked = resources.downloads.revoke(owner, fixture.link.linkId);
    vi.setSystemTime(Date.now() + 1000);
    expect(resources.downloads.revoke(owner, fixture.link.linkId)).toEqual(revoked);
    await expect(read(resources.downloads, fixture.link)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    store.db.prepare('UPDATE resource_objects SET verified_at=? WHERE hash=?').run(Date.now() - 2 * 60 * 60 * 1000, fixture.resource.sha256);
    resources.gc();
    expect(store.db.prepare('SELECT 1 FROM resource_objects WHERE hash=?').get(fixture.resource.sha256)).toBeUndefined();
    expect(fs.existsSync(resources.cas.objectPath(fixture.resource.sha256))).toBe(false);
  });

  it('rejects expired links and collects their objects once references and grace have elapsed', async () => {
    const fixture = await create(owner, 30);
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(fixture.link.expiresAt);
    await expect(read(resources.downloads, fixture.link)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    resources.gc();
    expect(resources.downloads.list(owner).some(link => link.linkId === fixture.link.linkId)).toBe(false);
    expect(fs.existsSync(resources.cas.objectPath(fixture.resource.sha256))).toBe(false);
  });

  it('binds management to the issuing caller and workspace and requires read plus write', async () => {
    const first = client(), second = client(), fixture = await create(first);
    expect(resources.downloads.list(second)).toEqual([]);
    expect(() => resources.downloads.revoke(second, fixture.link.linkId)).toThrowError(/unknown download link/);
    await expect(resources.downloads.create(second, { resourceId: fixture.resource.resourceId, expectedSha256: fixture.resource.sha256, expiresInDays: 7 }, ORIGIN)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const foreign = { ...first, services: { ...services, workspaceId: 'ws_otherworkspace' } };
    expect(() => resources.downloads.list(foreign)).toThrow();
    expect(() => resources.downloads.revoke(foreign, fixture.link.linkId)).toThrow();
    const reader = client(['dodo:read']), readable = await source(reader);
    await expect(resources.downloads.create(reader, { resourceId: readable.resource.resourceId, expectedSha256: readable.resource.sha256, expiresInDays: 7 }, ORIGIN)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('honors current grant, client and ACL authority while allowing a short access token to expire', async () => {
    const caller = client(), fixture = await create(caller);
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 120_000);
    expect(await read(resources.downloads, fixture.link)).toBe(fixture.bytes);
    store.setClientAccess(services.workspaceId, caller.principal.clientId, ['dodo:read']);
    await expect(read(resources.downloads, fixture.link)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    store.setClientAccess(services.workspaceId, caller.principal.clientId, ['dodo:read', 'dodo:write']);
    expect(await read(resources.downloads, fixture.link)).toBe(fixture.bytes);
    store.revokeGrant(caller.principal.grantId);
    await expect(read(resources.downloads, fixture.link)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const other = client(), otherFixture = await create(other);
    store.db.prepare('DELETE FROM oauth_clients WHERE client_id=?').run(other.principal.clientId);
    await expect(read(resources.downloads, otherFixture.link)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rechecks revocation after asynchronous CAS verification and closes the opened handle', async () => {
    const fixture = await create();
    let handle: fs.promises.FileHandle | undefined;
    const open = resources.cas.openVerified.bind(resources.cas);
    vi.spyOn(resources.cas, 'openVerified').mockImplementationOnce(async (...args) => {
      const result = await open(...args); handle = result.handle;
      resources.downloads.revoke(owner, fixture.link.linkId);
      return result;
    });
    await expect(read(resources.downloads, fixture.link)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(handle!.stat()).rejects.toMatchObject({ code: 'EBADF' });
  });

  it('rechecks issuance authority after asynchronous resource inspection', async () => {
    const caller = client(), fixture = await source(caller);
    const inspect = resources.inspect.bind(resources);
    vi.spyOn(resources, 'inspect').mockImplementationOnce(async (...args) => {
      const info = await inspect(...args); store.revokeGrant(caller.principal.grantId); return info;
    });
    const before = (store.db.prepare('SELECT COUNT(*) AS count FROM resource_download_links').get() as { count: number }).count;
    await expect(resources.downloads.create(caller, { resourceId: fixture.resource.resourceId, expectedSha256: fixture.resource.sha256, expiresInDays: 7 }, ORIGIN)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((store.db.prepare('SELECT COUNT(*) AS count FROM resource_download_links').get() as { count: number }).count).toBe(before);
  });

  it('rejects wrong hashes, unsupported TTLs and unsafe filenames before persisting a token', async () => {
    const fixture = await source();
    const input: DownloadLinkCreateInput = { resourceId: fixture.resource.resourceId, expectedSha256: fixture.resource.sha256, expiresInDays: 7 };
    const before = (store.db.prepare('SELECT COUNT(*) AS count FROM resource_download_links').get() as { count: number }).count;
    await expect(resources.downloads.create(owner, { ...input, expectedSha256: sha256Bytes('wrong bytes') }, ORIGIN)).rejects.toMatchObject({ code: 'FILE_CHANGED' });
    await expect(resources.downloads.create(owner, { ...input, expiresInDays: 3 as 7 }, ORIGIN)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    for (const fileName of ['../escape.txt', 'a\\b.txt', 'a\r\nHeader.txt', '\ud800', '.', '..', 'a'.repeat(181)]) {
      await expect(resources.downloads.create(owner, { ...input, fileName }, ORIGIN)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
    expect((store.db.prepare('SELECT COUNT(*) AS count FROM resource_download_links').get() as { count: number }).count).toBe(before);
    for (const token of ['', 'bad-token', 'A'.repeat(42), 'A'.repeat(44)]) await expect(resources.downloads.openDownload(token)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses corrupted CAS bytes rather than serving a changed object', async () => {
    const fixture = await create();
    const objectPath = resources.cas.objectPath(fixture.resource.sha256);
    fs.writeFileSync(objectPath, 'x'.repeat(fixture.resource.bytes));
    await expect(read(resources.downloads, fixture.link)).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
  });

  it('bounds revoked metadata without preventing revocation, and frees expired history on issue', async () => {
    const caller = client(), fixture = await create(caller);
    const now = Date.now();
    const fill = store.db.transaction(() => {
      for (let index = 0; index < 511; index++) {
        const id = newId('dl');
        store.db.prepare(`INSERT INTO resource_download_links
          (id,token_hash,workspace_id,principal,authority,registry_id,resource_id,object_hash,mime_type,file_name,created_at,expires_at,revoked_at)
          SELECT ?,?,workspace_id,principal,authority,registry_id,resource_id,object_hash,mime_type,file_name,created_at+1,expires_at,?
          FROM resource_download_links WHERE id=?`).run(id, sha256Bytes(id), now, fixture.link.linkId);
      }
    });
    fill.immediate();
    expect(resources.downloads.list(caller, { limit: 128 })[0]?.linkId).toBe(fixture.link.linkId);
    const input = { resourceId: fixture.resource.resourceId, expectedSha256: fixture.resource.sha256, expiresInDays: 7 as const };
    await expect(resources.downloads.create(caller, input, ORIGIN)).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' });
    expect(resources.downloads.revoke(caller, fixture.link.linkId)).toHaveProperty('revokedAt');
    store.db.prepare('UPDATE resource_download_links SET expires_at=? WHERE principal=? AND id<>?')
      .run(now - 1, (store.db.prepare('SELECT principal FROM resource_download_links WHERE id=?').get(fixture.link.linkId) as { principal: string }).principal, fixture.link.linkId);
    await expect(resources.downloads.create(caller, input, ORIGIN)).resolves.toHaveProperty('url');
  });

  it('upgrades the preceding schema while preserving existing auth, metadata and resource rows', () => {
    const upgradePath = path.join(configDir, 'upgrade-state.db');
    const legacy = new Store(openDatabase(upgradePath));
    const version = (legacy.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number }).version;
    legacy.db.exec('DROP TABLE resource_download_links');
    legacy.db.prepare('DELETE FROM schema_migrations WHERE version=?').run(version);
    legacy.setMeta('upgrade-sentinel', 'preserve-this-value');
    legacy.putOAuthClient('legacy-client', { client_id: 'legacy-client' });
    const identity = resolveWorkspaceRoot(root);
    legacy.upsertWorkspace({ id: services.workspaceId, ...identity, epoch: 'boot_legacy' });
    legacy.putGrant({ id: 'legacy-grant', workspaceId: services.workspaceId, clientId: 'legacy-client', accountId: 'legacy-account', scopes: ['dodo:read', 'dodo:write'] });
    const hash = sha256Bytes('legacy snapshot'), now = Date.now();
    legacy.db.prepare('INSERT INTO resource_objects(hash,bytes,created_at,verified_at) VALUES (?,?,?,?)').run(hash, 15, now, now);
    legacy.db.prepare(`INSERT INTO resource_refs(id,workspace_id,principal,object_hash,mime_type,source_kind,source_label,capabilities,metadata,created_at,expires_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run('res_legacy1234', services.workspaceId, 'legacy-owner', hash, 'text/plain', 'workspace', 'note.txt', '{}', '{}', now, now + DAY_MS);
    legacy.db.close();
    const upgraded = new Store(openDatabase(upgradePath));
    try {
      expect(upgraded.getMeta('upgrade-sentinel')).toBe('preserve-this-value');
      expect(upgraded.getOAuthClient('legacy-client')).toMatchObject({ client_id: 'legacy-client' });
      expect(upgraded.getGrant('legacy-grant')).toMatchObject({ scopes: ['dodo:read', 'dodo:write'], revokedAt: null });
      expect(upgraded.db.prepare('SELECT object_hash FROM resource_refs WHERE id=?').get('res_legacy1234')).toMatchObject({ object_hash: hash });
      expect(upgraded.db.prepare('SELECT COUNT(*) AS count FROM resource_download_links').get()).toEqual({ count: 0 });
      expect(upgraded.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({ version });
      expect(upgraded.db.pragma('foreign_key_check')).toEqual([]);
    } finally { upgraded.db.close(); }
  });

  it('stops links when a registered project becomes read-only, unavailable or removed', async () => {
    const direct = await create();
    const registry = new ProjectRegistry(store), project = registry.add(root, 'Download test project', 'full').project;
    expect(project.workspaceId).toBe(services.workspaceId);
    const registered = await create();
    store.db.prepare('UPDATE project_registry SET access_level=? WHERE id=?').run('read', project.projectId);
    await expect(read(resources.downloads, registered.link)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    store.db.prepare('UPDATE project_registry SET access_level=? WHERE id=?').run('full', project.projectId);
    expect(await read(resources.downloads, registered.link)).toBe(registered.bytes);
    const moved = `${root}-temporarily-moved`;
    fs.renameSync(root, moved);
    try { await expect(read(resources.downloads, registered.link)).rejects.toMatchObject({ code: 'NOT_FOUND' }); }
    finally { fs.renameSync(moved, root); }
    store.db.prepare('UPDATE project_registry SET removed_at=? WHERE id=?').run(Date.now(), project.projectId);
    await expect(read(resources.downloads, registered.link)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(read(resources.downloads, direct.link)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
