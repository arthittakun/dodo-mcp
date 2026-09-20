import { RecoveryEvidence } from './evidence.js';
import { RecoveryGitCopies } from './gitCopies.js';
import { RecoveryDrift } from './drift.js';
import { RecoveryHistory } from './history.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { AppServices } from '../../tools/context.js';
import { DodoError } from '../../errors.js';
import { ProjectRegistry, type RegisteredProject } from '../../projects/registry.js';
import { isWithinPath } from '../../platform/pathPolicy.js';
import { digestOf } from '../../util/hash.js';
import { loadGlobalConfig } from '../../config/globalConfig.js';
import { RecoveryPolicySchema, type RecoveryPolicy, type RecoveryEntry, type RecoveryManifest, type RecoveryTrigger } from './contracts.js';
import { RecoveryStorage, rootIdentity } from './storage.js';

const OMIT_DIR = new Set(['.git','node_modules','dist','build','out','.cache','coverage','target','.venv','venv','__pycache__','uploads','logs','volumes']);
const DATA_EXTENSION = /\.(?:db|sqlite|sqlite3|db-wal|db-shm|log|dump|bak)$/i;
// Bounded high-confidence screening, NOT a guarantee that every credential is detectable.
const SECRET = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:gh[pousr]_[a-zA-Z0-9]{30,}|github_pat_[a-zA-Z0-9_]{40,}|sk-[a-zA-Z0-9_-]{32,}|AKIA[0-9A-Z]{16})\b/;
const tick=()=>new Promise<void>(r=>setImmediate(r));
type CaptureFile={entry:RecoveryEntry; signature:string};

/** Owned by a leased runtime. Reads remain available while this async service captures source. */
export class RecoveryService {
  readonly storage:RecoveryStorage;
  readonly history:RecoveryHistory;
  readonly drift:RecoveryDrift;
  readonly git:RecoveryGitCopies;
  readonly evidence:RecoveryEvidence;
  private readonly deadline=new AsyncLocalStorage<number>();
  private readonly verificationCheck=new AsyncLocalStorage<()=>boolean>();
  async verifiedCheckpoint(verificationId:string,actor:string,stillVerified:()=>boolean){
    if(!this.project()||!this.policy().enabled)return;
    await Promise.allSettled(this.observations);
    return this.s.mutations!.run(async()=>{
      const key=`recovery-verified:${this.s.workspaceId}:${verificationId}`;
      if(this.s.store.getMeta(key)||!stillVerified())return;
      const id=await this.verificationCheck.run(stillVerified,()=>this.checkpoint('verified-checkpoint',actor));
      if(id)this.s.store.setMeta(key,id);
    });
  }
  private readonly reviewedRestore=new AsyncLocalStorage<boolean>();
  private scanTimer:NodeJS.Timeout|undefined;
  private background:Promise<unknown>|undefined;
  private observations=new Set<Promise<unknown>>();
  observeJob():Promise<unknown>{
    if(this.closed||!this.policy().enabled||!this.project())return Promise.resolve();
    const work=this.deadline.run(Date.now()+this.policy().scanMs,()=>this.drift.scan()).catch(()=>undefined);
    this.observations.add(work);void work.finally(()=>this.observations.delete(work));return work;
  }
  withReviewedRestore<T>(fn:()=>Promise<T>):Promise<T>{return this.reviewedRestore.run(true,fn);}
  private checkBudget(){if(Date.now()>(this.deadline.getStore()??Infinity))throw new DodoError('RESOURCE_LIMIT','source drift scan exceeded its time budget; state was not acknowledged');}
  async scanDrift(){
    if(!this.policy().enabled)return this.drift.status();
    if(this.s.mutations?.busy||this.s.jobs.runningCount())throw new DodoError('CONFLICT','wait for active source work before scanning');
    return this.s.mutations!.run(()=>this.deadline.run(Date.now()+this.policy().scanMs,()=>this.drift.scan()));
  }
  async acknowledgeDrift(digest:string,revalidate:()=>void){
    if(this.s.mutations?.busy||this.s.jobs.runningCount())throw new DodoError('CONFLICT','wait for active source work before reviewing drift');
    return this.s.mutations!.run(()=>this.deadline.run(Date.now()+this.policy().scanMs,()=>this.drift.acknowledge(digest,revalidate)));
  }
  captureObserved(){return this.capture('emergency-observed','system:observation');}
  private startScanner(){
    if(this.scanTimer)return;
    this.scanTimer=setInterval(()=>{if(this.closed||this.background||this.s.mutations?.busy||this.s.jobs.runningCount()||!this.policy().enabled)return;this.background=this.scanDrift().catch(()=>undefined).finally(()=>{this.background=undefined;});},60000);
    this.scanTimer.unref();
  }
  private readonly authority = new AsyncLocalStorage<() => void>();
  withAuthority<T>(check: () => void, action: () => Promise<T>): Promise<T> { return this.authority.run(check, action); }

  private readonly identity:string;
  private state:'INITIALIZING'|'READY'|'BLOCKED'|'DISABLED_BY_OWNER'='INITIALIZING';
  private errorCode:string|null=null;
  private baseline:string|undefined;
  private latest:string|undefined;
  private lastTrigger:RecoveryTrigger|null=null;
  private counts={included:0,excludedByPolicy:0};
  private lastCheckedAt:number|null=null;
  private initialization:Promise<void>|undefined;
  private closed=false;
  private activated=false;
  private reconciled=false;
  private progress={scanned:0,captured:0,bytes:0};
  constructor(private readonly s:AppServices,private readonly configDir:string){
    this.identity=rootIdentity(s.wfs.root);
    this.history=new RecoveryHistory(s,this);
    this.evidence=new RecoveryEvidence(s,this);
    this.drift=new RecoveryDrift(s,this);
    this.storage=new RecoveryStorage(s.store,configDir,()=>loadGlobalConfig(path.join(configDir,'config.json')).recovery);
    this.git=new RecoveryGitCopies(s,this.storage,configDir);
  }
  private project():RegisteredProject|undefined {
    const row=this.s.store.db.prepare('SELECT id FROM project_registry WHERE workspace_id=? AND removed_at IS NULL').get(this.s.workspaceId) as {id:string}|undefined;
    if(!row)return undefined;
    const p=new ProjectRegistry(this.s.store).get(row.id);
    if(!p.available||p.root!==this.s.wfs.root||rootIdentity(p.root)!==this.identity)throw new DodoError('PATH_DENIED','recovery requires the original registered project directory');
    if(isWithinPath(p.root,this.configDir)||isWithinPath(this.configDir,p.root))throw new DodoError('PATH_DENIED','recovery refuses private-state overlap');
    return p;
  }
  assertProject():void { if(!this.project())throw new DodoError('NOT_FOUND','Recovery requires a registered project'); }
  assertSourcePath(rel:string):void {
    this.assertProject();const normalized=this.s.wfs.normalizeRel(rel);
    if(normalized!==rel||normalized==='.'||this.excluded(rel,false,this.policy()))throw new DodoError('PATH_DENIED','path is outside allowed recovery source scope');
    this.s.wfs.resolve(rel,{allowMissing:true});
  }
  async currentEntries(targets?:string[],extraPaths:string[]=[]):Promise<RecoveryEntry[]> {
    return this.deadline.run(this.deadline.getStore()??Date.now()+this.policy().scanMs,async()=>{
      const read=async()=>{
        const inventory=await this.inventory(this.policy(),targets);
        const seen=new Set(inventory.files.map(f=>f.entry.path));
        for(const p of extraPaths)if(!seen.has(p)){
          try{this.assertSourcePath(p);}catch{continue;}
          const r=this.s.wfs.resolve(p,{allowMissing:true});
          if(r.stat?.isFile())inventory.files.push(...(await this.inventory(this.policy(),[p])).files);
        }
        if(inventory.files.length>this.policy().maxEntries)throw new DodoError('RESOURCE_LIMIT','source scan exceeds entry budget');
        for(const f of inventory.files)if(f.entry.kind==='file')f.entry.hash=await this.readFile(f);
        return inventory.files.sort((a,b)=>a.entry.path.localeCompare(b.entry.path));
      };
      const first=await read(),second=await read();
      if(digestOf(first)!==digestOf(second))throw new DodoError('FILE_CHANGED','source changed during drift scan');
      return first.map(f=>f.entry);
    });
  }
  policy():RecoveryPolicy {
    const r=this.s.store.db.prepare('SELECT payload FROM recovery_policies WHERE workspace_id=?').get(this.s.workspaceId) as {payload:string}|undefined;
    return RecoveryPolicySchema.parse(r?JSON.parse(r.payload):{});
  }
  /** Private owner service only. Repository configuration never reaches this method. */
  async configure(input:unknown,confirmed:boolean,revalidate?:()=>void):Promise<ReturnType<RecoveryService['status']>> {
    if(!confirmed)throw new DodoError('INVALID_INPUT','confirm the Recovery policy change');
    const policy=RecoveryPolicySchema.parse(input);if(!this.project())throw new DodoError('NOT_FOUND','register this project first');
    for(const p of policy.dataRoots){const rel=this.s.wfs.normalizeRel(p);if(rel==='.'||rel!==p)throw new DodoError('INVALID_INPUT','data roots must be canonical relative subdirectories');}
    if(this.s.jobs.runningCount()||this.s.mutations?.busy)throw new DodoError('CONFLICT','wait for active mutations and jobs before changing Recovery policy');
    await this.initialization;
    if(this.s.jobs.runningCount()||this.s.mutations?.busy)throw new DodoError('CONFLICT','project became busy while reviewing Recovery policy');
    revalidate?.();this.git.reviewDestination(policy);
    this.s.store.db.transaction(()=>{
      this.git.configure(policy);
      this.s.store.db.prepare('INSERT INTO recovery_policies VALUES (?,?) ON CONFLICT(workspace_id) DO UPDATE SET payload=excluded.payload').run(this.s.workspaceId,JSON.stringify(policy));
      this.s.store.audit({principal:'local-config-owner',workspaceId:this.s.workspaceId,tool:'recovery.policy',result:policy.enabled?'enabled':'disabled_by_owner'});
    }).immediate();
    this.baseline=undefined;this.activated=false;this.state=policy.enabled?'INITIALIZING':'DISABLED_BY_OWNER';this.errorCode=null;
    this.activate();return this.status();
  }
  summary(){
    const {enabled,state,registered,awaitingActivation,sourceOnly,lastCheckedAt,errorCode,progress,projectBytes}=this.status();
    const drift=this.drift.status();return {enabled,state,registered,awaitingActivation,sourceOnly,lastCheckedAt,errorCode,progress,projectBytes,drift:{state:drift.state,changedCount:drift.changedCount,critical:drift.critical,errorCode:drift.errorCode},git:this.git.status(),verification:this.evidence.summary()};
  }
  status(){
    const registered=Boolean(this.s.store.db.prepare('SELECT 1 FROM project_registry WHERE workspace_id=? AND removed_at IS NULL').get(this.s.workspaceId));
    const policy=this.policy();
    return {enabled:policy.enabled,state:policy.enabled?this.state:'DISABLED_BY_OWNER',registered,awaitingActivation:registered&&!this.activated,
      sourceOnly:true,lastTrigger:this.lastTrigger,counts:{...this.counts},lastCheckpointId:this.latest??null,baselineId:this.baseline??null,integrity:this.lastCheckedAt?'verified_at_capture':'not_verified',lastCheckedAt:this.lastCheckedAt,
      errorCode:this.errorCode,progress:{...this.progress},drift:this.drift.status(),git:this.git.status(),verification:this.evidence.summary(),...this.storage.usageFor(this.s.workspaceId),policy};
  }
  activate():void {
    if(this.closed||this.activated)return;
    try {if(!this.project())return;}catch(e){this.fail(e);return;}
    this.activated=true;
    if(!this.reconciled){this.storage.reconcile(this.s.workspaceId);this.history.reconcile();this.reconciled=true;}
    if(!this.policy().enabled){this.state='DISABLED_BY_OWNER';return;}
    this.initialization=(async()=>{
      // The same queue protects activation from direct, agent and scheduled writers.
      await this.s.mutations!.run(async()=>{
        const prior=this.s.store.db.prepare("SELECT id FROM recovery_snapshots WHERE workspace_id=? AND state='READY' ORDER BY created_at DESC LIMIT 1").get(this.s.workspaceId) as {id:string}|undefined;
        if(prior){const m=await this.storage.readVerified(prior.id,this.s.workspaceId);if(m.rootIdentity!==this.identity)throw new DodoError('PATH_DENIED','backup belongs to a previous root identity; owner review is required');}
        await this.capture('activation','system:activation');
        this.startScanner();
      });
    })().catch(e=>{this.fail(e);});
  }
  private fail(error:unknown):void {this.state='BLOCKED';this.errorCode=error instanceof DodoError?error.code:'BACKUP_IO_ERROR';}
  async checkpoint(trigger:RecoveryTrigger,actor:string,targets?:string[]):Promise<string|undefined>{
    if(this.closed)throw new DodoError('CONFLICT','Recovery runtime is closing');
    if(!this.project())return undefined; // launcher/unregistered CWD is never scanned
    if(!this.reconciled){this.storage.reconcile(this.s.workspaceId);this.history.reconcile();this.reconciled=true;}
    if(!this.policy().enabled){this.state='DISABLED_BY_OWNER';return undefined;}
    // Initialization may itself be waiting behind this call's mutation ticket.
    // Capture here within that ticket; never await a queued activation from a writer.
    return this.s.mutations!.run(async()=>{
      let guardRejected=false;
      try{
        if(!this.baseline){
          const prior=this.s.store.db.prepare("SELECT id FROM recovery_snapshots WHERE workspace_id=? AND state='READY' ORDER BY created_at DESC LIMIT 1").get(this.s.workspaceId) as {id:string}|undefined;
          if(prior){const m=await this.storage.readVerified(prior.id,this.s.workspaceId);if(m.rootIdentity!==this.identity)throw new DodoError('PATH_DENIED','backup belongs to a previous root identity; owner review is required');}
          await this.capture('activation','system:activation');
        }
        await this.storage.readVerified(this.baseline!,this.s.workspaceId);
        if(!this.reviewedRestore.getStore()&&(trigger==='before-write'||trigger==='before-exec'))try{await this.deadline.run(Date.now()+this.policy().scanMs,()=>this.drift.guard(targets));}catch(e){guardRejected=e instanceof DodoError&&['FILE_CHANGED','CONFLICT'].includes(e.code);throw e;}
        const id = await this.capture(trigger,actor,targets);
        this.startScanner();
        this.authority.getStore()?.();
        return id;
      }catch(e){if(guardRejected||e instanceof DodoError && (['FORBIDDEN','AUTH_REQUIRED'].includes(e.code)))throw e;this.fail(e);throw new DodoError('RECOVERY_REQUIRED','source backup is blocked; no source mutation was started',{detail:{reason:this.errorCode},recovery:'inspect Recovery in project settings, fix storage/path/integrity problems and retry'});}
    });
  }
  private signature(st:fs.Stats):string {return `${st.dev}:${st.ino}:${st.nlink}:${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.mode}`;}
  private excluded(rel:string,dir:boolean,policy:RecoveryPolicy):boolean {
    if(rel==='.')return false;
    return rel.split('/').some(p=>OMIT_DIR.has(p))||DATA_EXTENSION.test(rel)||policy.dataRoots.some(r=>r===rel||rel.startsWith(r+'/'))||this.s.wfs.ignores.isSecret(rel)||this.s.wfs.ignores.isProtected(rel)||(dir&&this.s.wfs.ignores.isSecret(rel+'/'));
  }
  private async inventory(policy:RecoveryPolicy,targets?:string[]):Promise<{files:CaptureFile[];excluded:number}> {
    this.project();const files:CaptureFile[]=[];let excluded=0,visited=0;
    const visit=async(rel:string,target:boolean):Promise<void>=>{
      this.checkBudget();if(this.closed)throw new DodoError('CONFLICT','Recovery runtime closing');
      if(++visited>policy.maxEntries)throw new DodoError('RESOURCE_LIMIT','source inventory exceeds entry budget');
      this.progress.scanned=visited;
      if(visited%100===0)await tick();
      if(this.excluded(rel,false,policy)){if(target)throw new DodoError('PATH_DENIED','mutation target is excluded from source Recovery');excluded++;return;}
      // Check every component with the shared policy, including NTFS aliases and links.
      const r=this.s.wfs.resolve(rel,{allowMissing:target}),st=r.stat;
      if(!st){files.push({entry:{path:rel,kind:'absent',hash:null,bytes:0,mode:null},signature:'absent'});return;}
      if(this.excluded(rel,st.isDirectory(),policy)){if(target)throw new DodoError('PATH_DENIED','mutation target is excluded from source Recovery');excluded++;return;}
      if(rel!=='.'&&!target&&this.s.wfs.ignores.isOrdinarilyIgnored(rel,st.isDirectory())){excluded++;return;}
      if(st.isDirectory()){
        if(rel!=='.')files.push({entry:{path:rel,kind:'directory',hash:null,bytes:0,mode:st.mode&0o777,identity:rootIdentity(r.abs)},signature:this.signature(st)});
        const dir=await fs.promises.opendir(r.abs);for await(const ent of dir){await visit(rel==='.'?ent.name:`${rel}/${ent.name}`,target);}
      }else{
        this.s.wfs.assertRegularFileForDirectAccess(r);
        if(st.size>policy.fileBytes)throw new DodoError('RESOURCE_LIMIT','source file exceeds Recovery file budget');
        files.push({entry:{path:rel,kind:'file',hash:null,bytes:st.size,mode:st.mode&0o777},signature:this.signature(st)});
      }
    };
    for(const rel of targets?[...new Set(targets.map(t=>this.s.wfs.normalizeRel(t)))]:['.'])await visit(rel,Boolean(targets));
    if(!targets){
      const seen=new Set(files.map(f=>f.entry.path));
      for(const p of this.drift.trackedPaths())if(!seen.has(p)&&!this.excluded(p,false,policy)){
        const r=this.s.wfs.resolve(p,{allowMissing:true});if(r.stat?.isFile())await visit(p,true);
      }
    }
    const distinct=new Map(files.map(f=>[f.entry.path,f]));
    return {files:[...distinct.values()].sort((a,b)=>a.entry.path.localeCompare(b.entry.path)),excluded};
  }
  private async readFile(file:CaptureFile,stage?:string):Promise<string>{
    const r=this.s.wfs.resolve(file.entry.path);this.s.wfs.assertRegularFileForDirectAccess(r);
    if(!r.stat||this.signature(r.stat)!==file.signature)throw new DodoError('FILE_CHANGED','source changed during backup');
    const input=await fs.promises.open(r.abs,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
    let output:fs.promises.FileHandle|undefined;
    try{
      if(this.signature(await input.stat())!==file.signature)throw new DodoError('FILE_CHANGED','source identity changed during backup');
      if(stage)output=await fs.promises.open(stage,'wx',0o600);
      const hash=createHash('sha256'),buf=Buffer.alloc(128*1024);let bytes=0,tail='';
      while(true){this.checkBudget();const {bytesRead}=await input.read(buf,0,buf.length,null);if(!bytesRead)break;bytes+=bytesRead;if(bytes>file.entry.bytes)throw new DodoError('FILE_CHANGED','source grew during backup');
        const chunk=buf.subarray(0,bytesRead),text=tail+chunk.toString('utf8');
        if(SECRET.test(text))throw new DodoError('SECRET_PATH_DENIED','credential-like content found during source backup');tail=text.slice(-1024);
        hash.update(chunk);if(output){let offset=0;while(offset<bytesRead){const w=await output.write(chunk,offset,bytesRead-offset);if(!w.bytesWritten)throw new DodoError('INTERNAL_ERROR','backup write made no progress');offset+=w.bytesWritten;}}
      }
      const final=this.s.wfs.resolve(file.entry.path).stat;
      if(bytes!==file.entry.bytes||!final||this.signature(final)!==file.signature||this.signature(await input.stat())!==file.signature)throw new DodoError('FILE_CHANGED','source changed during backup');
      if(output)await output.sync();return hash.digest('hex');
    }finally{await input.close();await output?.close();}
  }
  private async capture(trigger:RecoveryTrigger,actor:string,targets?:string[]):Promise<string>{
    const project=this.project();if(!project)throw new DodoError('NOT_FOUND','Recovery requires a registered project');
    const policy=this.policy(),id=`snap_${randomUUID()}`,createdAt=Date.now();
    this.state='INITIALIZING';this.progress={scanned:0,captured:0,bytes:0};
    let staging:string|undefined;
    try{
      const inventory=await this.inventory(policy,targets);
      // Hash before reserving: unchanged objects cost logical references, not duplicate disk bytes.
      const expectedHashes=new Map<string,string>();
      for(const f of inventory.files)if(f.entry.kind==='file')expectedHashes.set(f.entry.path,await this.readFile(f));
      const estimate=this.storage.estimate(this.s.workspaceId,inventory.files.filter(f=>f.entry.kind==='file').map(f=>({hash:expectedHashes.get(f.entry.path)!,bytes:f.entry.bytes})));
      this.storage.prune(this.s.workspaceId,policy);
      this.storage.collectOrphans();
      this.storage.reserve(id,this.s.workspaceId,estimate.physical,policy,estimate.logical,estimate.staging);
      this.s.store.db.prepare("INSERT INTO recovery_snapshots (id,workspace_id,project_id,state,scope,created_at) VALUES (?,?,?,'PREPARING',?,?)").run(id,this.s.workspaceId,project.projectId,targets?'targets':'source',createdAt);
      const entries:RecoveryEntry[]=[];
      for(const f of inventory.files){
        const entry={...f.entry};if(entry.kind==='file'){
          staging=this.storage.stagePath();entry.hash=await this.readFile(f,staging);
          if(entry.hash!==expectedHashes.get(entry.path))throw new DodoError('FILE_CHANGED','source changed after space reservation');
          await this.storage.publishObject(staging,entry.hash,entry.bytes);staging=undefined;
        }entries.push(entry);this.progress.captured++;this.progress.bytes+=entry.bytes;
      }
      // Rescan paths AND reread hashes. A watcher or old checkpoint alone is not freshness proof.
      const after=await this.inventory(policy,targets);
      if(digestOf(after)!==digestOf(inventory))throw new DodoError('FILE_CHANGED','source inventory changed during backup');
      const entryHashes=new Map(entries.map(e=>[e.path,e.hash]));
      for(const f of after.files)if(f.entry.kind==='file'){
        const hash=await this.readFile(f);if(hash!==entryHashes.get(f.entry.path))throw new DodoError('FILE_CHANGED','source content changed during backup');
      }
      this.project();
      if(trigger==='verified-checkpoint'&&!this.verificationCheck.getStore()?.())throw new DodoError('FILE_CHANGED','verification no longer matches the captured source');
      const m:RecoveryManifest={version:1,id,workspaceId:this.s.workspaceId,projectId:project.projectId,root:this.s.wfs.root,rootIdentity:this.identity,epoch:this.s.epoch,
        sessionId:(trigger==='activation'||trigger==='emergency-observed')?`implicit_${randomUUID()}`:this.history.sessionForCapture(actor),actor,trigger,scope:targets?'targets':'source',createdAt,policyDigest:digestOf(policy),entries,excludedByPolicy:inventory.excluded,complete:true};
      await this.storage.publish(m);if(trigger!=='emergency-observed')this.history.published(m);this.latest=id;if(!targets&&trigger!=='emergency-observed')this.baseline=id;
      if(trigger==='activation')this.drift.initialize(m);
      await this.git.capture(m,policy);
      this.lastTrigger=trigger;this.counts={included:entries.length,excludedByPolicy:inventory.excluded};
      this.lastCheckedAt=Date.now();this.state='READY';this.errorCode=null;
      this.s.store.audit({principal:actor,workspaceId:this.s.workspaceId,tool:'recovery.checkpoint',result:'ready',inputDigest:digestOf({id,trigger})});
      this.storage.prune(this.s.workspaceId,policy);this.git.prune();return id;
    }catch(e){this.s.store.db.prepare("UPDATE recovery_snapshots SET state='INCOMPLETE' WHERE id=? AND state='PREPARING'").run(id);this.fail(e);throw e;}
    finally{this.storage.release(id);if(staging)fs.rmSync(staging,{force:true});}
  }
  async close():Promise<void>{this.closed=true;if(this.scanTimer)clearInterval(this.scanTimer);await this.background;await Promise.allSettled(this.observations);await this.initialization;}
}
