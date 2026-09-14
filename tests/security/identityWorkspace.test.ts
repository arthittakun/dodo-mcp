import fs from 'node:fs';
import { describe, it, expect } from 'vitest';
import { launch, obtainToken, mcpRaw, rpc, callToolLegacy, wsArgs, rfetch, type TestContext } from '../helpers/testServer.js';
import { buildTokenVerifier } from '../../src/auth/verifier.js';
import { loadOrCreateJwks } from '../../src/auth/keys.js';
import { statePaths } from '../../src/config/paths.js';
import { ALL_SCOPES } from '../../src/security/policy.js';

function verifier(ctx: TestContext) {
  return buildTokenVerifier({ issuer:ctx.baseUrl,resourceUrl:`${ctx.baseUrl}/mcp`,workspaceId:ctx.server.workspaceId,store:ctx.server.services.store,jwks:loadOrCreateJwks(statePaths(ctx.configDir).jwksFile) });
}

describe('installation identity with explicit workspace access', () => {
  it('completes installation login without granting the selected workspace', async () => {
    const ctx = await launch({ toolSurface: 'compact' });
    try {
      const token = await obtainToken(ctx, { grantWorkspaceAccess: false });
      expect(ctx.server.services.store.clientAccess(ctx.server.workspaceId, token.clientId)).toEqual([]);
      expect((await verifier(ctx).verifyAccessToken(token.accessToken)).scopes).toEqual([]);
      expect((await mcpRaw(ctx, rpc('tools/list'), token.accessToken)).status).toBe(200);
      const denied = await callToolLegacy(ctx, token.accessToken, 'project_overview', {});
      expect((denied.envelope.error as { code: string }).code).toBe('WORKSPACE_ACCESS_REQUIRED');
      ctx.server.services.store.setClientAccess(ctx.server.workspaceId, token.clientId, ['dodo:read']);
      expect((await callToolLegacy(ctx, token.accessToken, 'project_overview', {})).envelope.ok).toBe(true);
    } finally { await ctx.cleanup(); }
  });

  it('allows OAuth and an authenticated catalog before any project is selected', async () => {
    const ctx = await launch({ toolSurface: 'compact', deferWorkspace: true });
    try {
      expect(ctx.server.workspaceSelected).toBe(false);
      const token = await obtainToken(ctx, { grantWorkspaceAccess: false });
      const listed = await mcpRaw(ctx, rpc('tools/list'), token.accessToken);
      expect(listed.status).toBe(200);
      const body = await listed.text();
      expect(body).toContain('dodo_discover');
      expect(body).not.toContain('launcher-workspace');
      const denied = await callToolLegacy(ctx, token.accessToken, 'project_overview', {});
      expect((denied.envelope.error as { code: string }).code).toBe('WORKSPACE_ACCESS_REQUIRED');
      expect(JSON.stringify(denied.envelope)).not.toContain('launcher-workspace');
    } finally { await ctx.cleanup(); }
  });

  it('reuses login only after local path consent; rejects old context and revoked access', async () => {
    const a = await launch({ toolSurface: 'full', fixtureFiles:{'a.txt':'A'}});
    const t = await obtainToken(a);
    const other = await obtainToken(a);
    const aWs = wsArgs(a);
    await a.cleanup();
    const b = await launch({ toolSurface: 'full', configDir:a.configDir,port:a.port,fixtureFiles:{'b.txt':'B'}});
    try {
      const v = verifier(b);
      expect((await v.verifyAccessToken(t.accessToken)).scopes).toEqual([]);
      expect(((await callToolLegacy(b,t.accessToken,'project_overview',{})).envelope.error as {code:string}).code).toBe('WORKSPACE_ACCESS_REQUIRED');
      b.server.services.store.setClientAccess(b.server.workspaceId,t.clientId,['dodo:read']);
      expect((await v.verifyAccessToken(t.accessToken)).scopes).toEqual(['dodo:read']);
      expect((await v.verifyAccessToken(other.accessToken)).scopes).toEqual([]);
      expect(((await callToolLegacy(b,other.accessToken,'project_overview',{})).envelope.error as {code:string}).code).toBe('WORKSPACE_ACCESS_REQUIRED');
      const overview = await callToolLegacy(b,t.accessToken,'project_overview',{});
      expect(overview.envelope.ok).toBe(true);
      const stale = await callToolLegacy(b,t.accessToken,'list_files',{...aWs,path:'.'});
      expect((stale.envelope.error as {code:string}).code).toBe('WORKSPACE_MISMATCH');
      const fresh = await callToolLegacy(b,t.accessToken,'list_files',{...wsArgs(b),path:'.'});
      expect(fresh.envelope.ok).toBe(true);
      const write = await callToolLegacy(b,t.accessToken,'write_file',{...wsArgs(b),path:'x',content:'no'});
      expect((write.envelope.error as {code:string}).code).toBe('FORBIDDEN');
      b.server.services.store.setClientAccess(b.server.workspaceId,t.clientId,[]);
      expect((await v.verifyAccessToken(t.accessToken)).scopes).toEqual([]);
      expect(((await callToolLegacy(b,t.accessToken,'project_overview',{})).envelope.error as {code:string}).code).toBe('WORKSPACE_ACCESS_REQUIRED');
      b.server.services.store.setClientAccess(b.server.workspaceId,t.clientId,ALL_SCOPES);
      // Tokens lacking a matching v2 grant marker stay workspace-bound.
      b.server.services.store.setMeta(`identity-grant:${t.grantId}`,'1');
      await expect(v.verifyAccessToken(t.accessToken)).rejects.toThrow('not valid for this workspace');
      b.server.services.store.setMeta(`identity-grant:${t.grantId}`,'2');
      b.server.services.store.revokeGrant(t.grantId);
      await expect(v.verifyAccessToken(t.accessToken)).rejects.toThrow('revoked');
    } finally { await b.cleanup(); }
  });

  it('refresh retains installation identity after switching paths, without bypassing path consent', async () => {
    const a = await launch({ toolSurface: 'full' });
    const t = await obtainToken(a);
    await a.cleanup();
    const b = await launch({ toolSurface: 'full', configDir:a.configDir,port:a.port});
    try {
      const response = await rfetch(`${b.baseUrl}/token`,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',authorization:`Basic ${Buffer.from(`${t.clientId}:${t.clientSecret}`).toString('base64')}`},body:new URLSearchParams({grant_type:'refresh_token',refresh_token:t.refreshToken!,resource:`${b.baseUrl}/mcp`})});
      expect(response.status).toBe(200);
      const tokens = await response.json() as {access_token:string};
      expect((await verifier(b).verifyAccessToken(tokens.access_token)).scopes).toEqual([]);
      expect(((await callToolLegacy(b,tokens.access_token,'project_overview',{})).envelope.error as {code:string}).code).toBe('WORKSPACE_ACCESS_REQUIRED');
      b.server.services.store.setClientAccess(b.server.workspaceId,t.clientId,['dodo:read']);
      expect((await mcpRaw(b,rpc('tools/list'),tokens.access_token)).status).toBe(200);
    } finally {await b.cleanup();}
  });

  it('replacing the directory at the same path resets saved trust and ACL', async () => {
    const a = await launch({ toolSurface: 'full', trust:'trusted'});
    const t = await obtainToken(a);
    await a.cleanup();
    fs.renameSync(a.fixtureDir, a.fixtureDir + '-old');
    fs.mkdirSync(a.fixtureDir);
    const b = await launch({ toolSurface: 'full', configDir:a.configDir,fixtureDir:a.fixtureDir,port:a.port});
    try {
      expect(b.server.services.trustMode()).toBe('inspect');
      expect(b.server.services.store.clientAccess(b.server.workspaceId,t.clientId)).toEqual([]);
      expect((await verifier(b).verifyAccessToken(t.accessToken)).scopes).toEqual([]);
      expect(((await callToolLegacy(b,t.accessToken,'project_overview',{})).envelope.error as {code:string}).code).toBe('WORKSPACE_ACCESS_REQUIRED');
    } finally {await b.cleanup();}
  });

  it('does not reconcile another workspace journal when a new root starts', async () => {
    const a = await launch({ toolSurface: 'full' });
    const store = a.server.services.store;
    store.createChangeset({id:'other-workspace-change',workspaceId:a.server.workspaceId,epoch:'old',planId:null,principal:'test',kind:'apply',summary:'pending'});
    store.setChangesetStatus('other-workspace-change','committing');
    await a.cleanup();
    const b = await launch({ toolSurface: 'full', configDir:a.configDir,port:a.port});
    try {
      expect(b.server.services.store.listChangesetsByStatus('committing').map(c=>c.id)).toContain('other-workspace-change');
      expect(b.server.services.applier.recoveryBlocked()).toBeUndefined();
    } finally {await b.cleanup();}
  });
});
