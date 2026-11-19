import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addStaticClient } from '../../src/auth/clients.js';
import { setAccessMode } from '../../src/security/accessMode.js';
import { installationAuthority, projectAuthority } from '../../src/security/projectAuthority.js';
import { liveAccess } from '../../src/services/multimodal/storage.js';
import { openDatabase } from '../../src/store/db.js';
import { Store } from '../../src/store/store.js';
import type { AppServices, Principal, ToolCtx } from '../../src/tools/context.js';

const GLOBAL = 'ws_00000000000000000001';
const PROJECT = 'ws_00000000000000000002';
const SCOPES = ['dodo:read', 'dodo:write', 'dodo:exec'];
let store: Store, principal: Principal;

beforeEach(() => {
  store = new Store(openDatabase(':memory:'));
  setAccessMode(store, 'managed');
  store.setMeta('installation-workspace-id', GLOBAL);
  const client = addStaticClient(store, { name: 'Global media fixture', redirectUris: ['https://example.com/cb'] });
  store.putGrant({ id: 'grant_global_fixture', workspaceId: PROJECT, clientId: client.clientId, accountId: 'owner', scopes: SCOPES });
  store.setMeta('identity-grant:grant_global_fixture', '2');
  principal = { grantId: 'grant_global_fixture', clientId: client.clientId, sub: 'owner', scopes: [...SCOPES], tokenScopes: [...SCOPES], identityGrant: true };
});
afterEach(() => store.db.close());

describe('installation tool authorization', () => {
  it('uses the installation login without a project ACL while project calls retain their ACL', () => {
    expect(projectAuthority(store, principal, GLOBAL).scopes).toEqual(SCOPES);
    expect(projectAuthority(store, principal, PROJECT).scopes).toEqual([]);
    expect(projectAuthority(store, principal, 'ws_00000000000000000003').scopes).toEqual([]);
  });

  it('intersects the token ceiling with live grant scopes and rechecks media access', () => {
    const narrowed = { ...principal, tokenScopes: ['dodo:read'] };
    expect(installationAuthority(store, narrowed).scopes).toEqual(['dodo:read']);
    store.putGrant({ id: principal.grantId, workspaceId: PROJECT, clientId: principal.clientId, accountId: 'owner', scopes: ['dodo:read'] });
    expect(installationAuthority(store, principal).scopes).toEqual(['dodo:read']);
    const ctx: ToolCtx = { services: { store, installationScoped: true } as AppServices, principal, trustMode: 'trusted' };
    expect(() => liveAccess(ctx, 'dodo:read')).not.toThrow();
    expect(() => liveAccess(ctx, 'dodo:exec')).toThrow(/authorization no longer permits/);
  });

  it('stops media access as soon as its grant is revoked', () => {
    const ctx: ToolCtx = { services: { store, installationScoped: true } as AppServices, principal, trustMode: 'trusted' };
    expect(() => liveAccess(ctx, 'dodo:exec')).not.toThrow();
    store.revokeGrant(principal.grantId);
    expect(() => projectAuthority(store, principal, GLOBAL)).toThrow(/revoked/);
    expect(() => liveAccess(ctx, 'dodo:exec')).toThrow(/revoked/);
  });

  it('requires a live matching registered client', () => {
    expect(() => installationAuthority(store, { ...principal, clientId: 'wrong-client' })).toThrow(/revoked/);
    store.db.prepare('DELETE FROM oauth_clients WHERE client_id=?').run(principal.clientId);
    expect(() => installationAuthority(store, principal)).toThrow(/revoked/);
  });

  it('rejects expired tokens and all project-restricted delegations', () => {
    expect(() => installationAuthority(store, { ...principal, expiresAt: Date.now() / 1000 - 1 })).toThrow(/expired/);
    expect(() => installationAuthority(store, { ...principal, projectRestriction: PROJECT })).toThrow(/project-restricted/);
    expect(() => installationAuthority(store, { ...principal, projectRestriction: GLOBAL })).toThrow(/project-restricted/);
  });

  it('requires reconnection for legacy workspace-bound logins', () => {
    expect(() => installationAuthority(store, { ...principal, identityGrant: false })).toThrow(/reconnect/);
    store.db.prepare('DELETE FROM meta WHERE key=?').run(`identity-grant:${principal.grantId}`);
    expect(() => installationAuthority(store, principal)).toThrow(/reconnect/);
  });
});
