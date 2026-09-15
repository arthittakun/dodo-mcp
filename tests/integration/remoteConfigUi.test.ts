import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';
import { installationIpcCall } from '../../src/ipc/installationClient.js';
import { launch } from '../helpers/testServer.js';

describe.skipIf(!fs.existsSync(chromium.executablePath()))('temporary Remote Config in Chromium', () => {
  it('pairs in the browser, loads the real dashboard at desktop/mobile widths, then closes immediately', async () => {
    const ctx = await launch({ trust: 'trusted', configPort: 0, remoteConfig: true, remoteConfigLeaseMs: 30_000 });
    const lease = ctx.server.remoteConfig;
    if (!lease) throw new Error('missing Remote Config lease');
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const problems: string[] = [];
    page.on('pageerror', error => problems.push(`pageerror:${error.name}`));
    page.on('console', message => {
      if (message.type() === 'error') problems.push(`console:${message.text().slice(0, 200)}`);
    });
    const evidence = path.resolve('release-evidence/remote-config');
    fs.mkdirSync(evidence, { recursive: true });
    try {
      await page.goto(lease.url);
      await page.getByRole('heading', { name: 'DODO Remote Config', exact: true }).waitFor();
      expect(page.url()).not.toMatch(/[?#]/);
      await page.getByLabel('Pairing code', { exact: true }).fill(lease.pairingCode);
      await page.getByRole('button', { name: 'เชื่อมต่อ', exact: true }).click();

      await page.locator('.brand .sub').getByText(/Remote Config/).waitFor();
      await page.locator('#chip-config').getByText('Remote Config', { exact: true }).waitFor();
      await page.locator('.foot').getByText(/ผ่าน HTTPS tunnel/).waitFor();
      await page.getByText(/โหมดส่วนตัว|โหมดแยกสิทธิ์/).first().waitFor();
      expect(page.url()).toBe(lease.url);
      expect(await page.evaluate('JSON.stringify({local:{...localStorage},session:{...sessionStorage}})')).not.toContain(lease.pairingCode);
      await page.screenshot({ path: path.join(evidence, 'desktop.png'), fullPage: true });

      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await page.getByRole('heading', { name: 'Advanced Settings', exact: true }).waitFor();
      expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
      await page.screenshot({ path: path.join(evidence, 'mobile.png'), fullPage: true });
      expect(problems).toEqual([]);

      await installationIpcCall(ctx.configDir, 'remoteConfig.close');
      await page.reload();
      expect((await page.locator('body').textContent()) ?? '').not.toContain('DODO Remote Config');
      expect(page.url()).toBe(lease.url);
    } finally {
      await browser.close();
      await ctx.cleanup();
    }
  }, 45_000);
});
