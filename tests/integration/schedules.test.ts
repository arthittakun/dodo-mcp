import fs from 'node:fs';
import path from 'node:path';
import { describe,it,expect } from 'vitest';
import { launch, obtainToken, callToolLegacy, wsArgs, type TestContext } from '../helpers/testServer.js';
import { ipcCall } from '../../src/ipc/client.js';
import { ipcSocketPath } from '../../src/config/paths.js';

const spec = (command='printf scheduled >> result.txt') => ({name:'daily fixture',command,cron:'* * * * *',timezone:'UTC',expiresAt:Date.now()+86400_000,sandbox:false,network:false,timeoutMs:1000});
const control = (c:TestContext,cmd:string,args:Record<string,unknown>={}) => ipcCall(ipcSocketPath(c.configDir,c.server.workspaceId),cmd,args);
async function finished(c:TestContext){await expect.poll(()=>c.server.services.jobs.runningCount()).toBe(0);}
describe('SCHEDULE: durable separate consent',()=>{
  it('proposes without execution; wrong digest denied; once approved launches exactly once at due time',async()=>{
    const c=await launch({ toolSurface: 'full', trust:'trusted'});
    try{
      c.server.services.schedules.stop();
      const row=c.server.services.schedules.propose(spec());
      await c.server.services.schedules.tick(Date.now()+60_000);
      expect(fs.existsSync(path.join(c.fixtureDir,'result.txt'))).toBe(false);
      await expect(control(c,'schedule.approve',{id:row.id,digest:'wrong'})).rejects.toThrow('hash');
      const approved=await control(c,'schedule.approve',{id:row.id,digest:row.digest}) as {nextAt:number};
      await c.server.services.schedules.tick(approved.nextAt);
      await c.server.services.schedules.tick(approved.nextAt);
      await finished(c);
      expect(fs.readFileSync(path.join(c.fixtureDir,'result.txt'),'utf8')).toBe('scheduled');
      const history=c.server.services.schedules.history(row.id);
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({status:'launched',job:{exitCode:0}});
    }finally{await c.cleanup();}
  });
  it('an authenticated tool proposal never approves a schedule; local owner approval remains required',async()=>{
    const c=await launch({ toolSurface: 'full', trust:'trusted'});
    try{
      c.server.services.schedules.stop();
      const t=await obtainToken(c);
      const p=await callToolLegacy(c,t.accessToken,'schedule_propose',{...wsArgs(c),...spec()});
      expect(p.envelope['ok']).toBe(true);
      const row=p.envelope['data'] as {id:string;digest:string};
      expect(c.server.services.schedules.inspect(row.id).status).toBe('pending');
      const approved=c.server.services.schedules.approve(row.id,row.digest);
      await c.server.services.schedules.tick(approved.nextAt!);
      await finished(c);
      expect(fs.readFileSync(path.join(c.fixtureDir,'result.txt'),'utf8')).toBe('scheduled');
    }finally{await c.cleanup();}
  });
  it('owner revoke cancels running scheduled job; overlap is skipped; expired consent cannot launch',async()=>{
    const c=await launch({ toolSurface: 'full', trust:'trusted'});
    try{
      c.server.services.schedules.stop();
      const row=c.server.services.schedules.propose({...spec('sleep 60'),timeoutMs:120000});
      const a=c.server.services.schedules.approve(row.id,row.digest);
      await c.server.services.schedules.tick(a.nextAt!);
      expect(c.server.services.jobs.runningCount()).toBe(1);
      await c.server.services.schedules.tick(a.nextAt!+60_000);
      expect(c.server.services.schedules.history(row.id)[0]?.status).toBe('skipped_overlap');
      await control(c,'schedule.revoke',{id:row.id});await finished(c);
      await c.server.services.schedules.tick(a.nextAt!+120000);
      expect(c.server.services.jobs.runningCount()).toBe(0);
      const b=c.server.services.schedules.propose(spec());
      c.server.services.store.db.prepare('UPDATE schedules SET expires_at=? WHERE id=?').run(Date.now()-1,b.id);
      expect(()=>c.server.services.schedules.approve(b.id,b.digest)).toThrow('expired');
    }finally{await c.cleanup();}
  });
  it('restart skips missed and claimed uncertain runs; only future ticks run; consent is durable',async()=>{
    const c=await launch({ toolSurface: 'full', trust:'trusted'});
    c.server.services.schedules.stop();
    const row=c.server.services.schedules.propose(spec());
    c.server.services.schedules.approve(row.id,row.digest);
    const missed=Date.now()-5000;
    c.server.services.store.db.prepare('UPDATE schedules SET next_at=? WHERE id=?').run(missed,row.id);
    await c.cleanup();
    const next=await launch({ toolSurface: 'full', configDir:c.configDir,fixtureDir:c.fixtureDir,port:c.port});
    try{
      next.server.services.schedules.stop();
      next.server.services.schedules.tick();
      expect(next.server.services.schedules.history(row.id)[0]?.status).toBe('skipped_missed');
      expect(fs.existsSync(path.join(c.fixtureDir,'result.txt'))).toBe(false);
      const due=next.server.services.schedules.inspect(row.id).nextAt!;
      next.server.services.store.db.prepare("INSERT INTO schedule_runs VALUES (?,?,'claimed',NULL,NULL)").run(row.id,due);
      await next.server.services.schedules.tick(due);
      expect(fs.existsSync(path.join(c.fixtureDir,'result.txt'))).toBe(false);
      await next.server.services.schedules.tick(due+60_000);
      await finished(next);
      expect(fs.readFileSync(path.join(c.fixtureDir,'result.txt'),'utf8')).toBe('scheduled');
    }finally{await next.cleanup();}
  });
  it('rejects invalid cron/timezone/traversal and pauses after policy, grant, or immutable-payload changes',async()=>{
    const c=await launch({ toolSurface: 'full', trust:'trusted'});
    try{
      c.server.services.schedules.stop();
      for(const patch of [{cron:'* * * * * *'},{timezone:'Not/AZone'},{cwd:'../'},{expiresAt:Date.now()+40*86400_000},{command:'abc\0def'}]) expect(()=>c.server.services.schedules.propose({...spec(),...patch})).toThrow();
      const row=c.server.services.schedules.propose(spec());
      const approved=c.server.services.schedules.approve(row.id,row.digest);
      c.server.services.store.setTrustMode(c.server.workspaceId,'inspect');
      await c.server.services.schedules.tick(approved.nextAt!);
      expect(c.server.services.schedules.inspect(row.id).status).toBe('paused');
      c.server.services.store.setTrustMode(c.server.workspaceId,'trusted');
      const changed=c.server.services.schedules.propose(spec());
      c.server.services.store.db.prepare('UPDATE schedules SET payload=? WHERE id=?').run(JSON.stringify({...changed,command:'evil'}),changed.id);
      expect(()=>c.server.services.schedules.approve(changed.id,changed.digest)).toThrow('changed');
      const t=await obtainToken(c);
      const r=c.server.services.schedules.propose(spec(),{grantId:t.grantId,clientId:t.clientId,sub:'owner',scopes:['dodo:exec']});
      const a=c.server.services.schedules.approve(r.id,r.digest);
      c.server.services.store.revokeGrant(t.grantId);
      await c.server.services.schedules.tick(a.nextAt!);
      expect(c.server.services.schedules.inspect(r.id).status).toBe('paused');
      expect(fs.existsSync(path.join(c.fixtureDir,'result.txt'))).toBe(false);
    }finally{await c.cleanup();}
  });
  it('a separate manager sharing SQLite cannot duplicate a claimed tick',async()=>{
    const c=await launch({ toolSurface: 'full', trust:'trusted'});
    try{
      c.server.services.schedules.stop();
      const {ScheduleService}=await import('../../src/services/schedules/scheduleService.js');
      const second=new ScheduleService(c.server.services);
      const r=c.server.services.schedules.propose(spec());
      const a=c.server.services.schedules.approve(r.id,r.digest);
      await Promise.all([c.server.services.schedules.tick(a.nextAt!), second.tick(a.nextAt!)]);
      await finished(c);
      expect(c.server.services.schedules.history(r.id)).toHaveLength(1);
      expect(fs.readFileSync(path.join(c.fixtureDir,'result.txt'),'utf8')).toBe('scheduled');
    }finally{await c.cleanup();}
  });
});
