import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { describe, expect, it, vi } from 'vitest';
import type { RemoteConfigLease } from '../../src/server/remoteConfig.js';
import { installationIpcCall } from '../../src/ipc/installationClient.js';
import type { TunnelRuntime } from '../../src/tunnel/runtime.js';
import { launch } from '../helpers/testServer.js';

describe.skipIf(!fs.existsSync(chromium.executablePath()))('temporary Remote Config in Chromium', () => {
  it('opens after nine hours, loads desktop/mobile dashboards, then closes and reopens without restarting', async () => {
    const tunnelRuntime = {
      status: () => ({ available: true as const, running: true, current: null, lastKnown: null }),
    } as unknown as TunnelRuntime;
    const ctx = await launch({ trust: 'trusted', configPort: 0, tunnelRuntime, connectionMode: 'tunnel' });
    const time = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 9 * 60 * 60 * 1000);
    const lease = await installationIpcCall(ctx.configDir, 'remoteConfig.open') as RemoteConfigLease;
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.clock.setFixedTime(Date.now());
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
      const renewed = await installationIpcCall(ctx.configDir, 'remoteConfig.open') as RemoteConfigLease;
      await page.goto(renewed.url);
      await page.getByLabel('Pairing code', { exact: true }).fill(renewed.pairingCode);
      await page.getByRole('button', { name: 'เชื่อมต่อ', exact: true }).click();
      await page.locator('#chip-config').getByText('Remote Config', { exact: true }).waitFor();
      await page.getByText(/โหมดส่วนตัว|โหมดแยกสิทธิ์/).first().waitFor();
      expect(await page.locator('body').textContent()).not.toContain('expires after 8 hours');
    } finally {
      time.mockRestore();
      await browser.close();
      await ctx.cleanup();
    }
  }, 45_000);
});
