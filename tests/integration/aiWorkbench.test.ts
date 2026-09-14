import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import sharp from 'sharp';
import { chromium } from 'playwright';
import { describe,it,expect } from 'vitest';
import { launch,mkTmpDir } from '../helpers/testServer.js';

describe.skipIf(!fs.existsSync(chromium.executablePath()))('owner AI workbench in Chromium',()=>{
  it('adds provider/profile/project in real UI, runs an agent on B, reconnects, and renders narrow/dark/light safely',async()=>{
    const ctx=await launch({trust:'trusted',configPort:0}),b=mkTmpDir('dodo-ui-project-b-');let calls=0,probeCalls=0,imageReceived=false;
    await sharp({create:{width:8,height:8,channels:3,background:'#6688aa'}}).png().toFile(path.join(b,'fixture.png'));
    const provider=http.createServer(async(req,res)=>{if(req.method==='GET'&&req.url==='/v1/models'){if(req.headers.authorization!=='Bearer fixture-ui-secret-123456'){res.writeHead(401);res.end('{}');return;}res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:'fixture-model'}]}));return;}let raw='';for await(const bytes of req)raw+=String(bytes);if(raw.includes('dodo_probe')){probeCalls++;const output=raw.includes('"tools":[]')?[{type:'message',content:[{type:'output_text',text:'Tool returned 1.'}]}]:[{type:'function_call',call_id:'probe1',name:'dodo_probe',arguments:'{"value":1}'}];res.end(`data: ${JSON.stringify({type:'response.completed',response:{output,usage:{input_tokens:3,output_tokens:2}}})}\n\n`);return;}imageReceived ||= raw.includes('data:image/png;base64,')||raw.includes('data:image/jpeg;base64,');calls++;res.end(`data: ${JSON.stringify({type:'response.completed',response:{output:calls===1?[{type:'function_call',call_id:'uiwrite1',name:'write_file',arguments:JSON.stringify({path:'ui-created.txt',content:'created through real web task'})}]:[{type:'message',content:[{type:'output_text',text:'Created ui-created.txt. <script>window.pwned=true</script>'}]}],usage:{input_tokens:20,output_tokens:10}}})}\n\n`);});
    await new Promise<void>(r=>provider.listen(0,'127.0.0.1',r));
    const browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors:string[]=[];page.on('pageerror',e=>errors.push(e.name));
    const evidence=path.resolve('release-evidence/ai-workbench');fs.mkdirSync(evidence,{recursive:true});
    try{
      await page.goto(ctx.configUrl!);await page.getByRole('button',{name:'Providers & Profiles',exact:true}).click();
      await page.locator('#wb-body select[name=provider]').selectOption('custom');
      await page.locator('#wb-body input[name=name]').fill('Protocol Fixture');await page.locator('#wb-body input[name=baseUrl]').fill(`http://127.0.0.1:${(provider.address() as {port:number}).port}/v1`);
      await page.locator('#wb-body input[name=private]').check();
      await page.getByRole('button',{name:'บันทึก connection',exact:true}).click();await page.getByRole('heading',{name:'Protocol Fixture',exact:true}).waitFor();
      await page.getByRole('button',{name:'โหลดรายชื่อโมเดล',exact:true}).click();await page.getByText(/โหลดรายชื่อโมเดลไม่สำเร็จ: model listing returned HTTP 401/).waitFor();
      await page.getByRole('button',{name:'แก้ไข',exact:true}).click();await page.locator('#wb-body input[name=apiKey]').fill('fixture-ui-secret-123456');
      await page.getByRole('button',{name:'บันทึก connection',exact:true}).click();await page.getByRole('heading',{name:'Protocol Fixture',exact:true}).waitFor();
      await page.getByRole('button',{name:'โหลดรายชื่อโมเดล',exact:true}).click();await page.getByText('fixture-model',{exact:true}).waitFor();expect(await page.getByText(/พบ 1 โมเดล/).isVisible()).toBe(true);
      expect(await page.locator('#wb-body input[name=apiKey]').inputValue()).toBe('');await page.screenshot({path:path.join(evidence,'providers-desktop.png'),fullPage:true});
      await page.getByRole('button',{name:'โปรเจกต์',exact:true}).click();await page.locator('#wb-body input[name=projectRoot]').fill(b);await page.locator('#wb-body input[name=projectName]').fill('แอปตัวอย่าง B');await page.getByRole('button',{name:'เพิ่ม path',exact:true}).click();
      const project=ctx.server.services.installation!.list(ctx.server.services.installation!.owner()).find(p=>p.root===fs.realpathSync(b))!;expect(project).toBeDefined();
      await page.locator('#wb-project').selectOption(project.projectId);await page.locator('#wb-body select[name=trust]').selectOption('edit');await page.getByRole('button',{name:'บันทึก Trust',exact:true}).click();await expect.poll(()=>page.locator('#wb-root').textContent()).toContain('มีผล edit');
      await page.getByRole('button',{name:'Providers & Profiles',exact:true}).click();await page.locator('#wb-body input[name=model]').fill('fixture-model');await page.locator('#wb-body input[name=write]').check();await page.locator('#wb-body input[name=tools]').check();await page.locator('#wb-body input[name=images]').check();await page.getByRole('button',{name:'บันทึก profile',exact:true}).click();await page.getByRole('heading',{name:'Coding',exact:true}).waitFor();
      await page.getByRole('button',{name:'ทดสอบ tool calling (มีค่าใช้จ่ายได้)',exact:true}).click();await page.locator('.swal2-confirm').click();await page.getByText(/✓ tools ผ่านการทดสอบจริง · /).waitFor();expect(probeCalls).toBe(2);
      const profile=ctx.server.services.installation!.ai.settings.list<{id:string}>('profile')[0]!;
      await page.locator(`#wb-body input[name="${profile.id}"]`).check();await page.locator('#wb-body input[name=egress]').check();await page.getByRole('button',{name:'บันทึกสิทธิ์ AI',exact:true}).click();await expect.poll(()=>page.locator('#wb-notice').textContent()).toContain('บันทึกสิทธิ์ AI แล้ว');
      await page.getByRole('button',{name:'Chat & Tasks',exact:true}).click();await page.locator('#wb-body textarea[name=task]').fill('สร้าง ui-created.txt ในโปรเจกต์ B');await page.locator('#wb-body textarea[name=images]').fill('fixture.png');await page.getByRole('button',{name:'ส่งงาน',exact:true}).click();
      await page.getByText('งานเสร็จแล้ว · ตรวจ diff และผลทดสอบใน receipts ด้านล่าง',{exact:true}).waitFor({timeout:12000});
      expect(fs.readFileSync(path.join(b,'ui-created.txt'),'utf8')).toBe('created through real web task');expect(fs.existsSync(path.join(ctx.fixtureDir,'ui-created.txt'))).toBe(false);expect(calls).toBe(2);expect(imageReceived).toBe(true);
      expect(await page.evaluate('Boolean(window.pwned)')).toBe(false);
      const storage=await page.evaluate('JSON.stringify({local:{...localStorage},session:{...sessionStorage}})');expect(storage).not.toContain('fixture-ui-secret-123456');expect(page.url()).not.toContain('#');
      await page.evaluate('scrollTo(0,0)');await page.screenshot({path:path.join(evidence,'task-desktop.png'),fullPage:true});
      await page.setViewportSize({width:390,height:844});await page.evaluate('scrollTo(0,0)');await page.screenshot({path:path.join(evidence,'task-mobile.png'),fullPage:true});expect(await page.evaluate('document.documentElement.scrollWidth<=innerWidth')).toBe(true);
      await page.reload();await page.getByRole('button',{name:'Runs & Jobs',exact:true}).click();await page.getByRole('button',{name:'เปิดผลและเหตุการณ์',exact:true}).click();await page.getByText('งานเสร็จแล้ว · ตรวจ diff และผลทดสอบใน receipts ด้านล่าง',{exact:true}).waitFor();expect(calls).toBe(2);
      await page.locator('#theme-toggle').click();expect(await page.locator('html').getAttribute('data-theme')).toBe('light');await page.screenshot({path:path.join(evidence,'history-mobile-light.png'),fullPage:true});await page.keyboard.press('Tab');expect(await page.evaluate('document.activeElement?.tagName')).not.toBe('BODY');expect(errors).toEqual([]);
      await page.locator('#wb-project').selectOption(project.projectId);await page.getByRole('button',{name:'Knowledge',exact:true}).click();await page.getByRole('heading',{name:'Project Brain',exact:true}).waitFor();await page.getByRole('heading',{name:'Context Engine',exact:true}).waitFor();
      expect(await page.locator('#wb-body').textContent()).not.toContain('✕');
      await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('heading',{name:'Advanced Settings',exact:true}).waitFor();expect(await page.locator('#wb-body textarea[name=config]').inputValue()).not.toContain('fixture-ui-secret-123456');
    }finally{await browser.close();await ctx.cleanup();fs.rmSync(b,{recursive:true,force:true});await new Promise<void>(r=>{provider.close(()=>r());provider.closeAllConnections();});}
  },45000);
});
