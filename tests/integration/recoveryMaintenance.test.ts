import type { DodoErrorInfo } from '../../src/errors.js';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { chromium } from 'playwright';
import { launch, obtainToken, callToolLegacy, wsArgs, type TestContext } from '../helpers/testServer.js';
import { ProjectRegistry } from '../../src/projects/registry.js';

describe('Recovery maintenance real HTTP/OAuth and web',()=>{
  let c:TestContext;
  afterEach(async()=>{await c?.cleanup();});
  it('compact dispatch preserves OAuth scopes, history isolation, live ACL and private owner authentication',async()=>{
    c=await launch({trust:'trusted',configPort:0,fixtureFiles:{'a.txt':'source'}});
    const p=new ProjectRegistry(c.server.services.store).add(c.fixtureDir,'Recovery fixture').project;
    const a=await obtainToken(c),b=await obtainToken(c),read=await obtainToken(c,{scope:'dodo:read'});
    const call=async(token:string,operation:string,args:Record<string,unknown>={},context={})=>{const result=await callToolLegacy(c,token,operation==='recovery_storage_status'?'dodo_read':'dodo_write',{...wsArgs(c),...context,operation,args});return {...result,envelope:{...result.envelope,data:result.envelope.data,error:result.envelope.error as DodoErrorInfo|undefined}};};
    const snap=async()=>{const result=await call(a.accessToken,'checkpoint_create',{idempotencyKey:crypto.randomUUID()});expect(result.isError).toBe(false);return (result.envelope.data as {checkpointId:string}).checkpointId;};
    const old=await snap();await snap();
    expect((await call(b.accessToken,'recovery_cleanup_preview',{checkpointIds:[old]})).envelope.error?.code).toBe('NOT_FOUND');
    expect((await call(read.accessToken,'recovery_settings_preview',{changes:{retentionDays:5}})).envelope.error?.code).toBe('FORBIDDEN');
    expect((await call(a.accessToken,'recovery_storage_status',{}, {workspaceEpoch:'stale'})).envelope.error?.code).toBe('STALE_WORKSPACE');
    expect((await call(a.accessToken,'recovery_settings_preview',{changes:{retentionDays:5},workspaceId:'evil'})).envelope.error?.code).toBe('INVALID_INPUT');
    const plan=await call(a.accessToken,'recovery_cleanup_preview',{checkpointIds:[old]});expect(plan.isError).toBe(false);
    const data=plan.envelope.data as {planId:string;planHash:string};const input={planId:data.planId,planHash:data.planHash,idempotencyKey:crypto.randomUUID()};
    const needs=await call(a.accessToken,'recovery_maintenance_apply',input);expect(needs.envelope.error?.code).toBe('APPROVAL_REQUIRED');
    const approvalId=(needs.envelope.error?.detail as {approvalId:string}).approvalId;c.server.services.store.setApprovalStatus(approvalId,'approved');
    expect((await call(a.accessToken,'recovery_maintenance_apply',input)).envelope.data).toMatchObject({deletedCheckpoints:[old],physicalCleanup:'complete'});
    expect((await call(a.accessToken,'recovery_maintenance_apply',input)).envelope.data).toMatchObject({replayed:true});
    const url=new URL(c.configUrl!);const body={projectId:p.projectId,operation:'recovery.recovery_storage_status',args:{}};
    const post=(base:string,auth?:string,epoch=c.server.epoch)=>fetch(base+'/api/admin/action',{method:'POST',headers:{'content-type':'application/json','x-dodo-workspace':c.server.workspaceId,'x-dodo-epoch':epoch,...(auth?{authorization:`Bearer ${auth}`}:{})},body:JSON.stringify(body)});
    expect((await post(url.origin)).status).toBe(401);expect((await post(url.origin,a.accessToken)).status).toBe(401);expect((await post(url.origin,url.hash.slice(1),'stale')).status).toBe(409);expect((await post(c.baseUrl,a.accessToken)).status).toBe(404);
    expect((await post(url.origin,url.hash.slice(1))).status).toBe(200);
    c.server.services.store.setClientAccess(c.server.workspaceId,a.clientId,[]);
    expect((await call(a.accessToken,'recovery_storage_status')).envelope.error?.code).toBe('WORKSPACE_ACCESS_REQUIRED');
  });
  it.skipIf(!fs.existsSync(chromium.executablePath()))('real desktop and narrow UI saves models exclusion and deletes reviewed checkpoint',async()=>{
    c=await launch({trust:'trusted',configPort:0,fixtureFiles:{'a.txt':'source','models/demo.onnx':'x'.repeat(2*1024*1024)}});
    const p=new ProjectRegistry(c.server.services.store).add(c.fixtureDir,'gutime fixture').project;
    const r=c.server.services.recovery!;await r.checkpoint('owner-checkpoint','local-config-owner');
    fs.writeFileSync(path.join(c.fixtureDir,'old.txt'),'unique-fixture-bytes');const old=await r.checkpoint('owner-checkpoint','local-config-owner');fs.rmSync(path.join(c.fixtureDir,'old.txt'));await r.checkpoint('owner-checkpoint','local-config-owner');
    const browser=await chromium.launch({headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000}});const errors:string[]=[];page.on('pageerror',e=>errors.push(e.name));
    const evidence=path.resolve('release-evidence/recovery/maintenance/browser');fs.mkdirSync(evidence,{recursive:true});
    try{
      await page.goto(c.configUrl!);await page.getByRole('button',{name:'โปรเจกต์',exact:true}).click();await page.locator('#wb-project').selectOption(p.projectId);
      const panel=page.getByRole('heading',{name:'จัดการพื้นที่ Recovery',exact:true}).locator('..');
      await panel.locator(`input[name="${old}"]`).check();await panel.getByRole('button',{name:'ตรวจแผนลบสำเนาที่เลือก',exact:true}).click();
      await panel.getByRole('heading',{name:'ตรวจรายการก่อนลบ',exact:true}).waitFor();await panel.getByRole('button',{name:'ยืนยันลบสำเนาตามแผน',exact:true}).click();await page.locator('.swal2-confirm').click();
      await panel.getByRole('heading',{name:'ผลการล้าง',exact:true}).waitFor();expect(c.server.services.store.db.prepare('SELECT 1 FROM recovery_snapshots WHERE id=?').get(old)).toBeUndefined();
      await panel.getByText('โควตา ระยะเก็บ และโฟลเดอร์ที่ไม่สำรอง',{exact:true}).click();await page.getByLabel('ไม่สำรองไฟล์หรือโฟลเดอร์ (relative path บรรทัดละรายการ)',{exact:true}).fill('models/');
      await panel.getByRole('button',{name:'ตรวจแผนนโยบายสำรอง',exact:true}).click();await panel.getByRole('button',{name:'ยืนยันบันทึกนโยบาย',exact:true}).click();await page.locator('.swal2-confirm').click();
      await expect.poll(()=>page.locator('textarea[name=maintenanceExcludes]').inputValue()).toBe('models');expect(r.policy().excludePaths).toEqual(['models']);
      await page.locator('.swal2-toast').waitFor({state:'hidden'});await panel.getByText('โควตา ระยะเก็บ และโฟลเดอร์ที่ไม่สำรอง',{exact:true}).click();
      await panel.screenshot({path:path.join(evidence,'recovery-desktop.png')});await page.setViewportSize({width:390,height:844});expect(await page.evaluate('document.documentElement.scrollWidth<=innerWidth')).toBe(true);await panel.screenshot({path:path.join(evidence,'recovery-mobile.png')});expect(errors).toEqual([]);
      expect(fs.readFileSync(path.join(c.fixtureDir,'models/demo.onnx'),'utf8')).toBe('x'.repeat(2*1024*1024));
    }finally{await browser.close();}
  },60000);
});
