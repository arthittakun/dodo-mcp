import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, CURRENT_SCHEMA_VERSION } from '../../src/store/db.js';
import { DEFAULT_GLOBAL_CONFIG, loadGlobalConfig, saveGlobalConfig } from '../../src/config/globalConfig.js';
import { atomicPrivateWrite, createStateCheckpoint, databaseSchemaVersion, inspectStateCheckpoint, listStateCheckpoints, restoreStateCheckpoint, withInstallationStateLock } from '../../src/config/stateCheckpoint.js';
import { EnvCredentials } from '../../src/services/ai/envCredentials.js';

describe('private installation upgrade checkpoints', () => {
  let directory: string;
  beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dodo-state-checkpoint-')); });
  afterEach(() => { vi.restoreAllMocks(); if (!path.resolve(directory).startsWith(path.join(os.tmpdir(), 'dodo-state-checkpoint-'))) throw new Error('unsafe fixture cleanup'); fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const file = () => path.join(directory, 'state.db');
  const config = () => path.join(directory, 'config.json');
  function pendingMigration() {
    const db = openDatabase(file());
    db.exec('DROP TABLE creative_output_reservations; DROP TABLE resource_gc_queue');
    db.prepare('DELETE FROM schema_migrations WHERE version=?').run(CURRENT_SCHEMA_VERSION);
    db.close();
  }

  it('keeps the previous complete config when staging flush or atomic replacement fails', () => {
    saveGlobalConfig(config(), DEFAULT_GLOBAL_CONFIG);
    const previous = fs.readFileSync(config(), 'utf8');
    const flush = vi.spyOn(fs, 'fsyncSync').mockImplementationOnce(() => { throw Object.assign(new Error('synthetic flush failure'), { code: 'ENOSPC' }); });
    expect(() => atomicPrivateWrite(config(), '{"broken":')).toThrow(); flush.mockRestore();
    expect(fs.readFileSync(config(), 'utf8')).toBe(previous);
    const rename = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw Object.assign(new Error('synthetic rename failure'), { code: 'ENOSPC' }); });
    expect(() => atomicPrivateWrite(config(), '{"broken":')).toThrow(); rename.mockRestore();
    expect(loadGlobalConfig(config()).port).toBe(DEFAULT_GLOBAL_CONFIG.port);
    expect(fs.readdirSync(directory).some(name => name.endsWith('.tmp'))).toBe(false);
    const linked = path.join(directory, 'hard-config.json'); fs.linkSync(config(), linked);
    expect(() => atomicPrivateWrite(config(), '{}')).toThrow();
    expect(fs.readFileSync(linked, 'utf8')).toBe(previous);
  });

  it('snapshots committed WAL rows, raw config and private Env files through a readonly SQLite source', () => {
    saveGlobalConfig(config(), { ...DEFAULT_GLOBAL_CONFIG, port: 21740 });
    const db = openDatabase(file());
    try {
      db.pragma('wal_autocheckpoint = 0');
      db.prepare("INSERT INTO meta(key,value) VALUES('wal-fixture','committed-only-in-wal')").run();
      const env = new EnvCredentials(path.join(directory, 'credentials', 'ai')); env.set('ai_fixture0001', 'synthetic-checkpoint-old');
      expect(fs.statSync(file() + '-wal').size).toBeGreaterThan(0);
      const checkpoint = createStateCheckpoint(directory);
      const restored = new Database(path.join(directory, 'state-checkpoints', checkpoint.id, 'state.db'), { readonly: true });
      try { expect(restored.prepare("SELECT value FROM meta WHERE key='wal-fixture'").get()).toEqual({ value: 'committed-only-in-wal' }); }
      finally { restored.close(); }
      expect(checkpoint.files.map(entry => entry.path)).toEqual(expect.arrayContaining(['state.db', 'config.json', 'credentials/ai/ai_fixture0001.env']));
      expect(inspectStateCheckpoint(directory, checkpoint.id).manifestHash).toBe(checkpoint.manifestHash);
      expect(JSON.stringify(checkpoint)).not.toContain('synthetic-checkpoint-old');
    } finally { db.close(); }
  });

  it('creates a verified checkpoint before applying a pending migration exactly once', () => {
    pendingMigration();
    const db = openDatabase(file());
    try { expect(databaseSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION); }
    finally { db.close(); }
    const checkpoints = listStateCheckpoints(directory);
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]).toMatchObject({ reason: 'before-migration', databaseSchemaVersion: CURRENT_SCHEMA_VERSION - 1, targetSchemaVersion: CURRENT_SCHEMA_VERSION });
    const reopened = openDatabase(file()); reopened.close();
    expect(listStateCheckpoints(directory)).toHaveLength(1);
  });

  it('does not advance the schema when a checkpoint cannot be committed', () => {
    pendingMigration();
    const actualRename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((source, target) => {
      if (String(target).includes('state-checkpoints') && path.basename(String(target)).startsWith('state_')) throw Object.assign(new Error('synthetic disk full'), { code: 'ENOSPC' });
      return actualRename(source, target);
    });
    expect(() => openDatabase(file())).toThrow(/checkpoint failed/);
    const previous = new Database(file(), { readonly: true });
    try { expect(databaseSchemaVersion(previous)).toBe(CURRENT_SCHEMA_VERSION - 1); }
    finally { previous.close(); }
    expect(fs.readdirSync(path.join(directory, 'state-checkpoints'))).toEqual([]);
  });

  it('refuses a future schema without migrating or creating a rollback checkpoint', () => {
    const db = openDatabase(file());
    db.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES (?,?)').run(CURRENT_SCHEMA_VERSION + 1, Date.now());
    db.close();
    expect(() => openDatabase(file())).toThrow(/newer DODO version/);
    const unchanged = new Database(file(), { readonly: true });
    try { expect(databaseSchemaVersion(unchanged)).toBe(CURRENT_SCHEMA_VERSION + 1); } finally { unchanged.close(); }
    expect(listStateCheckpoints(directory)).toEqual([]);
  });

  it('protects a version-only config change and records an actual previous runtime version', () => {
    saveGlobalConfig(config(), { ...DEFAULT_GLOBAL_CONFIG, port: 21740 }); const db = openDatabase(file());
    db.prepare("UPDATE meta SET value='1.9.0' WHERE key='dodo-runtime-version'").run(); db.close();
    atomicPrivateWrite(path.join(directory, 'state-runtime-version.json'), '{"version":"1.9.0"}\n');
    const previous = fs.readFileSync(config(), 'utf8'); saveGlobalConfig(config(), { ...DEFAULT_GLOBAL_CONFIG, port: 21741 });
    const checkpoints = listStateCheckpoints(directory); expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]).toMatchObject({ reason: 'before-config-change', previousRuntimeVersion: '1.9.0', databaseSchemaVersion: CURRENT_SCHEMA_VERSION });
    expect(fs.readFileSync(path.join(directory, 'state-checkpoints', checkpoints[0]!.id, 'config.json'), 'utf8')).toBe(previous);
  });

  it('backs up a version-only database open without revoking normal upgrade login', () => {
    let db = openDatabase(file()); db.prepare("UPDATE meta SET value='1.9.0' WHERE key='dodo-runtime-version'").run();
    db.prepare("INSERT INTO grants(id,workspace_id,client_id,account_id,scopes,created_at,revoked_at) VALUES('upgrade-grant','ws','client','owner','dodo:read',?,NULL)").run(Date.now()); db.close();
    db = openDatabase(file());
    try { expect(db.prepare("SELECT revoked_at FROM grants WHERE id='upgrade-grant'").get()).toEqual({ revoked_at: null }); } finally { db.close(); }
    expect(listStateCheckpoints(directory)[0]).toMatchObject({ reason: 'before-version-open', previousRuntimeVersion: '1.9.0' });
  });

  it('restores matching DB/config/Env state offline and saves the newer state first', () => {
    saveGlobalConfig(config(), { ...DEFAULT_GLOBAL_CONFIG, port: 21740 });
    const env = new EnvCredentials(path.join(directory, 'credentials', 'ai'));
    env.set('ai_fixture0001', 'synthetic-old-key');
    let db = openDatabase(file()); db.prepare("INSERT INTO meta(key,value) VALUES('restore-fixture','old')").run();
    db.prepare("INSERT INTO grants(id,workspace_id,client_id,account_id,scopes,created_at,revoked_at) VALUES('restore-grant','ws','client','owner','dodo:read',?,NULL)").run(Date.now());
    db.prepare("INSERT INTO oauth_models(model,id,payload) VALUES('RefreshToken','old-refresh','{}')").run();
    db.prepare("INSERT INTO oauth_clients(client_id,payload,created_at) VALUES('client','{}',?)").run(Date.now()); db.close();
    const checkpoint = createStateCheckpoint(directory);
    db = openDatabase(file()); db.prepare("UPDATE meta SET value='new' WHERE key='restore-fixture'").run(); db.close();
    saveGlobalConfig(config(), { ...DEFAULT_GLOBAL_CONFIG, port: 21741 }); env.set('ai_fixture0001', 'synthetic-new-key'); env.set('ai_fixture0002', 'synthetic-added-key');
    const inheritedName = 'DODO_CHECKPOINT_EXTERNAL_TEST', inherited = process.env[inheritedName]; process.env[inheritedName] = 'synthetic-external-value';
    try {
      const result = restoreStateCheckpoint(directory, checkpoint.id, { confirm: true, expectedManifestHash: checkpoint.manifestHash });
      expect(result.emergencyCheckpointId).not.toBe(checkpoint.id);
      expect(inspectStateCheckpoint(directory, result.emergencyCheckpointId).reason).toBe('before-restore');
      expect(loadGlobalConfig(config()).port).toBe(21740); expect(env.get('ai_fixture0001')).toBe('synthetic-old-key');
      expect(fs.existsSync(path.join(directory, 'credentials', 'ai', 'ai_fixture0002.env'))).toBe(false);
      expect(process.env[inheritedName]).toBe('synthetic-external-value');
      db = new Database(file(), { readonly: true });
      try {
        expect(db.prepare("SELECT value FROM meta WHERE key='restore-fixture'").get()).toEqual({ value: 'old' });
        expect(db.prepare("SELECT revoked_at FROM grants WHERE id='restore-grant'").get()).toMatchObject({ revoked_at: expect.any(Number) });
        expect(db.prepare("SELECT 1 FROM oauth_models WHERE id='old-refresh'").get()).toBeUndefined();
        expect(db.prepare("SELECT 1 FROM oauth_clients WHERE client_id='client'").get()).toBeDefined();
      } finally { db.close(); }
    } finally { if (inherited === undefined) delete process.env[inheritedName]; else process.env[inheritedName] = inherited; }
  });

  it('journals a partial restore, refuses mixed state and resumes without replacing the emergency copy', () => {
    saveGlobalConfig(config(), { ...DEFAULT_GLOBAL_CONFIG, port: 21740 }); let db = openDatabase(file());
    db.prepare("INSERT INTO meta(key,value) VALUES('partial-fixture','old')").run(); db.close();
    const checkpoint = createStateCheckpoint(directory);
    saveGlobalConfig(config(), { ...DEFAULT_GLOBAL_CONFIG, port: 21741 }); db = openDatabase(file());
    db.prepare("UPDATE meta SET value='new' WHERE key='partial-fixture'").run(); db.close();
    const actualRename = fs.renameSync;
    const failure = vi.spyOn(fs, 'renameSync').mockImplementation((source, target) => {
      if (String(target) === config()) throw Object.assign(new Error('synthetic interrupted config restore'), { code: 'ENOSPC' });
      return actualRename(source, target);
    });
    expect(() => restoreStateCheckpoint(directory, checkpoint.id, { confirm: true, expectedManifestHash: checkpoint.manifestHash })).toThrow(); failure.mockRestore();
    const journal = JSON.parse(fs.readFileSync(path.join(directory, 'state-restore.json'), 'utf8')) as { emergencyCheckpointId: string };
    expect(() => openDatabase(file())).toThrow(/restore is incomplete/);
    expect(() => saveGlobalConfig(config(), DEFAULT_GLOBAL_CONFIG)).toThrow(/restore is incomplete/);
    const result = restoreStateCheckpoint(directory, checkpoint.id, { confirm: true, expectedManifestHash: checkpoint.manifestHash });
    expect(result.emergencyCheckpointId).toBe(journal.emergencyCheckpointId);
    expect(loadGlobalConfig(config()).port).toBe(21740); expect(fs.existsSync(path.join(directory, 'state-restore.json'))).toBe(false);
    const emergency = new Database(path.join(directory, 'state-checkpoints', result.emergencyCheckpointId, 'state.db'), { readonly: true });
    try { expect(emergency.prepare("SELECT value FROM meta WHERE key='partial-fixture'").get()).toEqual({ value: 'new' }); } finally { emergency.close(); }
  });

  it('refuses an unreviewed/corrupt restore and refuses any live runtime before touching state', () => {
    saveGlobalConfig(config(), DEFAULT_GLOBAL_CONFIG); const db = openDatabase(file()); db.close();
    const checkpoint = createStateCheckpoint(directory), previous = fs.readFileSync(config(), 'utf8');
    expect(() => restoreStateCheckpoint(directory, checkpoint.id, { confirm: true, expectedManifestHash: '0'.repeat(64) })).toThrow(/manifest hash/);
    const leases = path.join(directory, 'runtime-leases'); fs.mkdirSync(leases); fs.writeFileSync(path.join(leases, 'a'.repeat(64) + '.json'), JSON.stringify({ pid: process.pid }));
    expect(() => restoreStateCheckpoint(directory, checkpoint.id, { confirm: true, expectedManifestHash: checkpoint.manifestHash })).toThrow(/stop all DODO/);
    fs.unlinkSync(path.join(leases, 'a'.repeat(64) + '.json'));
    fs.appendFileSync(path.join(directory, 'state-checkpoints', checkpoint.id, 'config.json'), ' ');
    expect(() => inspectStateCheckpoint(directory, checkpoint.id)).toThrow(/integrity/);
    expect(fs.readFileSync(config(), 'utf8')).toBe(previous);
  });

  it('keeps only five verified complete checkpoints and bounded raw config history', () => {
    saveGlobalConfig(config(), DEFAULT_GLOBAL_CONFIG); const db = openDatabase(file()); db.close();
    for (let index = 0; index < 7; index++) { saveGlobalConfig(config(), { ...DEFAULT_GLOBAL_CONFIG, port: 21740 + index }); createStateCheckpoint(directory); }
    expect(listStateCheckpoints(directory)).toHaveLength(5);
    expect(fs.readdirSync(path.join(directory, 'config-history'))).toHaveLength(5);
  });

  it('waits for another live process holding the installation writer lock', async () => {
    const ready = path.join(directory, 'ready'), script = "const fs=require('node:fs'),path=require('node:path'),Database=require('better-sqlite3');const d=process.argv[1],db=new Database(path.join(d,'installation-state.lock.db'));if(process.platform!=='win32')fs.chmodSync(path.join(d,'installation-state.lock.db'),0o600);db.pragma('journal_mode=MEMORY');db.exec('BEGIN EXCLUSIVE');fs.writeFileSync(path.join(d,'ready'),'ready');setTimeout(()=>{db.exec('ROLLBACK');db.close();},750);";
    const child = spawn(process.execPath, ['-e', script, directory], { stdio: 'ignore', windowsHide: true });
    try {
      for (let index = 0; index < 100 && !fs.existsSync(ready); index++) await new Promise(resolve => setTimeout(resolve, 10));
      expect(fs.existsSync(ready)).toBe(true);
      const started = Date.now(); const value = withInstallationStateLock(directory, () => 'acquired');
      expect(value).toBe('acquired'); expect(Date.now() - started).toBeGreaterThanOrEqual(250);
      await new Promise<void>(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit', () => resolve()); });
      expect(fs.statSync(path.join(directory, 'installation-state.lock.db')).size).toBe(0);
    } finally { if (child.exitCode === null) child.kill(); }
  });

  it('releases a crashed process lock and permits nested operations without deleting a live lock', async () => {
    const ready = path.join(directory, 'ready'), script = "const fs=require('node:fs'),path=require('node:path'),Database=require('better-sqlite3');const d=process.argv[1],db=new Database(path.join(d,'installation-state.lock.db'));if(process.platform!=='win32')fs.chmodSync(path.join(d,'installation-state.lock.db'),0o600);db.pragma('journal_mode=MEMORY');db.exec('BEGIN EXCLUSIVE');fs.writeFileSync(path.join(d,'ready'),'ready');setInterval(()=>{},1000);";
    const child = spawn(process.execPath, ['-e', script, directory], { stdio: 'ignore', windowsHide: true });
    try {
      for (let index = 0; index < 100 && !fs.existsSync(ready); index++) await new Promise(resolve => setTimeout(resolve, 10));
      expect(fs.existsSync(ready)).toBe(true);
      child.kill(); await new Promise<void>(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit', () => resolve()); });
      expect(withInstallationStateLock(directory, () => withInstallationStateLock(directory, () => 'nested'))).toBe('nested');
      expect(fs.statSync(path.join(directory, 'installation-state.lock.db')).isFile()).toBe(true);
      expect(fs.statSync(path.join(directory, 'installation-state.lock.db')).size).toBe(0);
    } finally { if (child.exitCode === null) child.kill(); }
  });

  it('refuses migration while another live DODO runtime lease exists', async () => {
    pendingMigration(); const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true });
    const leases = path.join(directory, 'runtime-leases'); fs.mkdirSync(leases);
    fs.writeFileSync(path.join(leases, 'a'.repeat(64) + '.json'), JSON.stringify({ pid: child.pid }));
    try { expect(() => openDatabase(file())).toThrow(/stop all other DODO/); expect(listStateCheckpoints(directory)).toEqual([]); }
    finally { child.kill(); await new Promise<void>(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit', () => resolve()); }); }
  });

  it('rechecks an interrupted restore journal after waiting for the installation lock', async () => {
    const initial = openDatabase(file()); initial.close();
    const ready = path.join(directory, 'ready'), script = "const fs=require('node:fs'),path=require('node:path'),Database=require('better-sqlite3');const d=process.argv[1],file=path.join(d,'installation-state.lock.db'),db=new Database(file);if(process.platform!=='win32')fs.chmodSync(file,0o600);db.pragma('journal_mode=MEMORY');db.exec('BEGIN EXCLUSIVE');fs.writeFileSync(path.join(d,'ready'),'ready');setTimeout(()=>{fs.writeFileSync(path.join(d,'state-restore.json'),'{}',{mode:0o600});db.exec('ROLLBACK');db.close();},750);";
    const child = spawn(process.execPath, ['-e', script, directory], { stdio: 'ignore', windowsHide: true });
    try {
      for (let index = 0; index < 100 && !fs.existsSync(ready); index++) await new Promise(resolve => setTimeout(resolve, 10));
      expect(fs.existsSync(ready)).toBe(true);
      expect(() => openDatabase(file())).toThrow(/installation restore is incomplete/);
      await new Promise<void>(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit', () => resolve()); });
    } finally { if (child.exitCode === null) child.kill(); }
  });
});
