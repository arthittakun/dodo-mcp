import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { chromium } from 'playwright';
import { launch, obtainToken, callToolLegacy, wsArgs, type TestContext } from '../helpers/testServer.js';
import { ProjectRegistry } from '../../src/projects/registry.js';

describe('R03 owner drift review through real HTTP and browser',()=>{
 let c:TestContext;
 afterEach(async()=>await c?.cleanup());
 const setup=async()=>{c=await launch({configPort:0,trust:'edit',fixtureFiles:{'a.txt':'before'}});const p=new ProjectRegistry(c.server.services.store).add(c.fixtureDir,'Drift fixture').project;await c.server.services.recovery!.checkpoint('owner-checkpoint','local-config-owner');fs.writeFileSync(path.join(c.fixtureDir,'a.txt'),'outside');return p;};
 it('OAuth can inspect drift but cannot acknowledge; private owner requires exact context, digest and confirmation',async()=>{
  const p=await setup(),token=await obtainToken(c),url=new URL(c.configUrl!);
  const post=(operation:string,args:unknown,auth?:string,base=url.origin)=>fetch(base+'/api/admin/action',{method:'POST',headers:{'content-type':'application/json','x-dodo-workspace':c.server.workspaceId,'x-dodo-epoch':c.server.epoch,...(auth?{authorization:'Bearer '+auth}:{})},body:JSON.stringify({projectId:p.projectId,operation,args})});
  const read=await callToolLegacy(c,token.accessToken,'dodo_read',{...wsArgs(c),operation:'restore_status',args:{scan:true}});expect(read.envelope.ok).toBe(true);const drift=(read.envelope.data as {drift:{digest:string}}).drift;
  const args={...wsArgs(c),digest:drift.digest,confirm:true};
  expect((await post('recovery.drift.acknowledge',args)).status).toBe(401);expect((await post('recovery.drift.acknowledge',args,token.accessToken)).status).toBe(401);expect((await post('recovery.drift.acknowledge',args,token.accessToken,c.baseUrl)).status).toBe(404);
  expect((await post('recovery.drift.acknowledge',{...args,confirm:false},url.hash.slice(1))).status).toBe(400);
  expect((await post('recovery.drift.acknowledge',{...args,workspaceEpoch:'old'},url.hash.slice(1))).status).toBe(409);
  const denied=await callToolLegacy(c,token.accessToken,'dodo_write',{...wsArgs(c),operation:'write_file',args:{path:'a.txt',content:'unsafe'}});expect(denied.envelope.error).toMatchObject({code:'FILE_CHANGED'});
  expect((await post('recovery.drift.acknowledge',args,url.hash.slice(1))).status).toBe(200);
  expect((await callToolLegacy(c,token.accessToken,'dodo_write',{...wsArgs(c),operation:'write_file',args:{path:'a.txt',content:'journaled'}})).envelope.ok).toBe(true);
 });
 it('built CLI pages exact scan and refuses acknowledgement without --yes',async()=>{
  await setup();const cli=async(args:string[])=>JSON.parse((await promisify(execFile)(process.execPath,[path.resolve('dist/cli/main.js'),'recovery',...args],{cwd:c.fixtureDir,env:{...process.env,DODO_CONFIG_DIR:c.configDir},timeout:20000})).stdout) as {digest:string;changedCount:number};
  const scan=await cli(['scan','--limit','1']);expect(scan.changedCount).toBe(1);
  const args=['acknowledge',scan.digest,'--workspace',c.server.workspaceId,'--epoch',c.server.epoch];await expect(cli(args)).rejects.toThrow('--yes');expect((await cli([...args,'--yes'])).changedCount).toBe(0);
 });
 it.skipIf(!fs.existsSync(chromium.executablePath()))('desktop and narrow browser scan, compare and owner confirmation actually change the drift baseline',async()=>{
  const p=await setup(),browser=await chromium.launch({headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000}}),errors:string[]=[];page.on('pageerror',e=>errors.push(e.name));
  const out=path.resolve('release-evidence/recovery/R04/20260920/browser');fs.mkdirSync(out,{recursive:true});
  try{
    await page.goto(c.configUrl!);await page.getByRole('button',{name:'โปรเจกต์',exact:true}).click();await page.locator('#wb-project').selectOption(p.projectId);
    await page.getByRole('button',{name:'ตรวจไฟล์และเปรียบเทียบ',exact:true}).click();await page.getByRole('button',{name:'ยอมรับสถานะที่ตรวจนี้',exact:true}).waitFor();
    expect(c.server.services.recovery!.drift.status().changedCount).toBe(1);await page.screenshot({path:path.join(out,'drift-desktop.png'),fullPage:true});
    await page.setViewportSize({width:390,height:844});expect(await page.evaluate('document.documentElement.scrollWidth<=innerWidth')).toBe(true);await page.screenshot({path:path.join(out,'drift-narrow.png'),fullPage:true});
    await page.getByRole('button',{name:'ยอมรับสถานะที่ตรวจนี้',exact:true}).click();await page.getByRole('button',{name:'ยอมรับสถานะ',exact:true}).click();await page.getByText('ไม่พบการเปลี่ยนจากสถานะที่บันทึก',{exact:true}).waitFor();
    expect((await c.server.services.recovery!.scanDrift()).changedCount).toBe(0);expect(fs.readFileSync(path.join(c.fixtureDir,'a.txt'),'utf8')).toBe('outside');expect(errors).toEqual([]);
  }finally{await browser.close();}
 },60000);
});
