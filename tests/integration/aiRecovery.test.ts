import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {describe,it,expect} from 'vitest';
import {launch,mkTmpDir} from '../helpers/testServer.js';
import {ProjectRegistry} from '../../src/projects/registry.js';
import {bootstrapWorkspace} from '../../src/server/bootstrap.js';

describe.skipIf(process.platform==='win32')('real process agent recovery',()=>{
  it('holds an exclusive project lease and never replays an uncertain inference after SIGKILL/restart',async()=>{
    const ctx=await launch({trust:'trusted'}),scripts=mkTmpDir('dodo-ai-recovery-driver-');let calls=0;let current=ctx;
    const provider=http.createServer(async(req,res)=>{for await(const bytes of req){void bytes;}calls++;if(calls===1)res.end(`data: ${JSON.stringify({type:'response.completed',response:{output:[{type:'function_call',call_id:'write1',name:'write_file',arguments:JSON.stringify({path:'once.txt',content:'executed once'})}]}})}\n\n`);else res.write('data: ');});
    await new Promise<void>(r=>provider.listen(0,'127.0.0.1',r));
    let child:ReturnType<typeof spawn>|undefined;
    try{
      expect(()=>bootstrapWorkspace({invokedCwd:ctx.fixtureDir,configDir:{dir:ctx.configDir,source:'env'},log:()=>undefined})).toThrow('holds this project');
      const m=ctx.server.services.installation!,project=new ProjectRegistry(m.store).add(ctx.fixtureDir,'recovery').project;
      const connection=await m.ai.settings.saveConnection({name:'fixture',provider:'custom',protocol:'responses',baseUrl:`http://127.0.0.1:${(provider.address() as {port:number}).port}`,allowPrivateNetwork:true});
      const profile=m.ai.settings.saveProfile({name:'Coding',connectionId:connection.id,model:'fixture',toolCalling:true,scopes:['dodo:read','dodo:write','dodo:exec']});m.ai.settings.savePermission({projectId:project.projectId,profileIds:[profile.id],allowSourceEgress:true,allowedClientIds:[]});
      await ctx.server.close();
      const script=path.join(scripts,'driver.mjs');fs.writeFileSync(script,`import {pathToFileURL} from 'node:url';import path from 'node:path';const {startServer}=await import(pathToFileURL(path.resolve('dist/server/appServer.js')));const s=await startServer({invokedCwd:process.env.DODO_TEST_ROOT,portOverride:0,quiet:true,onLog:()=>{}});const m=s.services.installation;const run=await m.ai.spawn({projectId:process.env.DODO_TEST_PROJECT,profileId:process.env.DODO_TEST_PROFILE,task:'Write once.txt then summarize',idempotencyKey:'crash-fixture-001'},m.owner(),s.services);process.send({id:run.id});`);
      child=spawn(process.execPath,[script],{cwd:process.cwd(),env:{...process.env,DODO_CONFIG_DIR:ctx.configDir,DODO_TEST_ROOT:ctx.fixtureDir,DODO_TEST_PROJECT:project.projectId,DODO_TEST_PROFILE:profile.id},stdio:['ignore','ignore','ignore','ipc']});
      const id=await new Promise<string>((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('child fixture did not start')),8000);child!.once('message',msg=>{clearTimeout(timeout);resolve((msg as {id:string}).id);});child!.once('error',reject);});
      await expect.poll(()=>calls,{timeout:10000}).toBe(2);expect(fs.readFileSync(path.join(ctx.fixtureDir,'once.txt'),'utf8')).toBe('executed once');
      const exited=new Promise<void>(r=>child!.once('exit',()=>r()));child.kill('SIGKILL');await exited;
      current=await launch({fixtureDir:ctx.fixtureDir,configDir:ctx.configDir,port:ctx.port});
      const ai=current.server.services.installation!.ai,owner=current.server.services.installation!.owner();
      expect(ai.status(id,owner)).toMatchObject({status:'interrupted',error:'UNCERTAIN',modelCalls:2});
      await expect(ai.control(id,'resume',owner)).rejects.toMatchObject({code:'CONFLICT'});
      await new Promise(r=>setTimeout(r,350));expect(calls).toBe(2);expect(ai.events(id,owner).filter(e=>e.kind==='tool')).toHaveLength(1);
    }finally{if(child&&child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await current.cleanup();fs.rmSync(scripts,{recursive:true,force:true});await new Promise<void>(r=>{provider.close(()=>r());provider.closeAllConnections();});}
  },25000);
});
