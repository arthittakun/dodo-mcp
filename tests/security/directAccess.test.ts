import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe,it,expect } from 'vitest';
import { launch,obtainToken,mcpRaw,rpc,parseMcpResponse,wsArgs,mkTmpDir,type TestContext } from '../helpers/testServer.js';
import { ipcCall } from '../../src/ipc/client.js';
import { TOOL_CATALOG } from '../../src/tools/catalog.js';
import { ipcSocketPath } from '../../src/config/paths.js';
const run=promisify(execFile),cli=path.resolve('dist/cli/main.js');
async function call(c:TestContext,token:string,name='project_overview',args:Record<string,unknown>={}) {
  let response:Response;
  for(let attempt=0;;attempt++) {
    try {response=await mcpRaw(c,rpc('tools/call',{name,arguments:args}),token,{connection:'close'});break;}
    catch(error) {
      const code=(error as {cause?:{code?:string}}).cause?.code;
      if(name!=='project_overview'||attempt>=2||!['ECONNRESET','UND_ERR_SOCKET'].includes(code??'')) throw error;
    }
  }
  expect(response.status).toBe(200);
  const r=(await parseMcpResponse(response))['result'] as {structuredContent:{ok:boolean;workspaceId:string|null;data:Record<string,unknown>|null;error:{code:string}|null}};
  return r.structuredContent;
}
describe('direct MCP access with existing local policy',()=>{
  it('authenticated clients immediately read/edit/run without creating usage state; removed fields/tools are not advertised',async()=>{
    const c=await launch({ toolSurface: 'full', trust:'trusted',fixtureFiles:{'proof.txt':'direct fixture'}});
    try{
      const t=await obtainToken(c);
      expect((await call(c,t.accessToken)).ok).toBe(true);
      expect(JSON.stringify(await call(c,t.accessToken,'read_files',{...wsArgs(c),files:[{path:'proof.txt'}]}))).toContain('direct fixture');
      expect((await call(c,t.accessToken,'write_file',{...wsArgs(c),path:'new.txt',content:'written'})).ok).toBe(true);
      expect(fs.readFileSync(path.join(c.fixtureDir,'new.txt'),'utf8')).toBe('written');
      expect((await call(c,t.accessToken,'run_command',{...wsArgs(c),command:'printf direct-run'})).data).toMatchObject({exitCode:0,stdout:'direct-run'});
      const catalog=await parseMcpResponse(await mcpRaw(c,rpc('tools/list'),t.accessToken));
      const tools=(catalog['result'] as {tools:Array<{name:string;inputSchema:{properties:Record<string,unknown>}}>}).tools;
      expect(tools).toHaveLength(TOOL_CATALOG.length);
      expect(tools.map(t=>t.name)).toEqual(TOOL_CATALOG.map(t=>t.name));
      expect(tools.map(t=>t.name)).not.toContain('usage_request');
      expect(tools.map(t=>t.name)).not.toContain('usage_status');
      expect(tools.map(t=>t.name)).not.toContain('usage_end');
      expect(tools.map(t=>t.name)).toContain('schedule_propose');
      for(const tool of tools){expect(tool.inputSchema.properties).not.toHaveProperty('chat');expect(tool.inputSchema.properties).not.toHaveProperty('usageId');}
      expect(c.server.services.store.db.prepare('SELECT count(*) AS n FROM usage_consents').get()).toEqual({n:0});
    }finally{await c.cleanup();}
  });
  it('still refuses anonymous/invalid auth, inspect execution, secret paths and stale workspace context',async()=>{
    const c=await launch({ toolSurface: 'full', fixtureFiles:{'.env':'DO_NOT_READ=1'}});
    try{
      expect((await mcpRaw(c,rpc('tools/call',{name:'project_overview',arguments:{}}))).status).toBe(401);
      expect((await mcpRaw(c,rpc('tools/list'),'not-a-token')).status).toBe(401);
      const t=await obtainToken(c);
      expect((await call(c,t.accessToken,'run_command',{...wsArgs(c),command:'touch must-not-run'})).ok).toBe(false);
      expect(fs.existsSync(path.join(c.fixtureDir,'must-not-run'))).toBe(false);
      const secret=await call(c,t.accessToken,'read_files',{...wsArgs(c),files:[{path:'.env'},{path:'../outside'}]});
      expect(JSON.stringify(secret)).not.toContain('DO_NOT_READ');expect(JSON.stringify(secret)).toContain('PATH_DENIED');
      expect((await call(c,t.accessToken,'list_files',{...wsArgs(c),workspaceEpoch:'old',path:'.'})).error?.code).toBe('STALE_WORKSPACE');
      c.server.services.store.setClientAccess(c.server.workspaceId,t.clientId,[]);
      expect(await call(c,t.accessToken)).toMatchObject({ok:false,workspaceId:null,data:null,error:{code:'WORKSPACE_ACCESS_REQUIRED'}});
    }finally{await c.cleanup();}
  });
  it('removes private usage/chat routes, UI state and CLI controls while retaining schedule controls',async()=>{
    const c=await launch({ toolSurface: 'full', configPort:0});
    try{
      const url=new URL(c.configUrl!);
      const headers={'content-type':'application/json',authorization:`Bearer ${url.hash.slice(1)}`,'x-dodo-workspace':c.server.workspaceId,'x-dodo-epoch':c.server.epoch};
      const state=await (await fetch(`${url.origin}/api/state`,{headers})).json();
      for(const key of ['usage','chatPermissions','chatClients'])expect(state).not.toHaveProperty(key);
      expect(state).toHaveProperty('schedules');
      const html=await (await fetch(url.origin)).text();expect(html).not.toContain('id="chat-form"');expect(html).not.toContain('id="usage-list"');expect(html).toContain('id="schedules-list"');
      for(const route of ['chat/allow','chat/reset','usage/approve','usage/revoke']) expect((await fetch(`${url.origin}/api/${route}`,{method:'POST',headers,body:'{}'})).status).toBe(404);
      const socket=ipcSocketPath(c.configDir,c.server.workspaceId);
      for(const command of ['chat.list','usage.list'])await expect(ipcCall(socket,command,{})).rejects.toThrow();
      for(const command of ['chat','usage','reset'])await expect(run(process.execPath,[cli,command],{cwd:c.fixtureDir,env:{...process.env,DODO_CONFIG_DIR:c.configDir}})).rejects.toMatchObject({code:1});
    }finally{await c.cleanup();}
  });
  it('ignores legacy chat rows after restart and keeps OAuth/path boundaries when changing roots',async()=>{
    const c=await launch({ toolSurface: 'full' });const t=await obtainToken(c);
    const db=c.server.services.store.db;
    db.prepare('INSERT INTO usage_consents (id,workspace_id,epoch,client_id,grant_id,label,status,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?)').run('legacy',c.server.workspaceId,c.server.epoch,t.clientId,t.grantId,'old','revoked',1,2);
    db.prepare('INSERT INTO chat_permissions VALUES (?,?,?,?,?,?,?,?,?)').run('legacy-chat',c.server.workspaceId,t.clientId,'old-chat',1,2,2,0,0);
    await c.cleanup();
    const next=await launch({ toolSurface: 'full', configDir:c.configDir,fixtureDir:c.fixtureDir,port:c.port});
    try{
      expect((await call(next,t.accessToken)).ok).toBe(true);
      expect(next.server.services.store.db.prepare('SELECT status FROM usage_consents WHERE id=?').get('legacy')).toEqual({status:'revoked'});
      await next.server.switchWorkspace({path:mkTmpDir('dodo-direct-other-')});
      expect((await call(next,t.accessToken)).error?.code).toBe('WORKSPACE_ACCESS_REQUIRED');
      next.server.services.store.setClientAccess(next.server.workspaceId,t.clientId,['dodo:read']);
      expect((await call(next,t.accessToken)).ok).toBe(true);
      next.server.services.store.revokeGrant(t.grantId);
      expect((await mcpRaw(next,rpc('tools/list'),t.accessToken)).status).toBe(401);
    }finally{await next.cleanup();}
  });
});
