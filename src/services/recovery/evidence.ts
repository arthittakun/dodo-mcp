import { z } from 'zod';
import type { AppServices } from '../../tools/context.js';
import type { RecoveryService } from './recoveryService.js';
import type { RecoveryActor } from './history.js';
import type { RecoveryEntry } from './contracts.js';
import { readVerificationEvidence } from '../assistance/verification.js';
import { DodoError } from '../../errors.js';
import { digestOf } from '../../util/hash.js';

interface Binding { id:string; actor:string; snapshot_id:string; manifest_digest:string; created_at:number; result_json:string|null; stale:number }
interface Pointer { name:string; snapshotId:string|null; revision:number; updatedAt:number }
export const PointerName=z.string().trim().min(1).max(64).regex(/^[\p{L}\p{N}][\p{L}\p{N}\p{M} ._-]*$/u)
  .refine(n=>!/^production(?:[ _.-]|$)|^last[ _.-]verified$/i.test(n),'reserved recovery name');
// Directory inode is not source content; modes and every included file hash ARE.
const sourceDigest=(entries:RecoveryEntry[])=>digestOf(entries.map(({path,kind,hash,bytes,mode})=>({path,kind,hash,bytes,mode})));

/** Evidence and owner labels never grant execution or restore authority. */
export class RecoveryEvidence {
  constructor(private s:AppServices,private r:RecoveryService){}
  private get db(){return this.s.store.db;}
  async bind(id:string,actor:string,snapshotId:string){
    const m=await this.r.history.manifest(snapshotId,{id:actor});
    if(m.scope!=='source'||sourceDigest(m.entries)!==sourceDigest(await this.r.currentEntries()))throw new DodoError('FILE_CHANGED','source changed before verification launch');
    this.db.prepare('INSERT INTO recovery_verifications (id,workspace_id,actor,snapshot_id,manifest_digest,created_at) VALUES (?,?,?,?,?,?)')
      .run(id,this.s.workspaceId,actor,m.id,digestOf(m),Date.now());
  }
  private binding(id:string,a:RecoveryActor){
    this.r.assertProject();
    const b=this.db.prepare('SELECT * FROM recovery_verifications WHERE id=? AND workspace_id=?').get(id,this.s.workspaceId) as Binding|undefined;
    if(!b||(!a.owner&&b.actor!==a.id))throw new DodoError('NOT_FOUND','verification unavailable for this caller/project');return b;
  }
  async inspect(id:string,a:RecoveryActor){
    const b=this.binding(id,a);
    let state:'VERIFIED'|'FAILED'|'INCONCLUSIVE'|'STALE'='INCONCLUSIVE',reason='evidence_unavailable';
    let evidence:ReturnType<typeof readVerificationEvidence>|null=null;
    let sourceMatches=false;
    try{
      evidence=readVerificationEvidence(this.s,id,b.actor);
      const m=await this.r.history.manifest(b.snapshot_id,a);
      sourceMatches=digestOf(m)===b.manifest_digest&&m.policyDigest===digestOf(this.r.policy())&&sourceDigest(m.entries)===sourceDigest(await this.r.currentEntries());
      // Re-read live jobs/recipe/source AFTER the asynchronous manifest check.
      evidence=readVerificationEvidence(this.s,id,b.actor);
      if(evidence.status==='failed'){state='FAILED';reason='required_check_failed';}
      else if(b.stale||!sourceMatches||evidence.status==='stale'){state='STALE';reason='source_recipe_or_runtime_changed';}
      else if(evidence.status==='passed'){state='VERIFIED';reason='selected_required_checks_passed';}
      else reason=evidence.status==='running'?'jobs_running':'missing_or_incomplete_evidence';
    }catch(e){reason=e instanceof DodoError?e.code:'evidence_unavailable';}
    if(state==='VERIFIED'&&this.binding(id,a).stale){state='STALE';reason='previously_observed_drift';}
    const result={verificationId:b.id,checkpointId:b.snapshot_id,manifestHash:b.manifest_digest,state,reason,sourceMatches,
      checkedAt:Date.now(),createdAt:b.created_at,evidence,scope:'included_source_and_selected_checks',production:'NOT_CONFIGURED',database:'NOT_SUPPORTED'};
    // Sanitized evidence only: no stdout/stderr, arbitrary messages or environment values.
    this.db.prepare('UPDATE recovery_verifications SET result_json=?,stale=MAX(stale,?),verified_at=COALESCE(verified_at,?) WHERE id=? AND workspace_id=?').run(JSON.stringify(result),Number(state==='STALE'),state==='VERIFIED'?result.checkedAt:null,id,this.s.workspaceId);
    return result;
  }
  list(a:RecoveryActor,cursor=0,limit=10){
    this.r.assertProject();
    const rows=this.db.prepare(`SELECT * FROM recovery_verifications WHERE workspace_id=? ${a.owner?'':'AND actor=?'} ORDER BY created_at DESC,id LIMIT ? OFFSET ?`)
      .all(this.s.workspaceId,...(a.owner?[]:[a.id]),limit+1,cursor) as Binding[];
    return {items:rows.slice(0,limit).map(b=>({verificationId:b.id,checkpointId:b.snapshot_id,createdAt:b.created_at,
      lastObservation:b.result_json?JSON.parse(b.result_json) as Record<string,unknown>:null,freshness:'refresh_required'})),nextCursor:rows.length>limit?cursor+limit:null};
  }
  summary(){
    const row=this.db.prepare('SELECT MAX(verified_at) AS lastVerifiedAt FROM recovery_verifications WHERE workspace_id=?').get(this.s.workspaceId) as {lastVerifiedAt:number|null};
    // Public overview discloses no cross-caller IDs, titles, paths or test details.
    return {lastVerifiedAt:row.lastVerifiedAt,freshness:'historical_observation_only',production:'NOT_CONFIGURED',database:'NOT_SUPPORTED'};
  }
  pointerEvents(cursor=0,limit=20){
    this.r.assertProject();
    const rows=this.db.prepare('SELECT seq,name,previous_id AS previousId,snapshot_id AS snapshotId,revision,created_at AS createdAt FROM recovery_pointer_events WHERE workspace_id=? ORDER BY seq DESC LIMIT ? OFFSET ?').all(this.s.workspaceId,limit+1,cursor);
    return {items:rows.slice(0,limit),nextCursor:rows.length>limit?cursor+limit:null};
  }
  pointers():Pointer[]{
    this.r.assertProject();
    return this.db.prepare('SELECT name,snapshot_id AS snapshotId,revision,updated_at AS updatedAt FROM recovery_pointers WHERE workspace_id=? ORDER BY name').all(this.s.workspaceId) as Pointer[];
  }
  async mark(name:string,snapshotId:string|null,expectedRevision:number,revalidate:()=>void){
    name=PointerName.parse(name);
    return this.s.mutations!.run(async()=>{
      this.r.assertProject();if(snapshotId)await this.r.history.manifest(snapshotId,{id:'local-config-owner',owner:true});
      revalidate();
      return this.db.transaction(()=>{
        const old=this.pointers().find(p=>p.name===name);
        if((old?.revision??0)!==expectedRevision)throw new DodoError('CONFLICT','checkpoint name changed since review; refresh before saving');
        if(!old&&this.pointers().length>=100)throw new DodoError('RESOURCE_LIMIT','named checkpoint limit reached');
        const revision=expectedRevision+1,now=Date.now();
        this.db.prepare('INSERT INTO recovery_pointers VALUES (?,?,?,?,?) ON CONFLICT(workspace_id,name) DO UPDATE SET snapshot_id=excluded.snapshot_id,revision=excluded.revision,updated_at=excluded.updated_at').run(this.s.workspaceId,name,snapshotId,revision,now);
        this.db.prepare('INSERT INTO recovery_pointer_events (workspace_id,name,previous_id,snapshot_id,revision,created_at) VALUES (?,?,?,?,?,?)').run(this.s.workspaceId,name,old?.snapshotId??null,snapshotId,revision,now);
        this.s.store.audit({principal:'local-config-owner',workspaceId:this.s.workspaceId,tool:'recovery.mark',refId:snapshotId??'cleared',inputDigest:digestOf({name,previous:old?.snapshotId??null,snapshotId,revision}),result:'owner_marked'});
        return {name,snapshotId,revision,updatedAt:now,label:snapshotId?'OWNER_MARKED_STABLE':'cleared',tested:false};
      }).immediate();
    });
  }
  async pin(snapshotId:string,pinned:boolean,expectedPinned:boolean,revalidate:()=>void){
    return this.s.mutations!.run(async()=>{
      await this.r.history.manifest(snapshotId,{id:'local-config-owner',owner:true});revalidate();
      return this.db.transaction(()=>{
        const changed=this.db.prepare('UPDATE recovery_snapshots SET pinned=? WHERE id=? AND workspace_id=? AND pinned=?').run(Number(pinned),snapshotId,this.s.workspaceId,Number(expectedPinned));
        if(changed.changes!==1)throw new DodoError('CONFLICT','pin changed since review; refresh first');
        this.s.store.audit({principal:'local-config-owner',workspaceId:this.s.workspaceId,tool:'recovery.pin',refId:snapshotId,result:pinned?'pinned':'unpinned'});
        return {checkpointId:snapshotId,pinned};
      }).immediate();
    });
  }
}
