import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { platformFixture } from '../helpers/platform.js';
import { ProjectRegistry } from '../../src/projects/registry.js';
import { RecoveryPolicySchema } from '../../src/services/recovery/contracts.js';
import { RecoveryStorage } from '../../src/services/recovery/storage.js';

describe('R01 durable default-on source backups',()=>{
  let f:ReturnType<typeof platformFixture>;
  afterEach(async()=>{vi.restoreAllMocks();await f?.close();});
  const setup=(files:Record<string,string>={})=>{f=platformFixture();for(const [name,text]of Object.entries(files)){fs.mkdirSync(path.dirname(path.join(f.root,name)),{recursive:true});fs.writeFileSync(path.join(f.root,name),text);}new ProjectRegistry(f.ws.store).add(f.root,'Fixture');return f.ws.services.recovery!;};
  const latest=()=>f.ws.store.db.prepare("SELECT id FROM recovery_snapshots WHERE workspace_id=? AND state='READY' ORDER BY created_at DESC,rowid DESC LIMIT 1").get(f.ws.workspaceId) as {id:string};
  it('defaults enabled for a dirty non-Git registered project; immutable actual bytes survive deleting source',async()=>{
    const r=setup({'a.txt':'original','untracked.txt':'untracked'});expect(r.status()).toMatchObject({enabled:true,state:'INITIALIZING',awaitingActivation:true});
    await f.call('edit_file',{path:'a.txt',edits:[{find:'original',replace:'edited'}]});
    const before=await r.storage.readVerified(latest().id,f.ws.workspaceId);expect(before.scope).toBe('targets');
    const e=before.entries.find(e=>e.path==='a.txt')!;expect(fs.readFileSync(r.storage.objectPath(e.hash!),'utf8')).toBe('original');
    expect(before.actor).toBe('local-stdio');expect(before.root).toBe(f.root);expect(before.sessionId).toMatch(/^implicit_/);
    fs.rmSync(path.join(f.root,'a.txt'));await expect(r.storage.readVerified(before.id,f.ws.workspaceId)).resolves.toMatchObject({id:before.id});
    expect(fs.existsSync(path.join(f.root,'.git'))).toBe(false);expect(r.status().state).toBe('READY');
    await expect(r.storage.readVerified(before.id,'ws_another')).rejects.toThrow('unavailable');
  });
  it('never scans unregistered CWD and launcher; target ignore rules cannot remove before-image',async()=>{
    f=platformFixture();fs.writeFileSync(path.join(f.root,'a.txt'),'before');
    await f.call('edit_file',{path:'a.txt',edits:[{find:'before',replace:'first'}]});expect(f.ws.store.db.prepare('SELECT COUNT(*) n FROM recovery_snapshots').get()).toEqual({n:0});
    new ProjectRegistry(f.ws.store).add(f.root,'Fixture');
    // Explicit ordinary ignored source remains protected when named as an edit target.
    fs.writeFileSync(path.join(f.root,'.gitignore'),'a.txt\n');
    await f.call('edit_file',{path:'a.txt',edits:[{find:'first',replace:'second'}]});
    const m=await f.ws.services.recovery!.storage.readVerified(latest().id,f.ws.workspaceId);expect(m.entries.some(e=>e.path==='a.txt')).toBe(true);
  });
  it('omits secrets/data/generated files from baseline but refuses excluded mutation targets',async()=>{
    const r=setup({'.env':'private','db.sqlite':'database','node_modules/lib.js':'dependency','a.txt':'source'});
    await r.checkpoint('owner-checkpoint','owner');const m=await r.storage.readVerified(latest().id,f.ws.workspaceId);
    expect(m.entries.map(e=>e.path)).toEqual(['a.txt']);expect(m.excludedByPolicy).toBe(3);
    await expect(f.call('edit_file',{path:'db.sqlite',edits:[{find:'database',replace:'changed'}]})).rejects.toThrow('RECOVERY_REQUIRED');
    expect(fs.readFileSync(path.join(f.root,'db.sqlite'),'utf8')).toBe('database');
  });
  it('tombstones a new file and captures both move ends',async()=>{
    const r=setup({'a.txt':'bytes'});await f.call('write_file',{path:'new.txt',content:'new'});
    expect((await r.storage.readVerified(latest().id,f.ws.workspaceId)).entries).toContainEqual({path:'new.txt',kind:'absent',hash:null,bytes:0,mode:null});
    await f.call('move_path',{path:'a.txt',destPath:'moved.txt'});
    const entries=(await r.storage.readVerified(latest().id,f.ws.workspaceId)).entries;
    expect(entries.find(e=>e.path==='moved.txt')?.kind).toBe('absent');expect(entries.find(e=>e.path==='a.txt')?.hash).toBeTruthy();
  });
  it('detects drift during capture and never permits the requested mutation',async()=>{
    const r=setup({'a.txt':'before'});const original=r.storage.publishObject.bind(r.storage);const publish=vi.spyOn(r.storage,'publishObject');
    publish.mockImplementationOnce(async(...args)=>{await original(...args);fs.writeFileSync(path.join(f.root,'a.txt'),'external');});
    await expect(f.call('edit_file',{path:'a.txt',edits:[{find:'before',replace:'AI'}]})).rejects.toThrow('RECOVERY_REQUIRED');
    expect(fs.readFileSync(path.join(f.root,'a.txt'),'utf8')).toBe('external');expect(r.status().state).toBe('BLOCKED');
    expect(f.ws.store.db.prepare("SELECT COUNT(*) n FROM recovery_snapshots WHERE state='READY'").get()).toEqual({n:0});
  });
  it('corrupt backup bytes block a subsequent write without overwriting source',async()=>{
    const r=setup({'a.txt':'before'});await r.checkpoint('owner-checkpoint','owner');const m=await r.storage.readVerified(latest().id,f.ws.workspaceId);
    fs.writeFileSync(r.storage.objectPath(m.entries[0]!.hash!),'broken');
    await expect(f.call('edit_file',{path:'a.txt',edits:[{find:'before',replace:'AI'}]})).rejects.toThrow('RECOVERY_REQUIRED');expect(fs.readFileSync(path.join(f.root,'a.txt'),'utf8')).toBe('before');
  });
  it('content credential screening stops backup and never stores credential bytes as a ready point',async()=>{
    const r=setup({'a.txt':'sk-'+ 'A'.repeat(40)});
    await expect(r.checkpoint('owner-checkpoint','owner')).rejects.toThrow('source backup is blocked');expect(r.status().errorCode).toBe('SECRET_PATH_DENIED');
    expect(fs.readdirSync(path.join(r.storage.directory,'objects'))).toEqual([]);expect(fs.readdirSync(path.join(r.storage.directory,'staging'))).toEqual([]);
  });
  it('links and replacement root fail closed',async()=>{
    const r=setup({'a.txt':'before'});fs.linkSync(path.join(f.root,'a.txt'),path.join(f.root,'linked.txt'));
    await expect(r.checkpoint('owner-checkpoint','owner')).rejects.toThrow();expect(r.status().state).toBe('BLOCKED');
    fs.unlinkSync(path.join(f.root,'linked.txt'));fs.renameSync(f.root,f.root+'-old');fs.mkdirSync(f.root);
    await expect(r.checkpoint('owner-checkpoint','owner')).rejects.toThrow('original registered project');
  });
  it('backup storage failure preserves source; owner opt-out is explicit and retains old points',async()=>{
    const r=setup({'a.txt':'before'});await r.checkpoint('owner-checkpoint','owner');const id=latest().id;
    await expect(r.configure({enabled:false},false)).rejects.toThrow('confirm');
    vi.spyOn(r.storage,'reserve').mockImplementation(()=>{throw Object.assign(new Error('disk full'),{code:'ENOSPC'});});
    await expect(f.call('edit_file',{path:'a.txt',edits:[{find:'before',replace:'AI'}]})).rejects.toThrow('RECOVERY_REQUIRED');
    expect(fs.readFileSync(path.join(f.root,'a.txt'),'utf8')).toBe('before');
    await r.configure({enabled:false},true);expect(r.status().state).toBe('DISABLED_BY_OWNER');
    await f.call('edit_file',{path:'a.txt',edits:[{find:'before',replace:'owner-optout'}]});
    expect((await r.storage.readVerified(id,f.ws.workspaceId)).id).toBe(id);
    expect(f.ws.store.db.prepare('SELECT payload FROM recovery_policies WHERE workspace_id=?').get(f.ws.workspaceId)).toBeTruthy();
  });
  it('before-exec snapshot precedes real child writes and direct start cannot bypass it',async()=>{
    const r=setup({'a.txt':'before'});const req={...f.context,kind:'exec' as const,program:'node',args:['-e',"require('fs').writeFileSync('a.txt','job')"],cwdRel:'.'};
    expect(()=>f.ws.services.jobs.start(req)).toThrow('source backup');
    const job=await f.ws.services.jobs.startProtected(req);await f.ws.services.jobs.waitForExit(job.jobId,10000);
    expect(fs.readFileSync(path.join(f.root,'a.txt'),'utf8')).toBe('job');const m=await r.storage.readVerified(latest().id,f.ws.workspaceId);expect(m.trigger).toBe('before-exec');expect(m.scope).toBe('source');
    expect(fs.readFileSync(r.storage.objectPath(m.entries[0]!.hash!),'utf8')).toBe('before');
  });
  it('installation reservations are atomic across project stores and free-floor failure blocks capture',()=>{
    const r=setup();const policy=RecoveryPolicySchema.parse({projectBytes:1024*1024});
    const other=new RecoveryStorage(f.ws.store,f.configDir,()=>({version:1,storageBytes:1024*1024,freeFloorBytes:0}));
    other.reserve('one','A',800000,policy);expect(()=>other.reserve('two','B',800000,policy)).toThrow('quota');other.release('one');other.reserve('two','B',800000,policy);other.release('two');
    const disk=vi.spyOn(fs,'statfsSync');disk.mockReturnValue({bavail:0n,bsize:4096n} as fs.BigIntStatsFs);
    expect(()=>r.storage.reserve('floor','A',0,policy)).toThrow('free-space');
  });
  it('dedup owns copies independent of source and GC keeps latest full, latest target and pinned points',async()=>{
    const r=setup({'a.txt':'same','b.txt':'same'});await r.checkpoint('owner-checkpoint','owner');
    expect(fs.readdirSync(path.join(r.storage.directory,'objects')).length).toBe(1);
    const id=latest().id;f.ws.store.db.prepare('UPDATE recovery_snapshots SET pinned=1 WHERE id=?').run(id);
    await r.checkpoint('owner-checkpoint','owner');await r.checkpoint('before-write','actor',['a.txt']);
    r.storage.prune(f.ws.workspaceId,RecoveryPolicySchema.parse({retainedPoints:1}));r.storage.collectOrphans(Date.now()+2*86400000);
    await expect(r.storage.readVerified(id,f.ws.workspaceId)).resolves.toMatchObject({id});expect(fs.readdirSync(path.join(r.storage.directory,'objects')).length).toBe(1);
  });
  it('shared-content manifests still reject inconsistent sizes and freshly recheck a previously verified object',async()=>{
    const r=setup({'a':'shared','b':'shared'});await r.checkpoint('owner-checkpoint','owner');
    const m=await r.storage.readVerified(latest().id,f.ws.workspaceId);expect(m.entries.map(e=>e.path)).toEqual(['a','b']);
    const malformed={...m,entries:m.entries.map((e,i)=>i===1?{...e,bytes:e.bytes+1}:e)};
    await expect(r.storage.publish(malformed)).rejects.toThrow('inconsistent backup object size');
    fs.writeFileSync(r.storage.objectPath(m.entries[0]!.hash!),'broken');
    await expect(r.storage.readVerified(m.id,f.ws.workspaceId)).rejects.toThrow('integrity');
  });
});
