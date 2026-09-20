import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { platformFixture } from '../helpers/platform.js';
import { ProjectRegistry } from '../../src/projects/registry.js';
import { RecoveryConfigVault } from '../../src/services/recovery/configVault.js';
import { ensurePrivateDirectory } from '../../src/platform/privateFs.js';
import { DodoError } from '../../src/errors.js';

describe('R06 encrypted private config recovery', () => {
  let f: ReturnType<typeof platformFixture>;
  afterEach(async () => { vi.restoreAllMocks(); await f?.close(); });
  async function setup() {
    f = platformFixture(); ensurePrivateDirectory(f.root); new ProjectRegistry(f.ws.store).add(f.root, 'Private config fixture');
    const secret = 'FIXTURE_SECRET=' + randomBytes(24).toString('hex'), file = path.join(f.root, '.env');
    fs.writeFileSync(file, secret, { mode: 0o600 });
    const keys = new Map<string, Buffer>();
    const store = { async get(id: string) { const key = keys.get(id); if (!key) throw new DodoError('AUTH_REQUIRED', 'fixture key unavailable'); return Buffer.from(key); },
      async put(id: string, value: Buffer) { keys.set(id, Buffer.from(value)); }, async delete(id: string) { keys.delete(id); } };
    const vault = new RecoveryConfigVault(f.ws.services, f.ws.services.recovery!, store);
    const target = await vault.configure({ expectedRevision: 0, enabled: true, definition: { name: 'private fixture', path: '.env', retention: 2 }, confirmEncryptedPrivateBackup: true }, () => {});
    return { vault, target, keys, file, secret };
  }
  it('stores authenticated ciphertext only, restores exactly with an encrypted pre-backup, and source tools never read the secret', async () => {
    const { vault, target, file, secret, keys } = await setup();
    const backup = await vault.backup(target.id, () => {});
    const row = f.ws.store.db.prepare('SELECT * FROM recovery_config_backups WHERE id=?').get(backup.id) as { sealed: string };
    expect(row.sealed).not.toContain(secret); expect(JSON.stringify(vault.list())).not.toContain(secret);
    for (const key of keys.values()) expect(row.sealed).not.toContain(key.toString('base64'));
    const denied = await f.call('read_files', { files: [{ path: '.env' }] });
    expect(denied.files).toEqual([]); expect(JSON.stringify(denied.errors)).toContain('SECRET_PATH_DENIED');
    expect(JSON.stringify(denied)).not.toContain(secret);
    fs.writeFileSync(file, 'SECOND_FIXTURE_VALUE');
    const plan = await vault.preview(backup.id, () => {});
    expect(plan).toMatchObject({ changed: true, plaintext: 'REDACTED', encryptedPreRestoreBackupRequired: true });
    expect(JSON.stringify(plan)).not.toContain(secret);
    expect(await vault.apply(plan.planId, plan.planHash, () => {})).toMatchObject({ state: 'APPLIED', outcome: { verified: true, restarted: false }, replayed: false });
    expect(fs.readFileSync(file, 'utf8')).toBe(secret);
    fs.writeFileSync(file, 'EXTERNAL_AFTER_SUCCESS');
    expect(await vault.apply(plan.planId, plan.planHash, () => {})).toMatchObject({ state: 'APPLIED', replayed: true });
    expect(fs.readFileSync(file, 'utf8')).toBe('EXTERNAL_AFTER_SUCCESS');
    const state = JSON.stringify(f.ws.store.db.prepare('SELECT * FROM recovery_config_restores').all());
    expect(state).not.toContain(secret); expect(state).not.toContain('SECOND_FIXTURE_VALUE');
  });
  it('tamper, missing/wrong key and cross-target ciphertext fail closed without changing the file', async () => {
    const { vault, target, file, secret, keys } = await setup(), backup = await vault.backup(target.id, () => {});
    const row = f.ws.store.db.prepare('SELECT key_ref,sealed FROM recovery_config_backups WHERE id=?').get(backup.id) as { key_ref: string; sealed: string };
    const original = Buffer.from(keys.get(row.key_ref)!);
    keys.set(row.key_ref, randomBytes(32)); await expect(vault.preview(backup.id, () => {})).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    keys.delete(row.key_ref); await expect(vault.preview(backup.id, () => {})).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    keys.set(row.key_ref, original);
    const data = JSON.parse(row.sealed) as { tag: string; header: { targetId: string } };
    data.tag = randomBytes(16).toString('base64'); f.ws.store.db.prepare('UPDATE recovery_config_backups SET sealed=? WHERE id=?').run(JSON.stringify(data), backup.id);
    await expect(vault.preview(backup.id, () => {})).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    data.header.targetId = 'other-target'; f.ws.store.db.prepare('UPDATE recovery_config_backups SET sealed=? WHERE id=?').run(JSON.stringify(data), backup.id);
    await expect(vault.preview(backup.id, () => {})).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    expect(fs.readFileSync(file, 'utf8')).toBe(secret);
  });
  it('rotation keeps prior keys usable, invalidates stale previews and never writes an encryption key into state', async () => {
    const { vault, target, keys } = await setup(), backup = await vault.backup(target.id, () => {}), old = await vault.preview(backup.id, () => {});
    expect(await vault.rotate(target.id, target.revision, () => {})).toMatchObject({ revision: 2, oldBackupsKeepOldOSKeys: true, oldBackupsReencrypted: false });
    expect(keys.size).toBe(2); await expect(vault.apply(old.planId, old.planHash, () => {})).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await vault.preview(backup.id, () => {})).toMatchObject({ targetId: target.id, plaintext: 'REDACTED' });
    const json = JSON.stringify(f.ws.store.db.prepare('SELECT * FROM recovery_config_targets').all());
    for (const key of keys.values()) expect(json).not.toContain(key.toString('base64'));
  });
  it('revoked owner, external edits, stale epoch and a non-secret path cannot authorize restore', async () => {
    const { vault, target, file } = await setup(), backup = await vault.backup(target.id, () => {}), plan = await vault.preview(backup.id, () => {});
    const revoked = () => { throw new DodoError('AUTH_REQUIRED', 'owner expired'); };
    await expect(vault.apply(plan.planId, plan.planHash, revoked)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    fs.writeFileSync(file, 'external'); await expect(vault.apply(plan.planId, plan.planHash, () => {})).rejects.toMatchObject({ code: 'FILE_CHANGED' });
    const fresh = await vault.preview(backup.id, () => {}), epoch = f.ws.services.epoch; f.ws.services.epoch = 'restarted';
    try { await expect(vault.apply(fresh.planId, fresh.planHash, () => {})).rejects.toMatchObject({ code: 'CONFLICT' }); }
    finally { f.ws.services.epoch = epoch; }
    fs.writeFileSync(path.join(f.root, 'source.txt'), 'ordinary source', { mode: 0o600 });
    await expect(vault.configure({ expectedRevision: 0, enabled: true, definition: { name: 'bad', path: 'source.txt' }, confirmEncryptedPrivateBackup: true }, () => {})).rejects.toMatchObject({ code: 'PATH_DENIED' });
  });
  it('an interrupted write has an encrypted pre-backup and UNKNOWN receipt; restart/retry never repeats writes', async () => {
    const { vault, target, file } = await setup(), backup = await vault.backup(target.id, () => {});
    fs.writeFileSync(file, 'before interrupted restore'); const plan = await vault.preview(backup.id, () => {});
    const original = fs.fsyncSync;
    vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => { if (fs.fstatSync(fd).ino === fs.statSync(file).ino) throw Error('injected crash after write'); original(fd); });
    expect(await vault.apply(plan.planId, plan.planHash, () => {})).toMatchObject({ state: 'UNKNOWN', retryAllowed: false });
    vi.restoreAllMocks();
    const row = f.ws.store.db.prepare('SELECT before_id,state FROM recovery_config_restores WHERE id=?').get(plan.planId) as { before_id: string; state: string };
    expect(row.before_id).toMatch(/^configbackup_/); expect(row.state).toBe('UNKNOWN');
    fs.writeFileSync(file, 'external after interruption'); vault.reconcile();
    expect(await vault.apply(plan.planId, plan.planHash, () => {})).toMatchObject({ state: 'UNKNOWN', replayed: true });
    expect(fs.readFileSync(file, 'utf8')).toBe('external after interruption');
    const restoreBefore = await vault.preview(row.before_id, () => {});
    expect(await vault.apply(restoreBefore.planId, restoreBefore.planHash, () => {})).toMatchObject({ state: 'APPLIED' });
    expect(fs.readFileSync(file, 'utf8')).toBe('before interrupted restore');
  });
  it('refuses replaced/linked private files and rechecks owner authority after waiting for the mutation queue', async () => {
    const { vault, target, file } = await setup();
    const backup = await vault.backup(target.id, () => {}), plan = await vault.preview(backup.id, () => {});
    fs.renameSync(file, file+'.old'); fs.writeFileSync(file, 'replacement', { mode: 0o600 });
    await expect(vault.apply(plan.planId, plan.planHash, () => {})).rejects.toMatchObject({ code: 'FILE_CHANGED' });
    const plan2 = await vault.preview(backup.id, () => {});
    let release!: () => void, revoked = false;
    const held = f.ws.services.mutations!.run(() => new Promise<void>(r => { release = r; }));
    const pending = vault.apply(plan2.planId, plan2.planHash, () => { if (revoked) throw new DodoError('AUTH_REQUIRED','owner expired while queued'); });
    revoked = true; release(); await held;
    await expect(pending).rejects.toMatchObject({ code: 'AUTH_REQUIRED' }); expect(fs.readFileSync(file,'utf8')).toBe('replacement');
    fs.linkSync(file, file+'.linked');
    await expect(vault.backup(target.id, () => {})).rejects.toThrow(); fs.unlinkSync(file+'.linked');
    if(process.platform !== 'win32'){
      fs.unlinkSync(file);fs.symlinkSync(file+'.old',file);
      await expect(vault.backup(target.id, () => {})).rejects.toMatchObject({code:'PATH_DENIED'});
    }
  });
  it('retention removes only unreferenced ciphertext; a missing file can still be disabled', async () => {
    const { vault, target, file } = await setup();
    const first=await vault.backup(target.id,()=>{});await vault.preview(first.id,()=>{});
    for(let i=0;i<4;i++){fs.writeFileSync(file, 'fixture-generation-'+i);await vault.backup(target.id,()=>{});}
    const backups = vault.list().backups as Array<{id:string}>;
    expect(backups).toHaveLength(3);expect(backups.some(b=>b.id===first.id)).toBe(true);
    fs.unlinkSync(file);
    expect(await vault.configure({targetId:target.id,expectedRevision:1,enabled:false,confirmEncryptedPrivateBackup:true,definition:{name:'private fixture',path:'.env',retention:2}},()=>{})).toMatchObject({enabled:false});
    await expect(vault.backup(target.id,()=>{})).rejects.toMatchObject({code:'FORBIDDEN'});
  });
});
