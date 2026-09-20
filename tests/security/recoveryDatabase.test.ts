import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { platformFixture } from '../helpers/platform.js';
import { ProjectRegistry } from '../../src/projects/registry.js';
import { createIpcDispatcher } from '../../src/server/ipcDispatch.js';

describe('R06 read-only database compatibility is distinct from source restore', () => {
  let f: ReturnType<typeof platformFixture>, db: Database.Database;
  afterEach(async () => { vi.restoreAllMocks(); db?.close(); await f?.close(); });
  async function setup() {
    f = platformFixture(); new ProjectRegistry(f.ws.store).add(f.root, 'Database fixture');
    fs.writeFileSync(path.join(f.root, 'source.txt'), 'A');
    db = new Database(path.join(f.root, 'fixture.sqlite'));
    db.exec('CREATE TABLE migrations(id TEXT PRIMARY KEY); CREATE TABLE orders(id INTEGER,quota INTEGER); INSERT INTO orders VALUES(1,42)');
    db.prepare('INSERT INTO migrations VALUES(?)').run('v1');
    const r = f.ws.services.recovery!, checkpointId = await r.checkpoint('owner-checkpoint', 'local-stdio');
    const definition = { name: 'fixture', adapter: 'sqlite-migration-table', databaseFile: 'fixture.sqlite', table: 'migrations', column: 'id' };
    return { r, checkpointId: checkpointId!, definition };
  }
  it('defaults to UNKNOWN without DB opt-in; owner-bound compatible IDs permit source restore while rows remain unchanged', async () => {
    const { r, checkpointId, definition } = await setup();
    expect(await r.databases.compatibility([checkpointId])).toMatchObject({ configured: false, state: 'UNKNOWN', blocking: false, databaseRollback: 'NOT_SUPPORTED' });
    const target = await r.databases.configure({ expectedRevision: 0, enabled: true, definition, confirmReadOnlyAccess: true }, () => {});
    await f.call('write_file', { path: 'source.txt', content: 'B' });
    expect(await f.call('restore_preview', { checkpointId })).toMatchObject({ applicable: false, database: { state: 'UNKNOWN', blocking: true } });
    await r.databases.bind({ targetId: target.id, expectedRevision: target.revision, checkpointId, requiredMigrationIds: ['v1'], confirmCompatibilityRule: true }, () => {});
    const preview = await f.call('restore_preview', { checkpointId });
    expect(preview).toMatchObject({ applicable: true, database: { state: 'COMPATIBLE' } });
    expect(JSON.stringify(preview)).not.toContain('appliedMigrationIds');
    const before = db.prepare('SELECT * FROM orders').all();
    await f.call('restore_apply', { planId: preview['planId'], planHash: preview['planHash'], idempotencyKey: f.key() });
    expect(fs.readFileSync(path.join(f.root, 'source.txt'), 'utf8')).toBe('A');
    expect(db.prepare('SELECT * FROM orders').all()).toEqual(before);
    expect(db.prepare('SELECT * FROM migrations').all()).toEqual([{ id: 'v1' }]);
  });
  it('external schema changes invalidate a reviewed restore and never run down migrations', async () => {
    const { r, checkpointId, definition } = await setup();
    const target = await r.databases.configure({ expectedRevision: 0, enabled: true, definition, confirmReadOnlyAccess: true }, () => {});
    await r.databases.bind({ targetId: target.id, expectedRevision: 1, checkpointId, requiredMigrationIds: ['v1'], confirmCompatibilityRule: true }, () => {});
    await f.call('write_file', { path: 'source.txt', content: 'B' });
    const preview = await f.call('restore_preview', { checkpointId });
    db.prepare('INSERT INTO migrations VALUES(?)').run('v2');
    await expect(f.call('restore_apply', { planId: preview['planId'], planHash: preview['planHash'], idempotencyKey: f.key() })).rejects.toThrow('database compatibility changed');
    expect(fs.readFileSync(path.join(f.root, 'source.txt'), 'utf8')).toBe('B');
    expect(await f.call('restore_preview', { checkpointId })).toMatchObject({ applicable: false, database: { state: 'INCOMPATIBLE', blocking: true } });
    expect(db.prepare('SELECT COUNT(*) n FROM migrations').get()).toEqual({ n: 2 });
  });
  it('unknown DB, renamed columns, replaced files and unbound checkpoints never claim compatibility; owner rules cannot inject SQL', async () => {
    const { r, checkpointId, definition } = await setup();
    for (const table of ['migrations; DROP TABLE orders', 'migrations"'])
      await expect(r.databases.configure({ expectedRevision: 0, enabled: true, definition: { ...definition, table }, confirmReadOnlyAccess: true }, () => {})).rejects.toThrow();
    const target = await r.databases.configure({ expectedRevision: 0, enabled: true, definition, confirmReadOnlyAccess: true }, () => {});
    await r.databases.bind({ targetId: target.id, expectedRevision: 1, checkpointId, requiredMigrationIds: ['v1'], confirmCompatibilityRule: true }, () => {});
    db.exec('ALTER TABLE migrations RENAME COLUMN id TO missing');
    expect(await r.databases.compatibility([checkpointId])).toMatchObject({ state: 'UNKNOWN', blocking: true });
    expect(await r.databases.compatibility(['forged'])).toMatchObject({ state: 'UNKNOWN', blocking: true });
    db.close(); fs.renameSync(path.join(f.root, 'fixture.sqlite'), path.join(f.root, 'old.sqlite'));
    db = new Database(path.join(f.root, 'fixture.sqlite')); db.exec('CREATE TABLE migrations(id TEXT)');
    expect(await r.databases.compatibility([checkpointId])).toMatchObject({ state: 'UNKNOWN', blocking: true });
  });
  it('rechecks schema after the pre-restore backup and refuses a race without marking backup storage broken', async () => {
    const { r, checkpointId, definition } = await setup();
    const target = await r.databases.configure({ expectedRevision: 0, enabled: true, definition, confirmReadOnlyAccess: true }, () => {});
    await r.databases.bind({ targetId: target.id, expectedRevision: 1, checkpointId, requiredMigrationIds: ['v1'], confirmCompatibilityRule: true }, () => {});
    await f.call('write_file', { path: 'source.txt', content: 'B' });
    const plan = await f.call('restore_preview', { checkpointId });
    const publish = r.storage.publishObject.bind(r.storage);
    vi.spyOn(r.storage, 'publishObject').mockImplementationOnce(async (...args) => {
      await publish(...args); db.prepare('INSERT INTO migrations VALUES(?)').run('v2-during-backup');
    });
    await expect(f.call('restore_apply', { planId: plan['planId'], planHash: plan['planHash'], idempotencyKey: f.key() })).rejects.toThrow('database compatibility changed');
    expect(fs.readFileSync(path.join(f.root, 'source.txt'), 'utf8')).toBe('B');
    expect(r.status().state).not.toBe('BLOCKED');
    expect(db.prepare('SELECT * FROM orders').all()).toEqual([{ id: 1, quota: 42 }]);
  });
  it('retention protects rule-bound manifests until an explicit owner unbind', async () => {
    const { r, checkpointId, definition } = await setup();
    const target=await r.databases.configure({expectedRevision:0,enabled:true,definition,confirmReadOnlyAccess:true},()=>{});
    await r.databases.bind({targetId:target.id,expectedRevision:1,checkpointId,requiredMigrationIds:['v1'],confirmCompatibilityRule:true},()=>{});
    await r.checkpoint('owner-checkpoint','local-stdio');
    const item=r.storage.cleanupPreview(f.ws.workspaceId,r.policy()).items.find(i=>i.checkpointId===checkpointId);
    expect(item).toMatchObject({eligible:false,reason:'database_compatibility_rule'});
    expect(await r.databases.unbind({targetId:target.id,expectedRevision:1,checkpointId,confirmCompatibilityRemoval:true},()=>{})).toMatchObject({removed:true,databaseChanged:false});
    expect(await r.databases.compatibility([checkpointId])).toMatchObject({state:'UNKNOWN',blocking:true});
    expect(r.storage.cleanupPreview(f.ws.workspaceId,r.policy()).items.find(i=>i.checkpointId===checkpointId)?.reason).not.toBe('database_compatibility_rule');
  });
  it('private owner context, expiry and revision checks apply; cross-project or symlinked paths are rejected', async () => {
    const { r, definition } = await setup();
    const input = { expectedRevision: 0, enabled: true, definition, confirmReadOnlyAccess: true };
    const dispatch = createIpcDispatcher({ ws: f.ws, transport: { kind: 'stdio', port: 0, locked: true, publicUrl: null }, requestStop: () => {}, revalidateOwner: () => {} });
    await expect(dispatch('recovery.database.configure', { input })).rejects.toThrow();
    await expect(r.databases.configure(input, () => { throw Error('owner expired'); })).rejects.toThrow('owner expired');
    for (const databaseFile of ['../outside.sqlite', '/outside.sqlite', '.git/private.sqlite'])
      await expect(r.databases.configure({ ...input, definition: { ...definition, databaseFile } }, () => {})).rejects.toThrow();
    if (process.platform !== 'win32') {
      fs.symlinkSync(path.join(f.root, 'fixture.sqlite'), path.join(f.root, 'linked.sqlite'));
      await expect(r.databases.configure({ ...input, definition: { ...definition, databaseFile: 'linked.sqlite' } }, () => {})).rejects.toThrow();
    }
    expect(r.databases.list()).toEqual([]);
  });
});
