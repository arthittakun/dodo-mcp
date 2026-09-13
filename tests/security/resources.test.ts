import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { launch, mcpRaw, obtainToken, rpc, wsArgs, type TestContext, type TokenSet } from '../helpers/testServer.js';
import { tool, assertOk } from '../helpers/multimodal.js';
import { AssetInfo } from '../../src/services/multimodal/contracts.js';
import { ResourceChunk, ResourceInfo } from '../../src/services/resources/contracts.js';
import { CasStore } from '../../src/services/resources/casStore.js';
import { ensurePrivateDirectory } from '../../src/platform/privateFs.js';
import { statePaths } from '../../src/config/paths.js';
import { digestOf } from '../../src/util/hash.js';
import { RESOURCE_STORE_MAX_BYTES } from '../../src/services/resources/casStore.js';

describe('Phase 04 resource authorization and failure boundaries', () => {
  let ctx: TestContext;
  let owner: TokenSet;
  let other: TokenSet;
  let reader: TokenSet;
  beforeAll(async () => {
    ctx = await launch({ toolSurface: 'full', fixtureFiles: { 'safe.txt': 'safe resource', 'quota-unique.txt': 'unique quota probe bytes 8421', '.env': 'DODO_SECRET=never', '.dodo-dev-state/private.txt': 'private state marker' } });
    fs.writeFileSync(path.join(ctx.fixtureDir, 'image.png'), await sharp({ create: { width: 80, height: 60, channels: 3, background: '#123456' } }).png().toBuffer());
    fs.symlinkSync('safe.txt', path.join(ctx.fixtureDir, 'linked.txt'));
    fs.writeFileSync(path.join(ctx.fixtureDir, 'hard-source.txt'), 'hardlink resource');
    fs.linkSync(path.join(ctx.fixtureDir, 'hard-source.txt'), path.join(ctx.fixtureDir, 'hard-linked.txt'));
    owner = await obtainToken(ctx);
    other = await obtainToken(ctx);
    reader = await obtainToken(ctx, { scope: 'dodo:read' });
  });
  afterAll(async () => ctx?.cleanup());
  const call = (name: string, args: Record<string, unknown>, accessToken = owner.accessToken) => tool(ctx, accessToken, name, args);
  const error = (result: Awaited<ReturnType<typeof call>>, code: string) => {
    expect(result.isError).toBe(true);
    expect(result.envelope.error).toMatchObject({ code });
  };

  it('keeps anonymous HTTP out before resource dispatch', async () => {
    expect((await mcpRaw(ctx, rpc('tools/call', { name: 'resource_inspect', arguments: { ...wsArgs(ctx), path: 'safe.txt' } }))).status).toBe(401);
  });

  it('preserves secret, private-state, traversal, symlink and hardlink refusal on ingest', async () => {
    for (const [inputPath, code] of [
      ['.env', 'SECRET_PATH_DENIED'], ['.dodo-dev-state/private.txt', 'PATH_DENIED'], ['../safe.txt', 'PATH_DENIED'],
      ['linked.txt', 'PATH_DENIED'], ['hard-linked.txt', 'PATH_DENIED'],
    ] as const) error(await call('resource_inspect', { path: inputPath }), code);
    const rows = ctx.server.services.store.db.prepare('SELECT COUNT(*) AS count FROM resource_refs').get() as { count: number };
    expect(rows.count).toBe(0);
  });

  it('binds every reference and resume token to the caller and current workspace context', async () => {
    const resource = ResourceInfo.parse(assertOk(await call('resource_inspect', { path: 'safe.txt' })));
    error(await call('resource_read', { resourceId: resource.resourceId }, other.accessToken), 'NOT_FOUND');
    error(await call('resource_read', { resourceId: resource.resourceId, workspaceEpoch: 'stale-epoch' }), 'STALE_WORKSPACE');
    const chunk = ResourceChunk.parse(assertOk(await call('resource_read_range', { resourceId: resource.resourceId, length: 4 })));
    if (chunk.resumeToken) {
      error(await call('resource_read_range', { cursor: chunk.resumeToken, length: 4 }, other.accessToken), 'STALE_WORKSPACE');
      const tampered = chunk.resumeToken.slice(0, -1) + (chunk.resumeToken.endsWith('a') ? 'b' : 'a');
      error(await call('resource_read_range', { cursor: tampered, length: 4 }), 'INVALID_INPUT');
    }
  });

  it('allows read tokens for guarded workspace resources but denies exec transforms and owned media assets', async () => {
    const readable = ResourceInfo.parse(assertOk(await call('resource_inspect', { path: 'safe.txt' }, reader.accessToken)));
    expect(ResourceChunk.parse(assertOk(await call('resource_read', { resourceId: readable.resourceId }, reader.accessToken))).data).toBe('safe resource');
    error(await call('resource_transform', { resourceId: readable.resourceId }, reader.accessToken), 'FORBIDDEN');

    const image = AssetInfo.parse((assertOk(await call('image_view', { path: 'image.png' })) as { asset: unknown }).asset);
    error(await call('resource_inspect', { assetId: image.assetId }, reader.accessToken), 'FORBIDDEN');
    expect(ResourceInfo.parse(assertOk(await call('resource_inspect', { assetId: image.assetId }))).sha256).toBe(image.sha256);
  });

  it('rechecks live workspace ACL and grant state instead of treating a resource URI as authority', async () => {
    const resource = ResourceInfo.parse(assertOk(await call('resource_inspect', { path: 'safe.txt' })));
    ctx.server.services.store.setClientAccess(ctx.server.workspaceId, owner.clientId, []);
    error(await call('resource_read', { resourceId: resource.resourceId }), 'WORKSPACE_ACCESS_REQUIRED');
    ctx.server.services.store.setClientAccess(ctx.server.workspaceId, owner.clientId, ['dodo:read', 'dodo:write', 'dodo:exec']);
    expect((await call('resource_read', { resourceId: resource.resourceId })).isError).toBe(false);
  });

  it('fails closed on expected hash/MIME mismatches and corrupt private CAS bytes', async () => {
    error(await call('resource_inspect', { path: 'safe.txt', expectedSha256: `sha256:${'0'.repeat(64)}` }), 'FILE_CHANGED');
    error(await call('resource_inspect', { path: 'safe.txt', expectedMimeType: 'image/png' }), 'INVALID_INPUT');
    const resource = ResourceInfo.parse(assertOk(await call('resource_inspect', { path: 'safe.txt' })));
    error(await call('resource_read', { resourceId: resource.resourceId, expectedSha256: `sha256:${'f'.repeat(64)}` }), 'FILE_CHANGED');

    const objectPath = ctx.server.services.resources!.cas.objectPath(resource.sha256);
    fs.writeFileSync(objectPath, 'tampered bytes', { mode: 0o600 });
    error(await call('resource_read', { resourceId: resource.resourceId }), 'INTERNAL_ERROR');
  });

  it('enforces disk and per-principal reference quotas before creating a reference', async () => {
    const fakeHash = `sha256:${'e'.repeat(64)}`;
    const used = ctx.server.services.store.db.prepare('SELECT COALESCE(SUM(bytes),0) AS bytes FROM resource_objects').get() as { bytes: number };
    const remaining = RESOURCE_STORE_MAX_BYTES - used.bytes;
    expect(remaining).toBeGreaterThan(0);
    ctx.server.services.store.db.prepare('INSERT INTO resource_objects(hash,bytes,created_at,verified_at) VALUES (?,?,?,?)').run(fakeHash, remaining, Date.now(), Date.now());
    expect(() => ctx.server.services.store.db.prepare('INSERT INTO resource_objects(hash,bytes,created_at,verified_at) VALUES (?,?,?,?)')
      .run(`sha256:${'d'.repeat(64)}`, 1, Date.now(), Date.now())).toThrow(/resource store quota exceeded/);
    try { error(await call('resource_inspect', { path: 'quota-unique.txt' }), 'RESOURCE_LIMIT'); }
    finally { ctx.server.services.store.db.prepare('DELETE FROM resource_objects WHERE hash=?').run(fakeHash); }

    const live = ResourceInfo.parse(assertOk(await call('resource_inspect', { path: 'image.png' })));
    const principal = digestOf({ grantId: owner.grantId, clientId: owner.clientId });
    const existing = ctx.server.services.store.db.prepare('SELECT COUNT(*) AS count FROM resource_refs WHERE workspace_id=? AND principal=? AND expires_at>?').get(ctx.server.workspaceId, principal, Date.now()) as { count: number };
    const insert = ctx.server.services.store.db.prepare(`INSERT INTO resource_refs(id,workspace_id,principal,object_hash,mime_type,source_kind,source_label,capabilities,metadata,created_at,expires_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    const ids: string[] = [];
    const fill = ctx.server.services.store.db.transaction(() => {
      for (let index = existing.count; index < 512; index += 1) {
        const id = `res_quota${String(index).padStart(8, '0')}`; ids.push(id);
        insert.run(id, ctx.server.workspaceId, principal, live.sha256, live.mimeType, 'workspace', 'quota fixture', JSON.stringify(live.capabilities), JSON.stringify(live.metadata), Date.now(), Date.now() + 60_000);
      }
    });
    fill();
    try { error(await call('resource_inspect', { path: 'image.png' }), 'RESOURCE_LIMIT'); }
    finally {
      const remove = ctx.server.services.store.db.prepare('DELETE FROM resource_refs WHERE id=?');
      ctx.server.services.store.db.transaction(() => { for (const id of ids) remove.run(id); })();
    }
  });

  it('requires target-specific inspect-mode approval before transform side effects', async () => {
    const source = ResourceInfo.parse(assertOk(await call('resource_inspect', { path: 'image.png' })));
    const before = (ctx.server.services.store.db.prepare('SELECT COUNT(*) AS count FROM resource_refs').get() as { count: number }).count;
    const denied = await call('resource_transform', { resourceId: source.resourceId, maxEdge: 64 });
    error(denied, 'APPROVAL_REQUIRED');
    const approval = ctx.server.services.store.db.prepare("SELECT tool FROM pending_approvals WHERE status='pending' ORDER BY created_at DESC LIMIT 1").get() as { tool: string };
    expect(approval.tool).toBe('resource_transform');
    expect((ctx.server.services.store.db.prepare('SELECT COUNT(*) AS count FROM resource_refs').get() as { count: number }).count).toBe(before);
  });

  it('GC removes only expired unreferenced objects and never live references', async () => {
    const resource = ResourceInfo.parse(assertOk(await call('resource_inspect', { path: 'image.png' })));
    const objectPath = ctx.server.services.resources!.cas.objectPath(resource.sha256);
    expect(fs.existsSync(objectPath)).toBe(true);
    expect(ctx.server.services.resources!.gc(Date.now())).toMatchObject({ expiredRefs: 0 });
    expect(fs.existsSync(objectPath)).toBe(true);
    ctx.server.services.store.db.prepare('UPDATE resource_refs SET expires_at=0 WHERE id=?').run(resource.resourceId);
    ctx.server.services.store.db.prepare('UPDATE resource_objects SET verified_at=0 WHERE hash=?').run(resource.sha256);
    const result = ctx.server.services.resources!.gc(Date.now());
    expect(result.expiredRefs).toBeGreaterThanOrEqual(1);
    const otherRefs = ctx.server.services.store.db.prepare('SELECT COUNT(*) AS count FROM resource_refs WHERE object_hash=?').get(resource.sha256) as { count: number };
    expect(fs.existsSync(objectPath)).toBe(otherRefs.count > 0);
  });

  it('rejects corrupt claimed formats without running a decoder or archive payload', async () => {
    fs.writeFileSync(path.join(ctx.fixtureDir, 'corrupt.zip'), Buffer.from('504b030400000000', 'hex'));
    fs.writeFileSync(path.join(ctx.fixtureDir, 'fake.png'), 'this is not an image');
    error(await call('resource_inspect', { path: 'corrupt.zip', expectedMimeType: 'application/zip' }), 'INVALID_INPUT');
    error(await call('resource_inspect', { path: 'fake.png', expectedMimeType: 'image/png' }), 'INVALID_INPUT');
  });

  it('recovers old uncommitted CAS objects without deleting database-backed objects', async () => {
    const hashName = 'a'.repeat(64);
    const paths = statePaths(ctx.configDir);
    const bucket = path.join(paths.resourceStoreDir, 'aa');
    ensurePrivateDirectory(bucket);
    const orphan = path.join(bucket, hashName);
    fs.writeFileSync(orphan, 'crash-before-db-commit', { mode: 0o600 });
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(orphan, old, old);
    const live = ResourceInfo.parse(assertOk(await call('resource_inspect', { path: 'image.png' })));
    const livePath = ctx.server.services.resources!.cas.objectPath(live.sha256);
    new CasStore(ctx.server.services.store, paths.resourceStoreDir, paths.resourceStagingDir);
    expect(fs.existsSync(orphan)).toBe(false);
    expect(fs.existsSync(livePath)).toBe(true);
  });

  it('refuses installation-private state even when DODO_CONFIG_DIR is nested under the workspace', async () => {
    const fixtureDir = fs.mkdtempSync(path.join(ctx.fixtureDir, 'nested-state-fixture-'));
    const configDir = path.join(fixtureDir, 'owner-private-state');
    fs.writeFileSync(path.join(fixtureDir, 'public.txt'), 'public');
    const nested = await launch({ fixtureDir, configDir, toolSurface: 'full' });
    try {
      expect(nested.server.services.resources?.configDir).toBe(fs.realpathSync.native(configDir));
      const nestedToken = await obtainToken(nested);
      const refused = await tool(nested, nestedToken.accessToken, 'resource_inspect', { path: 'owner-private-state/config.json' });
      expect(refused.isError).toBe(true);
      expect(refused.envelope.error).toMatchObject({ code: 'PATH_DENIED' });
      expect(ResourceInfo.parse(assertOk(await tool(nested, nestedToken.accessToken, 'resource_inspect', { path: 'public.txt' }))).source.label).toBe('public.txt');
    } finally { await nested.cleanup(); }
  });
});
