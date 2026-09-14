import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { bootstrapWorkspace } from '../../src/server/bootstrap.js';
import { startLocalConfig, type LocalConfigInfo } from '../../src/server/localConfig.js';
import { addStaticClient } from '../../src/auth/clients.js';
import { mkTmpDir, rawHttp, type TestContext } from '../helpers/testServer.js';

async function setup(runMode?: 'allow-all' | 'bypass', info: LocalConfigInfo = {}) {
  const old = process.env['DODO_CONFIG_DIR'];
  process.env['DODO_CONFIG_DIR'] = mkTmpDir('dodo-admin-cfg-');
  const ws = bootstrapWorkspace({ invokedCwd: mkTmpDir('dodo-admin-root-'), log: () => {}, ...(runMode ? { runMode } : {}) });
  if (old === undefined) delete process.env['DODO_CONFIG_DIR']; else process.env['DODO_CONFIG_DIR'] = old;
  const admin = await startLocalConfig(ws, 0, info);
  const url = new URL(admin.url);
  const token = url.hash.slice(1);
  return { ws, admin, url, token, close: async () => { await admin.close(); await ws.shutdownServices(); } };
}

describe('local config boundary', () => {
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
      const js = await fetch(`${s.url.origin}/assets/app.js`);
      expect(js.status).toBe(200);
      expect(js.headers.get('content-type')).toContain('javascript');
      expect(await js.text()).not.toContain('innerHTML');
      expect((await fetch(`${s.url.origin}/assets/app.css`)).status).toBe(200);
      expect((await fetch(`${s.url.origin}/assets/nope.js`)).status).toBe(404);
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

  it('stores a submitted Tunnel token only through the OS credential boundary and never echoes or persists it', async () => {
    let stored = '';
    let removed = false;
    const ref = { provider: 'os' as const, key: 'a'.repeat(24) };
    const s = await setup(undefined, {
      tunnelCredentials: {
        availability: () => ({ available: true, provider: 'fixture credential store' }),
        ref: () => ref,
        store: async (_ref, token) => { stored = token; },
        remove: () => { removed = true; stored = ''; },
      },
    });
    const submitted = 'fixture-cloudflare-tunnel-token-1234567890';
    try {
      const context = { 'x-dodo-workspace': s.ws.workspaceId, 'x-dodo-epoch': s.ws.epoch, 'content-type': 'application/json' };
      const unauthenticated = await fetch(`${s.url.origin}/api/tunnel/config`, { method: 'POST', headers: context, body: JSON.stringify({ mode: 'managed', token: submitted }) });
      expect(unauthenticated.status).toBe(401);
      expect(stored).toBe('');

      const saved = await fetch(`${s.url.origin}/api/tunnel/config`, {
        method: 'POST',
        headers: { ...context, authorization: `Bearer ${s.token}` },
        body: JSON.stringify({ mode: 'managed', token: submitted, metricsPort: 32174, maxRestarts: 1 }),
      });
      expect(saved.status).toBe(200);
      const responseText = await saved.text();
      expect(responseText).not.toContain(submitted);
      expect(JSON.parse(responseText)).toMatchObject({ ok: true, mode: 'managed', credentialConfigured: true, credentialProvider: 'os', started: false });
      expect(stored).toBe(submitted);
      expect(fs.readFileSync(s.ws.paths.configFile, 'utf8')).not.toContain(submitted);
      expect(JSON.stringify(s.ws.store.recentAudit(s.ws.workspaceId, 20))).not.toContain(submitted);

      const unconfirmed = await fetch(`${s.url.origin}/api/tunnel/config`, {
        method: 'POST', headers: { ...context, authorization: `Bearer ${s.token}` }, body: JSON.stringify({ removeCredential: true }),
      });
      expect(unconfirmed.status).toBe(400);
      expect(removed).toBe(false);
      const deleted = await fetch(`${s.url.origin}/api/tunnel/config`, {
        method: 'POST', headers: { ...context, authorization: `Bearer ${s.token}` }, body: JSON.stringify({ mode: 'external', removeCredential: true, confirm: 'remove-tunnel-credential' }),
      });
      expect(deleted.status).toBe(200);
      expect(removed).toBe(true);
    } finally { await s.close(); }
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
