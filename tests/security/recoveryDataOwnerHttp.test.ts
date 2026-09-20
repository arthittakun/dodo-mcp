import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { launch, obtainToken, wsArgs, type TestContext } from '../helpers/testServer.js';
import { ProjectRegistry } from '../../src/projects/registry.js';
import { OSRecoveryKeys } from '../../src/services/recovery/configKeys.js';
import { ensurePrivateDirectory } from '../../src/platform/privateFs.js';
import { DodoError } from '../../src/errors.js';

describe('R06 database/config administration over real HTTP boundaries', () => {
  let ctx: TestContext, db: Database.Database;
  afterEach(async () => { vi.restoreAllMocks(); db?.close(); await ctx?.cleanup(); });
  it('rejects anonymous/OAuth/public/stale/foreign access; only owner can enable, preview or restore private config', async () => {
    ctx = await launch({ toolSurface: 'compact', trust: 'trusted', configPort: 0 });
    ensurePrivateDirectory(ctx.fixtureDir);
    fs.writeFileSync(path.join(ctx.fixtureDir, '.env'), 'OWNER_FIXTURE_ONLY=one', { mode: 0o600 });
    db = new Database(path.join(ctx.fixtureDir, 'fixture.sqlite')); db.exec('CREATE TABLE migrations(id TEXT); INSERT INTO migrations VALUES(\'v1\')');
    // Only OS storage is simulated; HTTP auth, project routing, crypto, DB and filesystem are real.
    const keys = new Map<string, Buffer>();
    vi.spyOn(OSRecoveryKeys.prototype, 'put').mockImplementation(async (id, key) => { keys.set(id, Buffer.from(key)); });
    vi.spyOn(OSRecoveryKeys.prototype, 'get').mockImplementation(async id => { if (!keys.has(id)) throw new DodoError('AUTH_REQUIRED', 'fixture key absent'); return Buffer.from(keys.get(id)!); });
    const p = new ProjectRegistry(ctx.server.services.store).add(ctx.fixtureDir, 'R06 private owner fixture').project;
    const oauth = await obtainToken(ctx), url = new URL(ctx.configUrl!), owner = url.hash.slice(1);
    const send = (operation: string, input: unknown, auth: string | undefined = owner, epoch = ctx.server.epoch, origin = url.origin, projectId = p.projectId) => fetch(`${origin}/api/admin/action`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-dodo-workspace': ctx.server.workspaceId, 'x-dodo-epoch': epoch,
        ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
      body: JSON.stringify({ projectId, operation, args: { ...wsArgs(ctx), confirm: true, input } }),
    });
    const input = { expectedRevision: 0, enabled: true, confirmEncryptedPrivateBackup: true, definition: { name: 'Fixture', path: '.env' } };
    for (const operation of ['recovery.config.configure', 'recovery.config.backup', 'recovery.config.preview', 'recovery.config.apply', 'recovery.config.rotate', 'recovery.database.configure', 'recovery.database.inspect', 'recovery.database.bind']) {
      expect((await send(operation, input, '')).status).toBe(401);
      expect((await send(operation, input, oauth.accessToken)).status).toBe(401);
      expect((await send(operation, input, owner, 'stale')).status).toBe(409);
      expect((await send(operation, input, oauth.accessToken, ctx.server.epoch, ctx.baseUrl)).status).toBe(404);
    }
    expect(keys.size).toBe(0);
    const saved = await send('recovery.config.configure', input); expect(saved.status).toBe(200);
    const target = (await saved.json() as { data: { id: string } }).data;
    const backupResponse = await send('recovery.config.backup', { targetId: target.id }); expect(backupResponse.status).toBe(200);
    const backup = (await backupResponse.json() as { data: { id: string } }).data;
    fs.writeFileSync(path.join(ctx.fixtureDir, '.env'), 'OWNER_FIXTURE_ONLY=two');
    const previewResponse = await send('recovery.config.preview', { backupId: backup.id }); expect(previewResponse.status).toBe(200);
    const preview = (await previewResponse.json() as { data: { planId: string; planHash: string; plaintext: string } }).data;
    expect(preview.plaintext).toBe('REDACTED'); expect(JSON.stringify(preview)).not.toContain('OWNER_FIXTURE_ONLY');
    const restore = await send('recovery.config.apply', { planId: preview.planId, planHash: preview.planHash }); expect(restore.status).toBe(200);
    expect(await restore.json()).toMatchObject({ data: { state: 'APPLIED', outcome: { restarted: false } } });
    expect(fs.readFileSync(path.join(ctx.fixtureDir, '.env'), 'utf8')).toBe('OWNER_FIXTURE_ONLY=one');
    const savedDb = await send('recovery.database.configure', { expectedRevision: 0, enabled: true, confirmReadOnlyAccess: true,
      definition: { name: 'Fixture DB', adapter: 'sqlite-migration-table', databaseFile: 'fixture.sqlite', table: 'migrations', column: 'id' } });
    expect(savedDb.status).toBe(200);
    const dbTarget = (await savedDb.json() as { data: { id: string } }).data;
    expect(await (await send('recovery.database.inspect', { targetId: dbTarget.id })).json()).toMatchObject({ data: { appliedMigrationIds: ['v1'], databaseRollback: 'NOT_SUPPORTED' } });
    expect((await send('recovery.config.preview', { backupId: backup.id }, owner, ctx.server.epoch, url.origin, 'prj_0000000000000000')).status).not.toBe(200);
    const { TOOL_CATALOG } = await import('../../src/tools/catalog.js');
    expect(TOOL_CATALOG.some(t => t.name.startsWith('recovery.config.') || t.name.startsWith('recovery.database.'))).toBe(false);
  }, 60000);
});
