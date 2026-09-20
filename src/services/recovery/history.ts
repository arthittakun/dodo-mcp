import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { createTwoFilesPatch } from 'diff';
import type { AppServices } from '../../tools/context.js';
import type { RecoveryService } from './recoveryService.js';
import type { RecoveryEntry, RecoveryManifest } from './contracts.js';
import type { PlanFileChange, StoredPlan } from '../changes/types.js';
import { DodoError } from '../../errors.js';
import { digestOf, newId, sha256Bytes } from '../../util/hash.js';
import { truncateUtf8, looksBinary, decodeUtf8Strict } from '../../util/bytes.js';
import { rootIdentity } from './storage.js';

export interface RecoveryActor { id: string; owner?: boolean }
interface Session { id:string; workspace_id:string; actor:string; root_identity:string; epoch:string; title:string; state:string; baseline_id:string|null; dirty_json:string; created_at:number; ended_at:number|null }
interface Event { seq:number; session_id:string; snapshot_id:string|null; kind:string; ref:string|null; created_at:number }
interface Operation { actor:string; sessionId?:string; implicit:boolean; snapshotId?:string }
export interface RestoreSelection { checkpointId?:string; sessionId?:string; paths?:string[]; exactMirror?:boolean }
interface RestoreMeta { version:1; identity:string; epoch:string; source:RestoreSelection; snapshotIds:string[]; selectionDigest:string; planHash:string }
const absent=(path:string):RecoveryEntry=>({path,kind:'absent',hash:null,bytes:0,mode:null});
const selected=(p:string,paths:string[])=>!paths.length||paths.some(s=>s==='.'||p===s||p.startsWith(s+'/'));

/** Private durable history, never conversation memory or a source of authorization. */
export class RecoveryHistory {
  private context=new AsyncLocalStorage<Operation>();
  constructor(private s:AppServices,private recovery:RecoveryService){}
  private get db(){return this.s.store.db;}
  private assertRoot(){this.recovery.assertProject();}
  reconcile():void {
    this.db.prepare("UPDATE recovery_sessions SET state='interrupted',ended_at=? WHERE workspace_id=? AND state='open'").run(Date.now(),this.s.workspaceId);
    this.db.prepare('DELETE FROM recovery_plan_refs WHERE plan_id IN (SELECT plan_id FROM recovery_restore_plans WHERE workspace_id=?) AND plan_id IN (SELECT id FROM change_plans WHERE epoch<>? OR expires_at<? OR invalidated_at IS NOT NULL)').run(this.s.workspaceId,this.s.epoch,Date.now());
  }
  private session(id:string,a:RecoveryActor):Session {
    this.assertRoot();
    const row=this.db.prepare('SELECT * FROM recovery_sessions WHERE id=? AND workspace_id=?').get(id,this.s.workspaceId) as Session|undefined;
    if(!row||(!a.owner&&row.actor!==a.id))throw new DodoError('NOT_FOUND','recovery session is unavailable for this caller/project');
    if(row.root_identity!==rootIdentity(this.s.wfs.root))throw new DodoError('PATH_DENIED','session belongs to a replaced project directory');
    return row;
  }
  private newSession(id:string,actor:string,title:string):void {
    this.assertRoot();
    if((this.db.prepare('SELECT COUNT(*) n FROM recovery_sessions WHERE workspace_id=?').get(this.s.workspaceId) as {n:number}).n>=10000)throw new DodoError('RESOURCE_LIMIT','Recovery session history limit reached; owner review is required');
    this.db.prepare("INSERT INTO recovery_sessions (id,workspace_id,actor,root_identity,epoch,title,state,created_at) VALUES (?,?,?,?,?,?,'open',?)")
      .run(id,this.s.workspaceId,actor,rootIdentity(this.s.wfs.root),this.s.epoch,title,Date.now());
  }
  async around<T>(actor:string,sessionId:string|undefined,fn:()=>Promise<T>):Promise<T> {
    const inherited=this.context.getStore();if(inherited){if(sessionId&&inherited.sessionId!==sessionId)throw new DodoError('INVALID_INPUT','nested recovery session override');return fn();}
    if(sessionId){const row=this.session(sessionId,{id:actor});if(row.state!=='open'||row.epoch!==this.s.epoch)throw new DodoError('CONFLICT','session is not open in this epoch; begin a new session');}
    const op:Operation={actor,implicit:!sessionId,...(sessionId?{sessionId}:{})};
    return this.context.run(op,async()=>{try{return await fn();}finally{if(op.implicit&&op.sessionId)this.end(op.sessionId,{id:actor});}});
  }
  sessionForCapture(actor:string):string {
    const op=this.context.getStore();
    if(op?.sessionId)return op.sessionId;
    const id=`implicit_${randomUUID()}`;this.newSession(id,actor,'Automatic operation');if(op)op.sessionId=id;return id;
  }
  published(m:RecoveryManifest):void {
    if(m.trigger==='activation')return;
    const op=this.context.getStore();
    this.db.transaction(()=>{
      this.db.prepare('INSERT INTO recovery_events (session_id,snapshot_id,kind,created_at) VALUES (?,?,?,?)').run(m.sessionId,m.id,'checkpoint',Date.now());
      this.db.prepare('UPDATE recovery_sessions SET baseline_id=COALESCE(baseline_id,?) WHERE id=?').run(m.id,m.sessionId);
      if(!op)this.db.prepare("UPDATE recovery_sessions SET state='closed',ended_at=? WHERE id=?").run(Date.now(),m.sessionId);
    })();
    if(op)op.snapshotId=m.id;
  }
  record(kind:'changeset'|'job'|'verification',ref:string):void {
    const op=this.context.getStore();if(!op?.sessionId)return;
    this.db.prepare('INSERT INTO recovery_events (session_id,snapshot_id,kind,ref,created_at) VALUES (?,?,?,?,?)')
      .run(op.sessionId,op.snapshotId??null,kind,ref,Date.now());
  }
  async begin(actor:RecoveryActor,title:string):Promise<{sessionId:string;checkpointId:string}> {
    return this.s.mutations!.run(async()=>{
      this.assertRoot();if(!this.recovery.policy().enabled)throw new DodoError('CONFLICT','Recovery is disabled by the owner');
      await this.recovery.checkpoint('activation','system:activation');
      const id=newId('rs');this.newSession(id,actor.id,title);
      try {
        const checkpointId=await this.context.run({actor:actor.id,sessionId:id,implicit:false},()=>this.recovery.checkpoint('owner-checkpoint',actor.id));
        if(!checkpointId)throw new DodoError('CONFLICT','register and enable Recovery first');
        // Status is bounded and already filters secret paths. Never change the Git index.
        try{const git=await this.s.git.status();const entries=git.entries.filter(e=>{try{this.recovery.assertSourcePath(e.path);return true;}catch{return false;}});this.db.prepare('UPDATE recovery_sessions SET dirty_json=? WHERE id=?').run(JSON.stringify({isRepo:git.isRepo,entries,truncated:git.truncated}),id);}catch{this.db.prepare('UPDATE recovery_sessions SET dirty_json=? WHERE id=?').run('{"status":"unavailable"}',id);}
        return {sessionId:id,checkpointId};
      }catch(e){this.db.prepare("UPDATE recovery_sessions SET state='interrupted',ended_at=? WHERE id=?").run(Date.now(),id);throw e;}
    });
  }
  end(id:string,a:RecoveryActor){const row=this.session(id,a);this.db.prepare("UPDATE recovery_sessions SET state='closed',ended_at=? WHERE id=? AND state='open'").run(Date.now(),id);return {sessionId:id,state:row.state==='open'?'closed':row.state};}
  list(a:RecoveryActor,kind:'sessions'|'checkpoints',cursor=0,limit=20){
    this.assertRoot();
    if(!Number.isSafeInteger(cursor)||cursor<0||cursor>1000000||limit<1||limit>100)throw new DodoError('INVALID_INPUT','invalid recovery page');
    if(kind==='sessions'){
      const rows=this.db.prepare(`SELECT id,actor,title,state,created_at,ended_at FROM recovery_sessions WHERE workspace_id=? ${a.owner?'':'AND actor=?'} ORDER BY created_at DESC,id LIMIT ? OFFSET ?`).all(this.s.workspaceId,...(a.owner?[]:[a.id]),limit+1,cursor);
      return {items:rows.slice(0,limit),nextCursor:rows.length>limit?cursor+limit:null,sourceOnly:true};
    }
    const rows=this.db.prepare(`SELECT DISTINCT s.id,s.state,s.scope,s.bytes,s.created_at,s.pinned FROM recovery_snapshots s LEFT JOIN recovery_events e ON s.id=e.snapshot_id LEFT JOIN recovery_sessions r ON r.id=e.session_id WHERE s.workspace_id=? ${a.owner?'':'AND r.actor=?'} ORDER BY s.created_at DESC,s.id LIMIT ? OFFSET ?`).all(this.s.workspaceId,...(a.owner?[]:[a.id]),limit+1,cursor);
    return {items:rows.slice(0,limit),nextCursor:rows.length>limit?cursor+limit:null,sourceOnly:true};
  }
  async manifest(id:string,a:RecoveryActor):Promise<RecoveryManifest>{
    this.assertRoot();
    if(!a.owner&&!this.db.prepare('SELECT 1 FROM recovery_events e JOIN recovery_sessions r ON r.id=e.session_id WHERE e.snapshot_id=? AND r.workspace_id=? AND r.actor=?').get(id,this.s.workspaceId,a.id))throw new DodoError('NOT_FOUND','checkpoint unavailable for this caller/project');
    const m=await this.recovery.storage.readVerified(id,this.s.workspaceId);
    if(m.rootIdentity!==rootIdentity(this.s.wfs.root))throw new DodoError('PATH_DENIED','checkpoint root identity changed');
    return m;
  }
  async inspect(a:RecoveryActor,input:{sessionId?:string;checkpointId?:string;cursor?:number;limit?:number}){
    const cursor=input.cursor??0,limit=input.limit??50;
    if(input.sessionId){const row=this.session(input.sessionId,a);const events=this.db.prepare('SELECT seq,kind,ref,snapshot_id,created_at FROM recovery_events WHERE session_id=? ORDER BY seq LIMIT ? OFFSET ?').all(row.id,limit+1,cursor);return {sessionId:row.id,title:row.title,state:row.state,baselineId:row.baseline_id,dirtyState:this.filteredDirty(row.dirty_json),events:events.slice(0,limit),nextCursor:events.length>limit?cursor+limit:null,sourceOnly:true};}
    if(!input.checkpointId)throw new DodoError('INVALID_INPUT','choose a checkpoint or session');
    const m=await this.manifest(input.checkpointId,a);const allowed=m.entries.filter(e=>{try{this.recovery.assertSourcePath(e.path);return true;}catch{return false;}});
    return {checkpointId:m.id,scope:m.scope,createdAt:m.createdAt,actor:m.actor,entries:allowed.slice(cursor,cursor+limit),nextCursor:allowed.length>cursor+limit?cursor+limit:null,excludedByPolicy:m.excludedByPolicy+(m.entries.length-allowed.length),sourceOnly:true};
  }
  private filteredDirty(raw:string){
    const data=JSON.parse(raw) as {isRepo?:boolean;truncated?:boolean;status?:string;entries?:Array<{path:string;status:string}>};
    return {...data,...(data.entries?{entries:data.entries.filter(e=>{try{this.recovery.assertSourcePath(e.path);return true;}catch{return false;}})}:{})};
  }
  private current(rel:string):RecoveryEntry {
    this.recovery.assertSourcePath(rel);
    const r=this.s.wfs.resolve(rel,{allowMissing:true});if(!r.stat)return absent(rel);
    if(r.stat.isDirectory())return {path:rel,kind:'directory',hash:null,bytes:0,mode:r.stat.mode&0o777,identity:rootIdentity(r.abs)};
    const {bytes,stat}=this.s.wfs.readFileBytes(rel,this.s.limits.readFileBytes);
    return {path:rel,kind:'file',hash:sha256Bytes(bytes).slice(7),bytes:bytes.length,mode:stat.mode&0o777};
  }
  private async desired(a:RecoveryActor,selection:RestoreSelection){
    if(Boolean(selection.checkpointId)===Boolean(selection.sessionId))throw new DodoError('INVALID_INPUT','choose exactly one checkpoint or session');
    const paths=(selection.paths??[]).map(p=>this.s.wfs.normalizeRel(p)),desired=new Map<string,RecoveryEntry>(),expected=new Map<string,RecoveryEntry>(),ids=new Set<string>();
    if(selection.checkpointId){const m=await this.manifest(selection.checkpointId,a);ids.add(m.id);for(const e of m.entries)if(selected(e.path,paths)){this.recovery.assertSourcePath(e.path);desired.set(e.path,e);}
      if(selection.exactMirror){if(m.scope!=='source')throw new DodoError('INVALID_INPUT','exact mirror requires a complete source checkpoint');for(const e of await this.recovery.currentEntries())if(e.kind==='file'&&selected(e.path,paths)&&!desired.has(e.path))desired.set(e.path,absent(e.path));}
    }else{
      if(selection.exactMirror)throw new DodoError('INVALID_INPUT','session undo never mirrors unrelated files');
      const row=this.session(selection.sessionId!,a);
      const events=this.db.prepare('SELECT * FROM recovery_events WHERE session_id=? ORDER BY seq').all(row.id) as Event[];
      if(events.some(e=>e.kind==='job'))throw new DodoError('CONFLICT','session contains shell/job effects with unknown authorship; preview a specific checkpoint instead');
      for(const event of events.filter(e=>e.kind==='changeset')){
        const cs=this.s.store.getChangeset(event.ref!);if(!cs||cs.workspaceId!==this.s.workspaceId||!event.snapshot_id)throw new DodoError('RECOVERY_REQUIRED','session receipt chain is incomplete');
        if(cs.status==='failed')continue;
        if(!['committed','rolled_back'].includes(cs.status))throw new DodoError('RECOVERY_REQUIRED','session has an unfinished journal');
        const m=await this.manifest(event.snapshot_id,a);ids.add(m.id);const before=new Map(m.entries.map(e=>[e.path,e]));
        const plan=cs.planId?this.s.store.getPlan(cs.planId):undefined;
        if(!plan)throw new DodoError('RECOVERY_REQUIRED','session plan receipt is missing');
        const plannedFiles=(JSON.parse(plan.payload) as StoredPlan).files;
        for(const step of this.s.store.listJournalSteps(cs.id)){
          const updates:Array<[string,string|null]>=[[step.path,step.op==='move'?null:step.afterHash]];if(step.destPath)updates.push([step.destPath,step.afterHash]);
          for(const [p,h]of updates){if(!selected(p,paths))continue;this.recovery.assertSourcePath(p);const pre=before.get(p);if(!pre)throw new DodoError('RECOVERY_REQUIRED','missing session before-image');
            const last=expected.get(p);if(last&&(last.kind!==pre.kind||last.hash!==pre.hash||(last.identity&&last.identity!==pre.identity)||(process.platform!=='win32'&&last.mode!==null&&last.mode!==pre.mode)))throw new DodoError('FILE_CHANGED','external/interleaved edit detected between session receipts');
            const mode=plannedFiles[step.seq]?.mode??before.get(step.path)?.mode??null;
            if(!desired.has(p))desired.set(p,pre);expected.set(p,step.op==='mkdir'?{path:p,kind:'directory',hash:null,bytes:0,mode,identity:this.s.store.getMeta(`journal-directory:${cs.id}:${step.seq}`)??'unknown'}:h?{path:p,kind:'file',hash:h.replace(/^sha256:/,''),bytes:0,mode}:absent(p));
          }
        }
      }
    }
    const conflicts:Array<{path:string;reason:string}>=[];
    for(const [p,e]of expected){const current=this.current(p);if(e.kind!==current.kind||e.hash!==current.hash||(e.identity&&e.identity!==current.identity)||(process.platform!=='win32'&&e.mode!==null&&e.mode!==current.mode))conflicts.push({path:p,reason:'changed after this session; no merge or overwrite'});}
    return {desired,ids,conflicts,selectionDigest:digestOf([...desired])};
  }
  async preview(a:RecoveryActor,selection:RestoreSelection){
    return this.s.mutations!.run(async()=>{
      const {desired,ids,conflicts,selectionDigest}=await this.desired(a,selection);
      const files:PlanFileChange[]=[];let aggregate=0;
      for(const [rel,want]of desired){
        const current=this.current(rel);
        if(want.kind==='directory'){
          if(current.kind==='absent')files.push({path:rel,action:'mkdir',beforeHash:null,afterHash:'directory',mode:want.mode??0o755,createParents:this.s.wfs.resolveForCreate(rel,true).missingParents,diff:'create directory',diffTruncated:false,bytesBefore:0,bytesAfter:0});
          else if(current.kind!=='directory')conflicts.push({path:rel,reason:'file/directory type conflict'});
          else if(process.platform!=='win32'&&want.mode!==current.mode)conflicts.push({path:rel,reason:'existing directory permissions differ; preserved for owner review'});
          continue;
        }
        if(current.kind==='directory'){
          if(want.kind==='absent'&&selection.sessionId)files.push({path:rel,action:'rmdir',beforeHash:'directory:'+current.identity,afterHash:null,directoryIdentity:current.identity!,mode:current.mode??0o755,diff:'remove owned empty directory after selected file deletions',diffTruncated:false,bytesBefore:0,bytesAfter:0});
          else conflicts.push({path:rel,reason:'directory removal requires an empty owned directory plan'});
          continue;
        }
        if(want.kind===current.kind&&want.hash===current.hash&&(want.kind!=='file'||want.mode===current.mode))continue;
        if(files.length>=this.s.limits.previewFilesMax)throw new DodoError('RESOURCE_LIMIT','restore selection exceeds plan file limit; select fewer paths');
        let bytes:Buffer|undefined;
        if(want.kind==='file'){bytes=await this.recovery.storage.readObject(want.hash!,want.bytes,this.s.limits.readFileBytes);aggregate+=bytes.length;}
        if(aggregate>this.s.limits.previewAggregateBytes)throw new DodoError('RESOURCE_LIMIT','restore selection exceeds plan byte limit');
        const before=current.kind==='file'?this.s.wfs.readFileBytes(rel,this.s.limits.readFileBytes).bytes:Buffer.alloc(0);
        if(current.hash&&sha256Bytes(before)!=='sha256:'+current.hash)throw new DodoError('FILE_CHANGED','source changed during preview');
        const after=bytes??Buffer.alloc(0);let diff='Binary contents differ (hashes and sizes shown)';
        if(!looksBinary(before)&&!looksBinary(after)){try{diff=createTwoFilesPatch(rel,rel,decodeUtf8Strict(before)??'<binary>',decodeUtf8Strict(after)??'<binary>',undefined,undefined,{context:3,timeout:250,maxEditLength:10000})??'<diff exceeded computation budget; compare hashes>';}catch{/* binary encoding */}}
        const bounded=truncateUtf8(diff,Math.min(this.s.limits.toolContentBytes,16000));
        const f:PlanFileChange={path:rel,action:want.kind==='absent'?'delete':current.kind==='absent'?'create':'modify',beforeHash:current.hash?'sha256:'+current.hash:null,afterHash:want.hash?'sha256:'+want.hash:null,bytesBefore:current.bytes,bytesAfter:want.bytes,...(current.mode===null?{}:{beforeMode:current.mode}),diff:bounded.text,diffTruncated:bounded.truncated,...(bytes?{afterContentB64:bytes.toString('base64'),mode:want.mode??0o644}:{mode:current.mode??0o644})};
        if(f.action==='create'){const resolved=this.s.wfs.resolveForCreate(rel,true);if(resolved.missingParents.length)f.createParents=resolved.missingParents;}
        files.push(f);
      }
      // A partial directory selection may need ancestors outside that selection.
      // Include those structural creations in the reviewed journal, not hidden IO.
      const plannedPaths=new Set(files.map(f=>f.path));
      for(const file of [...files])if(file.action==='mkdir')for(const parent of file.createParents??[]){
        if(plannedPaths.has(parent))continue;
        this.recovery.assertSourcePath(parent);plannedPaths.add(parent);
        files.push({path:parent,action:'mkdir',beforeHash:null,afterHash:'directory',mode:0o755,createParents:this.s.wfs.resolveForCreate(parent,true).missingParents,diff:'create structural parent directory for selected restore',diffTruncated:false,bytesBefore:0,bytesAfter:0});
      }
      if(files.length>this.s.limits.previewFilesMax)throw new DodoError('RESOURCE_LIMIT','restore selection exceeds plan file limit');
      const order=(f:PlanFileChange)=>f.action==='mkdir'?0:f.action==='rmdir'?2:1;
      files.sort((a,b)=>order(a)-order(b)||(a.action==='mkdir'?a.path.length-b.path.length:a.action==='rmdir'?b.path.length-a.path.length:0));
      for(const f of files)if(f.action==='rmdir'){
        f.directoryChildren=files.filter(c=>(c.action==='delete'||c.action==='rmdir')&&path.posix.dirname(c.path)===f.path).map(c=>path.posix.basename(c.path));
        if(fs.readdirSync(this.s.wfs.resolve(f.path).abs).some(n=>!f.directoryChildren!.includes(n)))conflicts.push({path:f.path,reason:'directory contains unrelated entries; preserved'});
      }
      const view=files.map(({afterContentB64:_,...f})=>f);// bytes stay private; only bounded diffs go to the caller
      if(conflicts.length)return {applicable:false,conflicts:conflicts.slice(0,100),files:view,sourceOnly:true,planId:null,planHash:null};
      if(!files.length)return {applicable:false,conflicts:[],files:[],sourceOnly:true,planId:null,planHash:null,unchanged:true};
      const plan:StoredPlan={version:1,workspaceId:this.s.workspaceId,epoch:this.s.epoch,principal:a.id,source:'restore',summary:`restore ${files.length} source path(s)`,files};
      const id=newId('plan'),payload=JSON.stringify(plan),hash=digestOf({planId:id,payload}),expiresAt=Date.now()+this.s.limits.planExpiryMs;
      const meta:RestoreMeta={version:1,identity:rootIdentity(this.s.wfs.root),epoch:this.s.epoch,source:selection,snapshotIds:[...ids],selectionDigest,planHash:hash};
      this.db.transaction(()=>{this.s.store.putPlan({id,workspaceId:this.s.workspaceId,epoch:this.s.epoch,principal:a.id,planHash:hash,payload,ttlMs:this.s.limits.planExpiryMs});this.db.prepare('INSERT INTO recovery_restore_plans VALUES (?,?,?,?)').run(id,this.s.workspaceId,a.id,JSON.stringify(meta));for(const snap of ids)this.db.prepare('INSERT INTO recovery_plan_refs VALUES (?,?)').run(id,snap);})();// Preview writes private plan metadata only, never source/emergency snapshots.
      return {applicable:true,planId:id,planHash:hash,expiresAt,workspaceId:this.s.workspaceId,workspaceEpoch:this.s.epoch,files:view,conflicts:[],sourceOnly:true,coverage:'selected included source only; databases, secrets, volumes and external effects are excluded',exactMirror:selection.exactMirror??false};
    });
  }
  status(a:RecoveryActor,planId?:string){
    this.assertRoot();
    const rows=this.db.prepare(`SELECT r.plan_id,p.plan_hash,p.epoch,p.expires_at,p.invalidated_at FROM recovery_restore_plans r JOIN change_plans p ON p.id=r.plan_id WHERE r.workspace_id=? AND r.actor=? ${planId?'AND r.plan_id=?':''} ORDER BY p.created_at DESC LIMIT 20`).all(this.s.workspaceId,a.id,...(planId?[planId]:[])) as Array<{plan_id:string;plan_hash:string;epoch:string;expires_at:number;invalidated_at:number|null}>;
    if(planId&&!rows.length)throw new DodoError('NOT_FOUND','restore plan unavailable');
    return {plans:rows.map(r=>{
      const cs=this.db.prepare('SELECT id,status FROM changesets WHERE plan_id=? ORDER BY created_at DESC LIMIT 1').get(r.plan_id) as {id:string;status:string}|undefined;
      return {planId:r.plan_id,planHash:r.plan_hash,workspaceEpoch:r.epoch,workspaceId:this.s.workspaceId,expiresAt:r.expires_at,changesetId:cs?.id??null,status:cs?.status??(r.epoch!==this.s.epoch||r.expires_at<Date.now()?'expired':'planned')};
    })};
  }
  finishAgent(runId:string,actor:string):void {
    const key='recovery-agent:'+digestOf({runId,actor,workspace:this.s.workspaceId,epoch:this.s.epoch});const id=this.s.store.getMeta(key);
    if(id)this.end(id,{id:actor});
  }
  async forAgent(runId:string,actor:string):Promise<string|undefined>{
    if(!this.recovery.status().registered||!this.recovery.policy().enabled)return undefined;
    return this.s.mutations!.run(async()=>{
      const key='recovery-agent:'+digestOf({runId,actor,workspace:this.s.workspaceId,epoch:this.s.epoch});const saved=this.s.store.getMeta(key);
      if(saved&&this.session(saved,{id:actor}).state==='open')return saved;
      const result=await this.begin({id:actor},`Agent run ${runId}`);this.s.store.setMeta(key,result.sessionId);return result.sessionId;
    });
  }
  async apply(a:RecoveryActor,planId:string,planHash:string){
    return this.s.mutations!.run(async()=>{
      this.assertRoot();if(!this.recovery.policy().enabled)throw new DodoError('CONFLICT','enable Recovery before restore so the pre-restore source is protected');const row=this.db.prepare('SELECT payload FROM recovery_restore_plans WHERE plan_id=? AND workspace_id=? AND actor=?').get(planId,this.s.workspaceId,a.id) as {payload:string}|undefined;
      if(!row)throw new DodoError('NOT_FOUND','restore plan unavailable for this caller/project');
      const meta=JSON.parse(row.payload) as RestoreMeta;
      if(meta.planHash!==planHash)throw new DodoError('PLAN_HASH_MISMATCH','review the exact restore plan hash');
      if(meta.epoch!==this.s.epoch)throw new DodoError('STALE_WORKSPACE','preview restore again after restart');
      if(meta.identity!==rootIdentity(this.s.wfs.root))throw new DodoError('PATH_DENIED','restore root identity changed');
      for(const id of meta.snapshotIds)await this.manifest(id,a);
      const plan=this.s.store.getPlan(planId);if(!plan)throw new DodoError('NOT_FOUND','restore plan missing');
      for(const f of (JSON.parse(plan.payload) as StoredPlan).files)this.recovery.assertSourcePath(f.path);
      // Session history must still describe this exact selection; new receipts invalidate the plan.
      const current=await this.desired(a,meta.source);if(current.selectionDigest!==meta.selectionDigest||current.conflicts.length)throw new DodoError('FILE_CHANGED','session source drifted before restore');
      return this.around(a.id,undefined,async()=>{
        // Applier makes the pre-restore backup, rechecks all hashes and journals exact direction.
        const result=await this.recovery.withReviewedRestore(()=>this.s.applier.applyRecovery({planId,planHash,workspaceId:this.s.workspaceId,epoch:this.s.epoch,principal:a.id}));
        return {...result,verified:true,sourceOnly:true};
      });
    });
  }
}
