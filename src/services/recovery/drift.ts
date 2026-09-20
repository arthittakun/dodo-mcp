import fs from 'node:fs';
import { DodoError } from '../../errors.js';
import { digestOf } from '../../util/hash.js';
import type { AppServices } from '../../tools/context.js';
import type { PlanFileChange } from '../changes/types.js';
import type { RecoveryService } from './recoveryService.js';
import type { RecoveryEntry, RecoveryManifest } from './contracts.js';
import { rootIdentity } from './storage.js';

type State = { rootIdentity:string; entries:RecoveryEntry[]; revision:number };
export interface DriftChange { path:string; change:'added'|'modified'|'deleted'; beforeHash:string|null; observedHash:string|null }
const absent=(path:string):RecoveryEntry=>({path,kind:'absent',hash:null,mode:null,bytes:0});
const comparable=(e:RecoveryEntry)=>[e.kind,e.hash,e.mode,e.identity??null];
/** Expected bytes advance only from a committed journal or explicit owner review.
 * Capturing an emergency/owner snapshot never silently adopts external changes. */
export class RecoveryDrift {
  private observation: {digest:string; checkedAt:number; changes:DriftChange[]; critical:boolean; snapshotId:string|null}|undefined;
  private lastError:string|null=null;
  constructor(private readonly s:AppServices,private readonly recovery:RecoveryService){}
  private load():State|undefined {
    const row=this.s.store.db.prepare('SELECT payload FROM recovery_drift WHERE workspace_id=?').get(this.s.workspaceId) as {payload:string}|undefined;
    if(!row)return undefined;
    const state=JSON.parse(row.payload) as State;
    if(state.rootIdentity!==rootIdentity(this.s.wfs.root))throw new DodoError('PATH_DENIED','expected source belongs to a different root identity');
    return state;
  }
  initialize(m:RecoveryManifest):void {
    if(this.load())return;
    this.save({rootIdentity:m.rootIdentity,entries:m.entries,revision:0},m.id);
  }
  private save(state:State,baseline?:string):void {
    if(baseline)this.s.store.db.prepare('INSERT INTO recovery_drift VALUES (?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET payload=excluded.payload,baseline_id=excluded.baseline_id').run(this.s.workspaceId,JSON.stringify(state),baseline);
    else this.s.store.db.prepare('UPDATE recovery_drift SET payload=? WHERE workspace_id=?').run(JSON.stringify(state),this.s.workspaceId);
  }
  trackedPaths():string[]{return this.load()?.entries.filter(e=>e.kind!=='absent').map(e=>e.path)??[];}
  status(limit=50,cursor=0){return {state:this.lastError?'unavailable':!this.load()?'pending':!this.observation?'not_scanned':this.observation.changes.length?'external_changes':'unchanged',
    attribution:'unknown' as const,checkedAt:this.observation?.checkedAt??null,digest:this.observation?.digest??null,
    changedCount:this.observation?.changes.length??0,critical:this.observation?.critical??false,emergencyCheckpointId:this.observation?.snapshotId??null,
    changes:(this.observation?.changes??[]).filter(c=>{try{this.recovery.assertSourcePath(c.path);return true;}catch{return false;}}).slice(cursor,cursor+limit),
    nextCursor:cursor+limit<(this.observation?.changes.length??0)?cursor+limit:null,truncated:cursor+limit<(this.observation?.changes.length??0),errorCode:this.lastError};}
  private compare(expected:RecoveryEntry[],current:RecoveryEntry[]):DriftChange[]{
    const before=new Map(expected.map(e=>[e.path,e])),after=new Map(current.map(e=>[e.path,e]));const changes:DriftChange[]=[];
    for(const path of [...new Set([...before.keys(),...after.keys()])].sort()){
      // A newly excluded credential/data path must not leak through old metadata.
      try{this.recovery.assertSourcePath(path);}catch{continue;}
      const a=before.get(path)??absent(path),b=after.get(path)??absent(path);
      if(digestOf(comparable(a))!==digestOf(comparable(b)))changes.push({path,change:b.kind==='absent'?'deleted':a.kind==='absent'?'added':'modified',beforeHash:a.hash,observedHash:b.hash});
    }return changes;
  }
  async guard(targets?:string[]):Promise<void>{
    if(!this.load())return;
    if(!targets){const status=await this.scan();if(status.critical)throw new DodoError('CONFLICT','significant external source drift requires owner review before commands',{detail:{changedCount:status.changedCount,observationDigest:status.digest},recovery:'compare and acknowledge the exact observation in Recovery, or preview a restore'});return;}
    const expected=this.load()!;
    const current=await this.recovery.currentEntries(targets);
    const relevant=expected.entries.filter(e=>targets.some(t=>e.path===t||e.path.startsWith(t+'/')));
    // Ordinary ignore rules may omit the first before-image; named targets are
    // still captured. Once journaled, they stay tracked regardless of ignores.
    const known=new Set(expected.entries.map(e=>e.path));
    const compared=current.filter(e=>known.has(e.path)||!this.s.wfs.ignores.isOrdinarilyIgnored(e.path,e.kind==='directory'));
    const changes=this.compare(relevant,compared);
    if(changes.length){await this.scan();throw new DodoError('FILE_CHANGED','mutation target differs from recorded source; owner review is required',{detail:{paths:changes.slice(0,20).map(c=>c.path)},recovery:'compare external changes in Recovery; acknowledge only the reviewed state or preview a restore'});}
  }
  async scan(){
    this.recovery.assertProject();const expected=this.load();if(!expected)return this.status();
    try{
      const current=await this.recovery.currentEntries(undefined,this.trackedPaths());
      const changes=this.compare(expected.entries,current),policy=this.recovery.policy();
      const fileChanges=changes.filter(c=>c.beforeHash!==null||c.observedHash!==null);
      const denominator=Math.max(1,expected.entries.filter(e=>e.kind==='file').length);
      const critical=(fileChanges.length>=policy.massFiles&&100*fileChanges.length/denominator>policy.massPercent)||fileChanges.filter(c=>c.change==='deleted').length>=policy.deletedFiles;
      const digest=digestOf({revision:expected.revision,current});let snapshotId:string|null=null;
      if(changes.length){
        if(this.observation?.digest===digest&&this.observation.snapshotId)snapshotId=this.observation.snapshotId;
        else {
          snapshotId=await this.recovery.captureObserved();
          const m=await this.recovery.storage.readVerified(snapshotId,this.s.workspaceId);
          // The emergency capture can contain additional ordinarily ignored tracked
          // targets. Use the same source+tracked inventory for both observations.
          const after=await this.recovery.currentEntries(undefined,this.trackedPaths());
          if(digestOf(after)!==digestOf(current))throw new DodoError('FILE_CHANGED','source changed while recording external drift');
          if(m.rootIdentity!==expected.rootIdentity)throw new DodoError('PATH_DENIED','source root changed');
        }
      }
      this.observation={digest,checkedAt:Date.now(),changes,critical,snapshotId};this.lastError=null;return this.status();
    }catch(e){this.lastError=e instanceof DodoError?e.code:'BACKUP_IO_ERROR';throw e;}
  }
  async acknowledge(digest:string,revalidate:()=>void){
    const observed=await this.scan();if(observed.digest!==digest)throw new DodoError('FILE_CHANGED','source changed since review; scan and compare again');
    revalidate();const id=await this.recovery.captureObserved();
    const m=await this.recovery.storage.readVerified(id,this.s.workspaceId);
    const current=await this.recovery.currentEntries(undefined,this.trackedPaths()),state=this.load()!;
    if(digestOf({revision:state.revision,current})!==digest)throw new DodoError('FILE_CHANGED','source changed during acknowledgement');
    revalidate();this.s.store.db.transaction(()=>{
      this.save({rootIdentity:state.rootIdentity,entries:current,revision:state.revision+1},m.id);
      this.s.store.audit({principal:'local-config-owner',workspaceId:this.s.workspaceId,tool:'recovery.drift.acknowledge',inputDigest:digest,result:'acknowledged_observed_not_verified'});
    })();this.observation=undefined;return this.scan();
  }
  /** Called inside the SAME transaction as journal commit, after byte verification.
   * No asynchronous reread can accidentally adopt another writer's contents. */
  committed(files:PlanFileChange[]):void {
    const state=this.load();if(!state)return;const entries=new Map(state.entries.map(e=>[e.path,e]));
    const set=(p:string,kind:RecoveryEntry['kind'],hash:string|null,bytes:number)=>{
      const st=kind==='absent'?undefined:fs.lstatSync(this.s.wfs.resolve(p).abs);
      entries.set(p,{path:p,kind,hash:hash?.replace(/^sha256:/,'')??null,bytes,mode:st?st.mode&0o777:null,...(kind==='directory'?{identity:rootIdentity(this.s.wfs.resolve(p).abs)}:{})});
    };
    for(const f of files){
      for(const p of f.createParents??[])if(!entries.has(p))set(p,'directory',null,0);
      if(f.action==='move'){set(f.path,'absent',null,0);set(f.destPath!,'file',f.afterHash,f.bytesAfter);}
      else if(f.action==='delete'||f.action==='rmdir')set(f.path,'absent',null,0);
      else if(f.action==='mkdir')set(f.path,'directory',null,0);
      else set(f.path,'file',f.afterHash,f.bytesAfter);
    }
    state.entries=[...entries.values()].sort((a,b)=>a.path.localeCompare(b.path));state.revision++;this.save(state);this.observation=undefined;
  }
}
