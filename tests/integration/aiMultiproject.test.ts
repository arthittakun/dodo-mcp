import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { launch, obtainToken, callToolLegacy, mkTmpDir, wsArgs } from '../helpers/testServer.js';
import { ProjectRegistry } from '../../src/projects/registry.js';
import type { Principal } from '../../src/tools/context.js';

const data = (r: Awaited<ReturnType<typeof callToolLegacy>>) => { expect(r.envelope.ok, JSON.stringify(r.envelope.error)).toBe(true); return r.envelope.data as Record<string, unknown>; };
describe('effectful project routing and provider-backed agents', () => {
  it('routes real HTTP OAuth writes/edits to B while A stays active; validates target ACL, epoch, guards and queued hashes', async () => {
    const b = mkTmpDir('dodo-target-b-'); const ctx = await launch({ trust: 'trusted' });
    try {
      const token = await obtainToken(ctx); const reg = new ProjectRegistry(ctx.server.services.store); const target = reg.add(b,'B').project;
      ctx.server.services.store.setTrustMode(target.workspaceId,'trusted');
      const denied = await callToolLegacy(ctx,token.accessToken,'project_overview',{targetProjectId:target.projectId});
      expect(denied.envelope.error).toMatchObject({code:'WORKSPACE_ACCESS_REQUIRED'});
      ctx.server.services.store.setClientAccess(target.workspaceId,token.clientId,['dodo:read','dodo:write','dodo:exec']);
      const overview = await callToolLegacy(ctx,token.accessToken,'project_overview',{targetProjectId:target.projectId}); data(overview);
      ctx.server.services.store.setTrustMode(target.workspaceId,'trusted');
      const targetArgs = {targetProjectId:target.projectId,workspaceId:overview.envelope.workspaceId,workspaceEpoch:overview.envelope.workspaceEpoch};
      data(await callToolLegacy(ctx,token.accessToken,'dodo_write',{...targetArgs,operation:'write_file',args:{path:'test.txt',content:'alpha'}}));
      const read = data(await callToolLegacy(ctx,token.accessToken,'dodo_read',{...targetArgs,operation:'read_files',args:{files:[{path:'test.txt'}]}}));
      const file = (read.files as Array<{hash:string}>)[0]!;
      data(await callToolLegacy(ctx,token.accessToken,'dodo_write',{...targetArgs,operation:'edit_file',args:{path:'test.txt',expectedHash:file.hash,edits:[{find:'alpha',replace:'beta'}]}}));
      expect(fs.readFileSync(path.join(b,'test.txt'),'utf8')).toBe('beta');expect(fs.existsSync(path.join(ctx.fixtureDir,'test.txt'))).toBe(false);expect(ctx.server.workspaceId).not.toBe(target.workspaceId);
      const stale = await callToolLegacy(ctx,token.accessToken,'dodo_write',{...targetArgs,workspaceEpoch:'stale',operation:'write_file',args:{path:'bad.txt',content:'bad'}}); expect(stale.envelope.error).toMatchObject({code:'STALE_WORKSPACE'});
      const nested = await callToolLegacy(ctx,token.accessToken,'dodo_write',{...targetArgs,operation:'write_file',args:{targetProjectId:target.projectId,path:'bad.txt',content:'bad'}});expect(nested.envelope.error).toMatchObject({code:'INVALID_INPUT'});
      const secret = await callToolLegacy(ctx,token.accessToken,'dodo_write',{...targetArgs,operation:'write_file',args:{path:'.env',content:'secret'}});expect(secret.envelope.error).toMatchObject({code:'SECRET_PATH_DENIED'});
      const conflict = await callToolLegacy(ctx,token.accessToken,'dodo_write',{...targetArgs,operation:'edit_file',args:{path:'test.txt',expectedHash:file.hash,edits:[{find:'beta',replace:'wrong'}]}});expect(conflict.envelope.error).toMatchObject({code:'FILE_CHANGED'});
      ctx.server.services.store.setClientAccess(target.workspaceId,token.clientId,['dodo:read']);
      const scope = await callToolLegacy(ctx,token.accessToken,'dodo_write',{...targetArgs,operation:'write_file',args:{path:'bad.txt',content:'bad'}});expect(scope.envelope.error).toMatchObject({code:'FORBIDDEN'});
      data(await callToolLegacy(ctx,token.accessToken,'project_overview',{}));
    } finally {await ctx.cleanup();fs.rmSync(b,{recursive:true,force:true});}
  });

  it('executes a real provider tool loop via HTTP spawn; retains receipts, idempotency and owner-only settings',async()=>{
    const ctx=await launch({trust:'trusted',configPort:0});let step=0;
    const seen: Array<Record<string,unknown>>=[];
    const fake=http.createServer(async(req,res)=>{
      let raw='';for await(const chunk of req)raw+=String(chunk);
      const input=JSON.parse(raw) as Record<string,unknown>;seen.push(input);
      const hash=fs.existsSync(path.join(ctx.fixtureDir,'ai.txt'))?'sha256:'+createHash('sha256').update(fs.readFileSync(path.join(ctx.fixtureDir,'ai.txt'))).digest('hex'):'';
      const ops:[string,Record<string,unknown>][]=[['write_file',{path:'ai.txt',content:'alpha'}],['read_files',{files:[{path:'ai.txt'}]}],['edit_file',{path:'ai.txt',expectedHash:hash,edits:[{find:'alpha',replace:'beta'}]}],['exec_command',{program:'node',args:['-e','process.stdout.write("test passed")'],idempotencyKey:'model-provided-key'}],['read_files',{files:[{path:'ai.txt'}]}]];
      const operation=ops[step++];const output=operation?[{type:'function_call',call_id:`c${step}`,name:operation[0],arguments:JSON.stringify(operation[1])}]:[{type:'message',content:[{type:'output_text',text:'Changed ai.txt; command returned test passed.'}]}];
      res.setHeader('content-type','text/event-stream');const response=`data: ${JSON.stringify({type:'response.completed',response:{output,usage:{input_tokens:10,output_tokens:5}}})}\n\n`;
      res.write(response.slice(0,13));setTimeout(()=>res.end(response.slice(13)),5);
    });
    await new Promise<void>(r=>fake.listen(0,'127.0.0.1',r));
    try {
      const manager=ctx.server.services.installation!;const reg=new ProjectRegistry(ctx.server.services.store);const project=reg.add(ctx.fixtureDir,'AI fixture').project;const token=await obtainToken(ctx);
      const connection=await manager.ai.settings.saveConnection({name:'Fixture',provider:'custom',protocol:'responses',baseUrl:`http://127.0.0.1:${(fake.address() as {port:number}).port}/v1`,allowPrivateNetwork:true},'test-fixture-key');
      const profile=manager.ai.settings.saveProfile({name:'Coding',connectionId:connection.id,model:'fixture-model',scopes:['dodo:read','dodo:write','dodo:exec'],toolCalling:true,maxInputTokens:200000});
      manager.ai.settings.savePermission({projectId:project.projectId,profileIds:[profile.id],allowSourceEgress:true,allowedClientIds:[token.clientId]});
      const overview=data(await callToolLegacy(ctx,token.accessToken,'project_overview',{}));expect((overview.ai as {profiles:unknown[]}).profiles).toEqual([expect.objectContaining({id:profile.id})]);
      const call={...wsArgs(ctx),operation:'subagent_spawn',args:{profileId:profile.id,task:'create alpha, edit to beta and run a test',idempotencyKey:'agent-fixture-0001'}};
      const result=data(await callToolLegacy(ctx,token.accessToken,'dodo_assist_change',call));const id=String(result.id);
      const principal:Principal={grantId:token.grantId,clientId:token.clientId,sub:'owner',scopes:['dodo:read','dodo:write','dodo:exec']};
      let status=manager.ai.status(id,principal);const until=Date.now()+15000;
      while(!['completed','failed','waiting_auth'].includes(status.status)&&Date.now()<until){await new Promise(r=>setTimeout(r,50));status=manager.ai.status(id,principal);}
      expect(status.status,JSON.stringify(status)).toBe('completed');
      expect(manager.ai.events(id,principal).filter(e=>e.kind==='tool').map(e=>e.payload)).toEqual(expect.arrayContaining([expect.objectContaining({operation:'edit_file',ok:true})]));
      expect(status.actions).toBe(6);expect(fs.readFileSync(path.join(ctx.fixtureDir,'ai.txt'),'utf8')).toBe('beta');
      expect(data(await callToolLegacy(ctx,token.accessToken,'dodo_assist_change',call)).id).toBe(id);expect(step).toBe(6);
      expect(JSON.stringify(seen)).not.toContain('test-fixture-key');expect(JSON.stringify(manager.ai.settings.state())).not.toContain('test-fixture-key');
      const configUrl=new URL(ctx.configUrl!);const anonymous=await fetch(`${configUrl.origin}/api/ai/state`);expect(anonymous.status).toBe(401);
      const events=manager.ai.events(id,principal);expect(events.filter(e=>e.kind==='tool')).toHaveLength(5);
      expect(JSON.stringify(events.filter(e=>e.kind==='job'))).toContain('test passed');
      expect(status.estimatedCost).toBeNull();
    } finally {await ctx.cleanup();await new Promise<void>(r=>fake.close(()=>r()));}
  });
});
