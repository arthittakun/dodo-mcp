import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { AppServices } from '../../tools/context.js';
import { DodoError } from '../../errors.js';
import { buildChildEnv } from '../../security/env.js';
import { resolveTrustedExecutable } from '../../platform/execResolve.js';
import { assertPrivatePath, ensurePrivateDirectory } from '../../platform/privateFs.js';
import { isWithinPath } from '../../platform/pathPolicy.js';
import type { RecoveryManifest, RecoveryPolicy } from './contracts.js';
import type { RecoveryStorage } from './storage.js';
import { rootIdentity, syncDir } from './storage.js';

type Destination={path:string;identity:string};
/** Each immutable copy is an independent bare repository. Never reads objects from
 * the working Git database, its index, alternates, hooks, filters or remotes. */
export class RecoveryGitCopies {
  private last:{state:string;checkpointId?:string;commit?:string;errorCode?:string}={state:'not_checked'};
  constructor(private readonly s:AppServices,private readonly storage:RecoveryStorage,private readonly configDir:string){}
  status(){return {...this.last,location:'private_owner_storage',coverage:'approved source bytes only; empty directories and exact modes remain in the source manifest; no Git history, LFS downloads or submodule history'};}
  reviewDestination(policy:RecoveryPolicy):Destination|undefined {
    if(!policy.gitDirectory)return undefined;
    const p=policy.gitDirectory;
    if(!path.isAbsolute(p)||fs.realpathSync.native(p)!==p)throw new DodoError('PATH_DENIED','Git recovery destination must be an existing canonical private directory');
    assertPrivatePath(p,true);
    if(p.split(/[\\/]/).some(part=>['.ssh','.gnupg','.aws','.azure','.kube','.docker'].includes(part.toLowerCase())))throw new DodoError('PATH_DENIED','Git recovery cannot use a credential namespace');
    for(const name of fs.readdirSync(p)){
      const item=path.join(p,name);const row=this.s.store.db.prepare('SELECT identity FROM recovery_git_copies WHERE directory=?').get(item) as {identity:string}|undefined;
      if(!/^snap_[a-f0-9-]{36}\.git$/.test(name)||!row||row.identity!==rootIdentity(item))throw new DodoError('PATH_DENIED','choose an empty dedicated private backup directory, not an existing data directory');
    }
    const roots=this.s.store.db.prepare('SELECT canonical_root AS root FROM project_registry WHERE removed_at IS NULL').all() as Array<{root:string}>;
    for(const root of [this.configDir,...roots.map(r=>r.root)])if(isWithinPath(root,p)||isWithinPath(p,root))throw new DodoError('PATH_DENIED','Git recovery destination overlaps source or private credentials');
    return {path:p,identity:rootIdentity(p)};
  }
  configure(policy:RecoveryPolicy):void {
    const d=this.reviewDestination(policy);
    if(d)this.s.store.db.prepare('INSERT INTO recovery_git_destinations VALUES (?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET path=excluded.path,identity=excluded.identity').run(this.s.workspaceId,d.path,d.identity);
    else this.s.store.db.prepare('DELETE FROM recovery_git_destinations WHERE workspace_id=?').run(this.s.workspaceId);
  }
  private destination(policy:RecoveryPolicy):string {
    if(policy.gitDirectory){
      const d=this.s.store.db.prepare('SELECT path,identity FROM recovery_git_destinations WHERE workspace_id=?').get(this.s.workspaceId) as Destination|undefined;
      if(!d||d.path!==policy.gitDirectory||rootIdentity(d.path)!==d.identity)throw new DodoError('PATH_DENIED','owner-selected Git recovery volume is unavailable or replaced');
      this.reviewDestination(policy);return d.path;
    }
    assertPrivatePath(this.storage.directory,true);const p=path.join(this.storage.directory,'git');ensurePrivateDirectory(p);return p;
  }
  private async command(dir:string,args:string[],input?:Buffer,deadline=Date.now()+60000,maxOutput=2*1024*1024):Promise<Buffer>{
    if(Date.now()>=deadline)throw new DodoError('RESOURCE_LIMIT','Git checkpoint exceeded time budget');
    const executable=resolveTrustedExecutable('git',this.s.wfs.root,{allowBatch:false});
    const env=buildChildEnv({parentEnv:process.env,workspaceRoot:this.s.wfs.root,extraAllowlist:[]});
    Object.assign(env,{GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_NO_REPLACE_OBJECTS:'1',GIT_OPTIONAL_LOCKS:'0',GIT_CONFIG_COUNT:'0',GIT_ATTR_NOSYSTEM:'1',GIT_INDEX_FILE:path.join(dir,'private-index'),GIT_AUTHOR_NAME:'DODO Recovery',GIT_AUTHOR_EMAIL:'recovery@localhost.invalid',GIT_COMMITTER_NAME:'DODO Recovery',GIT_COMMITTER_EMAIL:'recovery@localhost.invalid'});
    const flags=['--git-dir='+dir,'-c','core.hooksPath='+path.join(dir,'disabled-hooks'),'-c','core.fsmonitor=false','-c','core.attributesFile='+ (process.platform==='win32'?'NUL':'/dev/null'),'-c','gc.auto=0','-c','maintenance.auto=false','-c','protocol.allow=never','-c','credential.helper='];
    return new Promise((resolve,reject)=>{
      const child=spawn(executable,[...flags,...args],{cwd:dir,env,shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});let bytes=0,finished=false;const output:Buffer[]=[];
      const finish=(error?:DodoError)=>{if(finished)return;finished=true;clearTimeout(timer);if(error){child.kill();reject(error);}else resolve(Buffer.concat(output));};
      const timer=setTimeout(()=>finish(new DodoError('RESOURCE_LIMIT','Git checkpoint command timed out')),Math.min(15000,Math.max(1,deadline-Date.now())));
      child.on('error',()=>finish(new DodoError('NOT_SUPPORTED','Git checkpoint process could not start')));
      child.stdout.on('data',(b:Buffer)=>{bytes+=b.length;if(bytes>maxOutput)finish(new DodoError('RESOURCE_LIMIT','Git checkpoint output exceeded budget'));else output.push(b);});
      child.stderr.resume();child.stdin.on('error',()=>{});child.stdin.end(input);
      child.on('close',code=>finish(code===0?undefined:new DodoError('RECOVERY_REQUIRED','Git checkpoint command failed; repository output hidden')));
    });
  }
  private seal(dir:string):number {
    ensurePrivateDirectory(dir);let bytes=0;
    for(const name of fs.readdirSync(dir)){const p=path.join(dir,name),st=fs.lstatSync(p);if(st.isSymbolicLink()||(!st.isFile()&&!st.isDirectory())||(st.isFile()&&st.nlink!==1))throw new DodoError('PATH_DENIED','Git copy has unsafe objects');if(st.isDirectory())bytes+=this.seal(p);else{if(process.platform!=='win32')fs.chmodSync(p,0o600);assertPrivatePath(p);const fd=fs.openSync(p,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}bytes+=st.size;}}
    syncDir(dir);return bytes;
  }
  async capture(m:RecoveryManifest,policy:RecoveryPolicy):Promise<void>{
    if(m.scope!=='source'||m.trigger==='emergency-observed')return;
    let directory:string|undefined,identity:string|undefined,recorded=false;
    try{
      const metadata=await this.s.git.recoveryMetadata();
      if(!metadata.isRepo){this.last={state:'not_a_git_repository'};if(policy.gitRequired)throw new DodoError('NOT_SUPPORTED','Git-required project has no Git repository');return;}
      const base=this.destination(policy);const estimate=m.entries.reduce((n,e)=>n+e.bytes*2+512,1024*1024);
      // Shared DB reservation covers copies from different active projects too.
      this.s.store.db.transaction(()=>{
        const usage=this.storage.usageFor(this.s.workspaceId),install=this.storage.installationPolicy(),stat=fs.statfsSync(base,{bigint:true});
        const pending=(this.s.store.db.prepare("SELECT (SELECT COALESCE(SUM(bytes),0) FROM recovery_git_copies WHERE state='PREPARING') + (SELECT COALESCE(SUM(bytes+staging_bytes),0) FROM recovery_reservations) AS n").get() as {n:number}).n;
        if(usage.installationBytes+usage.reservedBytes+estimate>install.storageBytes||usage.projectBytes+estimate>policy.projectBytes||stat.bavail*stat.bsize<BigInt(install.freeFloorBytes+pending+estimate))throw new DodoError('RESOURCE_LIMIT','Git recovery quota or free-space floor reached');
        directory=path.join(base,m.id+'.git');
        this.s.store.db.prepare('INSERT INTO recovery_git_copies VALUES (?,?,?,NULL,?,\'PREPARING\',?)').run(m.id,this.s.workspaceId,directory,estimate,JSON.stringify(metadata));recorded=true;
      }).immediate();
      fs.mkdirSync(directory!,{mode:0o700});ensurePrivateDirectory(directory!);identity=rootIdentity(directory!);
      this.s.store.db.prepare('UPDATE recovery_git_copies SET identity=? WHERE snapshot_id=?').run(identity,m.id);
      const deadline=Date.now()+60000;
      await this.command(directory!,['init','--bare','--template=','.'],undefined,deadline);
      await this.command(directory!,['read-tree','--empty'],undefined,deadline);
      const index:Buffer[]=[];const objects:Array<{oid:string;hash:string;bytes:number}>=[];
      for(const e of m.entries)if(e.kind==='file'){
        const bytes=await this.storage.readObject(e.hash!,e.bytes,policy.fileBytes);
        const oid=(await this.command(directory!,['hash-object','-w','--no-filters','--stdin'],bytes,deadline)).toString().trim();
        if(!/^[a-f0-9]{40,64}$/.test(oid))throw new DodoError('RECOVERY_REQUIRED','invalid Git object ID');
        index.push(Buffer.from(`${(e.mode??0)&0o111?'100755':'100644'} ${oid}\t${e.path}\0`));objects.push({oid,hash:e.hash!,bytes:e.bytes});
      }
      await this.command(directory!,['update-index','-z','--index-info'],Buffer.concat(index),deadline);
      const tree=(await this.command(directory!,['write-tree'],undefined,deadline)).toString().trim();
      const commit=(await this.command(directory!,['commit-tree',tree],Buffer.from('DODO approved source checkpoint\n'),deadline)).toString().trim();
      const ref='refs/dodo/snapshots/'+m.id;
      await this.command(directory!,['update-ref',ref,commit,'0'.repeat(commit.length)],undefined,deadline);
      await this.command(directory!,['fsck','--strict','--no-reflogs'],undefined,deadline);
      // Verify independent Git bytes, not just a successful plumbing exit code.
      for(const object of objects){const bytes=await this.command(directory!,['cat-file','blob',object.oid],undefined,deadline,policy.fileBytes);if(bytes.length!==object.bytes||createHash('sha256').update(bytes).digest('hex')!==object.hash)throw new DodoError('RECOVERY_REQUIRED','Git recovery content verification failed');}
      fs.rmSync(path.join(directory!,'private-index'),{force:true});
      fs.writeFileSync(path.join(directory!,'dodo-source-manifest.json'),JSON.stringify(m),{flag:'wx',mode:0o600});
      const bytes=this.seal(directory!);if(bytes>estimate)throw new DodoError('RESOURCE_LIMIT','Git recovery copy exceeded reserved size');
      syncDir(directory!);syncDir(base);
      this.s.store.db.prepare("UPDATE recovery_git_copies SET state='READY',bytes=?,payload=? WHERE snapshot_id=?").run(bytes,JSON.stringify({ref,commit,tree,metadata}),m.id);
      this.last={state:'ready',checkpointId:m.id,commit};
    }catch(e){
      if(directory&&identity&&fs.existsSync(directory)&&rootIdentity(directory)===identity){fs.rmSync(directory,{recursive:true});if(recorded)this.s.store.db.prepare('DELETE FROM recovery_git_copies WHERE snapshot_id=?').run(m.id);}
      else if(recorded)this.s.store.db.prepare("UPDATE recovery_git_copies SET state='INCOMPLETE' WHERE snapshot_id=?").run(m.id);
      this.last={state:'unavailable',errorCode:e instanceof DodoError?e.code:'BACKUP_IO_ERROR'};
      if(policy.gitRequired||policy.gitDirectory)throw new DodoError('RECOVERY_REQUIRED','configured Git recovery copy is unavailable; no fallback destination was used');
    }
  }
  prune():void {
    const rows=this.s.store.db.prepare('SELECT snapshot_id,directory,identity FROM recovery_git_copies WHERE workspace_id=? AND NOT EXISTS(SELECT 1 FROM recovery_snapshots WHERE id=snapshot_id)').all(this.s.workspaceId) as Array<{snapshot_id:string;directory:string;identity:string}>;
    for(const r of rows){try{if(!r.identity||rootIdentity(r.directory)!==r.identity)continue;assertPrivatePath(r.directory,true);fs.rmSync(r.directory,{recursive:true});this.s.store.db.prepare('DELETE FROM recovery_git_copies WHERE snapshot_id=?').run(r.snapshot_id);}catch{/* missing selected volume: keep quota accounting, never fallback */}}
  }
}
