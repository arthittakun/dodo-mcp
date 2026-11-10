import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { platformFixture } from '../helpers/platform.js';
import { ProjectRegistry } from '../../src/projects/registry.js';
import { RecoveryService } from '../../src/services/recovery/recoveryService.js';

describe('R03 persistent content drift',()=>{
 let f:ReturnType<typeof platformFixture>;
 afterEach(async()=>{vi.restoreAllMocks();await f?.close();});
 const setup=async(files:Record<string,string>)=>{f=platformFixture();for(const [p,v]of Object.entries(files)){fs.mkdirSync(path.dirname(path.join(f.root,p)),{recursive:true});fs.writeFileSync(path.join(f.root,p),v);}f.ws.store.db.prepare('INSERT INTO recovery_policies VALUES (?,?)').run(f.ws.workspaceId,JSON.stringify({version:1,enabled:true,strictEnforcement:true,skipSecretContentFiles:false}));new ProjectRegistry(f.ws.store).add(f.root,'Drift');const r=f.ws.services.recovery!;await r.checkpoint('owner-checkpoint','owner');return r;};
 it('detects 54 overwrites + 2 deletions, preserves old bytes, permits exec with a warning and rejects stale owner review',async()=>{
  const r=await setup(Object.fromEntries(Array.from({length:100},(_,i)=>[`f${i}`,'before'])));
  const baseline=r.status().baselineId!;
  for(let i=0;i<54;i++)fs.writeFileSync(path.join(f.root,`f${i}`),'after');for(let i=54;i<56;i++)fs.unlinkSync(path.join(f.root,`f${i}`));
  const result=await r.scanDrift();expect(result.changedCount).toBe(56);expect(result.critical).toBe(true);expect(result.emergencyCheckpointId).toMatch(/^snap_/);
  const original=await r.storage.readVerified(baseline,f.ws.workspaceId);expect((await r.storage.readObject(original.entries[0]!.hash!,6,100)).toString()).toBe('before');
  const run=await f.call('exec_command',{program:'node',args:['-e',"process.stdout.write('executed')"],idempotencyKey:f.key()});
  await f.ws.services.jobs.waitForExit(run.jobId as string,10000);await expect.poll(()=>f.ws.services.mutations!.busy,{timeout:r.policy().scanMs+5000}).toBe(false);
  expect(f.ws.store.getJob(run.jobId as string)?.exitCode).toBe(0);expect(f.ws.services.jobs.inlineOutput(run.jobId as string,f.ws.workspaceId,'stdout',1024).content).toBe('executed');
  expect(r.status().operationsBlocked).toBe(false);expect(r.status().lastWarning).toBeTruthy();
  fs.writeFileSync(path.join(f.root,'f0'),'newer');await expect(r.acknowledgeDrift(result.digest!,()=>{})).rejects.toThrow('source changed since review');
  const reviewed=await r.scanDrift();await r.acknowledgeDrift(reviewed.digest!,()=>{});expect((await r.scanDrift()).changedCount).toBe(0);
  await f.call('write_file',{path:'f0',content:'journaled'});expect((await r.scanDrift()).changedCount).toBe(0);
 });
 it('same size/mtime external edits remain visible, stale expectedHash fails and a reviewed current hash permits editing',async()=>{
  const r=await setup({'a':'alpha','b':'other'}),st=fs.statSync(path.join(f.root,'a')),staleHash=f.ws.services.wfs.readTextFile('a',1024).hash;
  fs.writeFileSync(path.join(f.root,'a'),'bravo');fs.utimesSync(path.join(f.root,'a'),st.atime,st.mtime);
  await expect(f.call('write_file',{path:'a',content:'unsafe',expectedHash:staleHash})).rejects.toThrow('FILE_CHANGED');expect(fs.readFileSync(path.join(f.root,'a'),'utf8')).toBe('bravo');
  await f.call('write_file',{path:'b',content:'allowed'});expect((await r.scanDrift()).changes).toEqual([expect.objectContaining({path:'a',change:'modified'})]);
  await r.checkpoint('owner-checkpoint','owner');expect((await r.scanDrift()).changes).toEqual([expect.objectContaining({path:'a',change:'modified'})]);
  const freshHash=f.ws.services.wfs.readTextFile('a',1024).hash;await f.call('write_file',{path:'a',content:'reviewed',expectedHash:freshHash});
  expect(fs.readFileSync(path.join(f.root,'a'),'utf8')).toBe('reviewed');expect((await r.scanDrift()).changedCount).toBe(0);
 });
 it('restart never adopts external bytes; journaled source is not misclassified',async()=>{
  const r=await setup({'a':'before'});await f.call('write_file',{path:'a',content:'known'});expect((await r.scanDrift()).changedCount).toBe(0);const staleHash=f.ws.services.wfs.readTextFile('a',1024).hash;
  await r.close();fs.writeFileSync(path.join(f.root,'a'),'external');
  const next=new RecoveryService(f.ws.services,f.configDir);f.ws.services.recovery=next;
  await next.checkpoint('owner-checkpoint','owner');expect((await next.scanDrift()).changes).toEqual([expect.objectContaining({path:'a'})]);
  await expect(f.call('write_file',{path:'a',content:'wrong',expectedHash:staleHash})).rejects.toThrow('FILE_CHANGED');
  const freshHash=f.ws.services.wfs.readTextFile('a',1024).hash;await f.call('write_file',{path:'a',content:'reviewed after restart',expectedHash:freshHash});
  expect(fs.readFileSync(path.join(f.root,'a'),'utf8')).toBe('reviewed after restart');expect((await next.scanDrift()).changedCount).toBe(0);
 });
 it('ignored named targets remain tracked and captured, generated changes do not trigger drift',async()=>{
  const r=await setup({'nested/.gitignore':'hidden.txt\n','nested/hidden.txt':'before','a':'source','node_modules/gen':'cache'});
  expect(f.ws.services.wfs.ignores.isOrdinarilyIgnored('nested/hidden.txt',false)).toBe(true);
  const initial=await r.storage.readVerified(r.status().baselineId!,f.ws.workspaceId);expect(initial.entries.some(e=>e.path==='nested/hidden.txt')).toBe(false);
  await f.call('write_file',{path:'nested/hidden.txt',content:'known'});expect((await r.scanDrift()).changedCount).toBe(0);
  fs.writeFileSync(path.join(f.root,'node_modules/gen'),'new cache');expect((await r.scanDrift()).changedCount).toBe(0);
  fs.writeFileSync(path.join(f.root,'nested/hidden.txt'),'outside');const scan=await r.scanDrift();expect(scan.changes[0]!.path).toBe('nested/hidden.txt');
  const m=await r.storage.readVerified(scan.emergencyCheckpointId!,f.ws.workspaceId);expect(m.entries.some(e=>e.path==='nested/hidden.txt')).toBe(true);
  const freshHash=f.ws.services.wfs.readTextFile('nested/hidden.txt',1024).hash;
  await f.call('write_file',{path:'nested/hidden.txt',content:'reviewed',expectedHash:freshHash});
  expect(fs.readFileSync(path.join(f.root,'nested/hidden.txt'),'utf8')).toBe('reviewed');expect((await r.scanDrift()).changedCount).toBe(0);
 });
 it('scan deadline and mid-hash race fail closed without acknowledging anything',async()=>{
  const r=await setup({'a':'before'});const now=Date.now;let n=0;vi.spyOn(Date,'now').mockImplementation(()=>now()+(n++>0?100000:0));
  await expect(r.scanDrift()).rejects.toThrow('budget');vi.restoreAllMocks();expect(r.drift.status().state).toBe('unavailable');
  const read=fs.promises.open;let changed=false;vi.spyOn(fs.promises,'open').mockImplementation(async(...args:Parameters<typeof read>)=>{const h=await read(...args);if(!changed&&String(args[0])===path.join(f.root,'a')){changed=true;fs.writeFileSync(path.join(f.root,'a'),'during');}return h;});
  await expect(r.scanDrift()).rejects.toThrow('changed');vi.restoreAllMocks();expect((await r.scanDrift()).changedCount).toBe(1);
 });
 it('owner authority is rechecked, secret paths stay denied and source-backup exclusions do not gate normal data edits',async()=>{
  const r=await setup({'a':'before','.env':'private','db.sqlite':'database'}),staleHash=f.ws.services.wfs.readTextFile('a',1024).hash;fs.writeFileSync(path.join(f.root,'a'),'external');const scan=await r.scanDrift();
  await expect(r.acknowledgeDrift(scan.digest!,()=>{throw new Error('owner expired');})).rejects.toThrow('owner expired');
  await expect(f.call('write_file',{path:'a',content:'unsafe',expectedHash:staleHash})).rejects.toThrow('FILE_CHANGED');
  await expect(f.call('write_file',{path:'.env',content:'unsafe'})).rejects.toThrow('SECRET_PATH_DENIED');
  await f.call('delete_path',{path:'db.sqlite'});expect(fs.existsSync(path.join(f.root,'db.sqlite'))).toBe(false);
  expect(r.status()).toMatchObject({state:'BLOCKED',operationsBlocked:false,errorCode:'PATH_DENIED'});expect(r.status().lastWarning).toBeTruthy();
 });
 it('job observation runs before releasing the mutation queue, attributes changes as unknown',async()=>{
  const r=await setup({'a':'before'});const scan=vi.spyOn(r,'observeJob');
  const run=await f.call('exec_command',{program:'node',args:['-e',"require('fs').writeFileSync('a','command')"],idempotencyKey:f.key()});await f.ws.services.jobs.waitForExit(run.jobId as string,10000);
  // Job exit precedes bounded source observation. Wait for that real lifecycle
  // completion, not Vitest's default one-second polling window on native NTFS.
  await expect.poll(()=>f.ws.services.mutations!.busy,{timeout:r.policy().scanMs+5000}).toBe(false);expect(scan).toHaveBeenCalled();expect(r.drift.status()).toMatchObject({attribution:'unknown',changedCount:1});
  const freshHash=f.ws.services.wfs.readTextFile('a',1024).hash;await f.call('write_file',{path:'a',content:'reviewed',expectedHash:freshHash});
  expect(fs.readFileSync(path.join(f.root,'a'),'utf8')).toBe('reviewed');expect((await r.scanDrift()).changedCount).toBe(0);
 });
 it('verified checkpoints require fresh evidence at publication and deduplicate a verification receipt',async()=>{
  const r=await setup({'a':'before'});await r.verifiedCheckpoint('verify-fixture','owner',()=>true);
  const first=r.status().lastCheckpointId;expect(r.status().lastTrigger).toBe('verified-checkpoint');
  await r.verifiedCheckpoint('verify-fixture','owner',()=>true);expect(r.status().lastCheckpointId).toBe(first);
  await r.verifiedCheckpoint('verify-failed','owner',()=>false);expect(r.status().lastCheckpointId).toBe(first);
  let calls=0;await expect(r.verifiedCheckpoint('verify-race','owner',()=>++calls===1)).rejects.toMatchObject({code:'RECOVERY_REQUIRED'});
  const rows=f.ws.store.db.prepare("SELECT id FROM recovery_snapshots WHERE state='INCOMPLETE'").all();expect(rows.length).toBeGreaterThan(0);
 });

 it('a failed final expected-state/journal transaction is uncertain, blocks later writes and never reports success',async()=>{
  await setup({'a':'before','b':'other'});const persist=f.ws.store.setChangesetStatus.bind(f.ws.store);let failed=false;
  vi.spyOn(f.ws.store,'setChangesetStatus').mockImplementation((...args)=>{if(args[1]==='committed'&&!failed){failed=true;throw new Error('injected final journal persistence failure');}return persist(...args);});
  await expect(f.call('write_file',{path:'a',content:'written'})).rejects.toThrow('PARTIAL_RECOVERY_REQUIRED');
  expect(fs.readFileSync(path.join(f.root,'a'),'utf8')).toBe('written');expect(f.ws.services.applier.recoveryBlocked()?.status).toBe('recovery_required');
  await expect(f.call('write_file',{path:'b',content:'must not run'})).rejects.toThrow('RECOVERY_REQUIRED');expect(fs.readFileSync(path.join(f.root,'b'),'utf8')).toBe('other');
 });

});
