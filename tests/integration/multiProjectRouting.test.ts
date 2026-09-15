import fs from 'node:fs';
import path from 'node:path';
import { Client,StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { describe,it,expect } from 'vitest';
import { launch,obtainToken,mkTmpDir } from '../helpers/testServer.js';
import { ProjectRegistry } from '../../src/projects/registry.js';
import type { Envelope } from '../../src/tools/envelope.js';

describe('concurrent project routing on modern HTTP + OAuth',()=>{
  it('keeps clients A/B isolated, parallel jobs, stale epochs and project selection without default ACL',async()=>{
    const b=mkTmpDir('dodo-concurrent-b-'),ctx=await launch({trust:'trusted'});const clients:Client[]=[];
    try{
      const aToken=await obtainToken(ctx),bToken=await obtainToken(ctx),s=ctx.server.services,reg=new ProjectRegistry(s.store),project=reg.add(b,'B').project;
      s.store.setClientAccess(project.workspaceId,bToken.clientId,['dodo:read','dodo:write','dodo:exec']);s.store.setClientAccess(s.workspaceId,bToken.clientId,[]);
      for(const t of [aToken,bToken]){const c=new Client({name:'target-fixture',version:'1.0.0'});clients.push(c);await c.connect(new StreamableHTTPClientTransport(new URL(`${ctx.baseUrl}/mcp`),{authProvider:{token:async()=>t.accessToken}}));}
      const call=async(c:Client,name:string,args:Record<string,unknown>)=>(await c.callTool({name,arguments:args})).structuredContent as unknown as Envelope;
      expect((await clients[0]!.listTools()).tools.length).toBe(20);
      const selection=await call(clients[1]!,'project_overview',{});expect(selection.ok).toBe(true);expect(selection.workspaceId).toBeNull();expect(JSON.stringify(selection.data)).not.toContain(ctx.fixtureDir);expect(selection.data).toMatchObject({selectProjectRequired:true,projects:[expect.objectContaining({projectId:project.projectId})]});
      const [aOverview,bOverview]=await Promise.all([call(clients[0]!,'project_overview',{}),call(clients[1]!,'project_overview',{targetProjectId:project.projectId})]);
      expect(aOverview.ok).toBe(true);expect(bOverview.ok).toBe(true);s.store.setTrustMode(project.workspaceId,'trusted');
      const contextA={workspaceId:aOverview.workspaceId,workspaceEpoch:aOverview.workspaceEpoch},contextB={workspaceId:bOverview.workspaceId,workspaceEpoch:bOverview.workspaceEpoch,targetProjectId:project.projectId};
      const jobs=await Promise.all([call(clients[0]!,'dodo_exec',{...contextA,operation:'exec_command',args:{program:'node',args:['-e','setTimeout(()=>console.log("A test passed"),1000)'],idempotencyKey:'parallel-project-a'}}),call(clients[1]!,'dodo_exec',{...contextB,operation:'exec_command',args:{program:'node',args:['-e','setTimeout(()=>console.log("B test passed"),1000)'],idempotencyKey:'parallel-project-b'}})]);
      expect(jobs.every(r=>r.ok)).toBe(true);expect(s.jobs.runningCount()).toBe(1);expect(s.installation!.status().find(r=>r.projectId===project.projectId)?.jobs).toBe(1);
      const results=await Promise.all(jobs.map((r,i)=>call(clients[i]!,'dodo_read',{...(i===0?contextA:contextB),operation:'job_wait',args:{jobId:(r.data as {jobId:string}).jobId,waitMs:5000}})));
      expect(results[0]?.data).toMatchObject({exitCode:0,stdout:expect.stringContaining('A test passed')});expect(results[1]?.data).toMatchObject({exitCode:0,stdout:expect.stringContaining('B test passed')});
      const writes=await Promise.all([call(clients[0]!,'dodo_write',{...contextA,operation:'write_file',args:{path:'same.txt',content:'A'}}),call(clients[1]!,'dodo_write',{...contextB,operation:'write_file',args:{path:'same.txt',content:'B'}})]);expect(writes.every(r=>r.ok)).toBe(true);expect(fs.readFileSync(path.join(ctx.fixtureDir,'same.txt'),'utf8')).toBe('A');expect(fs.readFileSync(path.join(b,'same.txt'),'utf8')).toBe('B');
      expect((await call(clients[0]!,'project_overview',{targetProjectId:project.projectId})).error).toMatchObject({code:'WORKSPACE_ACCESS_REQUIRED'});
      expect((await call(clients[1]!,'dodo_write',{...contextB,workspaceEpoch:contextA.workspaceEpoch,operation:'write_file',args:{path:'bad.txt',content:'bad'}})).error).toMatchObject({code:'STALE_WORKSPACE'});
      const beforeEpoch=bOverview.workspaceEpoch;await s.installation!.closeProject(project.projectId);const reopened=await call(clients[1]!,'project_overview',{targetProjectId:project.projectId});expect(reopened.workspaceEpoch).not.toBe(beforeEpoch);
      expect(s.store.listChangesets(s.workspaceId,20).every(c=>c.workspaceId===s.workspaceId)).toBe(true);expect(s.store.listChangesets(project.workspaceId,20).every(c=>c.workspaceId===project.workspaceId)).toBe(true);
    }finally{for(const c of clients)await c.close();await ctx.cleanup();fs.rmSync(b,{recursive:true,force:true});}
  },20000);
});
