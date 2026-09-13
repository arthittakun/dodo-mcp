import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectRegistry } from '../../src/projects/registry.js';
import { openDatabase } from '../../src/store/db.js';
import { Store } from '../../src/store/store.js';

const owned: string[] = [];

function fixture() {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dodo-project-registry-')));
  owned.push(base);
  const config = path.join(base, 'config');
  fs.mkdirSync(config);
  const db = openDatabase(path.join(config, 'state.db'));
  const store = new Store(db);
  return { base, db, store, registry: new ProjectRegistry(store) };
}

afterEach(() => {
  for (const directory of owned.splice(0)) fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
});

describe('installation project registry', () => {
  it('registers canonical Unicode/spaced paths and keeps one stable random project ID on duplicate add', () => {
    const f = fixture();
    const root = path.join(f.base, 'โปรเจกต์ เว็บ');
    fs.mkdirSync(root);
    try {
      const first = f.registry.add(root, 'เว็บหลัก');
      const duplicate = f.registry.add(path.join(root, '.'));
      expect(first.changed).toBe(true);
      expect(first.project.projectId).toMatch(/^prj_/);
      expect(first.project.root).toBe(fs.realpathSync.native(root));
      expect(first.project.displayName).toBe('เว็บหลัก');
      expect(first.project.availability).toBe('ready');
      expect(duplicate.changed).toBe(false);
      expect(duplicate.project.projectId).toBe(first.project.projectId);
      expect(f.registry.list()).toHaveLength(1);
    } finally { f.db.close(); }
  });

  it('preserves project ID across a proven directory move but rotates path-derived workspace ID and copies no authority', () => {
    const f = fixture();
    const before = path.join(f.base, 'before');
    const after = path.join(f.base, 'after');
    fs.mkdirSync(before);
    try {
      const added = f.registry.add(before, 'Moved project');
      const oldWorkspace = added.project.workspaceId;
      f.store.upsertWorkspace({ id: oldWorkspace, root: before, dev: added.project.identity.dev, ino: added.project.identity.ino, epoch: 'fixture' });
      f.store.setTrustMode(oldWorkspace, 'trusted');
      f.store.setClientAccess(oldWorkspace, 'client_fixture', ['dodo:read', 'dodo:write']);
      fs.renameSync(before, after);
      expect(f.registry.get(added.project.projectId).availability).toBe('missing');

      const relocated = f.registry.add(after);
      expect(relocated.relocated).toBe(true);
      expect(relocated.project.projectId).toBe(added.project.projectId);
      expect(relocated.project.workspaceId).not.toBe(oldWorkspace);
      expect(relocated.project.root).toBe(fs.realpathSync.native(after));
      expect(f.store.trustMode(relocated.project.workspaceId)).toBe('inspect');
      expect(f.store.clientAccess(relocated.project.workspaceId, 'client_fixture')).toEqual([]);
      expect(f.store.trustMode(oldWorkspace)).toBe('trusted');
      expect(f.store.clientAccess(oldWorkspace, 'client_fixture')).toEqual(['dodo:read', 'dodo:write']);
    } finally { f.db.close(); }
  });

  it('reports missing, symlinked and replaced roots distinctly and refuses silent identity takeover', () => {
    const f = fixture();
    const missingRoot = path.join(f.base, 'missing-project');
    const symlinkRoot = path.join(f.base, 'symlink-project');
    const target = path.join(f.base, 'target');
    const replacedRoot = path.join(f.base, 'replaced-project');
    fs.mkdirSync(missingRoot); fs.mkdirSync(symlinkRoot); fs.mkdirSync(target); fs.mkdirSync(replacedRoot);
    try {
      const missing = f.registry.add(missingRoot).project;
      const symlinked = f.registry.add(symlinkRoot).project;
      const replaced = f.registry.add(replacedRoot).project;
      fs.rmdirSync(missingRoot);
      fs.rmdirSync(symlinkRoot);
      fs.symlinkSync(target, symlinkRoot, process.platform === 'win32' ? 'junction' : 'dir');
      fs.rmdirSync(replacedRoot);
      fs.mkdirSync(replacedRoot);

      expect(f.registry.get(missing.projectId).availability).toBe('missing');
      expect(f.registry.get(symlinked.projectId).availability).toBe('symlinked');
      expect(f.registry.get(replaced.projectId).availability).toBe('replaced');
      expect(() => f.registry.add(replacedRoot)).toThrow(/another directory identity/);
    } finally { f.db.close(); }
  });

  it('soft-removes only registry metadata and preserves files, trust, ACL and historical workspace rows', () => {
    const f = fixture();
    const root = path.join(f.base, 'keep-everything');
    fs.mkdirSync(root); fs.writeFileSync(path.join(root, 'keep.txt'), 'keep');
    try {
      const project = f.registry.add(root).project;
      f.store.upsertWorkspace({ id: project.workspaceId, root, dev: project.identity.dev, ino: project.identity.ino, epoch: 'fixture' });
      f.store.setTrustMode(project.workspaceId, 'edit');
      f.store.setClientAccess(project.workspaceId, 'client_fixture', ['dodo:read']);

      const removed = f.registry.remove(project.projectId);
      expect(removed.removedAt).not.toBeNull();
      expect(f.registry.list()).toEqual([]);
      expect(f.registry.get(project.projectId, { includeRemoved: true }).projectId).toBe(project.projectId);
      expect(fs.readFileSync(path.join(root, 'keep.txt'), 'utf8')).toBe('keep');
      expect(f.store.trustMode(project.workspaceId)).toBe('edit');
      expect(f.store.clientAccess(project.workspaceId, 'client_fixture')).toEqual(['dodo:read']);

      const readded = f.registry.add(root).project;
      expect(readded.projectId).not.toBe(project.projectId);
      expect(readded.workspaceId).toBe(project.workspaceId);
      expect(f.store.trustMode(readded.workspaceId)).toBe('edit');
    } finally { f.db.close(); }
  });

  it('surfaces corrupt metadata as invalid and permits reviewed removal instead of granting readiness', () => {
    const f = fixture();
    const root = path.join(f.base, 'corrupt'); fs.mkdirSync(root);
    try {
      const project = f.registry.add(root).project;
      f.db.prepare('UPDATE project_registry SET metadata_version = 999 WHERE id = ?').run(project.projectId);
      const invalid = f.registry.get(project.projectId);
      expect(invalid.availability).toBe('invalid');
      expect(invalid.available).toBe(false);
      expect(() => f.registry.add(root)).toThrow(/registry row is invalid/);
      expect(f.registry.remove(project.projectId).removedAt).not.toBeNull();
    } finally { f.db.close(); }
  });

  it('rolls registry mutations back when their audit record cannot be committed', () => {
    const f = fixture();
    const root = path.join(f.base, 'audit-atomic'); fs.mkdirSync(root);
    try {
      f.db.exec("CREATE TRIGGER fail_project_audit BEFORE INSERT ON audit_events WHEN NEW.tool LIKE 'local.project.%' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END");
      expect(() => f.registry.add(root)).toThrow(/registry update failed/);
      expect((f.db.prepare('SELECT COUNT(*) AS count FROM project_registry').get() as { count: number }).count).toBe(0);
      f.db.exec('DROP TRIGGER fail_project_audit');
      const project = f.registry.add(root).project;
      f.db.exec("CREATE TRIGGER fail_project_audit BEFORE INSERT ON audit_events WHEN NEW.tool LIKE 'local.project.%' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END");
      expect(() => f.registry.remove(project.projectId)).toThrow(/registry update failed/);
      expect(f.registry.get(project.projectId).removedAt).toBeNull();
    } finally { f.db.close(); }
  });

  it('migrates an existing state database and gives independent connections one active row', () => {
    const f = fixture();
    const root = path.join(f.base, 'shared'); fs.mkdirSync(root);
    try {
      f.db.exec('DROP TABLE project_registry; DELETE FROM schema_migrations WHERE version = 7');
      f.db.close();
      const firstDb = openDatabase(path.join(f.base, 'config', 'state.db'));
      const secondDb = openDatabase(path.join(f.base, 'config', 'state.db'));
      try {
        const first = new ProjectRegistry(new Store(firstDb)).add(root);
        const second = new ProjectRegistry(new Store(secondDb)).add(root);
        expect(second.project.projectId).toBe(first.project.projectId);
        expect(second.changed).toBe(false);
        expect((firstDb.prepare('SELECT COUNT(*) AS count FROM project_registry WHERE removed_at IS NULL').get() as { count: number }).count).toBe(1);
      } finally { firstDb.close(); secondDb.close(); }
    } finally { if (f.db.open) f.db.close(); }
  });
});
