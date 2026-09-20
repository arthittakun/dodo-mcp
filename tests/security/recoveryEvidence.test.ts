import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { platformFixture } from '../helpers/platform.js';
import { ProjectRegistry } from '../../src/projects/registry.js';
import { VerificationSchema } from '../../src/services/assistance/verification.js';
import { digestOf } from '../../src/util/hash.js';

describe('R04 manifest-bound verification and owner labels',()=>{
 let f:ReturnType<typeof platformFixture>;
 afterEach(async()=>{vi.restoreAllMocks();await f?.close();});
 const setup=async(script?:string)=>{
  f=platformFixture();
  fs.writeFileSync(path.join(f.root,'a.txt'),'alpha');
  fs.writeFileSync(path.join(f.root,'package.json'),JSON.stringify({name:'recovery-check-fixture',scripts:{test:'node check.cjs'}}));
  fs.writeFileSync(path.join(f.root,'check.cjs'),script??`const fs=require('fs');const ok=fs.readFileSync('a.txt','utf8')==='alpha';console.log(JSON.stringify({numTotalTests:1,numPassedTests:+ok,numFailedTests:+!ok}));process.exitCode=ok?0:1;`);
  new ProjectRegistry(f.ws.store).add(f.root,'Evidence fixture');await f.ws.services.recovery!.checkpoint('owner-checkpoint','local-stdio');return f.ws.services.recovery!;
 };
 const run=async()=>{const p=VerificationSchema.parse(await f.call('verify_changes',{mode:'plan'}));const t=p.recommendedTasks.find(t=>t.taskId==='npm:test')!;return VerificationSchema.parse(await f.call('verify_changes',{mode:'run',tasks:[{taskId:t.taskId,recipeDigest:t.recipeDigest}],sourceDigest:p.freshness.baselineDigest,idempotencyKey:f.key(),waitMs:10000}));};
 const actor={id:'local-stdio'};
 it('binds actual jobs to the BEFORE snapshot, selected recipes and parser; observed source drift never regains VERIFIED',async()=>{
  const r=await setup(),v=await run();expect(v.status).toBe('passed');
  const e=await r.evidence.inspect(v.verificationId!,actor);expect(e.state).toBe('VERIFIED');expect(e.evidence?.checks[0]).toMatchObject({exitCode:0,counts:{total:1,passed:1}});
  const m=await r.storage.readVerified(e.checkpointId,f.ws.workspaceId);expect(digestOf(m)).toBe(e.manifestHash);expect(e.evidence?.parserVersion).toBe('dodo-checks/2');expect(e.evidence?.requiredChecks[0]?.jobId).toBe(v.checks[0]?.jobId);
  fs.writeFileSync(path.join(f.root,'a.txt'),'changed');expect((await r.evidence.inspect(v.verificationId!,actor)).state).toBe('STALE');
  fs.writeFileSync(path.join(f.root,'a.txt'),'alpha');expect((await r.evidence.inspect(v.verificationId!,actor)).state).toBe('STALE');
 });
 it.each([
  ['failed',`console.log(JSON.stringify({numTotalTests:1,numPassedTests:0,numFailedTests:1}));process.exitCode=1;`,'FAILED'],
  ['skipped',`console.log(JSON.stringify({numTotalTests:1,numPassedTests:0,numFailedTests:0,numPendingTests:1}));`,'INCONCLUSIVE'],
  ['claim',`console.log('all tests passed! SENSITIVE_OUTPUT_SENTINEL');`,'INCONCLUSIVE'],
  ['partly-skipped',`console.log(JSON.stringify({numTotalTests:2,numPassedTests:1,numFailedTests:0,numPendingTests:1}));`,'INCONCLUSIVE'],
  ['inconsistent',`console.log(JSON.stringify({numTotalTests:3,numPassedTests:1,numFailedTests:0}));`,'INCONCLUSIVE'],
  ['truncated',`console.log('x'.repeat(60000));console.log(JSON.stringify({numTotalTests:1,numPassedTests:1,numFailedTests:0}));`,'INCONCLUSIVE'],
 ])('never promotes %s output to VERIFIED and metadata contains no log contents',async(_name,script,state)=>{
  const r=await setup(script),v=await run(),e=await r.evidence.inspect(v.verificationId!,actor);expect(e.state).toBe(state);expect(JSON.stringify(e)).not.toContain('SENSITIVE_OUTPUT_SENTINEL');expect(JSON.stringify(e)).not.toContain('stdout');expect(await r.storage.readVerified(e.checkpointId,f.ws.workspaceId)).toBeDefined();
 });
 it('source-generating recipes stay stale even if job exits zero with passing counts',async()=>{
  const r=await setup(`require('fs').writeFileSync('a.txt','generated');console.log(JSON.stringify({numTotalTests:1,numPassedTests:1,numFailedTests:0}));`),v=await run();expect(v.status).toBe('stale');expect((await r.evidence.inspect(v.verificationId!,actor)).state).toBe('STALE');
 });
 it('recipe/runtime changes invalidate evidence and a foreign actor cannot inspect it',async()=>{
  const r=await setup(),v=await run();await expect(r.evidence.inspect(v.verificationId!,{id:'other'})).rejects.toMatchObject({code:'NOT_FOUND'});
  const tasks=f.ws.services.overview.discoverTasks(f.ws.services.projectConfig);
  vi.spyOn(f.ws.services.overview,'discoverTasks').mockReturnValue(tasks.map(t=>({...t,recipeDigest:digestOf('changed')})));
  expect((await r.evidence.inspect(v.verificationId!,actor)).state).toBe('STALE');vi.restoreAllMocks();
  expect(r.evidence.list({id:'other'}).items).toEqual([]);
 });
 it('new epoch cannot inherit prior verification freshness',async()=>{
  const r=await setup(),v=await run();const epoch=f.ws.services.epoch;f.ws.services.epoch='new-epoch';
  try{expect((await r.evidence.inspect(v.verificationId!,actor)).state).toBe('STALE');}finally{f.ws.services.epoch=epoch;}
 });
 it('full recovery manifest catches changes outside verification walker scope',async()=>{
  const r=await setup();await f.call('write_file',{path:'nested/.gitignore',content:'hidden.txt\n'});await f.call('write_file',{path:'nested/hidden.txt',content:'tracked'});
  const v=await run();expect((await r.evidence.inspect(v.verificationId!,actor)).state).toBe('VERIFIED');
  fs.writeFileSync(path.join(f.root,'nested/hidden.txt'),'external');expect(VerificationSchema.parse(await f.call('verify_changes',{mode:'report',verificationId:v.verificationId})).status).toBe('stale');
  fs.writeFileSync(path.join(f.root,'nested/hidden.txt'),'tracked');expect((await r.evidence.inspect(v.verificationId!,actor)).state).toBe('STALE');
 });
 it('owner CAS is atomic, tombstones prevent ABA, and labeling failed tests never turns them into passes',async()=>{
  const r=await setup(`process.exit(1);`),v=await run(),e=await r.evidence.inspect(v.verificationId!,actor);
  const before=await r.storage.readVerified(e.checkpointId,f.ws.workspaceId);
  const races=await Promise.allSettled([r.evidence.mark('stable',e.checkpointId,0,()=>{}),r.evidence.mark('stable',e.checkpointId,0,()=>{})]);expect(races.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(races.filter(r=>r.status==='rejected')).toHaveLength(1);
  expect((await r.evidence.inspect(v.verificationId!,actor)).state).toBe('FAILED');expect(await r.storage.readVerified(e.checkpointId,f.ws.workspaceId)).toEqual(before);
  await r.evidence.mark('stable',null,1,()=>{});await expect(r.evidence.mark('stable',e.checkpointId,0,()=>{})).rejects.toMatchObject({code:'CONFLICT'});
  await expect(r.evidence.mark('<img src=x>',e.checkpointId,0,()=>{})).rejects.toThrow();await expect(r.evidence.mark('production-known-good',e.checkpointId,0,()=>{})).rejects.toThrow();
  const events=f.ws.store.db.prepare('SELECT previous_id,snapshot_id,revision FROM recovery_pointer_events WHERE workspace_id=? ORDER BY seq').all(f.ws.workspaceId);expect(events).toEqual([{previous_id:null,snapshot_id:e.checkpointId,revision:1},{previous_id:e.checkpointId,snapshot_id:null,revision:2}]);
 });
 it('owner expiry cannot mutate labels or pins; a checkpoint from another workspace is refused',async()=>{
  const r=await setup(),id=r.status().lastCheckpointId!;
  const expired=()=>{throw Error('owner expired');};await expect(r.evidence.mark('stable',id,0,expired)).rejects.toThrow('owner expired');await expect(r.evidence.pin(id,true,false,expired)).rejects.toThrow('owner expired');expect(r.evidence.pointers()).toEqual([]);
  const update=f.ws.store.db.prepare('UPDATE recovery_snapshots SET workspace_id=? WHERE id=?');update.run('foreign',id);
  try{await expect(r.evidence.mark('stable',id,0,()=>{})).rejects.toMatchObject({code:'NOT_FOUND'});}finally{update.run(f.ws.workspaceId,id);}
 });
 it('pins and named targets survive real retention; unpin alone cannot delete a named point; preview matches prune',async()=>{
  const r=await setup(),id=r.status().lastCheckpointId!;await r.evidence.pin(id,true,false,()=>{});await r.evidence.mark('stable',id,0,()=>{});await r.checkpoint('owner-checkpoint','local-stdio');
  f.ws.store.db.prepare('UPDATE recovery_sessions SET created_at=1 WHERE workspace_id=?').run(f.ws.workspaceId);f.ws.store.db.prepare('UPDATE recovery_snapshots SET created_at=1 WHERE id=?').run(id);
  const policy={...r.policy(),retainedPoints:1,retentionDays:1};expect(r.storage.cleanupPreview(f.ws.workspaceId,policy).items.find(p=>p.checkpointId===id)?.reason).toBe('pinned');r.storage.prune(f.ws.workspaceId,policy);expect(await r.storage.readVerified(id,f.ws.workspaceId)).toBeDefined();
  await r.evidence.pin(id,false,true,()=>{});expect(r.storage.cleanupPreview(f.ws.workspaceId,policy).items.find(p=>p.checkpointId===id)?.reason).toBe('named_checkpoint');r.storage.prune(f.ws.workspaceId,policy);
  await r.evidence.mark('stable',null,1,()=>{});const preview=r.storage.cleanupPreview(f.ws.workspaceId,policy);expect(preview.items.find(p=>p.checkpointId===id)?.eligible).toBe(true);expect(r.storage.prune(f.ws.workspaceId,policy)).toBe(preview.eligiblePoints);await expect(r.storage.readVerified(id,f.ws.workspaceId)).rejects.toMatchObject({code:'NOT_FOUND'});
 });
});
