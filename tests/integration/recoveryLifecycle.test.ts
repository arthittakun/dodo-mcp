import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chromium } from 'playwright';
import { bootstrapWorkspace } from '../../src/server/bootstrap.js';
import { ProjectRegistry } from '../../src/projects/registry.js';
import { platformFixture } from '../helpers/platform.js';
import { launch, type TestContext } from '../helpers/testServer.js';
import { RecoveryPolicySchema } from '../../src/services/recovery/contracts.js';

describe('R01 runtime recovery, quotas and real owner UI',()=>{
  let f:ReturnType<typeof platformFixture>|undefined,ctx:TestContext|undefined;
  afterEach(async()=>{vi.restoreAllMocks();await f?.close();f=undefined;await ctx?.cleanup();ctx=undefined;});
  it('restart keeps opt-out and old points, marks interrupted capture without replay and releases only its reservation',async()=>{
    f=platformFixture();const ws=f.ws;new ProjectRegistry(ws.store).add(f.root,'A');fs.writeFileSync(path.join(f.root,'a.txt'),'before');
    await ws.services.recovery!.checkpoint('owner-checkpoint','owner');const points=ws.store.db.prepare("SELECT COUNT(*) n FROM recovery_snapshots WHERE state='READY'").get();
    await ws.services.recovery!.configure({enabled:false},true);
    ws.store.db.prepare("INSERT INTO recovery_snapshots (id,workspace_id,project_id,state,scope,created_at) VALUES (?,?,?,'PREPARING','source',?)").run('crash',ws.workspaceId,'fixture',Date.now());
    ws.services.recovery!.storage.reserve('crash',ws.workspaceId,10,RecoveryPolicySchema.parse({}));
    ws.services.recovery!.storage.reserve('other','ws_other',10,RecoveryPolicySchema.parse({}));
    await ws.shutdownServices();
    const next=bootstrapWorkspace({invokedCwd:f.root,configDir:{dir:f.configDir,source:'env'},log:()=>{}});
    try {
      expect(next.services.recovery!.status()).toMatchObject({enabled:false,state:'DISABLED_BY_OWNER'});
      expect(next.store.db.prepare("SELECT COUNT(*) n FROM recovery_snapshots WHERE state='READY'").get()).toEqual(points);
      expect(next.store.db.prepare('SELECT state FROM recovery_snapshots WHERE id=?').get('crash')).toEqual({state:'INCOMPLETE'});
      expect(next.store.db.prepare('SELECT id FROM recovery_reservations').all()).toEqual([{id:'other'}]);
      expect(fs.readFileSync(path.join(f.root,'a.txt'),'utf8')).toBe('before');
      expect(next.services.applier.recoveryBlocked()).toBeUndefined();
    }finally{await next.shutdownServices();}
  });
  it('unchanged checkpoint reuses actual bytes even near the project quota',async()=>{
    f=platformFixture();new ProjectRegistry(f.ws.store).add(f.root,'A');fs.writeFileSync(path.join(f.root,'large.txt'),'A'.repeat(800000));
    const r=f.ws.services.recovery!;f.ws.store.db.prepare('INSERT INTO recovery_policies VALUES (?,?)').run(f.ws.workspaceId,JSON.stringify(RecoveryPolicySchema.parse({projectBytes:1048576})));
    await r.checkpoint('owner-checkpoint','owner');const first=r.storage.usageFor(f.ws.workspaceId);await r.checkpoint('owner-checkpoint','owner');
    expect(r.storage.usageFor(f.ws.workspaceId)).toEqual(first);expect(first.projectBytes).toBe(800000);
  });
  it('live caller authority is rechecked after async backup before the source changes',async()=>{
    f=platformFixture();new ProjectRegistry(f.ws.store).add(f.root,'A');fs.writeFileSync(path.join(f.root,'a.txt'),'before');
    const {invokeToolDefinition}=await import('../../src/tools/context.js');const {TOOL_CATALOG}=await import('../../src/tools/catalog.js');
    let revoked=false;const r=f.ws.services.recovery!,publish=r.storage.publish.bind(r.storage);
    vi.spyOn(r.storage,'publish').mockImplementation(async m=>{await publish(m);revoked=true;});
    const result=await invokeToolDefinition({services:f.ws.services,def:TOOL_CATALOG.find(t=>t.name==='edit_file')!,principal:()=>({...f!.ws.services.localPrincipal!,scopes:revoked?['dodo:read']:['dodo:read','dodo:write']}),args:{workspaceId:f.ws.workspaceId,workspaceEpoch:f.ws.epoch,path:'a.txt',edits:[{find:'before',replace:'after'}]}});
    expect(result.envelope.error).toMatchObject({code:'FORBIDDEN'});expect(fs.readFileSync(path.join(f.root,'a.txt'),'utf8')).toBe('before');
  });
  it('scan limits and data-root policy fail closed without exposing secret content',async()=>{
    f=platformFixture();new ProjectRegistry(f.ws.store).add(f.root,'A');fs.writeFileSync(path.join(f.root,'a.txt'),'before');
    f.ws.store.db.prepare('INSERT INTO recovery_policies VALUES (?,?)').run(f.ws.workspaceId,JSON.stringify(RecoveryPolicySchema.parse({maxEntries:1})));
    await expect(f.call('edit_file',{path:'a.txt',edits:[{find:'before',replace:'after'}]})).rejects.toThrow('RECOVERY_REQUIRED');
    expect(f.ws.services.recovery!.status()).toMatchObject({state:'BLOCKED',errorCode:'RESOURCE_LIMIT'});
    expect(fs.readFileSync(path.join(f.root,'a.txt'),'utf8')).toBe('before');
    await expect(f.ws.services.recovery!.configure({dataRoots:['../elsewhere']},true)).rejects.toThrow('traversal');
  });
  it.skipIf(!fs.existsSync(chromium.executablePath()))('owner UI saves defaults/opt-out, confirms once and fits desktop and narrow screens',async()=>{
    ctx=await launch({configPort:0,fixtureFiles:{'a.txt':'before'}});const project=new ProjectRegistry(ctx.server.services.store).add(ctx.fixtureDir,'Recovery fixture').project;
    const browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors:string[]=[];page.on('pageerror',e=>errors.push(e.name));
    const evidence=path.resolve('release-evidence/recovery/R04/20260920/browser');fs.mkdirSync(evidence,{recursive:true});
    try{
      await page.goto(ctx.configUrl!);await page.getByRole('button',{name:'โปรเจกต์',exact:true}).click();await page.locator('#wb-project').selectOption(project.projectId);
      await page.getByRole('heading',{name:'Recovery · สำรอง source',exact:true}).waitFor();
      await page.getByRole('button',{name:'สร้างจุดกู้คืนตอนนี้',exact:true}).click();
      await expect.poll(()=>page.getByRole('switch',{name:'เปิดการสำรองอัตโนมัติ'}).isChecked()).toBe(true);
      await page.getByText('SAVED · มีสำเนาที่ตรวจ integrity แล้ว',{exact:true}).waitFor();
      await page.locator('section').filter({has:page.getByRole('heading',{name:'Recovery · สำรอง source',exact:true})}).last().screenshot({path:path.join(evidence,'recovery-desktop.png')});
      await page.getByRole('switch',{name:'เปิดการสำรองอัตโนมัติ'}).uncheck();await page.getByRole('button',{name:'บันทึกการสำรอง',exact:true}).click();
      await page.getByRole('button',{name:'ปิดการสำรอง',exact:true}).click();await page.getByText('เจ้าของปิดการสำรองอัตโนมัติ',{exact:true}).waitFor();
      expect(ctx.server.services.recovery!.status().enabled).toBe(false);
      await page.setViewportSize({width:390,height:844});await page.locator('section').filter({has:page.getByRole('heading',{name:'Recovery · สำรอง source',exact:true})}).last().screenshot({path:path.join(evidence,'recovery-narrow.png')});
      expect(await page.evaluate('document.documentElement.scrollWidth<=innerWidth')).toBe(true);
      expect(errors).toEqual([]);
    }finally{await browser.close();}
  },60000);
});
