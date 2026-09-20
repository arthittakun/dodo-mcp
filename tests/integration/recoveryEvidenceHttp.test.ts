import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { chromium } from 'playwright';
import { launch, obtainToken, callToolLegacy, wsArgs, type TestContext } from '../helpers/testServer.js';
import { ProjectRegistry } from '../../src/projects/registry.js';
import { VerificationSchema } from '../../src/services/assistance/verification.js';

describe('R04 private dashboard and real OAuth evidence',()=>{
 let c:TestContext;
 afterEach(async()=>await c?.cleanup());
 const setup=async(register=true)=>{
  c=await launch({configPort:0,trust:'trusted',fixtureFiles:{'a.txt':'alpha','package.json':JSON.stringify({name:'r04-http',scripts:{test:'node test.cjs'}}),'test.cjs':`const ok=require('fs').readFileSync('a.txt','utf8')==='alpha';console.log(JSON.stringify({numTotalTests:1,numPassedTests:+ok,numFailedTests:+!ok}));process.exitCode=+!ok;`}});
  if(register)new ProjectRegistry(c.server.services.store).add(c.fixtureDir,'Dashboard');
 };
 const verify=async()=>{
  const token=await obtainToken(c);
  const call=async(args:Record<string,unknown>)=>{const r=await callToolLegacy(c,token.accessToken,'dodo_assist_change',{...wsArgs(c),operation:'verify_changes',args});expect(r.envelope.ok,JSON.stringify(r.envelope.error)).toBe(true);return VerificationSchema.parse(r.envelope.data);};
  const p=await call({mode:'plan'}),t=p.recommendedTasks.find(t=>t.taskId==='npm:test')!;
  return {token,v:await call({mode:'run',tasks:[{taskId:t.taskId,recipeDigest:t.recipeDigest}],sourceDigest:p.freshness.baselineDigest,idempotencyKey:'r04-verification-http',waitMs:10000})};
 };
 const post=(operation:string,args:unknown,auth?:string,base=new URL(c.configUrl!).origin,extra:Record<string,string>={})=>{
  const project=new ProjectRegistry(c.server.services.store).list().find(p=>p.root===c.server.services.wfs.root)!;
  return fetch(base+'/api/admin/action',{method:'POST',headers:{'content-type':'application/json',...extra,'x-dodo-workspace':c.server.workspaceId,'x-dodo-epoch':c.server.epoch,...(auth?{authorization:'Bearer '+auth}:{})},body:JSON.stringify({projectId:project.projectId,operation,args})});
 };
 it('only private owner can mark/pin; OAuth evidence is caller-bound and model results cannot mark VERIFIED',async()=>{
  await setup();const {token,v}=await verify(),owner=new URL(c.configUrl!).hash.slice(1);
  const inspect=await post('recovery.evidence.inspect',{verificationId:v.verificationId},owner);expect(inspect.status).toBe(200);const e=(await inspect.json() as {data:{state:string;checkpointId:string}}).data;expect(e.state).toBe('VERIFIED');
  const args={name:'stable',snapshotId:e.checkpointId,expectedRevision:0,...wsArgs(c),confirm:true};
  for(const op of ['recovery.mark','recovery.pin','recovery.cleanup.preview','recovery.purge']){
    expect((await post(op,args)).status).toBe(401);expect((await post(op,args,token.accessToken)).status).toBe(401);expect((await post(op,args,token.accessToken,c.baseUrl)).status).toBe(404);
  }
  expect((await post('recovery.mark',{...args,workspaceEpoch:'stale'},owner)).status).toBe(409);
  expect((await post('recovery.mark',{...args,confirm:false},owner)).status).toBe(400);
  expect((await post('recovery.mark',{...args,state:'VERIFIED'},owner)).status).toBe(400);
  expect((await post('recovery.mark',args,owner,undefined,{Origin:'https://evil.invalid'})).status).toBe(403);
  expect((await post('recovery.mark',args,owner,undefined,{'X-Forwarded-For':'127.0.0.1'})).status).toBe(403);
  expect((await post('recovery.mark',args,owner)).status).toBe(200);expect((await post('recovery.mark',args,owner)).status).toBe(409);
  const read=await obtainToken(c,{scope:'dodo:read'});
  const denied=await callToolLegacy(c,read.accessToken,'dodo_assist_change',{...wsArgs(c),operation:'verify_changes',args:{mode:'plan'}});expect(denied.envelope.error).toMatchObject({code:'FORBIDDEN'});
  const status=await callToolLegacy(c,read.accessToken,'dodo_read',{...wsArgs(c),operation:'restore_status',args:{}});expect(status.envelope.ok).toBe(true);expect((status.envelope.data as {evidence:{items:unknown[]}}).evidence.items).toEqual([]);
  const mine=await callToolLegacy(c,token.accessToken,'dodo_read',{...wsArgs(c),operation:'restore_status',args:{}});expect((mine.envelope.data as {evidence:{items:unknown[]}}).evidence.items).toHaveLength(1);
  c.server.services.store.setClientAccess(c.server.workspaceId,token.clientId,[]);expect((await callToolLegacy(c,token.accessToken,'dodo_read',{...wsArgs(c),operation:'restore_status',args:{}})).envelope.error).toMatchObject({code:'WORKSPACE_ACCESS_REQUIRED'});
 });
 it('built CLI uses private evidence, revision-bound mark and read-only cleanup preview',async()=>{
  await setup();const {v}=await verify();const cli=async(args:string[])=>JSON.parse((await promisify(execFile)(process.execPath,[path.resolve('dist/cli/main.js'),'recovery',...args],{cwd:c.fixtureDir,env:{...process.env,DODO_CONFIG_DIR:c.configDir},timeout:20000})).stdout) as Record<string,unknown>;
  const e=await cli(['evidence','--id',v.verificationId!]);expect(e.state).toBe('VERIFIED');
  const args=['mark','stable',String(e.checkpointId),'--revision','0','--workspace',c.server.workspaceId,'--epoch',c.server.epoch];await expect(cli(args)).rejects.toThrow('--yes');expect((await cli([...args,'--yes'])).label).toBe('OWNER_MARKED_STABLE');
  expect((await cli(['cleanup-preview'])).scope).toBe('retention_preview_only');
 });
 it.skipIf(!fs.existsSync(chromium.executablePath()))('browser adds project ON, verifies, pins/names, shows stale evidence and quota errors at desktop/narrow sizes',async()=>{
  await setup(false);const browser=await chromium.launch({headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000}}),errors:string[]=[];page.on('pageerror',e=>errors.push(e.name));
  const out=path.resolve('release-evidence/recovery/R04/20260920/browser');fs.mkdirSync(out,{recursive:true});
  try{
    await page.goto(c.configUrl!);await page.getByRole('button',{name:'โปรเจกต์',exact:true}).click();await page.locator('input[name=projectRoot]').fill(c.fixtureDir);await page.locator('input[name=projectName]').fill('R04 dashboard');await page.getByRole('button',{name:'เพิ่ม path',exact:true}).click();
    const registry=new ProjectRegistry(c.server.services.store);await expect.poll(()=>registry.list().length).toBe(1);await page.locator('#wb-project').selectOption(registry.list()[0]!.projectId);
    await page.getByRole('heading',{name:'ประวัติและการกู้คืน',exact:true}).waitFor();expect(await page.getByRole('switch',{name:'เปิดการสำรองอัตโนมัติ'}).isChecked()).toBe(true);
    const writer=await obtainToken(c);expect((await callToolLegacy(c,writer.accessToken,'dodo_write',{...wsArgs(c),operation:'write_file',args:{path:'a.txt',content:'alpha'}})).envelope.ok).toBe(true);
    const {v}=await verify();expect(v.status).toBe('passed');await page.getByRole('button',{name:'ตรวจสถานะใหม่',exact:true}).click();await page.getByRole('heading',{name:'VERIFIED · ผ่าน checks ที่เลือกกับ snapshot นี้',exact:true}).waitFor();
    const evidence=await c.server.services.recovery!.evidence.inspect(v.verificationId!,{id:'owner',owner:true});
    const row=page.locator('.wb-card').filter({has:page.getByRole('button',{name:'ดู preview',exact:true})}).filter({hasText:evidence.checkpointId});
    await row.getByRole('button',{name:'Pin สำเนานี้',exact:true}).click();await row.getByRole('button',{name:'เลิก pin',exact:true}).waitFor();await row.getByRole('button',{name:'ตั้งชื่อสำเนา',exact:true}).click();await page.getByRole('button',{name:'บันทึกชื่อสำเนา',exact:true}).click();await page.getByRole('button',{name:'บันทึกชื่อ',exact:true}).click();await page.getByText(/stable · OWNER_MARKED_STABLE/).waitFor();
    const recovery=page.locator('section').filter({has:page.getByRole('heading',{name:'Recovery · สำรอง source',exact:true})}).last();await recovery.screenshot({path:path.join(out,'dashboard-verified-desktop.png')});
    await page.setViewportSize({width:390,height:844});expect(await page.evaluate('document.documentElement.scrollWidth<=innerWidth')).toBe(true);await recovery.screenshot({path:path.join(out,'dashboard-verified-narrow.png')});
    await page.locator('section').filter({has:page.getByRole('heading',{name:'หลักฐานและชื่อสำเนา',exact:true})}).last().screenshot({path:path.join(out,'verification-card-narrow.png')});
    fs.writeFileSync(path.join(c.fixtureDir,'a.txt'),'external');await page.getByRole('button',{name:'ตรวจหลักฐานปัจจุบัน',exact:true}).click();await page.getByRole('heading',{name:/STALE ·/}).waitFor();
    await page.locator('input[name=restorePath]').fill('a.txt');await row.getByRole('button',{name:'ดู preview',exact:true}).click();await page.getByRole('button',{name:'กู้คืนตามแผนนี้',exact:true}).click();await page.getByRole('button',{name:'กู้คืน',exact:true}).click();await page.getByRole('heading',{name:'ผลกู้คืน',exact:true}).waitFor();expect(fs.readFileSync(path.join(c.fixtureDir,'a.txt'),'utf8')).toBe('alpha');
    await page.getByText('ขอบเขตและพื้นที่สำรอง',{exact:true}).click();await page.getByRole('button',{name:'ดู preview การล้างตาม retention',exact:true}).click();await page.getByText(/ยังไม่ได้ลบข้อมูล/).waitFor();
    // Real quota reservation failure, not a canned browser response.
    fs.writeFileSync(path.join(c.fixtureDir,'large-source.txt'),'x'.repeat(2*1024*1024));await page.locator('input[name=recoveryQuota]').fill('0.001');await page.getByRole('button',{name:'บันทึกการสำรอง',exact:true}).click();
    await expect.poll(()=>c.server.services.recovery!.status().state).toBe('BLOCKED');await page.getByRole('button',{name:'ตรวจสถานะใหม่',exact:true}).click();await page.getByText('สำรองไม่ได้ — หยุดการเปลี่ยน source',{exact:true}).waitFor();await recovery.screenshot({path:path.join(out,'dashboard-blocked-narrow.png')});
    expect(await page.evaluate('document.documentElement.scrollWidth<=innerWidth')).toBe(true);await page.setViewportSize({width:1440,height:1000});await recovery.screenshot({path:path.join(out,'dashboard-blocked-desktop.png')});expect(errors).toEqual([]);
    expect(c.server.services.recovery!.evidence.pointers()[0]).toMatchObject({name:'stable',snapshotId:evidence.checkpointId});
  }finally{await browser.close();}
 },60000);
});
