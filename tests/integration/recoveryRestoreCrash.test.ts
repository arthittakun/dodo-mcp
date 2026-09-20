import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { mkTmpDir } from '../helpers/testServer.js';
import { bootstrapWorkspace } from '../../src/server/bootstrap.js';
import { invokeToolDefinition } from '../../src/tools/context.js';
import { TOOL_CATALOG } from '../../src/tools/catalog.js';

describe('R02 abrupt fixture process exit at restore journal boundaries',()=>{
 for(const boundary of ['backup','intent','first-write','last-write','commit','receipt'])it(boundary,async()=>{
  const base=fs.realpathSync.native(mkTmpDir('dodo-restore-crash-')),root=path.join(base,'root'),config=path.join(base,'state');fs.mkdirSync(root);for(const p of ['a','b'])fs.writeFileSync(path.join(root,p),'before');
  const mod=(p:string)=>JSON.stringify(pathToFileURL(path.resolve('dist',p)).href);
  const script=path.join(base,'child.mjs');fs.writeFileSync(script,`
import fs from 'node:fs';import path from 'node:path';
import{bootstrapWorkspace}from ${mod('server/bootstrap.js')};import{ProjectRegistry}from ${mod('projects/registry.js')};
import{invokeToolDefinition}from ${mod('tools/context.js')};import{TOOL_CATALOG}from ${mod('tools/catalog.js')};
const [root,config,boundary,base]=process.argv.slice(2),ws=bootstrapWorkspace({invokedCwd:root,configDir:{dir:config,source:'env'},log:()=>{}});
new ProjectRegistry(ws.store).add(root,'Crash fixture');ws.store.setTrustMode(ws.workspaceId,'trusted');
const principal={grantId:'fixture',clientId:'fixture',sub:'owner',scopes:['dodo:read','dodo:write','dodo:exec']};
const call=async(name,args)=>{const r=await invokeToolDefinition({def:TOOL_CATALOG.find(t=>t.name===name),services:ws.services,principal,args:{...args,workspaceId:ws.workspaceId,workspaceEpoch:ws.epoch}});if(!r.envelope.ok)throw Error(r.envelope.error.code);return r.envelope.data;};
const cp=await call('checkpoint_create',{idempotencyKey:'crash-checkpoint'});
for(const p of ['a','b'])await call('write_file',{path:p,content:'after'});
const plan=await call('restore_preview',{checkpointId:cp.checkpointId});fs.writeFileSync(path.join(base,'plan.json'),JSON.stringify({planId:plan.planId,planHash:plan.planHash}));
const stop=()=>process.kill(process.pid,'SIGKILL');
const step=ws.store.setJournalStepState.bind(ws.store);ws.store.setJournalStepState=(id,seq,state)=>{step(id,seq,state);if(seq===0&&((boundary==='backup'&&state==='backed_up')||(boundary==='intent'&&state==='written')))stop();};
const rename=fs.renameSync;let writes=0;fs.renameSync=(a,b)=>{const result=rename(a,b);if(path.dirname(String(b))===root&&['a','b'].includes(path.basename(String(b)))){writes++;if((boundary==='first-write'&&writes===1)||(boundary==='last-write'&&writes===2))stop();}return result;};
const status=ws.store.setChangesetStatus.bind(ws.store);ws.store.setChangesetStatus=(...args)=>{status(...args);if(boundary==='commit'&&args[1]==='committed')stop();};
const receipt=ws.store.completeIdempotency.bind(ws.store);ws.store.completeIdempotency=(...args)=>{receipt(...args);if(boundary==='receipt')stop();};
await call('restore_apply',{planId:plan.planId,planHash:plan.planHash,idempotencyKey:'crash-restore'});throw Error('did not stop');
`);
  const child=spawn(process.execPath,[script,root,config,boundary,base],{stdio:['ignore','ignore','pipe']});let err='';child.stderr!.on('data',b=>err+=String(b).slice(0,1500));let ws:ReturnType<typeof bootstrapWorkspace>|undefined;
  try{
   const exit=await new Promise<{code:number|null;signal:NodeJS.Signals|null}>((resolve,reject)=>{const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('fixture timed out'));},30000);child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('exit',(code,signal)=>{clearTimeout(timer);resolve({code,signal});});});expect(exit.signal??exit.code,err).toBe(process.platform==='win32'?1:'SIGKILL');
   const plan=JSON.parse(fs.readFileSync(path.join(base,'plan.json'),'utf8')) as {planId:string;planHash:string};if(boundary==='first-write')fs.writeFileSync(path.join(root,'a'),'human');
   ws=bootstrapWorkspace({invokedCwd:root,configDir:{dir:config,source:'env'},log:()=>{}});const cs=ws.store.listChangesets(ws.workspaceId,20).find(c=>c.planId===plan.planId)!;
   const expected=['backup','intent'].includes(boundary)?'failed':boundary==='first-write'?'recovery_required':'committed';expect(cs.status).toBe(expected);
   expect(fs.readFileSync(path.join(root,'a'),'utf8')).toBe(expected==='failed'?'after':expected==='committed'?'before':'human');expect(fs.readFileSync(path.join(root,'b'),'utf8')).toBe(expected==='committed'?'before':'after');
   expect(ws.store.db.prepare("SELECT COUNT(*) n FROM recovery_sessions WHERE workspace_id=? AND state='open'").get(ws.workspaceId)).toEqual({n:0});
   const replay=await invokeToolDefinition({def:TOOL_CATALOG.find(t=>t.name==='restore_apply')!,services:ws.services,principal:{grantId:'fixture',clientId:'fixture',sub:'owner',scopes:['dodo:read','dodo:write']},args:{...plan,workspaceId:ws.workspaceId,workspaceEpoch:ws.epoch,idempotencyKey:'crash-restore'}});
   if(boundary==='receipt')expect(replay.envelope.data).toMatchObject({changesetId:cs.id,replayed:true});else expect(replay.envelope.error).toMatchObject({code:'RECOVERY_REQUIRED'});
  }finally{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await ws?.shutdownServices();fs.rmSync(base,{recursive:true,force:true});}
 },45000);
});
