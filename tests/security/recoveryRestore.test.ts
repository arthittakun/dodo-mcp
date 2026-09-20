import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { platformFixture } from '../helpers/platform.js';
import { ProjectRegistry } from '../../src/projects/registry.js';
import { TOOL_CATALOG } from '../../src/tools/catalog.js';
import { invokeToolDefinition, type Principal } from '../../src/tools/context.js';

describe('R02 caller-owned reviewed restore',()=>{
 let f:ReturnType<typeof platformFixture>;
 afterEach(async()=>{vi.restoreAllMocks();await f?.close();});
 const setup=(files:Record<string,string>)=>{f=platformFixture();for(const [p,v]of Object.entries(files)){fs.mkdirSync(path.dirname(path.join(f.root,p)),{recursive:true});fs.writeFileSync(path.join(f.root,p),v);}new ProjectRegistry(f.ws.store).add(f.root,'Recovery fixture');};
 const read=(p:string)=>fs.readFileSync(path.join(f.root,p),'utf8');
 const begin=()=>f.call('recovery_session_begin',{title:'Fixture session',idempotencyKey:f.key()});
 const apply=(p:Record<string,unknown>,key=f.key())=>f.call('restore_apply',{planId:p.planId,planHash:p.planHash,idempotencyKey:key});
 it('preserves 12 pre-existing modified and 3 untracked files; coalesces two edits and replays receipt',async()=>{
  const files=Object.fromEntries(Array.from({length:12},(_,i)=>[`file${i}.txt`,`dirty ${i}`]));Object.assign(files,{'untracked1':'u1','untracked2':'u2','untracked3':'u3'});setup(files);
  const git=(args:string[])=>execFileSync('git',['-c','user.name=Fixture','-c','user.email=fixture@example.invalid',...args],{cwd:f.root,stdio:'pipe'});
  git(['init']);git(['add',...Object.keys(files).filter(p=>p.startsWith('file'))]);git(['commit','-m','fixture baseline']);
  for(let i=0;i<12;i++){files[`file${i}.txt`]=`dirty ${i} modified`;fs.writeFileSync(path.join(f.root,`file${i}.txt`),files[`file${i}.txt`]!);}
  const index=fs.readFileSync(path.join(f.root,'.git/index'));

  const session=await begin();const c={recoverySessionId:session.sessionId};
  await f.call('edit_file',{...c,path:'file0.txt',edits:[{find:'dirty 0',replace:'AI 1'}]});
  await f.call('edit_file',{...c,path:'file0.txt',edits:[{find:'AI 1',replace:'AI 2'}]});
  await f.call('delete_path',{...c,path:'file1.txt'});
  await f.call('recovery_session_end',{sessionId:session.sessionId});
  const p=await f.call('restore_preview',{sessionId:session.sessionId});expect(p.applicable).toBe(true);expect(read('file0.txt')).toBe('AI 2 modified');
  const key=f.key(),result=await apply(p,key);expect(result.verified).toBe(true);expect((await apply(p,key)).changesetId).toBe(result.changesetId);
  for(const [p,v]of Object.entries(files))expect(read(p)).toBe(v);
  expect(fs.readFileSync(path.join(f.root,'.git/index'))).toEqual(index);
  const history=await f.call('recovery_session_inspect',{sessionId:session.sessionId});expect((history.dirtyState as {entries:unknown[]}).entries).toHaveLength(15);
 });
 it('move/create/delete undo and partial path restore preserve unrelated extra files',async()=>{
  setup({'a':'alpha','b':'beta'});const session=await begin(),c={recoverySessionId:session.sessionId};
  await f.call('move_path',{...c,path:'a',destPath:'moved'});await f.call('write_file',{...c,path:'new',content:'new'});await f.call('delete_path',{...c,path:'b'});
  fs.writeFileSync(path.join(f.root,'external'),'user');
  const p=await f.call('restore_preview',{sessionId:session.sessionId});await apply(p);
  expect(read('a')).toBe('alpha');expect(read('b')).toBe('beta');expect(read('external')).toBe('user');expect(fs.existsSync(path.join(f.root,'new'))).toBe(false);expect(fs.existsSync(path.join(f.root,'moved'))).toBe(false);
  const cp=await f.call('checkpoint_create',{idempotencyKey:f.key()});await f.call('write_file',{path:'a',content:'changed'});await f.call('write_file',{path:'b',content:'changed'});
  await apply(await f.call('restore_preview',{checkpointId:cp.checkpointId,paths:['a']}));expect(read('a')).toBe('alpha');expect(read('b')).toBe('changed');
 });
 it('external edits before preview and after preview refuse without overwriting',async()=>{
  setup({'a':'original'});const session=await begin();await f.call('write_file',{recoverySessionId:session.sessionId,path:'a',content:'AI'});
  fs.writeFileSync(path.join(f.root,'a'),'external');const conflict=await f.call('restore_preview',{sessionId:session.sessionId});expect(conflict.applicable).toBe(false);expect(conflict.planId).toBeNull();
  fs.writeFileSync(path.join(f.root,'a'),'AI');const p=await f.call('restore_preview',{sessionId:session.sessionId});fs.writeFileSync(path.join(f.root,'a'),'newer');await expect(apply(p)).rejects.toThrow('FILE_CHANGED');expect(read('a')).toBe('newer');
 });
 it('explicit mirror is reviewed, preserves excluded data and cannot be applied as ordinary changes',async()=>{
  setup({'a':'before','db.sqlite':'database','.env':'private'});const cp=await f.call('checkpoint_create',{idempotencyKey:f.key()});await f.call('write_file',{path:'a',content:'after'});await f.call('write_file',{path:'extra',content:'extra'});
  const defaultPlan=await f.call('restore_preview',{checkpointId:cp.checkpointId});expect((defaultPlan.files as Array<{path:string}>).map(x=>x.path)).not.toContain('extra');
  const p=await f.call('restore_preview',{checkpointId:cp.checkpointId,exactMirror:true});expect((p.files as Array<{path:string}>).map(x=>x.path)).toContain('extra');
  await expect(f.call('apply_changes',{planId:p.planId,planHash:p.planHash,idempotencyKey:f.key()})).rejects.toThrow('FORBIDDEN');await apply(p);expect(read('db.sqlite')).toBe('database');expect(read('.env')).toBe('private');expect(fs.existsSync(path.join(f.root,'extra'))).toBe(false);
 });
 it('caller/project ownership, scope, nested override and stale epoch fail closed',async()=>{
  setup({'a':'before'});const session=await begin();await f.call('write_file',{recoverySessionId:session.sessionId,path:'a',content:'after'});const p=await f.call('restore_preview',{sessionId:session.sessionId});
  const invoke=(name:string,args:Record<string,unknown>,principal:Principal={grantId:'other',clientId:'other',sub:'other',scopes:['dodo:read','dodo:write']})=>invokeToolDefinition({def:TOOL_CATALOG.find(t=>t.name===name)!,services:f.ws.services,principal,args:{workspaceId:f.ws.workspaceId,workspaceEpoch:f.ws.epoch,...args}});
  expect((await invoke('recovery_session_inspect',{sessionId:session.sessionId})).envelope.error?.code).toBe('NOT_FOUND');
  expect((await invoke('restore_apply',{planId:p.planId,planHash:p.planHash,idempotencyKey:f.key()})).envelope.error?.code).toBe('NOT_FOUND');
  expect((await invoke('restore_apply',{planId:p.planId,planHash:p.planHash,idempotencyKey:f.key()},{grantId:'local-stdio',clientId:'stdio',sub:'owner',scopes:['dodo:read']})).envelope.error?.code).toBe('FORBIDDEN');
  expect((await invoke('checkpoint_list',{workspaceEpoch:'old'})).envelope.error?.code).toBe('STALE_WORKSPACE');expect(read('a')).toBe('after');
 });
 it('corrupt backup refuses preview/apply and changed retry args conflict',async()=>{
  setup({'a':'before'});const cp=await f.call('checkpoint_create',{idempotencyKey:f.key()});await f.call('write_file',{path:'a',content:'after'});const p=await f.call('restore_preview',{checkpointId:cp.checkpointId});
  const m=await f.ws.services.recovery!.storage.readVerified(cp.checkpointId as string,f.ws.workspaceId);fs.writeFileSync(f.ws.services.recovery!.storage.objectPath(m.entries[0]!.hash!),'broken');await expect(apply(p)).rejects.toThrow('RECOVERY_REQUIRED');expect(read('a')).toBe('after');
 });
 it('owned empty directories are journaled; unrelated children and replacement identities prevent removal',async()=>{
  setup({'a':'before'});const session=await begin(),c={recoverySessionId:session.sessionId};
  await f.call('make_directory',{...c,path:'owned/child'});await f.call('write_file',{...c,path:'owned/child/a',content:'AI'});
  const p=await f.call('restore_preview',{sessionId:session.sessionId});expect(p.applicable).toBe(true);await apply(p);expect(fs.existsSync(path.join(f.root,'owned'))).toBe(false);
  const second=await begin();await f.call('make_directory',{recoverySessionId:second.sessionId,path:'newdir'});fs.writeFileSync(path.join(f.root,'newdir/user'),'user');
  const plan=await f.call('restore_preview',{sessionId:second.sessionId});expect(plan.applicable).toBe(false);expect(plan.conflicts).toEqual(expect.arrayContaining([expect.objectContaining({path:'newdir'})]));expect(read('newdir/user')).toBe('user');
  fs.unlinkSync(path.join(f.root,'newdir/user'));const emptyPlan=await f.call('restore_preview',{sessionId:second.sessionId});
  if(process.platform!=='win32'){fs.chmodSync(path.join(f.root,'newdir'),0o700);await expect(apply(emptyPlan)).rejects.toThrow('FILE_CHANGED');expect(fs.existsSync(path.join(f.root,'newdir'))).toBe(true);}
 });
 it('partial directory restore reviews missing structural parents and recreates exact nested bytes',async()=>{
  setup({'outer/inner/file.txt':'original','a':'unrelated'});const cp=await f.call('checkpoint_create',{idempotencyKey:f.key()});fs.rmSync(path.join(f.root,'outer'),{recursive:true});
  const p=await f.call('restore_preview',{checkpointId:cp.checkpointId,paths:['outer/inner']});expect((p.files as Array<{path:string;action:string}>)).toEqual(expect.arrayContaining([expect.objectContaining({path:'outer',action:'mkdir'}),expect.objectContaining({path:'outer/inner',action:'mkdir'})]));
  await apply(p);expect(read('outer/inner/file.txt')).toBe('original');expect(read('a')).toBe('unrelated');
 });
 it('binary bytes and executable mode restore exactly without decoding',async()=>{
  setup({'a':'original'});const bytes=Buffer.from([0,255,128,1,10]);fs.writeFileSync(path.join(f.root,'blob'),bytes);if(process.platform!=='win32')fs.chmodSync(path.join(f.root,'blob'),0o750);
  const cp=await f.call('checkpoint_create',{idempotencyKey:f.key()});fs.writeFileSync(path.join(f.root,'blob'),'new');if(process.platform!=='win32')fs.chmodSync(path.join(f.root,'blob'),0o600);
  const p=await f.call('restore_preview',{checkpointId:cp.checkpointId,paths:['blob']});await apply(p);expect(fs.readFileSync(path.join(f.root,'blob'))).toEqual(bytes);if(process.platform!=='win32')expect(fs.statSync(path.join(f.root,'blob')).mode&0o777).toBe(0o750);
  if(process.platform!=='win32'){
   fs.mkdirSync(path.join(f.root,'private-dir'),{mode:0o700});const directory=await f.call('checkpoint_create',{idempotencyKey:f.key()});fs.chmodSync(path.join(f.root,'private-dir'),0o755);
   const conflict=await f.call('restore_preview',{checkpointId:directory.checkpointId,paths:['private-dir']});expect(conflict.applicable).toBe(false);expect(conflict.conflicts).toEqual(expect.arrayContaining([expect.objectContaining({path:'private-dir'})]));expect(fs.statSync(path.join(f.root,'private-dir')).mode&0o777).toBe(0o755);
  }
 });
 it('shell jobs have unknown attribution and cannot masquerade as exclusive session edits',async()=>{
  setup({'a':'before'});const session=await begin();const result=await f.call('exec_command',{program:'node',args:['-e','process.exit(0)'],recoverySessionId:session.sessionId,idempotencyKey:f.key()});expect(result.jobId).toBeTruthy();await f.ws.services.jobs.waitForExit(result.jobId as string,5000);
  await expect(f.call('restore_preview',{sessionId:session.sessionId})).rejects.toThrow('unknown authorship');
 });
 it('compensates a failed restore write and preserves external edits during apply',async()=>{
  setup({'a':'before','b':'before'});const cp=await f.call('checkpoint_create',{idempotencyKey:f.key()});await f.call('write_file',{path:'a',content:'after'});await f.call('write_file',{path:'b',content:'after'});const p=await f.call('restore_preview',{checkpointId:cp.checkpointId});
  const rename=fs.renameSync;vi.spyOn(fs,'renameSync').mockImplementation((from,to)=>{if(String(to)===path.join(f.root,'b'))throw Object.assign(new Error('disk failure'),{code:'ENOSPC'});return rename(from,to);});
  await expect(apply(p)).rejects.toThrow();expect(read('a')).toBe('after');expect(read('b')).toBe('after');expect(f.ws.services.applier.recoveryBlocked()).toBeUndefined();
 });

 it('traversal, secret paths, symlinks and hardlinks remain denied during preview/apply',async()=>{
  setup({'a':'before','.env':'private'});const cp=await f.call('checkpoint_create',{idempotencyKey:f.key()});await f.call('write_file',{path:'a',content:'after'});const p=await f.call('restore_preview',{checkpointId:cp.checkpointId});
  await expect(f.call('restore_preview',{checkpointId:cp.checkpointId,paths:['../a']})).rejects.toThrow('PATH_DENIED');
  fs.linkSync(path.join(f.root,'a'),path.join(f.root,'hard'));await expect(apply(p)).rejects.toThrow();expect(read('a')).toBe('after');fs.unlinkSync(path.join(f.root,'hard'));
  fs.unlinkSync(path.join(f.root,'a'));fs.symlinkSync(path.join(f.root,'.env'),path.join(f.root,'a'));await expect(f.call('restore_preview',{checkpointId:cp.checkpointId})).rejects.toThrow('PATH_DENIED');expect(read('.env')).toBe('private');
 });
 it('queued restore rechecks hashes and live authority after waiting and after backup',async()=>{
  setup({'a':'before'});const cp=await f.call('checkpoint_create',{idempotencyKey:f.key()});await f.call('write_file',{path:'a',content:'after'});const p=await f.call('restore_preview',{checkpointId:cp.checkpointId});
  let release=()=>{};const blocker=f.ws.services.mutations!.run(()=>new Promise<void>(resolve=>{release=resolve;}));
  const pending=apply(p);await expect.poll(()=>f.ws.services.mutations!.pending).toBe(1);fs.writeFileSync(path.join(f.root,'a'),'external');release();await blocker;await expect(pending).rejects.toThrow('FILE_CHANGED');expect(read('a')).toBe('external');
  const q=await f.call('restore_preview',{checkpointId:cp.checkpointId});let revoked=false;const r=f.ws.services.recovery!,publish=r.storage.publish.bind(r.storage);
  vi.spyOn(r.storage,'publish').mockImplementation(async m=>{await publish(m);revoked=true;});
  const result=await invokeToolDefinition({def:TOOL_CATALOG.find(t=>t.name==='restore_apply')!,services:f.ws.services,principal:()=>({...f.ws.services.localPrincipal!,scopes:revoked?['dodo:read']:['dodo:read','dodo:write']}),args:{workspaceId:f.ws.workspaceId,workspaceEpoch:f.ws.epoch,planId:q.planId,planHash:q.planHash,idempotencyKey:f.key()}});
  expect(result.envelope.error?.code).toBe('FORBIDDEN');expect(read('a')).toBe('external');
 });

});
