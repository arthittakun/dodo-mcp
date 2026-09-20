import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { chromium } from 'playwright';
import { launch, type TestContext } from '../helpers/testServer.js';
import { ProjectRegistry } from '../../src/projects/registry.js';

describe('owner deployment configuration in the real browser and CLI', () => {
  let c: TestContext;
  afterEach(async () => c?.cleanup());
  it.skipIf(!fs.existsSync(chromium.executablePath()))('saves an actual target, renders without overflow, and CLI reads the same revision', async () => {
    c = await launch({ configPort: 0, trust: 'trusted', fixtureFiles: { 'Dockerfile': 'FROM scratch\n', 'check.cjs': 'process.exit(0);',
      'package.json': JSON.stringify({ name: 'deployment-web-fixture', scripts: { test: 'node check.cjs' } }) } });
    const p = new ProjectRegistry(c.server.services.store).add(c.fixtureDir, 'Deployment web fixture').project;
    const browser = await chromium.launch({ headless: true }), page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors: string[] = [];page.on('pageerror', error => errors.push(error.name));
    const out=path.resolve('release-evidence/recovery/r05/20260920-foundation/browser');fs.mkdirSync(out,{recursive:true});
    try {
      await page.goto(c.configUrl!);await page.getByRole('button', { name: 'โปรเจกต์', exact: true }).click();
      await page.locator('#wb-project').selectOption(p.projectId);
      await page.getByText('เพิ่มหรือแก้ปลายทาง',{exact:true}).click();
      await page.getByLabel('ชื่อปลายทาง (a-z, 0-9, -)',{exact:true}).fill('web-fixture');
      await page.getByLabel('Compose project',{exact:true}).fill('dodo-browser-fixture');
      await page.getByLabel('Health URL',{exact:true}).fill('https://fixture.example/health');
      await page.getByRole('button',{name:'บันทึกปลายทาง',exact:true}).click();
      await page.locator('.swal2-confirm').click();
      await page.getByText('บันทึก web-fixture revision 1 แล้ว · กดรีเฟรชเพื่อใช้รายการล่าสุด',{exact:true}).waitFor();
      const target=c.server.services.recovery!.deployments.targets()[0]!;
      expect(target.definition).toMatchObject({ name:'web-fixture',composeProject:'dodo-browser-fixture',service:'web',requiredChecks:[{taskId:'npm:test'}] });
      expect(target.revision).toBe(1);expect(c.server.services.store.db.prepare('SELECT * FROM recovery_deployments').all()).toEqual([]);
      const panel=page.getByRole('heading',{name:'Deployment · Docker',exact:true}).locator('..');
      await panel.screenshot({path:path.join(out,'deployment-desktop.png')});
      await page.setViewportSize({width:390,height:844});expect(await page.evaluate('document.documentElement.scrollWidth<=innerWidth')).toBe(true);
      await panel.screenshot({path:path.join(out,'deployment-narrow.png')});
      const cli=await promisify(execFile)(process.execPath,[path.resolve('dist/cli/main.js'),'deployment','targets'],{cwd:c.fixtureDir,env:{...process.env,DODO_CONFIG_DIR:c.configDir},timeout:20000});
      expect(JSON.parse(cli.stdout)).toMatchObject({items:[{id:target.id,revision:1,definition:{name:'web-fixture'}}]});
      expect(errors).toEqual([]);
    } finally { await browser.close(); }
  },60000);
});
