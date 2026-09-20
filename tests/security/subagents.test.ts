import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { describe,it,expect } from 'vitest';
import { launch,obtainToken,callToolLegacy,wsArgs } from '../helpers/testServer.js';
import { ProjectRegistry } from '../../src/projects/registry.js';
import type { Principal } from '../../src/tools/context.js';
async function fixture(operation:string,args:Record<string,unknown>) {
  const ctx=await launch({trust:'trusted',configPort:0});let calls=0;
  const provider=http.createServer(async(req,res)=>{for await(const _ of req){void _;}calls++;res.end(`data: ${JSON.stringify({type:'response.completed',response:{output:calls===1?[{type:'function_call',call_id:'tool1',name:operation,arguments:JSON.stringify(args)}]:[{type:'message',content:[{type:'output_text',text:'Done; inspect actual receipts.'}]}]}})}\n\n`);});
  await new Promise<void>(r=>provider.listen(0,'127.0.0.1',r));
  const token=await obtainToken(ctx),manager=ctx.server.services.installation!,ai=manager.ai;
  const project=new ProjectRegistry(manager.store).add(ctx.fixtureDir,'fixture').project;
  const connection=await ai.settings.saveConnection({name:'fixture',provider:'custom',protocol:'responses',baseUrl:`http://127.0.0.1:${(provider.address() as {port:number}).port}`,allowPrivateNetwork:true},'fixture-private-key-abcdef');
  const profile=ai.settings.saveProfile({name:'Coding',connectionId:connection.id,model:'fixture',scopes:['dodo:read','dodo:write','dodo:exec'],toolCalling:true});
  ai.settings.savePermission({projectId:project.projectId,profileIds:[profile.id],allowSourceEgress:true,allowedClientIds:[token.clientId]});
  const principal:Principal={grantId:token.grantId,clientId:token.clientId,sub:'owner',scopes:['dodo:read','dodo:write','dodo:exec']};
  const input={profileId:profile.id,task:'fixture task',idempotencyKey:'security-agent-0001'};
  const spawn=()=>callToolLegacy(ctx,token.accessToken,'dodo_assist_change',{...wsArgs(ctx),operation:'subagent_spawn',args:input});
  return {ctx,ai,manager,project,profile,connection,token,principal,input,spawn,calls:()=>calls,close:async()=>{await ctx.cleanup();await new Promise<void>(r=>{provider.close(()=>r());provider.closeAllConnections();});}};
}
async function until(check:()=>boolean,ms=8000){const end=Date.now()+ms;while(!check()){if(Date.now()>end)throw new Error('fixture condition timeout');await new Promise(r=>setTimeout(r,25));}}
const idOf=(r:Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['spawn']>>)=>{expect(r.envelope.ok,JSON.stringify(r.envelope.error)).toBe(true);return String((r.envelope.data as {id:string}).id);};
describe('subagent authorization, approval and recovery boundaries',()=>{
  it('image attachments cannot bypass a profile without read scope',async()=>{
    const f=await fixture('write_file',{path:'never.txt',content:'no'});
    try {
      f.ai.settings.saveProfile({...f.profile,scopes:['dodo:exec'],imageInput:true});
      const run=await f.ai.spawn({...f.input,projectId:f.project.projectId,images:[{path:'not-authorized.png'}]},f.principal,f.ctx.server.services) as {id:string};
      await until(()=>f.ai.status(run.id,f.principal).status==='waiting_auth');
      expect(f.calls()).toBe(0);expect(f.ai.status(run.id,f.principal).error).toMatch(/scope|permission/i);
    } finally {await f.close();}
  });
  it('read-only cannot spawn; local admin requires owner token/origin/context and public MCP has no admin endpoint',async()=>{
    const f=await fixture('write_file',{path:'never.txt',content:'no'});
    try{
      const read=await obtainToken(f.ctx,{scope:'dodo:read'});
      const r=await callToolLegacy(f.ctx,read.accessToken,'dodo_assist_change',{...wsArgs(f.ctx),operation:'subagent_spawn',args:f.input});expect(r.envelope.error).toMatchObject({code:'FORBIDDEN',detail:{requiredScope:'dodo:write'}});expect(f.calls()).toBe(0);
      const edit=await obtainToken(f.ctx,{scope:'dodo:read dodo:write'});
      const noExec=await callToolLegacy(f.ctx,edit.accessToken,'dodo_assist_change',{...wsArgs(f.ctx),operation:'subagent_spawn',args:f.input});expect(noExec.envelope.error).toMatchObject({code:'FORBIDDEN',detail:{requiredScope:'dodo:exec'}});
      const u=new URL(f.ctx.configUrl!),headers={authorization:`Bearer ${u.hash.slice(1)}`,'content-type':'application/json','x-dodo-workspace':f.ctx.server.workspaceId,'x-dodo-epoch':f.ctx.server.epoch};
      expect((await fetch(`${u.origin}/api/ai/state`)).status).toBe(401);
      expect((await fetch(`${u.origin}/api/ai/state`,{headers:{...headers,origin:'https://evil.example'}})).status).toBe(403);
      expect((await fetch(`${u.origin}/api/ai/state`,{headers:{...headers,'x-forwarded-for':'127.0.0.1'}})).status).toBe(403);
      expect((await fetch(`${u.origin}/api/ai/limits`,{method:'POST',headers:{...headers,'x-dodo-epoch':'stale'},body:'{}'})).status).toBe(409);
      expect((await fetch(`${f.ctx.baseUrl}/api/ai/state`,{headers})).status).toBe(404);
      expect(f.ctx.server.services.config.allowWebFetch).toBe(false);
    }finally{await f.close();}
  });
  it('inspect approval binds spawn and target write separately; resume cannot impersonate the original client',async()=>{
    const f=await fixture('write_file',{path:'approved.txt',content:'approved'});
    try{
      f.ai.settings.saveProfile({...f.profile,inputPricePerMillion:1,outputPricePerMillion:1});
      const s=f.ctx.server.services;s.store.setTrustMode(s.workspaceId,'inspect');
      const first=await f.spawn();expect((first.envelope.error as {code:string}|null)?.code).toBe('APPROVAL_REQUIRED');
      const spawnApproval=s.store.listPendingApprovals('action').find(a=>a.tool==='subagent_spawn')!;expect(spawnApproval).toBeDefined();s.store.setApprovalStatus(spawnApproval.id,'approved');
      const id=idOf(await f.spawn());await until(()=>f.ai.status(id,f.principal).status==='waiting_approval');
      expect(fs.existsSync(path.join(f.ctx.fixtureDir,'approved.txt'))).toBe(false);const approval=s.store.listPendingApprovals('action').find(a=>a.tool==='write_file')!;expect(approval.workspaceId).toBe(s.workspaceId);
      expect(()=>new ProjectRegistry(s.store).remove(f.project.projectId)).toThrow(/unfinished/);
      expect(f.ai.status(id,f.principal).estimatedCost).toBeNull();
      await expect(f.ai.control(id,'resume',f.manager.owner())).rejects.toMatchObject({code:'AUTH_REQUIRED'});
      s.store.setApprovalStatus(approval.id,'approved');await f.ai.control(id,'resume',f.principal);await until(()=>f.ai.status(id,f.principal).status==='completed');
      expect(fs.readFileSync(path.join(f.ctx.fixtureDir,'approved.txt'),'utf8')).toBe('approved');expect(f.calls()).toBe(2);expect(s.store.getApproval(approval.id)?.status).toBe('consumed');
    }finally{await f.close();}
  });
  it('revoked target ACL while a model action waits in the shared queue prevents the write',async()=>{
    const f=await fixture('write_file',{path:'blocked.txt',content:'must not write'});let release=()=>undefined as void;
    const held=f.ctx.server.services.mutations!.run(()=>new Promise<void>(r=>{release=r;}));
    try{
      const id=idOf(await f.spawn());await until(()=>f.ctx.server.services.mutations!.pending>0 && f.calls()>0);
      await expect(f.ai.settings.saveConnection({...f.connection,baseUrl:f.connection.baseUrl+'/new'},'new-fixture-key')).rejects.toMatchObject({code:'CONFLICT'});
      f.manager.store.setClientAccess(f.ctx.server.workspaceId,f.token.clientId,[]);release();await held;
      await until(()=>f.ai.status(id,f.manager.owner()).status==='waiting_auth');expect(fs.existsSync(path.join(f.ctx.fixtureDir,'blocked.txt'))).toBe(false);expect(f.calls()).toBe(1);
    }finally{release();await held;await f.close();}
  });
  it('checks expectedHash after the queue and preserves external edits',async()=>{
    const f=await fixture('edit_file',{path:'a.txt',expectedHash:'sha256:8ed3f6ad685b959ead7022518e1af76cd816f8e8ec7ccdda1ed4018e8f2223f8',edits:[{find:'alpha',replace:'beta'}]});let release=()=>undefined as void;
    fs.writeFileSync(path.join(f.ctx.fixtureDir,'a.txt'),'alpha');const held=f.ctx.server.services.mutations!.run(()=>new Promise<void>(r=>{release=r;}));
    try{
      const id=idOf(await f.spawn());await until(()=>f.ctx.server.services.mutations!.pending>0 && f.calls()>0);fs.writeFileSync(path.join(f.ctx.fixtureDir,'a.txt'),'external');release();await held;
      await until(()=>f.ai.status(id,f.principal).status==='completed');expect(fs.readFileSync(path.join(f.ctx.fixtureDir,'a.txt'),'utf8')).toBe('external');
      expect(f.ai.events(id,f.principal).map(e=>e.payload)).toContainEqual(expect.objectContaining({operation:'edit_file',ok:false,error:expect.objectContaining({code:'FILE_CHANGED'})}));
    }finally{release();await held;await f.close();}
  });
  it('cancel terminates only the run-owned command and does not make another inference',async()=>{
    const f=await fixture('exec_command',{program:'node',args:['-e','setInterval(()=>{},1000)'],idempotencyKey:'fixture-job'});
    try{
      const id=idOf(await f.spawn());await until(()=>f.ctx.server.services.jobs.runningCount()===1);await until(()=>JSON.parse((f.manager.store.db.prepare('SELECT payload FROM ai_runs WHERE id=?').get(id) as {payload:string}).payload).jobs?.length===1);
      await f.ai.control(id,'cancel',f.principal);await until(()=>f.ctx.server.services.jobs.runningCount()===0);
      expect(f.ai.status(id,f.principal).status).toBe('canceled');expect(f.calls()).toBe(1);await expect(f.ai.control(id,'resume',f.principal)).rejects.toMatchObject({code:'CONFLICT'});
    }finally{await f.close();}
  });
  it('model cannot request recursive agents, owner controls or nested project routing',async()=>{
    for(const [operation,args] of [['subagent_spawn',{task:'recurse'}],['write_file',{targetProjectId:'other',path:'bad.txt',content:'bad'}]] as const){
      const f=await fixture(operation,args);
      try{const id=idOf(await f.spawn());await until(()=>f.ai.status(id,f.principal).status==='waiting_auth');expect(f.calls()).toBe(1);expect(fs.existsSync(path.join(f.ctx.fixtureDir,'bad.txt'))).toBe(false);}finally{await f.close();}
    }
  });
});
