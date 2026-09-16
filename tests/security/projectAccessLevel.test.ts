import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { openDatabase } from '../../src/store/db.js';
import { Store } from '../../src/store/store.js';
import { ProjectRegistry } from '../../src/projects/registry.js';
import { ProjectAdmin } from '../../src/projects/ownerAdmin.js';
import { projectAuthority } from '../../src/security/projectAuthority.js';
import { projectScopeCeiling, scopesForLevel, levelForScopes } from '../../src/security/projectAccess.js';
import { setAccessMode } from '../../src/security/accessMode.js';
import { addStaticClient } from '../../src/auth/clients.js';
import { mkTmpDir } from '../helpers/testServer.js';
import type { Principal } from '../../src/tools/context.js';

/**
 * Simple Project Access Policy (read | edit | full).
 *
 * The level is a CEILING layered onto the existing model. These tests pin the
 * two directions that matter: it must narrow what a broad token can do, and it
 * must never widen what a narrow token can do.
 */
function fixture() {
  const base = mkTmpDir('dodo-access-level-');
  const configDir = path.join(base, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  const db = openDatabase(path.join(configDir, 'state.db'));
  const store = new Store(db);
  const root = path.join(base, 'project');
  fs.mkdirSync(root);
  return { base, db, store, root, admin: new ProjectAdmin(store), registry: new ProjectRegistry(store) };
}

/** A live OAuth client + grant, as the HTTP pipeline would present it. */
function principalWith(store: Store, workspaceId: string, tokenScopes: string[]): Principal {
  const client = addStaticClient(store, { name: 'Fixture client', redirectUris: ['https://example.com/cb'] });
  const grantId = `grant_${Math.abs(workspaceId.length * 7 + tokenScopes.length)}_${client.clientId.slice(-6)}`;
  store.putGrant({ id: grantId, workspaceId, clientId: client.clientId, accountId: 'owner', scopes: tokenScopes });
  // A v2 identity grant, so workspace binding does not reject cross-project use.
  store.setMeta(`identity-grant:${grantId}`, '2');
  return { grantId, clientId: client.clientId, sub: 'owner', scopes: [...tokenScopes], tokenScopes: [...tokenScopes], identityGrant: true };
}

describe('simple project access policy', () => {
  it('maps each level to a scope ceiling and back', () => {
    expect(scopesForLevel('read')).toEqual(['dodo:read']);
    expect(scopesForLevel('edit')).toEqual(['dodo:read', 'dodo:write']);
    expect(scopesForLevel('full')).toEqual(['dodo:read', 'dodo:write', 'dodo:exec']);
    expect(levelForScopes(['dodo:read'])).toBe('read');
    expect(levelForScopes(['dodo:read', 'dodo:write'])).toBe('edit');
    expect(levelForScopes(['dodo:read', 'dodo:write', 'dodo:exec'])).toBe('full');
    expect(levelForScopes([])).toBe('none');
  });

  it('narrows a full-scope client to exactly what the project level allows', () => {
    const f = fixture();
    try {
      setAccessMode(f.store, 'personal');
      const project = f.admin.add({ path: f.root, name: 'auto-upload', access: 'read' }).project;
      const p = principalWith(f.store, project.workspaceId, ['dodo:read', 'dodo:write', 'dodo:exec']);

      // read: search and analysis only
      expect(projectAuthority(f.store, p, project.workspaceId).scopes).toEqual(['dodo:read']);

      // edit: may change files, still cannot run commands
      f.admin.setAccess(project.projectId, 'edit');
      expect(projectAuthority(f.store, p, project.workspaceId).scopes).toEqual(['dodo:read', 'dodo:write']);

      // full: may also run commands and tests
      f.admin.setAccess(project.projectId, 'full');
      expect(projectAuthority(f.store, p, project.workspaceId).scopes).toEqual(['dodo:read', 'dodo:write', 'dodo:exec']);
    } finally { f.db.close(); }
  });

  it('never lets a read-only OAuth token write or execute, even on a full project', () => {
    const f = fixture();
    try {
      setAccessMode(f.store, 'personal');
      const project = f.admin.add({ path: f.root, name: 'read-only-token', access: 'full' }).project;
      const p = principalWith(f.store, project.workspaceId, ['dodo:read']);
      // The OAuth token remains the ceiling: 'full' cannot add authority.
      expect(projectAuthority(f.store, p, project.workspaceId).scopes).toEqual(['dodo:read']);
    } finally { f.db.close(); }
  });

  it('applies the level in managed mode too, on top of the per-client ACL', () => {
    const f = fixture();
    try {
      setAccessMode(f.store, 'managed');
      const project = f.admin.add({ path: f.root, name: 'managed-project', access: 'edit' }).project;
      const p = principalWith(f.store, project.workspaceId, ['dodo:read', 'dodo:write', 'dodo:exec']);

      // Managed mode still requires the explicit ACL row...
      expect(projectAuthority(f.store, p, project.workspaceId).scopes).toEqual([]);

      // ...and once granted, the project level narrows it further, never wider.
      f.store.setClientAccess(project.workspaceId, p.clientId, ['dodo:read', 'dodo:write', 'dodo:exec']);
      expect(projectAuthority(f.store, p, project.workspaceId).scopes).toEqual(['dodo:read', 'dodo:write']);
    } finally { f.db.close(); }
  });

  it('does not narrow workspaces that are not registered projects', () => {
    const f = fixture();
    try {
      // The launcher root and stdio cwd workspaces have no registry row; the
      // policy must leave them exactly as they were.
      expect(projectScopeCeiling(f.store, 'ws_not_a_registered_one')).toEqual(['dodo:read', 'dodo:write', 'dodo:exec']);
    } finally { f.db.close(); }
  });

  it('treats an unrecognised stored level as the least authority', () => {
    const f = fixture();
    try {
      const project = f.admin.add({ path: f.root, name: 'tampered', access: 'full' }).project;
      f.store.db.prepare('UPDATE project_registry SET access_level = ? WHERE id = ?').run('superuser', project.projectId);
      expect(projectScopeCeiling(f.store, project.workspaceId)).toEqual(['dodo:read']);
      expect(f.admin.get(project.projectId).accessLevel).toBe('read');
    } finally { f.db.close(); }
  });

  it('migrates pre-policy rows to full so an upgrade revokes nothing', () => {
    const f = fixture();
    try {
      const project = f.registry.add(f.root).project; // legacy caller, no level
      expect(project.accessLevel).toBe('full');
    } finally { f.db.close(); }
  });

  it('rejects an invalid level without registering the project', () => {
    const f = fixture();
    try {
      expect(() => f.admin.add({ path: f.root, name: 'bad', access: 'root' as never })).toThrow(/access level/);
      expect(f.admin.list()).toHaveLength(0); // nothing half-registered
    } finally { f.db.close(); }
  });
});

describe('project names address projects', () => {
  it('rejects a duplicate name case-insensitively', () => {
    const f = fixture();
    const second = path.join(f.base, 'second');
    fs.mkdirSync(second);
    try {
      f.admin.add({ path: f.root, name: 'Auto-Upload', access: 'edit' });
      expect(() => f.admin.add({ path: second, name: 'auto-upload', access: 'edit' })).toThrow(/already named/);
      expect(f.admin.list()).toHaveLength(1);
    } finally { f.db.close(); }
  });

  it('resolves a name to one project and reports ambiguity instead of guessing', () => {
    const f = fixture();
    const second = path.join(f.base, 'second');
    fs.mkdirSync(second);
    try {
      const a = f.admin.add({ path: f.root, name: 'auto-upload', access: 'edit' }).project;
      expect(f.admin.resolve('auto-upload').projectId).toBe(a.projectId);
      expect(f.admin.resolve('  AUTO-UPLOAD  ').projectId).toBe(a.projectId); // trimmed, case-insensitive
      expect(f.admin.resolve(a.projectId).projectId).toBe(a.projectId);

      // A legacy duplicate (written before uniqueness was enforced) must fail
      // closed at resolve time rather than route an edit to the wrong repo.
      f.admin.add({ path: second, name: 'other', access: 'edit' });
      f.store.db.prepare("UPDATE project_registry SET display_name='auto-upload' WHERE canonical_root=?").run(fs.realpathSync.native(second));
      expect(() => f.admin.resolve('auto-upload')).toThrow(/matches 2 registered projects/);
    } finally { f.db.close(); }
  });

  it('reports a clear error for an unknown name', () => {
    const f = fixture();
    try {
      expect(() => f.admin.resolve('nope')).toThrow(/no registered project named/);
    } finally { f.db.close(); }
  });
});
