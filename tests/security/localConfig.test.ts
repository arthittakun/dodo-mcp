import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { bootstrapWorkspace } from '../../src/server/bootstrap.js';
import { startLocalConfig, type LocalConfigInfo } from '../../src/server/localConfig.js';
import { addStaticClient } from '../../src/auth/clients.js';
import { mkTmpDir, rawHttp, type TestContext } from '../helpers/testServer.js';
import { GlobalConfigSchema, saveGlobalConfig } from '../../src/config/globalConfig.js';
import { createHash } from 'node:crypto';

async function setup(runMode?: 'allow-all' | 'bypass', info: LocalConfigInfo = {}) {
  const old = process.env['DODO_CONFIG_DIR'];
  const configDir = mkTmpDir('dodo-admin-cfg-');
  process.env['DODO_CONFIG_DIR'] = configDir;
  saveGlobalConfig(path.join(configDir, 'config.json'), GlobalConfigSchema.parse({ accessMode: 'managed' }));
  const ws = bootstrapWorkspace({ invokedCwd: mkTmpDir('dodo-admin-root-'), log: () => {}, ...(runMode ? { runMode } : {}) });
  if (old === undefined) delete process.env['DODO_CONFIG_DIR']; else process.env['DODO_CONFIG_DIR'] = old;
  const admin = await startLocalConfig(ws, 0, info);
  const url = new URL(admin.url);
  const token = url.hash.slice(1);
  return { ws, admin, url, token, close: async () => { await admin.close(); await ws.shutdownServices(); } };
}

describe('local config boundary', () => {
  it('keeps bridge capabilities separate, bounded and revocable without renewing local access', async () => {
    const s = await setup();
    const time = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    try {
      const expiry = Date.now() + 1000;
      const remote = s.admin.createRemoteSession(expiry);
      expect(remote.capability).not.toBe(s.token);
      expect(() => s.admin.createRemoteSession(Date.now() + 3_600_001)).toThrow(/one hour/);
      const get = (capability: string, extra: Record<string, string> = {}) => fetch(`${s.url.origin}/api/state`, { headers: { authorization: `Bearer ${capability}`, ...extra } });
      const initial = await get(remote.capability);
      expect(initial.status).toBe(200);
      expect((await initial.json() as { connection: { expiresAt: number } }).connection.expiresAt).toBe(expiry);
      for (const header of ['forwarded', 'x-forwarded-for', 'cf-connecting-ip']) {
        expect((await get(remote.capability, { [header]: '127.0.0.1' })).status).toBe(403);
      }
      expect((await get(remote.capability, { origin: 'https://foreign.example' })).status).toBe(403);
      remote.revoke();
      expect(() => remote.assertActive()).toThrow(/expired or closed/);
      expect((await get(remote.capability)).status).toBe(401);
      expect((await get(s.token)).status).toBe(200);
      const next = s.admin.createRemoteSession(expiry);
      time.mockReturnValue(expiry);
      expect((await get(next.capability)).status).toBe(401);
      expect((await get(s.token)).status).toBe(200);
    } finally { time.mockRestore(); await s.close(); }
  });
  it('requires a private token, rejects foreign origins/hosts and proxy headers even with the token', async () => {
    const s = await setup();
    try {
      const port = Number(s.url.port);
      const request = (headers: Record<string,string> = {}, host = `127.0.0.1:${port}`) => rawHttp({port} as TestContext, {method:'GET',path:'/api/state',host,headers});
      expect((await request()).status).toBe(401);
      const headers = { authorization: `Bearer ${s.token}` };
      const valid = await request(headers);
      expect(valid.status).toBe(200);
      expect(JSON.parse(valid.body).workspace.root).toBe(s.ws.rootInfo.root);
      expect(valid.body).not.toContain(s.token);
      expect((await request({...headers, origin:'https://evil.example'})).status).toBe(403);
      expect((await request(headers,'evil.example')).status).toBe(403);
      for (const name of ['forwarded','x-forwarded-for','x-forwarded-host','cf-connecting-ip']) {
        expect((await request({...headers,[name]:'127.0.0.1'})).status).toBe(403);
      }
      expect((await request({...headers,'sec-fetch-site':'cross-site'})).status).toBe(403);
    } finally { await s.close(); }
  });

  it('changes only current-root client scopes and validates configuration', async () => {
    const s = await setup();
    try {
      const client = addStaticClient(s.ws.store,{redirectUris:['https://example.com/callback']});
      const post = (route: string, body: unknown, auth = true) => fetch(`${s.url.origin}/api/${route}`, {method:'POST', headers:{'x-dodo-workspace':s.ws.workspaceId,'x-dodo-epoch':s.ws.epoch,'content-type':'application/json', ...(auth ? {authorization:`Bearer ${s.token}`} : {})}, body:JSON.stringify(body)});
      expect((await post('access',{clientId:client.clientId,scopes:['dodo:read']},false)).status).toBe(401);
      expect((await post('access',{clientId:client.clientId,scopes:['dodo:read']})).status).toBe(200);
      expect(s.ws.store.clientAccess(s.ws.workspaceId,client.clientId)).toEqual(['dodo:read']);
      expect(s.ws.store.clientAccess('other-root',client.clientId)).toEqual([]);
      expect((await post('access',{clientId:client.clientId,scopes:['admin']})).status).toBe(400);
      expect((await post('access',{clientId:client.clientId,scopes:[],workspaceId:'other'})).status).toBe(400);
      expect((await post('config',{publicUrl:'http://evil.example'})).status).toBe(400);
      expect((await post('config',{mode:'trusted'})).status).toBe(200);
      expect(s.ws.services.trustMode()).toBe('trusted');
      expect((await post('access',{clientId:client.clientId,scopes:[]})).status).toBe(200);
      expect(s.ws.store.clientAccess(s.ws.workspaceId,client.clientId)).toEqual([]);
      // Occupied port must fail; the first listener remains usable.
      await expect(startLocalConfig(s.ws,Number(s.url.port))).rejects.toMatchObject({code:'EADDRINUSE'});
      expect((await fetch(`${s.url.origin}/api/state`,{headers:{authorization:`Bearer ${s.token}`}})).status).toBe(200);
    } finally { await s.close(); }
  });

  it('lists only active clients of this root, not unrelated, revoked or malformed ACLs', async () => {
    const s = await setup();
    try {
      const register = () => addStaticClient(s.ws.store,{name:'ChatGPT',redirectUris:['https://example.com/callback']});
      const current=register(), other=register(), revoked=register(), malformed=register();
      s.ws.store.setClientAccess(s.ws.workspaceId,current.clientId,['dodo:read']);
      s.ws.store.setClientAccess('other-root',other.clientId,['dodo:read','dodo:write']);
      s.ws.store.setClientAccess(s.ws.workspaceId,revoked.clientId,[]);
      s.ws.store.db.prepare('INSERT INTO workspace_clients VALUES (?,?,?)').run(s.ws.workspaceId,malformed.clientId,'not-json');
      const response=await fetch(`${s.url.origin}/api/state`,{headers:{authorization:`Bearer ${s.token}`}});
      const text=await response.text(), state=JSON.parse(text);
      expect(state.clients).toEqual([{id:current.clientId,name:'ChatGPT',public:false,scopes:['dodo:read']}]);
      for(const client of [other,revoked,malformed])expect(text).not.toContain(client.clientId);
      for(const client of [current,other,revoked,malformed])expect(text).not.toContain(client.clientSecret!);
      expect(s.ws.store.listOAuthClients()).toHaveLength(4);
      expect(s.ws.store.clientAccess('other-root',other.clientId)).toEqual(['dodo:read','dodo:write']);
    } finally { await s.close(); }
  });

  it('loads an owner-only picker on demand and adds/revokes only the reviewed root without stale overwrites', async () => {
    const s = await setup();
    try {
      const client=addStaticClient(s.ws.store,{name:'Existing ChatGPT',redirectUris:['https://example.com/callback']});
      s.ws.store.setClientAccess('other-root',client.clientId,['dodo:read','dodo:write']);
      const headers={authorization:`Bearer ${s.token}`,'x-dodo-workspace':s.ws.workspaceId,'x-dodo-epoch':s.ws.epoch};
      const available=(extra:Record<string,string>={})=>fetch(`${s.url.origin}/api/access/available`,{headers:{...headers,...extra}});
      expect((await fetch(`${s.url.origin}/api/access/available`)).status).toBe(401);
      expect((await available({origin:'https://evil.example'})).status).toBe(403);
      expect((await available({'x-forwarded-host':'evil.example'})).status).toBe(403);
      expect((await available({'x-dodo-epoch':'stale'})).status).toBe(409);
      const result=await (await available()).json();
      expect(result).toEqual({workspaceId:s.ws.workspaceId,workspaceEpoch:s.ws.epoch,clients:[{id:client.clientId,name:'Existing ChatGPT',public:false}]});
      expect(JSON.stringify(result)).not.toContain(client.clientSecret!);
      expect(JSON.stringify(result)).not.toContain('other-root');
      const post=(scopes:string[],context=headers)=>fetch(`${s.url.origin}/api/access`,{method:'POST',headers:{...context,'content-type':'application/json'},body:JSON.stringify({clientId:client.clientId,scopes,addOnly:true})});
      expect((await post(['dodo:read'],{...headers,'x-dodo-workspace':'other-root'})).status).toBe(409);
      expect((await post(['dodo:read'])).status).toBe(200);
      expect((await (await available()).json() as {clients:unknown[]}).clients).toEqual([]);
      expect((await post(['dodo:exec'])).status).toBe(409); // another tab added it already
      expect(s.ws.store.clientAccess(s.ws.workspaceId,client.clientId)).toEqual(['dodo:read']);
      expect((await fetch(`${s.url.origin}/api/access`,{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({clientId:client.clientId,scopes:[]})})).status).toBe(200);
      expect((await (await fetch(`${s.url.origin}/api/state`,{headers})).json() as {clients:unknown[]}).clients).toEqual([]);
      expect((await (await available()).json() as {clients:unknown[]}).clients).toHaveLength(1);
      expect(s.ws.store.clientAccess('other-root',client.clientId)).toEqual(['dodo:read','dodo:write']);
      expect(s.ws.store.getOAuthClient(client.clientId)).toBeDefined();
    } finally { await s.close(); }
  });

  it('serves the packaged UI with a self-only CSP (no inline code), never echoes the token, and refuses switching for a single-workspace entry', async () => {
    const s = await setup();
    try {
      const page = await fetch(`${s.url.origin}/`);
      expect(page.status).toBe(200);
      const csp = page.headers.get('content-security-policy') ?? '';
      expect(csp).toContain("script-src 'self'");
      expect(csp).not.toContain('unsafe-inline');
      const html = await page.text();
      expect(html).toContain('/assets/app.js');
      expect(html).not.toMatch(/<script>[^<]/); // no inline script blocks
      expect(html).not.toMatch(/ on[a-z]+=/); // no inline handlers
      expect(html).not.toContain(s.token);
      // Same-origin only: no CDN in the CSP and no absolute script/style URLs in the page.
      expect(csp).not.toMatch(/https?:\/\//);
      expect(html).not.toMatch(/(?:src|href)="https?:/);
      // First-party scripts render untrusted values via textContent, never innerHTML.
      for (const name of ['app.js', 'workbench.js', 'ui/dom.js', 'ui/tooltips.js', 'ui/alerts.js']) {
        const js = await fetch(`${s.url.origin}/assets/${name}`);
        expect(js.status, name).toBe(200);
        expect(js.headers.get('content-type'), name).toContain('javascript');
        expect(await js.text(), name).not.toContain('innerHTML');
      }
      // Vendored SweetAlert2 ships from the same origin with the pinned bytes.
      expect((await fetch(`${s.url.origin}/assets/vendor/sweetalert2.min.js`)).status).toBe(200);
      const vendorCss = await fetch(`${s.url.origin}/assets/vendor/sweetalert2.min.css`);
      expect(vendorCss.status).toBe(200);
      expect(vendorCss.headers.get('content-type')).toContain('text/css');
      expect((await fetch(`${s.url.origin}/assets/app.css`)).status).toBe(200);
      expect((await fetch(`${s.url.origin}/assets/nope.js`)).status).toBe(404);
      // Traversal, deep paths and non-allowlisted extensions are fail-closed 404s
      // (rawHttp bypasses fetch's client-side path normalization).
      const port = Number(s.url.port);
      for (const evil of [
        '/assets/../package.json',
        '/assets/%2e%2e/package.json',
        '/assets/vendor/../../package.json',
        '/assets/vendor/../app.js/../../package.json',
        '/assets/ui/nested/too/deep.js',
        '/assets/vendor/VERSION.txt',
        '/assets/app.js%00.css',
      ]) {
        const res = await rawHttp({ port } as TestContext, { method: 'GET', path: evil, host: `127.0.0.1:${port}` });
        expect(res.status, evil).toBe(404);
      }
      const st = await (await fetch(`${s.url.origin}/api/state`, { headers: { authorization: `Bearer ${s.token}` } })).json() as { workspace: { switchSupported: boolean }; connection: { mcpLocalUrl: string | null } };
      expect(st.workspace.switchSupported).toBe(false);
      expect(st.connection.mcpLocalUrl).toBeNull();
      expect(JSON.stringify(st)).not.toContain(s.token);
      const sw = await fetch(`${s.url.origin}/api/workspace/switch`, { method: 'POST', headers: { 'x-dodo-workspace':s.ws.workspaceId,'x-dodo-epoch':s.ws.epoch, 'content-type': 'application/json', authorization: `Bearer ${s.token}` }, body: JSON.stringify({ path: mkTmpDir('dodo-admin-other-') }) });
      expect(sw.status).toBe(501);
      expect(((await sw.json()) as { code: string }).code).toBe('NOT_SUPPORTED');
      expect((await fetch(`${s.url.origin}/api/workspace/switch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(401);
    } finally { await s.close(); }
  });

  it('stores a Tunnel token only through the OS boundary and selects exactly one persistent mode', async () => {
    const submitted = 'fixture-cloudflare-tunnel-token-1234567890';
    const expectedDigest = createHash('sha256').update(submitted).digest('hex');
    let storedDigest = '';
    const credentialRef = { provider: 'os' as const, key: 'a'.repeat(24) };
    const s = await setup(undefined, {
      transport: { port: 21730, locked: false, publicUrl: 'http://127.0.0.1:21730', connectionMode: 'local' },
      tunnelCredentialStore: {
        available: true,
        provider: 'fixture credential store',
        store: async (value) => { storedDigest = createHash('sha256').update(value).digest('hex'); return credentialRef; },
      },
    });
    try {
      saveGlobalConfig(s.ws.paths.configFile, GlobalConfigSchema.parse({ ...s.ws.config, publicUrl: 'https://dodo.example.com' }));
      const context = { 'x-dodo-workspace': s.ws.workspaceId, 'x-dodo-epoch': s.ws.epoch, 'content-type': 'application/json' };
      const unauthenticated = await fetch(`${s.url.origin}/api/tunnel/config`, { method: 'POST', headers: context, body: JSON.stringify({ connectionMode: 'local' }) });
      expect(unauthenticated.status).toBe(401);

      const saved = await fetch(`${s.url.origin}/api/tunnel/config`, {
        method: 'POST', headers: { ...context, authorization: `Bearer ${s.token}` },
        body: JSON.stringify({ connectionMode: 'tunnel', token: submitted, metricsPort: 32174, maxRestarts: 1 }),
      });
      const responseText = await saved.text();
      expect(saved.status).toBe(200);
      expect(responseText).not.toContain(submitted);
      expect(JSON.parse(responseText)).toMatchObject({ ok: true, connectionMode: 'tunnel', credentialConfigured: true, credentialStorage: 'os', restartRequired: true });
      expect(storedDigest).toBe(expectedDigest);
      const configText = fs.readFileSync(s.ws.paths.configFile, 'utf8');
      expect(configText).not.toContain(submitted);
      expect(JSON.stringify(s.ws.store.recentAudit(s.ws.workspaceId, 20))).not.toContain(submitted);
      expect(JSON.parse(configText).tunnel).toMatchObject({ connectionMode: 'tunnel', credentialRef, metricsPort: 32174, maxRestarts: 1 });

      const external = await fetch(`${s.url.origin}/api/tunnel/config`, {
        method: 'POST', headers: { ...context, authorization: `Bearer ${s.token}` }, body: JSON.stringify({ connectionMode: 'external' }),
      });
      expect(external.status).toBe(200);
      expect(JSON.parse(fs.readFileSync(s.ws.paths.configFile, 'utf8')).tunnel).toMatchObject({ connectionMode: 'external' });

      const local = await fetch(`${s.url.origin}/api/tunnel/config`, {
        method: 'POST', headers: { ...context, authorization: `Bearer ${s.token}` }, body: JSON.stringify({ connectionMode: 'local' }),
      });
      expect(local.status).toBe(200);
      expect(JSON.parse(fs.readFileSync(s.ws.paths.configFile, 'utf8')).tunnel).toMatchObject({ connectionMode: 'local' });
      expect((await fetch(`${s.url.origin}/api/tunnel/session/start`, { method: 'POST', headers: { ...context, authorization: `Bearer ${s.token}` }, body: '{}' })).status).toBe(404);
    } finally { storedDigest = ''; await s.close(); }
  });

  it.each(['allow-all','bypass'] as const)('%s overrides are temporary and do not authorize remote clients', async runMode => {
    const s = await setup(runMode);
    try {
      expect(s.ws.services.trustMode()).toBe('trusted');
      expect(s.ws.store.trustMode(s.ws.workspaceId)).toBe('inspect');
      expect(s.ws.store.clientAccess(s.ws.workspaceId,'unknown')).toEqual([]);
      expect(s.ws.config.allowWebFetch).toBe(true);
      if (runMode === 'bypass') expect(s.ws.config.commandSandbox).toBe('off');
      expect(() => s.ws.services.wfs.readFileBytes('../escape', 100)).toThrow();
    } finally { await s.close(); }
  });
});
