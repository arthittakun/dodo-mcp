import { describe,it,expect } from 'vitest';
import { launch,obtainToken,mcpRaw,rpc,type TestContext,type TokenSet } from '../helpers/testServer.js';
import { addStaticClient } from '../../src/auth/clients.js';

type Review = {id:string;name:string|null;workspaceCount:number;grantCount:number;reviewHash:string};
function owner(c:TestContext) {
  const u=new URL(c.configUrl!);
  const headers={authorization:`Bearer ${u.hash.slice(1)}`,'x-dodo-workspace':c.server.workspaceId,'x-dodo-epoch':c.server.epoch};
  return {
    headers,origin:u.origin,
    list:async()=> await (await fetch(`${u.origin}/api/clients/manage`,{headers})).json() as {clients:Review[]},
    del:(clients:Review[],extra:Record<string,string>={},confirm='delete-selected-clients')=>fetch(`${u.origin}/api/clients/delete`,{method:'POST',headers:{...headers,'content-type':'application/json',...extra},body:JSON.stringify({clients:clients.map(({id,reviewHash})=>({id,reviewHash})),confirm})}),
  };
}
function refresh(c:TestContext,t:TokenSet) {
  return fetch(`${c.baseUrl}/token`,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',authorization:`Basic ${Buffer.from(`${t.clientId}:${t.clientSecret}`).toString('base64')}`},body:new URLSearchParams({grant_type:'refresh_token',refresh_token:t.refreshToken!,resource:`${c.baseUrl}/mcp`})});
}

describe('owner client deletion',()=>{
  it('revokes selected access/refresh credentials across roots and pending approvals while retaining other clients and history',async()=>{
    const c=await launch({configPort:0});
    try {
      const a=await obtainToken(c),b=await obtainToken(c),s=c.server.services.store,o=owner(c);
      s.setClientAccess('other-root',a.clientId,['dodo:read']);
      s.setClientAccess('other-root',b.clientId,['dodo:read']);
      s.createApproval({id:'pending-deleted-client',kind:'oauth',summary:JSON.stringify({clientId:a.clientId}),ttlMs:60_000});
      const review=(await o.list()).clients.find(x=>x.id===a.clientId)!;
      expect(review).toMatchObject({workspaceCount:2,grantCount:1});
      expect(JSON.stringify(await o.list())).not.toContain(a.clientSecret);
      expect((await o.del([review])).status).toBe(200);
      expect(s.getOAuthClient(a.clientId)).toBeUndefined();
      expect(s.getGrant(a.grantId)?.revokedAt).not.toBeNull();
      expect(s.clientAccess('other-root',a.clientId)).toEqual([]);
      expect(s.getApproval('pending-deleted-client')?.status).toBe('denied');
      expect((await mcpRaw(c,rpc('tools/list'),a.accessToken)).status).toBe(401);
      expect((await refresh(c,a)).status).toBe(401); // registration is gone
      expect((await mcpRaw(c,rpc('tools/list'),b.accessToken)).status).toBe(200);
      expect((await refresh(c,b)).status).toBe(200);
      expect(s.clientAccess('other-root',b.clientId)).toEqual(['dodo:read']);
      expect(s.db.prepare('SELECT count(*) AS n FROM oauth_models WHERE grant_id=?').get(a.grantId)).toEqual({n:0});
      expect(s.db.prepare("SELECT ref_id FROM audit_events WHERE tool='local.client.delete'").all()).toEqual([{ref_id:a.clientId}]);
      expect((await o.list()).clients.map(x=>x.id)).toEqual([b.clientId]);
    } finally {await c.cleanup();}
  });
  it('requires private capability, local origin, exact confirmation and fresh workspace/review; rejects stale batch without partial deletion',async()=>{
    const c=await launch({configPort:0});
    try {
      const s=c.server.services.store,o=owner(c);
      const a=addStaticClient(s,{redirectUris:['https://example.com/a']}),b=addStaticClient(s,{redirectUris:['https://example.com/b']});
      const rows=(await o.list()).clients;
      expect((await fetch(`${o.origin}/api/clients/manage`)).status).toBe(401);
      expect((await fetch(`${o.origin}/api/clients/manage`,{headers:{...o.headers,'x-dodo-epoch':'old'}})).status).toBe(409);
      expect((await o.del(rows,{authorization:''})).status).toBe(401);
      expect((await o.del(rows,{origin:'https://evil.example'})).status).toBe(403);
      expect((await o.del(rows,{'x-forwarded-host':'evil.example'})).status).toBe(403);
      expect((await o.del(rows,{'x-dodo-epoch':'old'})).status).toBe(409);
      expect((await o.del(rows,{},'yes')).status).toBe(400);
      expect((await o.del([])).status).toBe(400);
      expect((await o.del([rows[0]!,rows[0]!])).status).toBe(409);
      s.setClientAccess(c.server.workspaceId,b.clientId,['dodo:read']);
      expect((await o.del(rows)).status).toBe(409);
      expect(s.getOAuthClient(a.clientId)).toBeDefined();expect(s.getOAuthClient(b.clientId)).toBeDefined();
      expect((await fetch(`${c.baseUrl}/api/clients/delete`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status).toBe(404);
      // A new registration after review is not swept into a clear-selection request.
      const fresh=(await o.list()).clients;
      const later=addStaticClient(s,{redirectUris:['https://example.com/later']});
      expect((await o.del(fresh)).status).toBe(200);
      expect((await o.list()).clients.map(x=>x.id)).toEqual([later.clientId]);
    } finally {await c.cleanup();}
  });
  it('rolls back every selected deletion on storage failure and can safely retry the reviewed selection',async()=>{
    const c=await launch({configPort:0});
    try {
      const a=await obtainToken(c),b=await obtainToken(c),s=c.server.services.store,o=owner(c);
      const rows=(await o.list()).clients;
      // SQL target is a generated hex-only client id; quote defensively anyway.
      const id=b.clientId.replaceAll("'","''");
      s.db.exec(`CREATE TRIGGER fail_client_delete BEFORE DELETE ON oauth_clients WHEN OLD.client_id='${id}' BEGIN SELECT RAISE(ABORT,'injected fixture'); END;`);
      expect((await o.del(rows)).status).toBe(500);
      expect((await mcpRaw(c,rpc('tools/list'),a.accessToken)).status).toBe(200);
      expect(s.getGrant(a.grantId)?.revokedAt).toBeNull();
      expect(s.getOAuthClient(b.clientId)).toBeDefined();
      expect(s.db.prepare("SELECT count(*) AS n FROM audit_events WHERE tool='local.client.delete'").get()).toEqual({n:0});
      s.db.exec('DROP TRIGGER fail_client_delete');
      expect((await o.del(rows)).status).toBe(200);
      expect((await o.list()).clients).toEqual([]);
      expect((await o.del(rows)).status).toBe(409);
      expect((await mcpRaw(c,rpc('tools/list'),a.accessToken)).status).toBe(401);
    } finally {await c.cleanup();}
  });
});
