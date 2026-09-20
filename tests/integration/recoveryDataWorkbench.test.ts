import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chromium } from 'playwright';
import { launch, type TestContext } from '../helpers/testServer.js';
import { ProjectRegistry } from '../../src/projects/registry.js';
import { OSRecoveryKeys } from '../../src/services/recovery/configKeys.js';
import { ensurePrivateDirectory } from '../../src/platform/privateFs.js';

describe('R06 owner data recovery in the real browser and CLI', () => {
  let c: TestContext, db: Database.Database;
  afterEach(async () => { vi.restoreAllMocks(); db?.close(); await c?.cleanup(); });
  it.skipIf(!fs.existsSync(chromium.executablePath()))('configures SQLite and encrypted config, restores with redacted preview, and remains usable on narrow screens', async () => {
    c = await launch({ configPort: 0, trust: 'trusted' }); ensurePrivateDirectory(c.fixtureDir);
    const file = path.join(c.fixtureDir, '.env'); fs.writeFileSync(file, 'UI_FIXTURE_PRIVATE=before', { mode: 0o600 });
    db = new Database(path.join(c.fixtureDir, 'fixture.sqlite')); db.exec("CREATE TABLE migrations(id TEXT); INSERT INTO migrations VALUES('v1')");
    const keys = new Map<string, Buffer>();
    vi.spyOn(OSRecoveryKeys.prototype, 'put').mockImplementation(async (id, key) => { keys.set(id, Buffer.from(key)); });
    vi.spyOn(OSRecoveryKeys.prototype, 'get').mockImplementation(async id => Buffer.from(keys.get(id)!));
    const p = new ProjectRegistry(c.server.services.store).add(c.fixtureDir, 'Private data fixture').project;
    const browser = await chromium.launch({ headless: true }), page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors: string[] = []; page.on('pageerror', e => errors.push(e.name));
    const evidence = path.resolve('release-evidence/recovery/r06/browser'); fs.mkdirSync(evidence, { recursive: true });
    try {
      await page.goto(c.configUrl!); await page.getByRole('button', { name: 'โปรเจกต์', exact: true }).click(); await page.locator('#wb-project').selectOption(p.projectId);
      await page.getByText('เพิ่มปลายทาง SQLite แบบอ่านอย่างเดียว', { exact: true }).click();
      await page.getByLabel('ชื่อฐานข้อมูลสำหรับการตรวจ', { exact: true }).fill('Database fixture');
      await page.getByLabel('ไฟล์ .sqlite/.db ภายในโปรเจกต์', { exact: true }).fill('fixture.sqlite');
      await page.getByRole('button', { name: 'อนุญาตให้อ่าน migration metadata', exact: true }).click(); await page.locator('.swal2-confirm').click();
      await page.getByText(/บันทึก dbtarget_.*revision 1/).waitFor(); expect(c.server.services.recovery!.databases.list()).toHaveLength(1);
      await page.getByText('ลงทะเบียนไฟล์ลับสำหรับสำรอง', { exact: true }).click();
      await page.getByLabel('ชื่อรายการ config', { exact: true }).fill('Private fixture');
      await page.getByLabel('Path ภายในโปรเจกต์ เช่น .env', { exact: true }).fill('.env');
      await page.getByRole('button', { name: 'เปิดสำรองไฟล์ลับนี้', exact: true }).click(); await page.locator('.swal2-confirm').click();
      await page.getByText(/ลงทะเบียน configtarget_.*revision 1/).waitFor();
      await page.getByRole('button', { name: 'สำรอง config ตอนนี้', exact: true }).click(); await page.getByText(/สร้างสำเนาเข้ารหัส configbackup_/).waitFor();
      fs.writeFileSync(file, 'UI_FIXTURE_PRIVATE=after');
      await page.getByRole('button', { name: 'ตรวจแผนคืน config', exact: true }).click();
      await page.getByRole('heading', { name: 'แผนคืนค่า · ไม่แสดงเนื้อหาลับ', exact: true }).waitFor();
      expect(await page.locator('#wb-body').innerText()).not.toContain('UI_FIXTURE_PRIVATE');
      await page.getByRole('button', { name: 'ยืนยันคืนค่า config', exact: true }).click(); await page.locator('.swal2-confirm').click();
      await page.getByText(/อ่านกลับตรงกับสำเนา · configrestore_/).waitFor();
      expect(fs.readFileSync(file, 'utf8')).toBe('UI_FIXTURE_PRIVATE=before');
      expect(db.prepare('SELECT * FROM migrations').all()).toEqual([{ id: 'v1' }]);
      const panel = page.getByRole('heading', { name: 'Private config · สำรองแบบเข้ารหัส', exact: true }).locator('..');
      await panel.screenshot({ path: path.join(evidence, 'private-config-desktop.png') });
      await page.setViewportSize({ width: 390, height: 844 });
      expect(await page.evaluate('document.documentElement.scrollWidth<=innerWidth')).toBe(true);
      await panel.screenshot({ path: path.join(evidence, 'private-config-narrow.png') });
      const cli = await promisify(execFile)(process.execPath, [path.resolve('dist/cli/main.js'), 'recovery', 'private-config', 'list'], { cwd: c.fixtureDir, env: { ...process.env, DODO_CONFIG_DIR: c.configDir }, timeout: 20000 });
      expect(JSON.parse(cli.stdout)).toMatchObject({ targets: [{ enabled: true, revision: 1 }], automaticRestart: false });
      expect(cli.stdout).not.toContain('UI_FIXTURE_PRIVATE'); expect(errors).toEqual([]);
    } finally { await browser.close(); }
  }, 60000);
});
