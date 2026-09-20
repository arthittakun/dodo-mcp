import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { chromium } from 'playwright';
import { launch, obtainToken, callToolLegacy, wsArgs, mcpRaw, rpc, parseMcpResponse, mkTmpDir, type TestContext } from '../helpers/testServer.js';
import { ProjectRegistry } from '../../src/projects/registry.js';

describe('R02 real HTTP OAuth, Compact gateway and owner browser',()=>{
 let c:TestContext;
 afterEach(async()=>{await c?.cleanup();});
 const start=async()=>{c=await launch({configPort:0,trust:'edit',fixtureFiles:{'a.txt':'before'}});return new ProjectRegistry(c.server.services.store).add(c.fixtureDir,'Restore fixture').project;};
 const gateway=(token:string,operation:string,args:Record<string,unknown>,extra:Record<string,unknown>={})=>callToolLegacy(c,token,operation.endsWith('_list')||operation.endsWith('_inspect')||operation==='restore_status'?'dodo_read':'dodo_write',{...wsArgs(c),operation,args,...extra});
 const ok=(r:Awaited<ReturnType<typeof callToolLegacy>>)=>{expect(r.envelope.ok,JSON.stringify(r.envelope.error)).toBe(true);return r.envelope.data as Record<string,unknown>;};
 it('20-tool HTTP surface can capture/edit/preview/restore with live OAuth and target-bound approvals',async()=>{
  await start();const token=await obtainToken(c),read=await obtainToken(c,{scope:'dodo:read'}),other=await obtainToken(c);
  expect((await mcpRaw(c,rpc('tools/list'))).status).toBe(401);
  const catalog=await parseMcpResponse(await mcpRaw(c,rpc('tools/list'),token.accessToken));expect((catalog.result as {tools:unknown[]}).tools.length).toBeLessThanOrEqual(20);
  const session=ok(await gateway(token.accessToken,'recovery_session_begin',{title:'HTTP session',idempotencyKey:'http-session-001'}));
  ok(await gateway(token.accessToken,'write_file',{path:'a.txt',content:'after'},{recoverySessionId:session.sessionId}));
  const deniedNested=await gateway(token.accessToken,'write_file',{path:'a.txt',content:'bad',recoverySessionId:session.sessionId});expect(deniedNested.envelope.error).toMatchObject({code:'INVALID_INPUT'});
  expect((await gateway(other.accessToken,'recovery_session_inspect',{sessionId:session.sessionId})).envelope.error).toMatchObject({code:'NOT_FOUND'});
  const plan=ok(await gateway(token.accessToken,'restore_preview',{sessionId:session.sessionId}));const args={planId:plan.planId,planHash:plan.planHash,idempotencyKey:'http-restore-001'};
  expect((await gateway(read.accessToken,'restore_apply',args)).envelope.error).toMatchObject({code:'FORBIDDEN'});
  c.server.services.store.setTrustMode(c.server.workspaceId,'inspect');
  const attempt=await gateway(token.accessToken,'restore_apply',args);expect(attempt.envelope.error).toMatchObject({code:'APPROVAL_REQUIRED'});
  const approval=(attempt.envelope.error as {detail:{approvalId:string}}).detail.approvalId;
  expect(c.server.services.store.getApproval(approval)?.tool).toBe('restore_apply');
  c.server.services.store.setApprovalStatus(approval,'approved');
  const applied=ok(await gateway(token.accessToken,'restore_apply',args));expect(applied.verified).toBe(true);expect(fs.readFileSync(path.join(c.fixtureDir,'a.txt'),'utf8')).toBe('before');
  const status=ok(await gateway(token.accessToken,'restore_status',{planId:plan.planId}));expect(status.plans).toEqual(expect.arrayContaining([expect.objectContaining({status:'committed',changesetId:applied.changesetId})]));
  c.server.services.store.setClientAccess(c.server.workspaceId,token.clientId,[]);
  expect((await gateway(token.accessToken,'checkpoint_list',{})).envelope.error).toMatchObject({code:'WORKSPACE_ACCESS_REQUIRED'});
 });
 it('private owner restore requires owner token, exact current context and confirmation; public MCP has no admin route',async()=>{
  const project=await start(),token=await obtainToken(c);
  const cp=ok(await gateway(token.accessToken,'checkpoint_create',{idempotencyKey:'private-snapshot-001'}));
  ok(await gateway(token.accessToken,'write_file',{path:'a.txt',content:'after'}));
  const url=new URL(c.configUrl!),headers={'content-type':'application/json','x-dodo-workspace':c.server.workspaceId,'x-dodo-epoch':c.server.epoch};
  const post=(operation:string,args:unknown,auth?:string,origin=url.origin)=>fetch(origin+'/api/admin/action',{method:'POST',headers:{...headers,...(auth?{authorization:'Bearer '+auth}:{})},body:JSON.stringify({projectId:project.projectId,operation,args})});
  expect((await post('recovery.restore_preview',{checkpointId:cp.checkpointId})).status).toBe(401);
  expect((await post('recovery.restore_preview',{checkpointId:cp.checkpointId},token.accessToken)).status).toBe(401);
  expect((await post('recovery.restore_preview',{checkpointId:cp.checkpointId},token.accessToken,c.baseUrl)).status).toBe(404);
  const response=await post('recovery.restore_preview',{checkpointId:cp.checkpointId},url.hash.slice(1));expect(response.status).toBe(200);const plan=(await response.json() as {data:{planId:string;planHash:string}}).data;
  const args={...plan,idempotencyKey:'private-restore-001',...wsArgs(c),confirm:true};
  expect((await post('recovery.restore_apply',{...args,confirm:false},url.hash.slice(1))).status).toBe(400);
  expect((await post('recovery.restore_apply',{...args,workspaceEpoch:'old'},url.hash.slice(1))).status).toBe(400);
  expect(fs.readFileSync(path.join(c.fixtureDir,'a.txt'),'utf8')).toBe('after');
  // Send only reviewed plan references, never response file contents.
  const applyArgs={planId:plan.planId,planHash:plan.planHash,idempotencyKey:'private-restore-002',...wsArgs(c),confirm:true};
  expect((await post('recovery.restore_apply',applyArgs,url.hash.slice(1))).status).toBe(200);expect(fs.readFileSync(path.join(c.fixtureDir,'a.txt'),'utf8')).toBe('before');
 });
 it('target project ACL and historical data stay isolated across A/B',async()=>{
  await start();const token=await obtainToken(c);const a=ok(await gateway(token.accessToken,'checkpoint_create',{idempotencyKey:'project-a-checkpoint'}));
  const bRoot=mkTmpDir('dodo-restore-project-b-');fs.writeFileSync(path.join(bRoot,'b.txt'),'B');
  try{
   const b=new ProjectRegistry(c.server.services.store).add(bRoot,'B').project;
   const denied=await callToolLegacy(c,token.accessToken,'project_overview',{targetProjectId:b.projectId});expect(denied.envelope.ok).toBe(false);
   expect(c.server.services.store.trustMode(b.workspaceId)).toBe('inspect');
   c.server.services.store.setClientAccess(b.workspaceId,token.clientId,['dodo:read','dodo:write']);
   const overview=await callToolLegacy(c,token.accessToken,'project_overview',{targetProjectId:b.projectId});ok(overview);
   // First bootstrap verifies directory identity and resets trust. Set the
   // fixture owner's choice only after that identity has been established.
   expect(c.server.services.store.trustMode(b.workspaceId)).toBe('inspect');
   c.server.services.store.setTrustMode(b.workspaceId,'edit');
   const target={targetProjectId:b.projectId,workspaceId:overview.envelope.workspaceId,workspaceEpoch:overview.envelope.workspaceEpoch};
   const foreign=await gateway(token.accessToken,'checkpoint_inspect',{checkpointId:a.checkpointId},target);expect(foreign.envelope.error).toMatchObject({code:'NOT_FOUND'});
   const bp=ok(await gateway(token.accessToken,'checkpoint_create',{idempotencyKey:'project-b-checkpoint'},target));
   expect((await gateway(token.accessToken,'checkpoint_inspect',{checkpointId:bp.checkpointId})).envelope.error).toMatchObject({code:'NOT_FOUND'});
   ok(await gateway(token.accessToken,'write_file',{path:'b.txt',content:'B2'},target));const plan=ok(await gateway(token.accessToken,'restore_preview',{checkpointId:bp.checkpointId},target));
   ok(await gateway(token.accessToken,'restore_apply',{planId:plan.planId,planHash:plan.planHash,idempotencyKey:'restore-project-b'},target));
   expect(fs.readFileSync(path.join(bRoot,'b.txt'),'utf8')).toBe('B');expect(fs.readFileSync(path.join(c.fixtureDir,'a.txt'),'utf8')).toBe('before');
  }finally{await c.server.services.installation?.close();fs.rmSync(bRoot,{recursive:true,force:true});}
 });
 it('built CLI previews over private IPC and applies only with the exact reviewed context and --yes',async()=>{
  await start();const checkpointId=await c.server.services.recovery!.checkpoint('owner-checkpoint','local-config-owner');
  fs.writeFileSync(path.join(c.fixtureDir,'a.txt'),'after');
  const cli=async(args:string[])=>{
   const result=await promisify(execFile)(process.execPath,[path.resolve('dist/cli/main.js'),'recovery',...args],{cwd:c.fixtureDir,env:{...process.env,DODO_CONFIG_DIR:c.configDir},timeout:20000});
   return JSON.parse(result.stdout) as Record<string,unknown>;
  };
  const listed=await cli(['list']);expect(listed.items).toEqual(expect.arrayContaining([expect.objectContaining({id:checkpointId})]));
  const plan=await cli(['preview',checkpointId!,'--path','a.txt']);expect(plan.applicable).toBe(true);expect(fs.readFileSync(path.join(c.fixtureDir,'a.txt'),'utf8')).toBe('after');
  const args=['apply',String(plan.planId),'--hash',String(plan.planHash),'--key','cli-restore-fixture','--workspace',String(plan.workspaceId),'--epoch',String(plan.workspaceEpoch)];
  await expect(cli(args)).rejects.toThrow(/--yes/);
  const applied=await cli([...args,'--yes']);expect(applied.verified).toBe(true);expect(fs.readFileSync(path.join(c.fixtureDir,'a.txt'),'utf8')).toBe('before');
  expect((await cli([...args,'--yes'])).changesetId).toBe(applied.changesetId);
 },60000);
 it.skipIf(!fs.existsSync(chromium.executablePath()))('real desktop/narrow browser preview, confirm, restore and reconnect status',async()=>{
  const project=await start();await c.server.services.recovery!.checkpoint('owner-checkpoint','local-config-owner');fs.writeFileSync(path.join(c.fixtureDir,'a.txt'),'after');
  const browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors:string[]=[];page.on('pageerror',e=>errors.push(e.name));
  const dir=path.resolve('release-evidence/recovery/R04/20260920/browser');fs.mkdirSync(dir,{recursive:true});
  try{
   await page.goto(c.configUrl!);await page.getByRole('button',{name:'โปรเจกต์',exact:true}).click();await page.locator('#wb-project').selectOption(project.projectId);
   await page.getByRole('heading',{name:'ประวัติและการกู้คืน',exact:true}).waitFor();
   await expect.poll(()=>c.server.services.recovery!.status().state).toBe('READY');
   await page.getByRole('button',{name:'ตรวจสถานะใหม่',exact:true}).click();
   await page.getByRole('heading',{name:'ประวัติและการกู้คืน',exact:true}).waitFor();
   // Select the owner checkpoint (runtime activation may add a newer baseline).
   const rows=page.locator('.wb-card').filter({has:page.getByRole('button',{name:'ดู preview',exact:true})});
   await rows.last().getByRole('button',{name:'ดู preview',exact:true}).click();await page.getByRole('button',{name:'กู้คืนตามแผนนี้',exact:true}).waitFor();
   expect(fs.readFileSync(path.join(c.fixtureDir,'a.txt'),'utf8')).toBe('after');
   await page.screenshot({path:path.join(dir,'restore-desktop.png'),fullPage:true});
   await page.setViewportSize({width:390,height:844});expect(await page.evaluate('document.documentElement.scrollWidth<=innerWidth')).toBe(true);await page.screenshot({path:path.join(dir,'restore-narrow.png'),fullPage:true});
   await page.getByRole('button',{name:'กู้คืนตามแผนนี้',exact:true}).click();await page.getByRole('button',{name:'กู้คืน',exact:true}).click();await page.getByRole('heading',{name:'ผลกู้คืน',exact:true}).waitFor();expect(fs.readFileSync(path.join(c.fixtureDir,'a.txt'),'utf8')).toBe('before');
   await page.getByRole('button',{name:'ตรวจแผนล่าสุด / หลังเชื่อมต่อใหม่',exact:true}).click();await page.getByText(/committed/).waitFor();expect(errors).toEqual([]);
  }finally{await browser.close();}
 },60000);
});
