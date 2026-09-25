import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AppServices } from '../../tools/context.js';
import type { RecoveryService } from './recoveryService.js';
import type { RecoveryActor } from './history.js';
import { RecoveryPolicySchema, type RecoveryPolicy } from './contracts.js';
import { rootIdentity } from './storage.js';
import { digestOf } from '../../util/hash.js';
import { DodoError } from '../../errors.js';

export const RecoverySettingsSchema=z.object({
  projectBytes:RecoveryPolicySchema.shape.projectBytes.removeDefault().optional(),
  retentionDays:RecoveryPolicySchema.shape.retentionDays.removeDefault().optional(),
  retainedPoints:RecoveryPolicySchema.shape.retainedPoints.removeDefault().optional(),
  excludePaths:RecoveryPolicySchema.shape.excludePaths.removeDefault().optional(),
}).strict();
export type RecoverySettings=z.infer<typeof RecoverySettingsSchema>;
export type CleanupRequest={mode:'selected'|'retention'|'pending';checkpointIds:string[]};
interface Point {id:string;state:string;scope:string;bytes:number;created_at:number;pinned:number}
interface Session {id:string;actor:string;state:string;baseline_id:string|null}
interface Review {kind:'cleanup'|'settings';root:string;policyHash:string;selection?:CleanupRequest;changes?:RecoverySettings;decision:unknown}
interface PlanRow {id:string;workspace_id:string;actor:string;owner:number;epoch:string;payload:string;digest:string;expires_at:number;result_json:string|null}

/** Bounded owner-reviewed maintenance. Never edits source, approves actions,
 * discards integrity failures, or widens the caller's history access. */
export class RecoveryMaintenance {
  constructor(private s:AppServices,private r:RecoveryService){}
  private get db(){return this.s.store.db;}
  private points(a:RecoveryActor):Point[]{
    return this.db.prepare(`SELECT s.id,s.state,s.scope,s.bytes,s.created_at,s.pinned FROM recovery_snapshots s WHERE s.workspace_id=? ${a.owner?'':`AND EXISTS (SELECT 1 FROM recovery_events e JOIN recovery_sessions h ON h.id=e.session_id WHERE e.snapshot_id=s.id AND h.actor=?)`} ORDER BY s.created_at DESC,s.rowid DESC LIMIT 10001`).all(this.s.workspaceId,...(a.owner?[]:[a.id])) as Point[];
  }
  private sessions(id:string):Session[]{return this.db.prepare(`SELECT DISTINCT h.id,h.actor,h.state,h.baseline_id FROM recovery_sessions h LEFT JOIN recovery_events e ON e.session_id=h.id WHERE h.workspace_id=? AND (e.snapshot_id=? OR h.baseline_id=?)`).all(this.s.workspaceId,id,id) as Session[];}
  private protectedReason(p:Point,a:RecoveryActor,selected:Set<string>):string|null {
    const id=p.id,exists=(sql:string,...args:unknown[])=>Boolean(this.db.prepare(sql).get(...args));
    if(this.r.protectedCheckpointIds().includes(id))return 'active_baseline';
    if(exists("SELECT 1 FROM (SELECT id FROM recovery_snapshots WHERE workspace_id=? AND state='READY' ORDER BY created_at DESC,rowid DESC LIMIT 1) WHERE id=?",this.s.workspaceId,id)||exists("SELECT 1 FROM (SELECT id FROM recovery_snapshots WHERE workspace_id=? AND state='READY' AND scope='source' ORDER BY created_at DESC,rowid DESC LIMIT 1) WHERE id=?",this.s.workspaceId,id))return 'latest_backup';
    if(p.pinned)return 'pinned';
    if(exists('SELECT 1 FROM recovery_reservations WHERE id=?',id))return 'active_capture';
    if(exists('SELECT 1 FROM recovery_drift WHERE baseline_id=?',id))return 'drift_baseline';
    if(exists('SELECT 1 FROM recovery_pointers WHERE snapshot_id=?',id))return 'named_checkpoint';
    if(exists('SELECT 1 FROM recovery_deployments WHERE snapshot_id=?',id))return 'deployment_provenance';
    if(exists('SELECT 1 FROM recovery_database_bindings WHERE snapshot_id=?',id))return 'database_compatibility_rule';
    if(exists('SELECT 1 FROM recovery_plan_refs r JOIN change_plans p ON p.id=r.plan_id WHERE r.snapshot_id=? AND p.expires_at>=? AND p.invalidated_at IS NULL',id,Date.now()))return 'reviewed_restore_plan';
    for(const session of this.sessions(id)){
      if(!a.owner&&session.actor!==a.id)return 'other_caller_session';
      if(session.state==='open')return 'open_session';
      const refs=this.db.prepare('SELECT snapshot_id,kind,ref FROM recovery_events WHERE session_id=?').all(session.id) as Array<{snapshot_id:string|null;kind:string;ref:string|null}>;
      if(refs.some(e=>e.kind==='job'&&exists("SELECT 1 FROM jobs WHERE id=? AND status='running'",e.ref)||e.kind==='changeset'&&exists("SELECT 1 FROM changesets WHERE id=? AND status IN ('committing','recovery_required')",e.ref)))return 'unfinished_work';
      if((session.baseline_id&&!selected.has(session.baseline_id))||refs.some(e=>e.snapshot_id&&!selected.has(e.snapshot_id)))return 'select_complete_session';
    }
    return null;
  }
  private cleanup(a:RecoveryActor,selection:CleanupRequest){
    const points=this.points(a);if(points.length>10000)throw new DodoError('RESOURCE_LIMIT','Recovery history needs owner inspection');
    const visible=new Map(points.map(p=>[p.id,p]));
    let ids=[...new Set(selection.checkpointIds)].sort();
    if(selection.mode==='pending')ids=[];
    if(selection.mode==='retention')ids=this.r.storage.cleanupPreview(this.s.workspaceId,this.r.policy(),0,10001).items.filter(p=>p.eligible&&visible.has(p.checkpointId)).slice(0,100).map(p=>p.checkpointId).sort();
    if(ids.some(id=>!visible.has(id)))throw new DodoError('NOT_FOUND','checkpoint unavailable for this caller/project');
    const selected=new Set(ids);const reasons=new Map<string,string>();
    // Remove protected members to a fixed point so a partially selected session
    // can never erase the history of a checkpoint that remains protected.
    for(let pass=0;pass<=ids.length;pass++){
      let changed=false;
      for(const id of [...selected]){const reason=this.protectedReason(visible.get(id)!,a,selected);if(reason){selected.delete(id);reasons.set(id,reason);changed=true;}}
      if(!changed)break;
    }
    const sessions=[...new Set([...selected].flatMap(id=>this.sessions(id).map(s=>s.id)))].sort();
    const items=ids.map(id=>({checkpointId:id,logicalBytes:visible.get(id)!.bytes,state:visible.get(id)!.state,eligible:selected.has(id),reason:reasons.get(id)??'eligible'}));
    return {items,sessions,deleteIds:[...selected].sort(),logicalBytes:items.filter(p=>p.eligible).reduce((n,p)=>n+p.logicalBytes,0)};
  }
  reviewStatus(a:RecoveryActor,id:string){
    this.r.assertProject();const row=this.db.prepare('SELECT * FROM recovery_maintenance_plans WHERE id=? AND workspace_id=? AND actor=? AND owner=?').get(id,this.s.workspaceId,a.id,a.owner?1:0) as PlanRow|undefined;
    if(!row)throw new DodoError('NOT_FOUND','maintenance review unavailable');
    return {planId:id,expiresAt:row.expires_at,applied:row.result_json!==null,result:row.result_json?JSON.parse(row.result_json) as Record<string,unknown>:null};
  }
  status(a:RecoveryActor,cursor=0,limit=20){
    this.r.assertProject();const all=this.points(a),rows=all.slice(cursor,cursor+limit),usage=this.r.storage.usageFor(this.s.workspaceId);
    const sum=(sql:string,...args:unknown[])=>(this.db.prepare(sql).get(...args) as {n:number}).n;
    const gitBytes=sum('SELECT COALESCE(SUM(bytes),0) n FROM recovery_git_copies WHERE workspace_id=?',this.s.workspaceId);
    const {projectBytes,retentionDays,retainedPoints,excludePaths}=this.r.policy();
    return {...usage,uniqueSourceBytes:usage.projectBytes-gitBytes,gitCopyBytes:gitBytes,
      logicalCheckpointBytes:all.reduce((n,p)=>n+p.bytes,0),checkpointCount:all.length,
      quota:{projectBytes,installationBytes:this.r.storage.installationPolicy().storageBytes,freeFloorBytes:this.r.storage.installationPolicy().freeFloorBytes},
      settings:{projectBytes,retentionDays,retainedPoints,excludePaths},
      pendingFiles:sum(`SELECT COUNT(*) n FROM recovery_cleanup_files WHERE workspace_id=? ${a.owner?'':'AND actor=?'}`,this.s.workspaceId,...(a.owner?[]:[a.id])),
      items:rows.map(p=>({...p,protectedReason:this.protectedReason(p,a,new Set(all.map(p=>p.id)))})),nextCursor:all.length>cursor+limit?cursor+limit:null,
      note:'Checkpoint bytes are logical. Unique source objects are shared; Git copies are accounted separately. Filesystem overhead and temporary staging are not included. Exclusions affect future backups only.'};
  }
  private save(a:RecoveryActor,review:Review){
    this.r.assertProject();const id=`rm_${randomUUID()}`,expiresAt=Date.now()+15*60000;
    const payload=JSON.stringify(review),hash=digestOf({workspaceId:this.s.workspaceId,epoch:this.s.epoch,actor:a.id,owner:Boolean(a.owner),review});
    this.db.prepare('DELETE FROM recovery_maintenance_plans WHERE workspace_id=? AND expires_at<? AND result_json IS NULL').run(this.s.workspaceId,Date.now());
    if((this.db.prepare('SELECT COUNT(*) n FROM recovery_maintenance_plans WHERE workspace_id=?').get(this.s.workspaceId) as {n:number}).n>=10000)throw new DodoError('RESOURCE_LIMIT','maintenance review history is full');
    this.db.prepare('INSERT INTO recovery_maintenance_plans VALUES (?,?,?,?,?,?,?,?,NULL)').run(id,this.s.workspaceId,a.id,a.owner?1:0,this.s.epoch,payload,hash,expiresAt);
    return {planId:id,planHash:hash,expiresAt,kind:review.kind,decision:review.decision,requiresOwnerApproval:!a.owner};
  }
  previewCleanup(a:RecoveryActor,selection:CleanupRequest){
    this.r.assertProject();if(selection.mode==='selected'&&!selection.checkpointIds.length||selection.mode!=='selected'&&selection.checkpointIds.length)throw new DodoError('INVALID_INPUT','select checkpoint IDs only in selected mode');
    return this.save(a,{kind:'cleanup',root:rootIdentity(this.s.wfs.root),policyHash:digestOf(this.r.policy()),selection,decision:this.cleanup(a,selection)});
  }
  private settings(changes:RecoverySettings):RecoveryPolicy {
    const parsed=RecoverySettingsSchema.parse(changes);
    if(parsed.excludePaths)parsed.excludePaths=[...new Set(parsed.excludePaths.map(p=>{
      const candidate=p.replace(/\/+$/,'');const rel=this.s.wfs.normalizeRel(candidate);
      if(rel==='.'||rel!==candidate||/[?*\[\]]/.test(rel))throw new DodoError('INVALID_INPUT','exclusions must be relative file/directory paths, without wildcards or traversal');
      this.s.wfs.resolve(rel,{allowMissing:true});return rel;
    }))].sort();
    return RecoveryPolicySchema.parse({...this.r.policy(),...parsed});
  }
  previewSettings(a:RecoveryActor,changes:RecoverySettings){
    this.r.assertProject();const policy=this.settings(changes);const fields=(p:RecoveryPolicy)=>({projectBytes:p.projectBytes,retentionDays:p.retentionDays,retainedPoints:p.retainedPoints,excludePaths:p.excludePaths});
    return this.save(a,{kind:'settings',root:rootIdentity(this.s.wfs.root),policyHash:digestOf(this.r.policy()),changes:fields(policy),decision:{before:fields(this.r.policy()),after:fields(policy),existingBackupsUnchanged:true,excludedFilesCannotBeRecoveredFromFutureCheckpoints:true}});
  }
  async apply(a:RecoveryActor,id:string,hash:string,revalidate:()=>void,approve:(summary:string)=>void){
    return this.s.mutations!.run(async()=>{
      revalidate();this.r.assertProject();
      const row=this.db.prepare('SELECT * FROM recovery_maintenance_plans WHERE id=? AND workspace_id=? AND actor=? AND owner=?').get(id,this.s.workspaceId,a.id,a.owner?1:0) as PlanRow|undefined;
      if(!row)throw new DodoError('NOT_FOUND','maintenance review unavailable');
      if(row.digest!==hash||row.epoch!==this.s.epoch)throw new DodoError('STALE_WORKSPACE','review maintenance in the current project epoch');
      if(row.result_json)return {...JSON.parse(row.result_json) as Record<string,unknown>,replayed:true};
      const review=JSON.parse(row.payload) as Review;
      if(row.expires_at<Date.now()||review.root!==rootIdentity(this.s.wfs.root)||review.policyHash!==digestOf(this.r.policy()))throw new DodoError('CONFLICT','maintenance review expired or policy changed; preview again');
      if(this.s.jobs.runningCount())throw new DodoError('CONFLICT','wait for running jobs before Recovery maintenance');
      let decision:ReturnType<RecoveryMaintenance['cleanup']>|undefined;
      if(review.kind==='cleanup'){
        decision=this.cleanup(a,review.selection!);
        if(digestOf(decision)!==digestOf(review.decision))throw new DodoError('CONFLICT','checkpoint protection/history changed; preview again');
        if(decision.items.some(p=>!p.eligible))throw new DodoError('CONFLICT','selection contains protected checkpoints; remove them and preview again');
      }
      const policy=review.kind==='settings'?this.settings(review.changes!):undefined;
      const summary=decision?`Delete ${decision.deleteIds.length} Recovery checkpoint(s) and ${decision.sessions.length} closed session(s); retry private pending cleanup. IDs: ${decision.deleteIds.slice(0,5).join(', ')}${decision.deleteIds.length>5?' …':''}. Plan ${id}`:
        `Recovery policy: quota ${policy!.projectBytes} bytes; retention ${policy!.retentionDays} days / ${policy!.retainedPoints} points; exclusions ${JSON.stringify(policy!.excludePaths).slice(0,700)}. Applies to future coverage/retention. Plan ${id}`;
      revalidate();approve(summary);revalidate();
      let result:Record<string,unknown>={planId:id,kind:review.kind,sourceChanged:false,deletedCheckpoints:decision?.deleteIds??[],settingsSaved:Boolean(policy),physicalCleanup:decision?'pending':'not_requested'};
      this.db.transaction(()=>{
        // The same database lock serializes owner pin/name/restore-plan changes
        // from other processes with the final deletion decision.
        revalidate();this.r.assertProject();
        if(review.policyHash!==digestOf(this.r.policy())||(decision&&digestOf(this.cleanup(a,review.selection!))!==digestOf(review.decision)))throw new DodoError('CONFLICT','maintenance state changed; preview again');
        if(policy)this.r.updateMaintenancePolicy(policy);
        if(decision){
          // Expired restore plans are not an authority or a permanent FK pin.
          this.db.prepare('DELETE FROM recovery_plan_refs WHERE plan_id IN (SELECT id FROM change_plans WHERE workspace_id=? AND (expires_at<? OR invalidated_at IS NOT NULL))').run(this.s.workspaceId,Date.now());
          for(const checkpoint of decision.deleteIds){
            this.db.prepare("INSERT OR IGNORE INTO recovery_cleanup_files VALUES (?,?,'manifest',?)").run(this.s.workspaceId,a.id,checkpoint);
            this.db.prepare("INSERT OR IGNORE INTO recovery_cleanup_files SELECT ?,?,'object',object_hash FROM recovery_refs WHERE snapshot_id=?").run(this.s.workspaceId,a.id,checkpoint);
          }
          for(const session of decision.sessions){this.db.prepare('DELETE FROM recovery_events WHERE session_id=?').run(session);this.db.prepare('DELETE FROM recovery_sessions WHERE id=?').run(session);}
          for(const checkpoint of decision.deleteIds)this.db.prepare('DELETE FROM recovery_snapshots WHERE id=? AND workspace_id=?').run(checkpoint,this.s.workspaceId);
        }
        this.db.prepare('UPDATE recovery_maintenance_plans SET result_json=? WHERE id=?').run(JSON.stringify(result),id);
        this.s.store.audit({principal:a.id,workspaceId:this.s.workspaceId,tool:'recovery.maintenance',result:review.kind});
      }).immediate();
      if(decision){
        const files=this.r.storage.cleanupRetired(this.s.workspaceId,a.owner?undefined:a.id);
        // Git copies retain their own identity checks and accounting on failure.
        const before=this.r.storage.usageFor(this.s.workspaceId).projectBytes;
        this.r.git.prune();
        const after=this.r.storage.usageFor(this.s.workspaceId).projectBytes;
        const pendingGitCopies=(this.db.prepare('SELECT COUNT(*) n FROM recovery_git_copies g WHERE workspace_id=? AND NOT EXISTS (SELECT 1 FROM recovery_snapshots s WHERE s.id=g.snapshot_id)').get(this.s.workspaceId) as {n:number}).n;
        result={...result,...files,reclaimedGitBytes:Math.max(0,before-after),pendingGitCopies,physicalCleanup:files.pendingFiles||pendingGitCopies?'pending':'complete'};
        this.db.prepare('UPDATE recovery_maintenance_plans SET result_json=? WHERE id=?').run(JSON.stringify(result),id);
      }
      return result;
    });
  }
}
