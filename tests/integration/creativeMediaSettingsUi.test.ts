import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';
import { CREATIVE_MEDIA_DEFAULTS, CreativeSettingsInput } from '../../src/services/multimodal/creativeSettings.js';

const executablePath = process.env['DODO_TEST_CHROMIUM_EXECUTABLE'] ?? chromium.executablePath();
describe.skipIf(!fs.existsSync(executablePath))('creative media owner UI', () => {
  it('uses key-only OpenAI setup, saves allowed projects and upload preference, and keeps keys out of browser storage', async () => {
    const browser = await chromium.launch({ headless: true, executablePath });
    const page = await browser.newPage();
    const state = { presets: [], connections: [] as Array<{ id: string; name: string; provider: string; protocol: string; baseUrl: string; enabled: boolean; credentialPresent: boolean }>, profiles: [], permissions: [], projects: [{ projectId: 'prj_fixture0001', displayName: 'Media fixture', available: true }], runs: [], accessMode: 'personal', media: CreativeSettingsInput.parse({}), mediaDefaults: CREATIVE_MEDIA_DEFAULTS };
    const requests: Array<{ path: string; body?: Record<string, unknown> }> = [];
    const key = 'synthetic-creative-ui-credential';
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    try {
      await page.route('https://owner-fixture.invalid/**', async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.pathname === '/') { await route.fulfill({ contentType: 'text/html', body: '<button data-wb-view="providers">Providers</button><main id="workbench"><div id="wb-toolbar"></div><select id="wb-project"></select><button id="wb-select"></button><button id="wb-refresh"></button><div id="wb-root"></div><div id="wb-summary"></div><div id="wb-notice"></div><div id="wb-body"></div></main>' }); return; }
        const body = request.method() === 'POST' ? request.postDataJSON() as Record<string, unknown> : undefined;
        requests.push({ path: url.pathname, ...(body ? { body } : {}) });
        let data: unknown;
        if (url.pathname === '/api/ai/state') data = state;
        else if (url.pathname === '/api/ai/connection') {
          const c = body!['connection'] as Record<string, unknown>;
          expect(c['baseUrl']).toBe('https://api.openai.com/v1'); expect(body!['apiKey']).toBe(key);
          const connection = { id: 'ai_fixture0001', name: String(c['name']), provider: String(c['provider']), protocol: String(c['protocol']), baseUrl: String(c['baseUrl']), enabled: true, credentialPresent: true };
          state.connections.push(connection); data = connection;
        } else if (url.pathname === '/api/ai/media') { state.media = CreativeSettingsInput.parse(body); data = state.media; }
        else throw new Error(`unexpected route ${url.pathname}`);
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, data }) });
      });
      await page.goto('https://owner-fixture.invalid/');
      await page.addScriptTag({ content: 'window.DodoRecovery = window.DodoDataRecovery = window.DodoDeployment = () => async () => {};' });
      await page.addScriptTag({ content: fs.readFileSync(path.resolve('src/server/configUi/workbench.js'), 'utf8') });
      await page.getByRole('button', { name: 'Providers', exact: true }).click();
      await expect.poll(() => page.locator('#wb-notice').textContent()).not.toContain('✕');
      const panel = page.locator('#wb-creative-media');
      await panel.waitFor({ timeout: 3000 }).catch(async () => { throw new Error(`media panel missing: ${await page.locator('#wb-notice').textContent()}; ${errors.join('; ')}`); });
      expect(await panel.locator('input[name=baseUrl]').count()).toBe(0);
      expect(await panel.locator('input[name=mediaImageModel]').inputValue()).toBe('gpt-image-2.5-flare');
      expect(await panel.locator('input[name=mediaEnabled]').isChecked()).toBe(false);
      expect(await panel.locator('input[name=mediaVideoEnabled]').isChecked()).toBe(false);
      expect(await panel.locator('input[name=mediaVideoModel]').inputValue()).toBe('');
      expect(await panel.textContent()).toContain('24 กันยายน 2026');
      await panel.locator('summary').click(); await panel.locator('input[name=mediaApiKey]').fill(key);
      await panel.getByRole('button', { name: 'บันทึก OpenAI สำหรับงานสื่อ', exact: true }).click();
      await expect.poll(() => state.media.connectionId).toBe('ai_fixture0001');
      await expect.poll(() => panel.locator('select[name=mediaConnection]').inputValue()).toBe('ai_fixture0001');
      expect(await panel.locator('input[name=mediaVideoEnabled]').isDisabled()).toBe(true);
      await panel.locator('input[name=mediaEnabled]').check(); await panel.locator('input[name=mediaAllowImageUpload]').check();
      await panel.locator('input[name=mediaProject-prj_fixture0001]').check();
      await panel.getByRole('button', { name: 'บันทึก Creative Media', exact: true }).click();
      await expect.poll(() => state.media.enabled).toBe(true);
      expect(state.media).toMatchObject({ connectionId: 'ai_fixture0001', projectIds: ['prj_fixture0001'], allowImageUpload: true });
      expect(state.media).toMatchObject({ videoEnabled: false, videoModel: '' });
      expect(await panel.locator('input[name=mediaApiKey]').inputValue()).toBe('');
      state.connections.push({ id: 'ai_videofixture', name: 'Compatibility fixture', provider: 'custom', protocol: 'responses', baseUrl: 'https://media-fixture.example/v1', enabled: true, credentialPresent: true });
      await page.getByRole('button', { name: 'Providers', exact: true }).click();
      await expect.poll(() => panel.locator('select[name=mediaConnection] option').count()).toBe(3);
      await panel.locator('select[name=mediaConnection]').selectOption('ai_videofixture');
      expect(await panel.locator('input[name=mediaVideoEnabled]').isDisabled()).toBe(false);
      await panel.locator('input[name=mediaVideoEnabled]').check();
      await panel.locator('input[name=mediaVideoModel]').fill('fixture-video');
      await panel.getByRole('button', { name: 'บันทึก Creative Media', exact: true }).click();
      await expect.poll(() => state.media.videoEnabled).toBe(true);
      expect(state.media).toMatchObject({ connectionId: 'ai_videofixture', videoModel: 'fixture-video' });
      expect(await panel.textContent()).not.toContain('https://media-fixture.example');
      expect(await page.evaluate('JSON.stringify({local:{...localStorage},session:{...sessionStorage}})')).not.toContain(key);
      expect(requests.every(r => ['/api/ai/state', '/api/ai/connection', '/api/ai/media'].includes(r.path))).toBe(true);
      expect(errors).toEqual([]);
    } finally { await browser.close(); }
  });
});
