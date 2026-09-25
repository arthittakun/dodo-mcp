import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { platformFixture } from '../helpers/platform.js';
import { ProjectRegistry } from '../../src/projects/registry.js';
import { invokeToolDefinition, type Principal } from '../../src/tools/context.js';
import { TOOL_CATALOG } from '../../src/tools/catalog.js';
import { RecoverySettingsSchema } from '../../src/services/recovery/maintenance.js';

const owner={id:'local-config-owner',owner:true};
describe('Recovery maintenance: durable, caller-bound, reviewed cleanup',()=>{
  let f:ReturnType<typeof platformFixture>;
  afterEach(async()=>{vi.restoreAllMocks();await f?.close();});
  const setup=()=>{f=platformFixture();fs.writeFileSync(path.join(f.root,'source.txt'),'original');new ProjectRegistry(f.ws.store).add(f.root,'Fixture');return f.ws.services.recovery!;};
  const apply=async(p:{planId:string;planHash:string})=>f.ws.services.recovery!.maintenance.apply(owner,p.planId,p.planHash,()=>{},()=>{});
  const snap=async()=>String((await f.call('checkpoint_create',{idempotencyKey:f.key()})).checkpointId);
  it('deduplicates unchanged model bytes without restaging, verifies reuse and reports logical versus actual storage',async()=>{
    const r=setup();fs.mkdirSync(path.join(f.root,'models'));fs.writeFileSync(path.join(f.root,'models/model.onnx'),Buffer.alloc(2*1024*1024,9));
    await snap();const publish=vi.spyOn(r.storage,'publishObject');for(let i=0;i<3;i++)await snap();expect(publish).not.toHaveBeenCalled();
    const stats=r.maintenance.status(owner);expect(stats.uniqueSourceBytes).toBe(2*1024*1024+8);expect(stats.logicalCheckpointBytes).toBeGreaterThan(stats.uniqueSourceBytes*3);
    const object=f.ws.store.db.prepare('SELECT hash FROM recovery_objects WHERE bytes=?').get(2*1024*1024) as {hash:string};fs.writeFileSync(r.storage.objectPath(object.hash),'corrupt');
    await expect(snap()).rejects.toThrow('RECOVERY_REQUIRED');expect(r.status().state).toBe('BLOCKED');
  });
  it('deletes selected closed history and unshared bytes, preserves shared/latest/drift copies, and replays receipts',async()=>{
    const r=setup();await snap();fs.writeFileSync(path.join(f.root,'old.txt'),'unique-old-bytes');const old=await snap();fs.rmSync(path.join(f.root,'old.txt'));await snap();
    const p=r.maintenance.previewCleanup(owner,{mode:'selected',checkpointIds:[old]});const d=p.decision as {deleteIds:string[]};expect(d.deleteIds).toEqual([old]);
    const result=await apply(p);expect(result).toMatchObject({deletedCheckpoints:[old],reclaimedObjectBytes:16,physicalCleanup:'complete'});
    expect(fs.existsSync(r.storage.manifestPath(old))).toBe(false);expect(f.ws.store.db.prepare('SELECT 1 FROM recovery_snapshots WHERE id=?').get(old)).toBeUndefined();
    expect((await apply(p)).replayed).toBe(true);expect(fs.readFileSync(path.join(f.root,'source.txt'),'utf8')).toBe('original');
    await r.storage.readVerified(r.status().lastCheckpointId!,f.ws.workspaceId);
    expect(r.maintenance.reviewStatus(owner,p.planId)).toMatchObject({applied:true,result:{deletedCheckpoints:[old]}});
  });
  it('refuses protected checkpoints and partial sessions, rechecks new pins after preview',async()=>{
    const r=setup();const old=await snap();await snap();
    const p=r.maintenance.previewCleanup(owner,{mode:'selected',checkpointIds:[old]});f.ws.store.db.prepare('UPDATE recovery_snapshots SET pinned=1 WHERE id=?').run(old);
    await expect(apply(p)).rejects.toThrow('changed');
    const blocked=r.maintenance.previewCleanup(owner,{mode:'selected',checkpointIds:[old,r.status().lastCheckpointId!]});await expect(apply(blocked)).rejects.toThrow('protected');
    const session=await f.call('recovery_session_begin',{title:'Open session',idempotencyKey:f.key()});await snap();
    const open=r.maintenance.previewCleanup(owner,{mode:'selected',checkpointIds:[String(session.checkpointId)]});expect(JSON.stringify(open.decision)).toContain('open_session');
    await f.call('recovery_session_end',{sessionId:session.sessionId});
  });
  it('requires owner approval for MCP even when trusted, rejects foreign caller/read scopes/stale context, preserves retry',async()=>{
    const r=setup();const old=await snap();await snap();
    const p=await f.call('recovery_cleanup_preview',{checkpointIds:[old]});const input={planId:p.planId,planHash:p.planHash,idempotencyKey:f.key()};
    await expect(f.call('recovery_maintenance_apply',input)).rejects.toThrow('APPROVAL_REQUIRED');
    expect(f.ws.store.db.prepare('SELECT 1 FROM recovery_snapshots WHERE id=?').get(old)).toBeTruthy();
    const def=TOOL_CATALOG.find(t=>t.name==='recovery_maintenance_apply')!;
    const invoke=(principal:Principal,extra:Record<string,unknown>={})=>invokeToolDefinition({def,services:f.ws.services,principal,args:{...input,workspaceId:f.ws.workspaceId,workspaceEpoch:f.ws.epoch,...extra}});
    const caller={grantId:'local-stdio',clientId:'stdio',sub:'owner',scopes:['dodo:read','dodo:write']};
    expect((await invoke({...caller,scopes:['dodo:read']})).envelope.error?.code).toBe('FORBIDDEN');
    expect((await invoke(caller,{workspaceEpoch:'stale'})).envelope.error?.code).toBe('STALE_WORKSPACE');
    await expect(r.maintenance.apply({id:'someone-else'},String(p.planId),String(p.planHash),()=>{},()=>{})).rejects.toThrow('unavailable');
    const approval=f.ws.store.db.prepare("SELECT id FROM pending_approvals WHERE tool='recovery_maintenance_apply' AND status='pending'").get() as {id:string};f.ws.store.setApprovalStatus(approval.id,'approved');
    expect(await f.call('recovery_maintenance_apply',input)).toMatchObject({deletedCheckpoints:[old],replayed:false});expect(await f.call('recovery_maintenance_apply',input)).toMatchObject({replayed:true});
  });
  it('applies canonical exclusions only after review, retains old backups and never resets drift or enables disabled features',async()=>{
    const r=setup();fs.mkdirSync(path.join(f.root,'models'));fs.writeFileSync(path.join(f.root,'models/m.onnx'),'model');const before=await snap();
    expect(RecoverySettingsSchema.parse({retentionDays:7})).toEqual({retentionDays:7});
    const p=r.maintenance.previewSettings(owner,{projectBytes:6*1024**3,excludePaths:['models/']});expect(r.policy().excludePaths).toEqual([]);await apply(p);
    expect(r.policy()).toMatchObject({enabled:true,projectBytes:6*1024**3,excludePaths:['models']});
    expect((await r.storage.readVerified(before,f.ws.workspaceId)).entries.some(e=>e.path==='models/m.onnx')).toBe(true);
    const after=await snap();expect((await r.storage.readVerified(after,f.ws.workspaceId)).entries.some(e=>e.path.startsWith('models'))).toBe(false);
    expect(fs.readFileSync(path.join(f.root,'models/m.onnx'),'utf8')).toBe('model');
    for(const p of ['../outside','/absolute','.','models/*'])expect(()=>r.maintenance.previewSettings(owner,{excludePaths:[p]})).toThrow();
    expect(()=>RecoverySettingsSchema.parse({enabled:false})).toThrow();
  });
  it('keeps a durable cleanup task when unlink fails; explicit pending cleanup retries without deleting more checkpoints',async()=>{
    const r=setup();await snap();fs.writeFileSync(path.join(f.root,'temp.txt'),'unique');const old=await snap();fs.rmSync(path.join(f.root,'temp.txt'));await snap();
    const original=fs.unlinkSync;const unlink=vi.spyOn(fs,'unlinkSync').mockImplementation(p=>{if(String(p).includes('/objects/'))throw Object.assign(new Error('busy'),{code:'EBUSY'});original(p);});
    const result=await apply(r.maintenance.previewCleanup(owner,{mode:'selected',checkpointIds:[old]}));expect(result).toMatchObject({physicalCleanup:'pending',reclaimedObjectBytes:0});
    expect(r.maintenance.status(owner).pendingFiles).toBeGreaterThan(0);unlink.mockRestore();
    const retry=await apply(r.maintenance.previewCleanup(owner,{mode:'pending',checkpointIds:[]}));expect(retry).toMatchObject({deletedCheckpoints:[],reclaimedObjectBytes:6,physicalCleanup:'complete'});
  });
  it('defers shared object cleanup during another project capture, then collects only unreferenced objects',async()=>{
    const r=setup();await snap();fs.writeFileSync(path.join(f.root,'temp.txt'),'unique');const old=await snap();fs.rmSync(path.join(f.root,'temp.txt'));await snap();
    r.storage.reserve('other-capture','other-project',0,r.policy());
    const p=r.maintenance.previewCleanup(owner,{mode:'selected',checkpointIds:[old]});expect(await apply(p)).toMatchObject({physicalCleanup:'pending',reclaimedObjectBytes:0});
    r.storage.release('other-capture');expect(await apply(r.maintenance.previewCleanup(owner,{mode:'pending',checkpointIds:[]}))).toMatchObject({physicalCleanup:'complete',reclaimedObjectBytes:6});
  });
  it('revocation while queued prevents policy changes and receipt, and stale policy invalidates reviewed cleanup',async()=>{
    const r=setup();await snap();const p=r.maintenance.previewSettings(owner,{retentionDays:10});
    let release!:()=>void;const hold=f.ws.services.mutations!.run(()=>new Promise<void>(resolve=>{release=resolve;}));
    let allowed=true;const pending=r.maintenance.apply(owner,p.planId,p.planHash,()=>{if(!allowed)throw new Error('revoked');},()=>{});allowed=false;release();await hold;
    await expect(pending).rejects.toThrow('revoked');expect(r.policy().retentionDays).toBe(30);expect(r.maintenance.reviewStatus(owner,p.planId).applied).toBe(false);
    await apply(r.maintenance.previewSettings(owner,{retentionDays:12}));await expect(apply(p)).rejects.toThrow('policy changed');
  });
  it('does not unlink a shared object referenced by another project or follow a substituted backup hardlink',async()=>{
    const r=setup();await snap();fs.writeFileSync(path.join(f.root,'temp.txt'),'shared-project-bytes');const old=await snap();fs.rmSync(path.join(f.root,'temp.txt'));await snap();
    const hash=(f.ws.store.db.prepare('SELECT hash FROM recovery_objects WHERE bytes=20').get() as {hash:string}).hash;
    f.ws.store.db.prepare("INSERT INTO recovery_snapshots(id,workspace_id,project_id,state,scope,created_at) VALUES ('other-snapshot','other-workspace','other-project','READY','source',?)").run(Date.now());
    f.ws.store.db.prepare('INSERT INTO recovery_refs VALUES (?,?)').run('other-snapshot',hash);
    expect(await apply(r.maintenance.previewCleanup(owner,{mode:'selected',checkpointIds:[old]}))).toMatchObject({reclaimedObjectBytes:0});expect(fs.readFileSync(r.storage.objectPath(hash),'utf8')).toBe('shared-project-bytes');
    // No caller path is accepted for cleanup; even a private-state replacement fails closed.
    const outside=path.join(f.base,'outside.txt');fs.writeFileSync(outside,'preserve');
    const id=`snap_${crypto.randomUUID()}`,manifest=r.storage.manifestPath(id);fs.linkSync(outside,manifest);
    f.ws.store.db.prepare("INSERT INTO recovery_cleanup_files VALUES (?,?,'manifest',?)").run(f.ws.workspaceId,owner.id,id);
    expect(r.storage.cleanupRetired(f.ws.workspaceId)).toMatchObject({pendingFiles:1,removedManifests:0});expect(fs.readFileSync(outside,'utf8')).toBe('preserve');
  });
  it('rejects a partial closed session; the whole reviewed session can be retired without changing its source',async()=>{
    const r=setup();const session=await f.call('recovery_session_begin',{title:'Two actions',idempotencyKey:f.key()});
    await f.call('write_file',{path:'new.txt',content:'changed',recoverySessionId:session.sessionId});await f.call('recovery_session_end',{sessionId:session.sessionId});await snap();
    const partial=r.maintenance.previewCleanup(owner,{mode:'selected',checkpointIds:[String(session.checkpointId)]});expect(JSON.stringify(partial.decision)).toContain('select_complete_session');
    const ids=(f.ws.store.db.prepare('SELECT DISTINCT snapshot_id FROM recovery_events WHERE session_id=? AND snapshot_id IS NOT NULL').all(session.sessionId) as {snapshot_id:string}[]).map(e=>e.snapshot_id);
    const all=r.maintenance.previewCleanup(owner,{mode:'selected',checkpointIds:ids});expect((await apply(all)).deletedCheckpoints).toEqual([...ids].sort());expect(fs.readFileSync(path.join(f.root,'new.txt'),'utf8')).toBe('changed');
  });

  it('reclaims independent Git-copy bytes and keeps the current verified Git copy',async()=>{
    const r=setup();execFileSync('git',['init',f.root],{stdio:'ignore'});await snap();const old=await snap();await snap();
    const before=r.maintenance.status(owner).gitCopyBytes;expect(before).toBeGreaterThan(0);
    const result=await apply(r.maintenance.previewCleanup(owner,{mode:'selected',checkpointIds:[old]}));expect(result.physicalCleanup).toBe('complete');expect(result.reclaimedGitBytes).toBeGreaterThan(0);
    expect(r.maintenance.status(owner).gitCopyBytes).toBe(before-Number(result.reclaimedGitBytes));expect(r.maintenance.status(owner).gitCopyBytes).toBeGreaterThan(0);
  });

});
