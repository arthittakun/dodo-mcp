import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { describe, it, expect } from 'vitest';
import { launch, mkTmpDir } from '../helpers/testServer.js';
import { ProjectAdmin } from '../../src/projects/ownerAdmin.js';

/**
 * The Projects page is the ONE place an owner configures a project: path, name
 * and a single access level. These run in real Chromium against the real
 * Local Config server.
 */
describe.skipIf(!fs.existsSync(chromium.executablePath()))('projects page access level', () => {
  const evidence = path.resolve('release-evidence/project-access');

  it('adds a project with one access level, shows it, changes it, and persists across reload', async () => {
    const projectDir = mkTmpDir('dodo-ui-access-');
    const ctx = await launch({ trust: 'trusted', configPort: 0, configPatch: { accessMode: 'personal' } });
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const problems: string[] = [];
    page.on('pageerror', (e) => problems.push(e.message));
    fs.mkdirSync(evidence, { recursive: true });
    try {
      await page.goto(ctx.configUrl!);
      await page.getByRole('button', { name: 'โปรเจกต์', exact: true }).click();

      // Personal mode: the per-project ACL/trust ceremony is not on this page.
      await page.locator('#personal-note').waitFor({ state: 'visible' });
      expect(await page.locator('#card-perm').isVisible()).toBe(false);
      expect(await page.locator('#card-clients').isVisible()).toBe(false);

      // One flow: path + name + access level.
      await page.locator('#project-add-path').fill(projectDir);
      await page.locator('#project-add-name').fill('auto-upload');
      await page.locator('#project-add-access').selectOption('read');
      await page.locator('#project-add-open').uncheck();
      await page.locator('#project-add').click();

      // The card shows the level the backend actually stored.
      const card = page.locator('.project-entry', { hasText: 'auto-upload' });
      await card.waitFor();
      await expect.poll(() => card.locator('.project-access select').inputValue()).toBe('read');
      expect(await card.locator('.project-access .help').first().textContent()).toContain('อ่านอย่างเดียว');
      const admin = new ProjectAdmin(ctx.server.services.store);
      expect(admin.list().find((p) => p.displayName === 'auto-upload')?.accessLevel).toBe('read');
      await page.screenshot({ path: path.join(evidence, 'projects-access-read.png'), fullPage: true });

      // Changing the level goes through the backend and reports only on success.
      await card.locator('.project-access select').selectOption('full');
      await card.getByRole('button', { name: 'บันทึกระดับ' }).click();
      await expect.poll(() => card.locator('.project-access-status').textContent()).toContain('✓');
      expect(admin.list().find((p) => p.displayName === 'auto-upload')?.accessLevel).toBe('full');

      // Persisted: a reload shows the saved value, not an optimistic one.
      await page.reload();
      await page.getByRole('button', { name: 'โปรเจกต์', exact: true }).click();
      const reloaded = page.locator('.project-entry', { hasText: 'auto-upload' });
      await reloaded.waitFor();
      await expect.poll(() => reloaded.locator('.project-access select').inputValue()).toBe('full');

      // A duplicate name is refused, and the page reports the error (no success).
      const second = mkTmpDir('dodo-ui-access-dup-');
      try {
        await page.locator('#project-add-path').fill(second);
        await page.locator('#project-add-name').fill('Auto-Upload');
        await page.locator('#project-add').click();
        await page.locator('#project-add-error').waitFor({ state: 'visible' });
        expect(await page.locator('#project-add-error').textContent()).toMatch(/already named|ชื่อ/i);
        expect(admin.list()).toHaveLength(1);
      } finally { fs.rmSync(second, { recursive: true, force: true }); }

      // Narrow viewport stays usable.
      await page.setViewportSize({ width: 390, height: 844 });
      expect(await page.evaluate('document.documentElement.scrollWidth<=innerWidth')).toBe(true);
      expect(problems).toEqual([]);
    } finally {
      await browser.close();
      await ctx.cleanup();
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  }, 90000);

  it('shows managed-mode controls when the installation is managed', async () => {
    const ctx = await launch({ trust: 'trusted', configPort: 0, configPatch: { accessMode: 'managed' } });
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    try {
      await page.goto(ctx.configUrl!);
      await page.getByRole('button', { name: 'โปรเจกต์', exact: true }).click();
      await page.locator('#card-perm').waitFor({ state: 'visible' });
      expect(await page.locator('#card-clients').isVisible()).toBe(true);
      expect(await page.locator('#personal-note').isVisible()).toBe(false);
    } finally { await browser.close(); await ctx.cleanup(); }
  }, 60000);
});
