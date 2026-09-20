import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Store } from '../../store/store.js';
import { DodoError } from '../../errors.js';
import { assertPrivatePath, ensurePrivateDirectory } from '../../platform/privateFs.js';
import { digestOf } from '../../util/hash.js';
import type { RecoveryInstallationPolicy, RecoveryManifest, RecoveryPolicy } from './contracts.js';

const HASH = /^[a-f0-9]{64}$/;
export function syncDir(dir: string): void {
  if (process.platform === 'win32') return;
  const fd = fs.openSync(dir, fs.constants.O_RDONLY);
  try { fs.fsyncSync(fd); } catch (err) {
    if (!['EINVAL','ENOTSUP','EOPNOTSUPP'].includes((err as NodeJS.ErrnoException).code ?? '')) throw err;
  } finally { fs.closeSync(fd); }
}
export function rootIdentity(root: string): string {
  const st = fs.lstatSync(root, { bigint: true });
  if (!st.isDirectory() || st.isSymbolicLink() || fs.realpathSync.native(root) !== root) throw new DodoError('PATH_DENIED','recovery root is no longer canonical');
  return `${st.dev}:${st.ino}:${st.birthtimeNs}`;
}
/** Separate CAS and references: media/resource TTL and GC never own these bytes. */
export class RecoveryStorage {
  readonly directory: string;
  private readonly identity: string;
  constructor(readonly store: Store, configDir: string, readonly installationPolicy: () => RecoveryInstallationPolicy) {
    assertPrivatePath(configDir,true);
    const recoveryDir = path.join(configDir,'recovery');
    ensurePrivateDirectory(recoveryDir);
    this.directory = fs.realpathSync.native(recoveryDir);
    this.identity = rootIdentity(this.directory);
    for (const dir of ['objects','manifests','staging']) ensurePrivateDirectory(path.join(this.directory,dir));
  }
  private safeDir(name: 'objects'|'manifests'|'staging'): string {
    if (rootIdentity(this.directory) !== this.identity) throw new DodoError('PATH_DENIED','recovery storage directory changed');
    assertPrivatePath(this.directory,true);
    const dir = path.join(this.directory,name); assertPrivatePath(dir,true); return dir;
  }
  objectPath(hash:string):string {
    if (!HASH.test(hash)) throw new DodoError('RECOVERY_REQUIRED','invalid recovery object reference');
    return path.join(this.safeDir('objects'),hash);
  }
  manifestPath(id:string):string {
    if (!/^snap_[a-f0-9-]{36}$/.test(id)) throw new DodoError('INVALID_INPUT','invalid snapshot ID');
    return path.join(this.safeDir('manifests'),`${id}.json`);
  }
  stagePath():string { return path.join(this.safeDir('staging'),randomUUID()); }
  private usage(query:string,...params:unknown[]):number {return (this.store.db.prepare(query).get(...params) as {n:number}).n;}
  usageFor(workspaceId:string) {
    return {installationBytes:this.usage('SELECT COALESCE(SUM(bytes),0) n FROM recovery_objects')+this.usage('SELECT COALESCE(SUM(bytes),0) n FROM recovery_git_copies'),
      projectBytes:this.usage('SELECT COALESCE(SUM(bytes),0) n FROM recovery_objects WHERE hash IN (SELECT object_hash FROM recovery_refs r JOIN recovery_snapshots s ON s.id=r.snapshot_id WHERE workspace_id=?)',workspaceId)+this.usage('SELECT COALESCE(SUM(bytes),0) n FROM recovery_git_copies WHERE workspace_id=?',workspaceId),
      reservedBytes:this.usage('SELECT COALESCE(SUM(bytes),0) n FROM recovery_reservations')};
  }
  reserve(id:string,workspaceId:string,bytes:number,policy:RecoveryPolicy,logicalBytes=bytes,stagingBytes=bytes):void {
    if (!Number.isSafeInteger(bytes) || bytes<0) throw new DodoError('RESOURCE_LIMIT','invalid recovery reservation');
    this.store.db.transaction(()=>{
      const usage=this.usageFor(workspaceId), install=this.installationPolicy();
      const local=this.usage('SELECT COALESCE(SUM(logical_bytes),0) n FROM recovery_reservations WHERE workspace_id=?',workspaceId);
      const reservedDisk=this.usage('SELECT COALESCE(SUM(bytes+staging_bytes),0) n FROM recovery_reservations');
      const stat=fs.statfsSync(this.directory,{bigint:true}); const free=stat.bavail*stat.bsize;
      if (usage.installationBytes+usage.reservedBytes+bytes>install.storageBytes || usage.projectBytes+local+logicalBytes>policy.projectBytes || free<BigInt(install.freeFloorBytes)+BigInt(reservedDisk+bytes+stagingBytes)) {
        throw new DodoError('RESOURCE_LIMIT','backup storage reservation exceeds quota or free-space floor',{recovery:'free disk space or review Recovery quotas in owner settings; source was not changed'});
      }
      this.store.db.prepare('INSERT INTO recovery_reservations VALUES (?,?,?,?,?,?)').run(id,workspaceId,bytes,logicalBytes,stagingBytes,Date.now());
    }).immediate();
  }
  estimate(workspaceId:string,entries:Array<{hash:string;bytes:number}>):{physical:number;logical:number;staging:number} {
    const unique=new Map(entries.map(e=>[e.hash,e.bytes]));let physical=0,logical=0,staging=0;
    for(const [hash,bytes]of unique){
      if(!this.store.db.prepare('SELECT 1 FROM recovery_objects WHERE hash=?').get(hash))physical+=bytes;
      if(!this.store.db.prepare('SELECT 1 FROM recovery_refs r JOIN recovery_snapshots s ON s.id=r.snapshot_id WHERE s.workspace_id=? AND r.object_hash=? LIMIT 1').get(workspaceId,hash))logical+=bytes;
      staging=Math.max(staging,bytes);
    }
    return {physical,logical,staging};
  }
  release(id:string):void {this.store.db.prepare('DELETE FROM recovery_reservations WHERE id=?').run(id);}
  async verifyObject(hash:string,expectedBytes:number):Promise<void> {
    const file=this.objectPath(hash), before=assertPrivatePath(file);
    if(before.size!==expectedBytes) throw new DodoError('RECOVERY_REQUIRED','backup object size mismatch');
    const handle=await fs.promises.open(file,fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW??0));
    try {
      const h=createHash('sha256');const b=Buffer.alloc(128*1024);let size=0;
      const fdstat=await handle.stat();if(fdstat.dev!==before.dev||fdstat.ino!==before.ino||fdstat.nlink!==1)throw new DodoError('RECOVERY_REQUIRED','backup object identity changed');
      while(true){const {bytesRead}=await handle.read(b,0,b.length,null);if(!bytesRead)break;size+=bytesRead;if(size>expectedBytes)throw new DodoError('RECOVERY_REQUIRED','backup object grew');h.update(b.subarray(0,bytesRead));}
      const after=await handle.stat(), live=assertPrivatePath(file);
      if(size!==expectedBytes||h.digest('hex')!==hash||after.mtimeMs!==fdstat.mtimeMs||after.ctimeMs!==fdstat.ctimeMs||live.ino!==after.ino||live.dev!==after.dev)throw new DodoError('RECOVERY_REQUIRED','backup object integrity failed');
    } finally {await handle.close();}
  }
  async readObject(hash:string,bytes:number,limit:number):Promise<Buffer> {
    if(bytes>limit)throw new DodoError('FILE_TOO_LARGE','restore file exceeds configured content budget');
    await this.verifyObject(hash,bytes);
    const file=this.objectPath(hash),stat=assertPrivatePath(file),fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
    try {
      const opened=fs.fstatSync(fd);if(opened.ino!==stat.ino||opened.dev!==stat.dev||opened.size!==bytes||opened.nlink!==1)throw new DodoError('RECOVERY_REQUIRED','backup changed before read');
      const result=fs.readFileSync(fd);
      if(result.length!==bytes||createHash('sha256').update(result).digest('hex')!==hash)throw new DodoError('RECOVERY_REQUIRED','backup content integrity failed');
      return result;
    }finally{fs.closeSync(fd);}
  }
  async publishObject(stage:string,hash:string,bytes:number):Promise<void> {
    if(path.dirname(stage)!==this.safeDir('staging'))throw new DodoError('PATH_DENIED','invalid recovery staging path');
    assertPrivatePath(stage);
    const dest=this.objectPath(hash);
    try {fs.linkSync(stage,dest);} catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
    fs.unlinkSync(stage);syncDir(path.dirname(dest));
    // Another project may be publishing identical bytes. Publication/verification
    // is serialized by the caller's installation transaction where needed.
    await this.verifyObject(hash,bytes);
    this.store.db.prepare('INSERT OR IGNORE INTO recovery_objects VALUES (?,?,?)').run(hash,bytes,Date.now());
  }
  async publish(manifest:RecoveryManifest):Promise<void> {
    for(const e of manifest.entries)if(e.hash)await this.verifyObject(e.hash,e.bytes);
    const text=JSON.stringify(manifest), digest=digestOf(manifest);const file=this.manifestPath(manifest.id);
    const fd=fs.openSync(file,'wx',0o600);
    try {fs.writeFileSync(fd,text);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}syncDir(path.dirname(file));
    this.store.db.transaction(()=>{
      const row=this.store.db.prepare('UPDATE recovery_snapshots SET state=\'READY\',manifest_digest=?,bytes=? WHERE id=? AND state=\'PREPARING\'').run(digest,manifest.entries.reduce((n,e)=>n+e.bytes,0),manifest.id);
      if(row.changes!==1)throw new DodoError('RECOVERY_REQUIRED','snapshot state changed while publishing');
      for(const e of manifest.entries)if(e.hash)this.store.db.prepare('INSERT OR IGNORE INTO recovery_refs VALUES (?,?)').run(manifest.id,e.hash);
      this.release(manifest.id);
    }).immediate();
  }
  async readVerified(id:string,workspaceId:string):Promise<RecoveryManifest> {
    const row=this.store.db.prepare("SELECT manifest_digest FROM recovery_snapshots WHERE id=? AND workspace_id=? AND state='READY'").get(id,workspaceId) as {manifest_digest:string}|undefined;
    if(!row)throw new DodoError('NOT_FOUND','snapshot unavailable for this project');
    const file=this.manifestPath(id),stat=assertPrivatePath(file);if(stat.size>256*1024*1024)throw new DodoError('RESOURCE_LIMIT','backup manifest too large');
    const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));let text:string;
    try{const st=fs.fstatSync(fd);if(st.ino!==stat.ino||st.dev!==stat.dev||st.nlink!==1)throw new DodoError('RECOVERY_REQUIRED','manifest identity changed');text=fs.readFileSync(fd,'utf8');}finally{fs.closeSync(fd);}
    let m:RecoveryManifest;try{m=JSON.parse(text) as RecoveryManifest;}catch{throw new DodoError('RECOVERY_REQUIRED','backup manifest is corrupt');}
    if(m.id!==id||m.workspaceId!==workspaceId||m.version!==1||m.complete!==true||digestOf(m)!==row.manifest_digest)throw new DodoError('RECOVERY_REQUIRED','backup manifest integrity failed');
    for(const e of m.entries)if(e.hash)await this.verifyObject(e.hash,e.bytes);
    return m;
  }
  /** Only under the exclusive project lease. Interrupted snapshots never become READY. */
  reconcile(workspaceId:string):void {
    this.store.db.transaction(()=>{
      this.store.db.prepare("UPDATE recovery_snapshots SET state='INCOMPLETE' WHERE workspace_id=? AND state='PREPARING'").run(workspaceId);
      this.store.db.prepare('DELETE FROM recovery_reservations WHERE workspace_id=?').run(workspaceId);
    }).immediate();
  }
  /** Shared read-only retention calculation. Preview never deletes state or bytes. */
  private retention(workspaceId:string,policy:RecoveryPolicy,now=Date.now()) {
    const sessions=this.store.db.prepare("SELECT id,created_at FROM recovery_sessions WHERE workspace_id=? AND state='closed' ORDER BY created_at DESC,rowid DESC").all(workspaceId) as Array<{id:string;created_at:number}>;
    const removeSessions=new Set<string>();
    const livePlan=(id:string)=>Boolean(this.store.db.prepare(`SELECT 1 FROM recovery_plan_refs r JOIN change_plans p ON p.id=r.plan_id WHERE r.snapshot_id=? AND p.expires_at>=? AND p.invalidated_at IS NULL LIMIT 1`).get(id,now));
    const named=(id:string)=>Boolean(this.store.db.prepare('SELECT 1 FROM recovery_pointers WHERE snapshot_id=? LIMIT 1').get(id));
    const deployment=(id:string)=>Boolean(this.store.db.prepare('SELECT 1 FROM recovery_deployments WHERE snapshot_id=? LIMIT 1').get(id));
    const databaseRule=(id:string)=>Boolean(this.store.db.prepare('SELECT 1 FROM recovery_database_bindings WHERE snapshot_id=? LIMIT 1').get(id));
    for(const [i,session]of sessions.entries()){
      if(i<policy.retainedPoints&&session.created_at>=now-policy.retentionDays*86400000)continue;
      const events=this.store.db.prepare(`SELECT e.snapshot_id,s.pinned,e.kind,e.ref FROM recovery_events e LEFT JOIN recovery_snapshots s ON s.id=e.snapshot_id WHERE e.session_id=?`).all(session.id) as Array<{snapshot_id:string|null;pinned:number|null;kind:string;ref:string|null}>;
      if(events.some(e=>e.pinned===1||(e.snapshot_id&&(named(e.snapshot_id)||livePlan(e.snapshot_id)||deployment(e.snapshot_id)||databaseRule(e.snapshot_id)))
        ||e.kind==='changeset'&&Boolean(this.store.db.prepare("SELECT 1 FROM changesets WHERE id=? AND status IN ('committing','recovery_required')").get(e.ref))
        ||e.kind==='job'&&Boolean(this.store.db.prepare("SELECT 1 FROM jobs WHERE id=? AND status='running'").get(e.ref))))continue;
      removeSessions.add(session.id);
    }
    const rows=this.store.db.prepare("SELECT id,scope,created_at,pinned,bytes FROM recovery_snapshots WHERE workspace_id=? AND state='READY' ORDER BY created_at DESC,rowid DESC").all(workspaceId) as Array<{id:string;scope:string;created_at:number;pinned:number;bytes:number}>;
    const keep=new Set([rows[0]?.id,rows.find(r=>r.scope==='source')?.id]);
    const points=rows.map((r,i)=>{
      let reason='eligible';
      if(keep.has(r.id))reason='latest_backup';else if(r.pinned)reason='pinned';else if(named(r.id))reason='named_checkpoint';
      else if(deployment(r.id))reason='deployment_provenance';
      else if(databaseRule(r.id))reason='database_compatibility_rule';
      else if(this.store.db.prepare('SELECT 1 FROM recovery_drift WHERE baseline_id=?').get(r.id))reason='drift_baseline';
      else if(livePlan(r.id))reason='reviewed_restore_plan';
      else if((this.store.db.prepare('SELECT session_id FROM recovery_events WHERE snapshot_id=?').all(r.id) as Array<{session_id:string}>).some(e=>!removeSessions.has(e.session_id)))reason='session_history';
      else if(i<policy.retainedPoints&&r.created_at>=now-policy.retentionDays*86400000)reason='within_retention';
      return {checkpointId:r.id,logicalBytes:r.bytes,reason,eligible:reason==='eligible'};
    });
    return {sessions:[...removeSessions],points};
  }
  cleanupPreview(workspaceId:string,policy:RecoveryPolicy,cursor=0,limit=50){
    const plan=this.retention(workspaceId,policy),eligible=plan.points.filter(p=>p.eligible);
    return {digest:digestOf(plan),checkedAt:Date.now(),items:plan.points.slice(cursor,cursor+limit),nextCursor:plan.points.length>cursor+limit?cursor+limit:null,
      eligiblePoints:eligible.length,closedSessions:plan.sessions.length,logicalBytes:eligible.reduce((n,p)=>n+p.logicalBytes,0),
      physicalBytesFreed:null,scope:'retention_preview_only',note:'Shared objects, Git copies and the orphan grace period affect actual disk savings; no purge was executed.'};
  }
  /** Same plan as preview, under a transaction; named points and pins are never expired. */
  prune(workspaceId:string,policy:RecoveryPolicy):number {
    const manifests:string[]=[];
    this.store.db.transaction(()=>{
      this.store.db.prepare('DELETE FROM recovery_plan_refs WHERE plan_id IN (SELECT id FROM change_plans WHERE workspace_id=? AND (expires_at<? OR invalidated_at IS NOT NULL))').run(workspaceId,Date.now());
      const plan=this.retention(workspaceId,policy);
      for(const id of plan.sessions){this.store.db.prepare('DELETE FROM recovery_events WHERE session_id=?').run(id);this.store.db.prepare('DELETE FROM recovery_sessions WHERE id=?').run(id);}
      for(const p of plan.points)if(p.eligible){this.store.db.prepare('DELETE FROM recovery_snapshots WHERE id=?').run(p.checkpointId);manifests.push(this.manifestPath(p.checkpointId));}
    }).immediate();
    for(const file of manifests)fs.rmSync(file,{force:true});return manifests.length;
  }
  /** Orphans only; no active capture anywhere. Grace covers unpublished files after crashes. */
  collectOrphans(now=Date.now()):number {
    let removed=0;
    this.store.db.transaction(()=>{
      if(this.usage('SELECT COUNT(*) n FROM recovery_reservations')>0)return;
      const cutoff=now-24*60*60*1000;
      const rows=this.store.db.prepare('SELECT hash FROM recovery_objects WHERE created_at<? AND NOT EXISTS (SELECT 1 FROM recovery_refs WHERE object_hash=hash)').all(cutoff) as Array<{hash:string}>;
      for(const r of rows){fs.rmSync(this.objectPath(r.hash),{force:true});this.store.db.prepare('DELETE FROM recovery_objects WHERE hash=?').run(r.hash);removed++;}
      for(const name of fs.readdirSync(this.safeDir('objects'))){
        if(!HASH.test(name)||this.store.db.prepare('SELECT 1 FROM recovery_objects WHERE hash=?').get(name))continue;
        const p=this.objectPath(name),st=fs.lstatSync(p);
        if(st.isFile()&&!st.isSymbolicLink()&&st.nlink===1&&st.mtimeMs<cutoff){fs.unlinkSync(p);removed++;}
      }
      // Unpublished staging files have no database references. Don't traverse links.
      for(const name of fs.readdirSync(this.safeDir('staging'))){const p=path.join(this.safeDir('staging'),name);const st=fs.lstatSync(p);if(st.isFile()&&!st.isSymbolicLink()&&st.nlink===1&&st.mtimeMs<cutoff){fs.unlinkSync(p);removed++;}}
    }).immediate();return removed;
  }
}
