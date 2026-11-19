import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';
import { CREATIVE_MEDIA_DEFAULTS, CREATIVE_IMAGE_PRESETS, CreativeSettingsInput } from '../../src/services/multimodal/creativeSettings.js';

const executablePath = process.env['DODO_TEST_CHROMIUM_EXECUTABLE'] ?? chromium.executablePath();
interface Connection { id: string; name: string; provider: string; protocol: string; baseUrl: string; enabled: boolean; credentialPresent: boolean; credentialStorage: string; allowPrivateNetwork: boolean }

async function fixture() {
  const browser = await chromium.launch({ headless: true, executablePath }), page = await browser.newPage();
  const state = { presets: [], connections: [] as Connection[], profiles: [], permissions: [], projects: [{ projectId: 'prj_fixture0001', displayName: 'Media fixture', available: true }], runs: [], accessMode: 'personal', media: CreativeSettingsInput.parse({}), mediaDefaults: CREATIVE_MEDIA_DEFAULTS, mediaPresets: CREATIVE_IMAGE_PRESETS };
  const requests: Array<{ path: string; body?: Record<string, unknown> }> = [], errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://owner-fixture.invalid/**', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname === '/') { await route.fulfill({ contentType: 'text/html', body: '<button data-wb-view="providers">Providers</button><main id="workbench"><div id="wb-toolbar"></div><select id="wb-project"></select><button id="wb-select"></button><button id="wb-refresh"></button><div id="wb-root"></div><div id="wb-summary"></div><div id="wb-notice"></div><div id="wb-body"></div></main>' }); return; }
    const body = request.method() === 'POST' ? request.postDataJSON() as Record<string, unknown> : undefined;
    requests.push({ path: url.pathname, ...(body ? { body } : {}) });
    let data: unknown;
    if (url.pathname === '/api/ai/state') data = state;
    else if (url.pathname === '/api/ai/connection') {
      const c = body!['connection'] as Omit<Connection, 'id' | 'credentialPresent'> & { id?: string };
      const previous = state.connections.find(value => value.id === c.id);
      const connection: Connection = { ...c, id: c.id ?? `ai_fixture000${state.connections.length + 1}`, credentialPresent: Boolean(body!['apiKey']) || previous?.credentialPresent === true };
      if (previous) state.connections.splice(state.connections.indexOf(previous), 1, connection); else state.connections.push(connection);
      data = connection;
    } else if (url.pathname === '/api/ai/media') { state.media = CreativeSettingsInput.parse(body); data = state.media; }
    else if (url.pathname === '/api/ai/models') data = [{ id: 'fixture-image-a' }, { id: 'fixture-image-b' }];
    else throw new Error(`unexpected route ${url.pathname}`);
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, data }) });
  });
  await page.goto('https://owner-fixture.invalid/');
  await page.addScriptTag({ content: 'window.DodoRecovery = window.DodoDataRecovery = window.DodoDeployment = () => async () => {};' });
  await page.addScriptTag({ content: fs.readFileSync(path.resolve('src/server/configUi/workbench.js'), 'utf8') });
  await page.getByRole('button', { name: 'Providers', exact: true }).click();
  const panel = page.locator('#wb-creative-media');
  await panel.waitFor({ timeout: 3000 });
  return { browser, page, panel, state, requests, errors };
}

describe.skipIf(!fs.existsSync(executablePath))('creative media owner UI', () => {
  it('offers editable official presets and saves Gemini without enabling compatibility video', async () => {
    const { browser, page, panel, state, requests, errors } = await fixture();
    const key = 'synthetic-gemini-ui-credential';
    try {
      expect(await panel.locator('input[name=mediaBaseUrl]').inputValue()).toBe('https://api.openai.com/v1');
      expect(await panel.locator('input[name=mediaBaseUrl]').isEditable()).toBe(true);
      expect(await panel.locator('input[name=mediaImageModel]').inputValue()).toBe('gpt-image-2.5-flare');
      expect(await panel.locator('input[name=mediaVideoEnabled]').isChecked()).toBe(false);
      expect(await panel.locator('input[name=mediaVideoModel]').inputValue()).toBe('');
      await panel.locator('summary').click();
      await panel.locator('select[name=mediaProviderPreset]').selectOption('gemini');
      expect(await panel.locator('select[name=mediaProtocol]').inputValue()).toBe('gemini');
      expect(await panel.locator('input[name=mediaBaseUrl]').inputValue()).toBe('https://generativelanguage.googleapis.com/v1beta');
      expect(await panel.locator('input[name=mediaProviderModel]').inputValue()).toBe('gemini-nano-banana-2.1');
      await panel.locator('input[name=mediaApiKey]').fill(key);
      await panel.getByRole('button', { name: 'บันทึก Provider สำหรับภาพ', exact: true }).click();
      await expect.poll(() => state.media.connectionId).toBe('ai_fixture0001');
      expect(state.connections[0]).toMatchObject({ provider: 'gemini', protocol: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' });
      expect(state.media.imageModel).toBe('gemini-nano-banana-2.1');
      await expect.poll(() => panel.locator('select[name=mediaConnection]').inputValue()).toBe('ai_fixture0001');
      expect(await panel.locator('input[name=mediaVideoEnabled]').isDisabled()).toBe(true);
      await panel.locator('input[name=mediaEnabled]').check();
      await panel.locator('input[name=mediaAllowImageUpload]').check();
      await panel.locator('input[name=mediaProject-prj_fixture0001]').check();
      await panel.getByRole('button', { name: 'บันทึก Creative Media', exact: true }).click();
      await expect.poll(() => state.media.enabled).toBe(true);
      expect(state.media).toMatchObject({ projectIds: ['prj_fixture0001'], allowImageUpload: true, videoEnabled: false });
      expect(await panel.locator('input[name=mediaApiKey]').inputValue()).toBe('');
      expect(await page.evaluate('JSON.stringify({local:{...localStorage},session:{...sessionStorage}})')).not.toContain(key);
      expect(JSON.stringify(state)).not.toContain(key);
      expect(requests.find(request => request.path === '/api/ai/connection')?.body?.['apiKey']).toBe(key);
      // Provider labels are metadata; the explicitly selected wire protocol controls eligibility.
      await panel.locator('summary').click();
      await panel.locator('select[name=mediaProtocol]').selectOption('gemini');
      await panel.locator('input[name=mediaBaseUrl]').fill('https://native-images.example/v1beta');
      await panel.locator('input[name=mediaProviderModel]').fill('gemini-fixture');
      await panel.locator('input[name=mediaApiKey]').fill(key);
      await panel.getByRole('button', { name: 'บันทึก Provider สำหรับภาพ', exact: true }).click();
      await expect.poll(() => state.media.connectionId).toBe('ai_fixture0002');
      expect(state.connections[1]).toMatchObject({ provider: 'openai', protocol: 'gemini' });
      await expect.poll(() => panel.locator('select[name=mediaConnection]').inputValue()).toBe('ai_fixture0002');
      expect(errors).toEqual([]);
    } finally { await browser.close(); }
  });

  it('creates and edits a custom URL/key, retains blank-key credentials and offers explicit model selection', async () => {
    const { browser, page, panel, state, requests, errors } = await fixture();
    const key = 'synthetic-custom-ui-credential', replacementKey = 'synthetic-replacement-ui-credential';
    const endpoint = 'https://image-gateway.example/v1', changedEndpoint = 'https://alternate-images.example/api/v1';
    const saves = () => requests.filter(request => request.path === '/api/ai/connection');
    try {
      await panel.locator('summary').click();
      await panel.locator('select[name=mediaProviderPreset]').selectOption('custom');
      expect(await panel.locator('input[name=mediaBaseUrl]').inputValue()).toBe('');
      expect(await panel.locator('input[name=mediaProviderModel]').inputValue()).toBe('');
      await panel.locator('input[name=mediaProviderName]').fill('Custom image fixture');
      await panel.locator('input[name=mediaBaseUrl]').fill(endpoint);
      await panel.locator('input[name=mediaProviderModel]').fill('fixture-image-a');
      expect(await panel.locator('input[name=mediaBaseUrl]').inputValue()).toBe(endpoint);
      await panel.locator('input[name=mediaApiKey]').fill(key);
      await panel.getByRole('button', { name: 'บันทึก Provider สำหรับภาพ', exact: true }).click();
      await expect.poll(() => state.media.connectionId).toBe('ai_fixture0001');
      expect(state.connections[0]).toMatchObject({ provider: 'custom', protocol: 'responses', baseUrl: endpoint, credentialPresent: true });
      await expect.poll(() => panel.locator('select[name=mediaConnection]').inputValue()).toBe('ai_fixture0001');
      await panel.locator('input[name=mediaImageModel]').fill('manual-model');
      await panel.getByRole('button', { name: 'โหลดโมเดลสำหรับภาพ', exact: true }).click();
      await expect.poll(() => panel.locator('select[name=mediaModelPicker] option').count()).toBe(3);
      expect(await panel.locator('input[name=mediaImageModel]').inputValue()).toBe('manual-model');
      await panel.locator('select[name=mediaModelPicker]').selectOption('fixture-image-b');
      expect(await panel.locator('input[name=mediaImageModel]').inputValue()).toBe('fixture-image-b');
      await panel.getByRole('button', { name: 'แก้ไข connection ที่เลือก', exact: true }).click();
      expect(await panel.locator('input[name=mediaBaseUrl]').inputValue()).toBe(endpoint);
      expect(await panel.locator('input[name=mediaProviderModel]').inputValue()).toBe('fixture-image-b');
      await panel.locator('input[name=mediaProviderName]').fill('Renamed custom fixture');
      await panel.getByRole('button', { name: 'บันทึก Provider สำหรับภาพ', exact: true }).click();
      await expect.poll(() => state.connections[0]?.name).toBe('Renamed custom fixture');
      expect(state.connections).toHaveLength(1); expect(saves()).toHaveLength(2);
      expect(saves()[1]?.body).not.toHaveProperty('apiKey');
      expect(saves()[1]?.body?.['connection']).toMatchObject({ id: 'ai_fixture0001', provider: 'custom', baseUrl: endpoint });
      await expect.poll(() => panel.locator('select[name=mediaConnection]').inputValue()).toBe('ai_fixture0001');
      await panel.getByRole('button', { name: 'แก้ไข connection ที่เลือก', exact: true }).click();
      await panel.locator('input[name=mediaBaseUrl]').fill(changedEndpoint);
      await panel.getByRole('button', { name: 'บันทึก Provider สำหรับภาพ', exact: true }).click();
      await expect.poll(() => page.locator('#wb-notice').textContent()).toContain('กรอก API key ใหม่');
      expect(saves()).toHaveLength(2);
      await panel.locator('input[name=mediaApiKey]').fill(replacementKey);
      await panel.getByRole('button', { name: 'บันทึก Provider สำหรับภาพ', exact: true }).click();
      await expect.poll(() => state.connections[0]?.baseUrl).toBe(changedEndpoint);
      expect(saves()).toHaveLength(3); expect(saves()[2]?.body?.['apiKey']).toBe(replacementKey);
      expect(saves()[2]?.body?.['connection']).toMatchObject({ id: 'ai_fixture0001', baseUrl: changedEndpoint });
      await expect.poll(() => panel.locator('select[name=mediaConnection]').inputValue()).toBe('ai_fixture0001');
      expect(await panel.locator('input[name=mediaApiKey]').inputValue()).toBe('');
      const storage = await page.evaluate('JSON.stringify({local:{...localStorage},session:{...sessionStorage}})');
      for (const secret of [key, replacementKey]) { expect(storage).not.toContain(secret); expect(JSON.stringify(state)).not.toContain(secret); }
      expect(errors).toEqual([]);
    } finally { await browser.close(); }
  });
});
