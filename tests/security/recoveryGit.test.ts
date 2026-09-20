import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { platformFixture } from '../helpers/platform.js';
import { ProjectRegistry } from '../../src/projects/registry.js';
import { ensurePrivateDirectory } from '../../src/platform/privateFs.js';

describe('R03 independent Git recovery copies',()=>{
 let f:ReturnType<typeof platformFixture>;
 afterEach(async()=>{vi.restoreAllMocks();await f?.close();});
 const git=(args:string[],cwd=f.root)=>execFileSync('git',['-c','user.name=Fixture','-c','user.email=fixture@example.invalid',...args],{cwd,stdio:'pipe'});
 const setup=()=>{f=platformFixture();git(['init']);fs.writeFileSync(path.join(f.root,'a'),'committed');git(['add','a']);git(['commit','-m','fixture']);new ProjectRegistry(f.ws.store).add(f.root,'Git recovery');return f.ws.services.recovery!;};
 const copies=()=>f.ws.store.db.prepare("SELECT directory,payload FROM recovery_git_copies WHERE state='READY'").all() as Array<{directory:string;payload:string}>;
 it('preserves staged/unstaged split, HEAD, refs and remote while excluding staged secrets; hooks and filters never run',async()=>{
  const r=setup();fs.writeFileSync(path.join(f.root,'a'),'staged');git(['add','a']);fs.writeFileSync(path.join(f.root,'a'),'dirty');fs.writeFileSync(path.join(f.root,'untracked'),'untracked');fs.writeFileSync(path.join(f.root,'.env'),'private');git(['add','.env']);
  fs.writeFileSync(path.join(f.root,'.gitattributes'),'a filter=fixture\n');git(['config','filter.fixture.clean','touch injected-filter']);git(['config','core.fsmonitor','touch injected-monitor']);git(['remote','add','origin','https://example.invalid/unreachable']);fs.writeFileSync(path.join(f.root,'.git/hooks/pre-commit'),'#!/bin/sh\ntouch injected-hook\n',{mode:0o700});
  const index=fs.readFileSync(path.join(f.root,'.git/index')),head=fs.readFileSync(path.join(f.root,'.git/HEAD')),config=fs.readFileSync(path.join(f.root,'.git/config'));const id=await r.checkpoint('owner-checkpoint','owner');
  expect(r.git.status()).toMatchObject({state:'ready'});expect(fs.readFileSync(path.join(f.root,'.git/index'))).toEqual(index);expect(fs.readFileSync(path.join(f.root,'.git/HEAD'))).toEqual(head);expect(fs.readFileSync(path.join(f.root,'.git/config'))).toEqual(config);
  for(const p of ['injected-filter','injected-monitor','injected-hook'])expect(fs.existsSync(path.join(f.root,p))).toBe(false);
  const copy=copies().find(c=>JSON.parse(c.payload).ref.endsWith(id))!,meta=JSON.parse(copy.payload);
  expect(git(['--git-dir='+copy.directory,'show',meta.commit+':a']).toString()).toBe('dirty');expect(git(['--git-dir='+copy.directory,'show',meta.commit+':untracked']).toString()).toBe('untracked');
  const names=git(['--git-dir='+copy.directory,'ls-tree','-r','--name-only',meta.commit]).toString();expect(names).not.toContain('.env');expect(fs.existsSync(path.join(copy.directory,'objects/info/alternates'))).toBe(false);expect(fs.existsSync(path.join(copy.directory,'private-index'))).toBe(false);
  // Create-only ref refuses replacing its first value.
  expect(()=>git(['--git-dir='+copy.directory,'update-ref',meta.ref,meta.commit,'0'.repeat(40)])).toThrow();
 });
 it('owner-selected bare copy survives deleting working .git and source; reviewed restore recovers exact bytes',async()=>{
  const r=setup(),destination=path.join(f.base,'separate-backups');ensurePrivateDirectory(destination);await r.configure({...r.policy(),gitRequired:true,gitDirectory:destination},true);
  await expect.poll(()=>r.status().state).toBe('READY');const cp=await r.checkpoint('owner-checkpoint','local-stdio');const copy=copies().at(-1)!;
  for(const name of fs.readdirSync(f.root))fs.rmSync(path.join(f.root,name),{recursive:true,force:true});const meta=JSON.parse(copy.payload);expect(git(['--git-dir='+copy.directory,'show',meta.commit+':a']).toString()).toBe('committed');
  const plan=await f.call('restore_preview',{checkpointId:cp});await f.call('restore_apply',{planId:plan.planId,planHash:plan.planHash,idempotencyKey:f.key()});expect(fs.readFileSync(path.join(f.root,'a'),'utf8')).toBe('committed');expect(fs.existsSync(path.join(f.root,'.git'))).toBe(false);
 });
 it('rejects repository/private-state destinations and unavailable volumes without fallback',async()=>{
  const r=setup();await expect(r.configure({...r.policy(),gitDirectory:f.root},true)).rejects.toThrow();await expect(r.configure({...r.policy(),gitDirectory:f.configDir},true)).rejects.toThrow();
  const destination=path.join(f.base,'private-backups');ensurePrivateDirectory(destination);await r.configure({...r.policy(),gitDirectory:destination},true);await expect.poll(()=>r.status().state).toBe('READY');
  fs.renameSync(destination,destination+'-removed');await expect(r.checkpoint('before-exec','owner')).rejects.toThrow('backup is blocked');expect(fs.existsSync(destination)).toBe(false);
 });
 it('handles unborn and detached HEAD; a parent repo copy never includes a sibling',async()=>{
  f=platformFixture();git(['init'],f.base);fs.writeFileSync(path.join(f.base,'sibling'),'do not capture');fs.writeFileSync(path.join(f.root,'a'),'source');new ProjectRegistry(f.ws.store).add(f.root,'Subdirectory');const r=f.ws.services.recovery!;
  await r.checkpoint('owner-checkpoint','owner');expect(r.git.status().state).toBe('ready');let copy=copies().at(-1)!,meta=JSON.parse(copy.payload);expect(meta.metadata.head).toBeNull();expect(git(['--git-dir='+copy.directory,'ls-tree','-r','--name-only',meta.commit]).toString().trim()).toBe('a');
  git(['add','.'],f.base);git(['commit','-m','baseline'],f.base);git(['checkout','--detach'],f.base);await r.checkpoint('owner-checkpoint','owner');copy=copies().at(-1)!;meta=JSON.parse(copy.payload);expect(meta.metadata.branch).toBeNull();expect(meta.metadata.head).toMatch(/^[a-f0-9]{40}$/);
 });
 it('supports worktree gitfiles and large approved blobs without touching the shared index',async()=>{
  f=platformFixture();const main=path.join(f.base,'main-repo');fs.mkdirSync(main);git(['init'],main);fs.writeFileSync(path.join(main,'seed'),'base');git(['add','seed'],main);git(['commit','-m','base'],main);
  git(['worktree','add','--detach',f.root],main);fs.writeFileSync(path.join(f.root,'large'),Buffer.alloc(3*1024*1024,97));new ProjectRegistry(f.ws.store).add(f.root,'Linked worktree');const r=f.ws.services.recovery!;
  const gitfile=fs.readFileSync(path.join(f.root,'.git'));await r.checkpoint('owner-checkpoint','owner');expect(r.git.status().state).toBe('ready');expect(fs.readFileSync(path.join(f.root,'.git'))).toEqual(gitfile);
  const copy=copies().at(-1)!,meta=JSON.parse(copy.payload);expect(git(['--git-dir='+copy.directory,'cat-file','-s',meta.commit+':large']).toString().trim()).toBe(String(3*1024*1024));
 });
 it('required copy respects shared quotas; existing data/credential destinations are refused',async()=>{
  const r=setup(),mixed=path.join(f.base,'mixed');ensurePrivateDirectory(mixed);fs.writeFileSync(path.join(mixed,'user-data'),'never overwrite');
  await expect(r.configure({...r.policy(),gitDirectory:mixed},true)).rejects.toThrow('dedicated');
  const secret=path.join(f.base,'.ssh');ensurePrivateDirectory(secret);await expect(r.configure({...r.policy(),gitDirectory:secret},true)).rejects.toThrow('credential');
  await r.configure({...r.policy(),projectBytes:1024*1024,gitRequired:true},true);await expect.poll(()=>r.status().state).toBe('BLOCKED');
  await expect(f.call('exec_command',{program:'node',args:['-e','process.exit(0)'],idempotencyKey:f.key()})).rejects.toThrow('RECOVERY_REQUIRED');expect(f.ws.services.jobs.runningCount()).toBe(0);expect(fs.readFileSync(path.join(mixed,'user-data'),'utf8')).toBe('never overwrite');
 });

 it('free-space floor accounts for other projects pending reservations before Git starts',async()=>{
  const r=setup();await r.checkpoint('owner-checkpoint','owner');
  const stat=fs.statfsSync;vi.spyOn(fs,'statfsSync').mockImplementation((p,opts)=>{const result=stat(p,opts);if(String(p).endsWith(path.sep+'git'))Object.assign(result,typeof result.bavail==='bigint'?{bavail:1024n**3n,bsize:1n}:{bavail:1024**3,bsize:1});return result;});
  f.ws.store.db.prepare('INSERT INTO recovery_reservations VALUES (?,?,?,?,?,?)').run('other-project','ws_other',900*1024*1024,0,0,Date.now());
  await r.checkpoint('owner-checkpoint','owner');expect(r.git.status()).toMatchObject({state:'unavailable',errorCode:'RESOURCE_LIMIT'});
 });

 it('requires writable durable copy handles and refuses a copy whose flush fails',async()=>{
  const r=setup(),open=fs.openSync,flush=fs.fsyncSync,close=fs.closeSync;
  const copyFds=new Set<number>();let sealed=0,fail=false;
  vi.spyOn(fs,'openSync').mockImplementation((file,flags,mode)=>{
   const fd=open(file,flags,mode);
   if(typeof flags==='number'&&String(file).includes('.git'+path.sep)&&!fs.fstatSync(fd).isDirectory()){
    expect(flags&3).toBe(fs.constants.O_RDWR);copyFds.add(fd);
   }
   return fd;
  });
  vi.spyOn(fs,'closeSync').mockImplementation(fd=>{copyFds.delete(fd);return close(fd);});
  vi.spyOn(fs,'fsyncSync').mockImplementation(fd=>{if(copyFds.has(fd)){sealed++;if(fail)throw Object.assign(new Error('fixture flush failure'),{code:'EIO'});}return flush(fd);});
  await r.checkpoint('owner-checkpoint','owner');expect(r.git.status().state).toBe('ready');expect(sealed).toBeGreaterThan(0);
  const count=copies().length;fail=true;await r.checkpoint('owner-checkpoint','owner');expect(r.git.status().state).toBe('unavailable');expect(copies()).toHaveLength(count);
 });

});
