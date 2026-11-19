import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';
import { CREATIVE_MEDIA_DEFAULTS, CREATIVE_IMAGE_PRESETS, CreativeSettingsInput } from '../../src/services/multimodal/creativeSettings.js';

const executablePath = process.env['DODO_TEST_CHROMIUM_EXECUTABLE'] ?? chromium.executablePath();
interface Connection { id: string; name: string; provider: string; protocol: string; baseUrl: string; enabled: boolean; credentialPresent: boolean; credentialStorage: string; credentialEnvVar?: string; allowPrivateNetwork: boolean }
interface FixtureOptions {
  connections?: Connection[];
  media?: Record<string, unknown>;
  credentialStorageOptions?: Array<{ id: string; available: boolean }>;
  existingEnvVars?: string[];
  models?: (connectionId: string) => Promise<{ data?: Array<{ id: string }>; status?: number; error?: string }>;
}

async function fixture(options: FixtureOptions = {}) {
  const browser = await chromium.launch({ headless: true, executablePath }), page = await browser.newPage();
  const state = { presets: [], connections: options.connections ?? [] as Connection[], credentialStorageOptions: options.credentialStorageOptions, profiles: [], permissions: [], projects: [{ projectId: 'prj_fixture0001', displayName: 'Media fixture', available: true }], runs: [], accessMode: 'personal', media: CreativeSettingsInput.parse(options.media ?? {}), mediaDefaults: CREATIVE_MEDIA_DEFAULTS, mediaPresets: CREATIVE_IMAGE_PRESETS };
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
      const connection: Connection = { ...c, id: c.id ?? `ai_fixture000${state.connections.length + 1}`, credentialPresent: Boolean(body!['apiKey']) || previous?.credentialPresent === true || options.existingEnvVars?.includes(c.credentialEnvVar ?? '') === true };
      if (connection.credentialStorage === 'env' && !connection.credentialEnvVar) connection.credentialEnvVar = `DODO_AI_KEY_${connection.id.toUpperCase()}`;
      if (previous) state.connections.splice(state.connections.indexOf(previous), 1, connection); else state.connections.push(connection);
      data = connection;
    } else if (url.pathname === '/api/ai/media') { state.media = CreativeSettingsInput.parse(body); data = state.media; }
    else if (url.pathname === '/api/ai/models') {
      const response = options.models ? await options.models(String(body!['connectionId'])) : { data: [{ id: 'fixture-image-a' }, { id: 'fixture-image-b' }] };
      if (response.error) { await route.fulfill({ status: response.status ?? 400, contentType: 'application/json', body: JSON.stringify({ ok: false, error: response.error }) }); return; }
      data = response.data ?? [];
    }
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
  it('offers permanent server Env storage for images, retains references and supports an existing variable without a browser key', async () => {
    const storageOptions = [{ id: 'session', available: true }, { id: 'env', available: true }, { id: 'keychain', available: false }];
    const { browser, page, panel, state, requests, errors } = await fixture({ credentialStorageOptions: storageOptions, existingEnvVars: ['DODO_EXTERNAL_IMAGE_KEY'] });
    const key = 'synthetic-persistent-env-ui-key';
    const saves = () => requests.filter(request => request.path === '/api/ai/connection');
    try {
      await panel.locator('summary').click();
      expect(await panel.locator('select[name=mediaCredentialStorage]').inputValue()).toBe('env');
      expect(await panel.locator('input[name=mediaCredentialEnvVar]').isVisible()).toBe(true);
      expect(await panel.locator('option[value=keychain]').getAttribute('disabled')).toBe('');
      expect(await panel.textContent()).toContain('เครื่องที่รัน DODO');
      await panel.locator('input[name=mediaApiKey]').fill(key);
      await panel.getByRole('button', { name: 'บันทึก Provider สำหรับภาพ', exact: true }).click();
      await expect.poll(() => state.media.connectionId).toBe('ai_fixture0001');
      expect(state.connections[0]).toMatchObject({ credentialStorage: 'env', credentialEnvVar: 'DODO_AI_KEY_AI_FIXTURE0001', credentialPresent: true });
      expect(saves()[0]?.body?.['connection']).toMatchObject({ credentialStorage: 'env' });
      expect(saves()[0]?.body?.['connection']).not.toHaveProperty('credentialEnvVar');
      await panel.getByRole('button', { name: 'แก้ไข connection ที่เลือก', exact: true }).click();
      expect(await panel.locator('input[name=mediaCredentialEnvVar]').inputValue()).toBe('DODO_AI_KEY_AI_FIXTURE0001');
      expect(await panel.locator('input[name=mediaApiKey]').inputValue()).toBe('');
      await panel.locator('input[name=mediaProviderName]').fill('Persistent image renamed');
      await panel.getByRole('button', { name: 'บันทึก Provider สำหรับภาพ', exact: true }).click();
      await expect.poll(() => state.connections[0]?.name).toBe('Persistent image renamed');
      expect(saves()[1]?.body).not.toHaveProperty('apiKey');
      expect(saves()[1]?.body?.['connection']).toMatchObject({ credentialStorage: 'env', credentialEnvVar: 'DODO_AI_KEY_AI_FIXTURE0001' });
      await panel.getByRole('button', { name: 'แก้ไข connection ที่เลือก', exact: true }).click();
      await panel.locator('input[name=mediaCredentialEnvVar]').fill('DODO_CHANGED_IMAGE_KEY');
      await panel.getByRole('button', { name: 'บันทึก Provider สำหรับภาพ', exact: true }).click();
      await expect.poll(() => page.locator('#wb-notice').textContent()).toContain('กรอก API key ใหม่');
      expect(saves()).toHaveLength(2);
      await panel.getByRole('button', { name: 'สร้าง connection ใหม่', exact: true }).click();
      await panel.locator('input[name=mediaCredentialEnvVar]').fill('DODO_EXTERNAL_IMAGE_KEY');
      await panel.getByRole('button', { name: 'บันทึก Provider สำหรับภาพ', exact: true }).click();
      await expect.poll(() => state.media.connectionId).toBe('ai_fixture0002');
      expect(saves()[2]?.body).not.toHaveProperty('apiKey');
      expect(state.connections[1]).toMatchObject({ credentialStorage: 'env', credentialEnvVar: 'DODO_EXTERNAL_IMAGE_KEY', credentialPresent: true });
      expect(await panel.locator('input[name=mediaApiKey]').inputValue()).toBe('');
      expect(await page.evaluate('JSON.stringify({local:{...localStorage},session:{...sessionStorage}})')).not.toContain(key);
      expect(JSON.stringify(state)).not.toContain(key);
      storageOptions[2]!.available = true;
      await page.getByRole('button', { name: 'Providers', exact: true }).click();
      expect(await panel.locator('option[value=keychain]').getAttribute('disabled')).toBe(null);
      expect(errors).toEqual([]);
    } finally { await browser.close(); }
  });

  it('saves and edits general providers with Env references and guards storage/reference changes before submission', async () => {
    const { browser, page, panel, state, requests, errors } = await fixture({ credentialStorageOptions: [{ id: 'session', available: true }, { id: 'env', available: true }, { id: 'keychain', available: false }] });
    const general = page.locator('#wb-body > section').filter({ has: page.getByRole('heading', { name: 'AI Providers', exact: true }) });
    const saves = () => requests.filter(request => request.path === '/api/ai/connection');
    const key = 'synthetic-general-env-ui-key', replacement = 'synthetic-general-env-ui-rotation';
    try {
      expect(await general.locator('select[name=storage]').inputValue()).toBe('env');
      expect(await general.locator('option[value=keychain]').getAttribute('disabled')).toBe('');
      await general.locator('select[name=provider]').selectOption('custom');
      await general.locator('input[name=name]').fill('General Env provider');
      await general.locator('input[name=baseUrl]').fill('https://general-env.example/v1');
      await general.locator('input[name=credentialEnvVar]').fill('DODO_GENERAL_IMAGE_KEY');
      await general.locator('input[name=apiKey]').fill(key);
      await general.getByRole('button', { name: 'บันทึก connection', exact: true }).click();
      await expect.poll(() => state.connections.length).toBe(1);
      expect(state.connections[0]).toMatchObject({ credentialStorage: 'env', credentialEnvVar: 'DODO_GENERAL_IMAGE_KEY' });
      expect(saves()[0]?.body?.['apiKey']).toBe(key);
      await general.getByRole('button', { name: 'แก้ไข', exact: true }).click();
      expect(await general.locator('input[name=credentialEnvVar]').inputValue()).toBe('DODO_GENERAL_IMAGE_KEY');
      expect(await general.locator('input[name=apiKey]').inputValue()).toBe('');
      await general.locator('input[name=name]').fill('General Env renamed');
      await general.getByRole('button', { name: 'บันทึก connection', exact: true }).click();
      await expect.poll(() => state.connections[0]?.name).toBe('General Env renamed');
      expect(saves()[1]?.body).not.toHaveProperty('apiKey');
      await general.getByRole('button', { name: 'แก้ไข', exact: true }).click();
      await general.locator('input[name=credentialEnvVar]').fill('DODO_GENERAL_ROTATED_KEY');
      await general.getByRole('button', { name: 'บันทึก connection', exact: true }).click();
      await expect.poll(() => page.locator('#wb-notice').textContent()).toContain('กรอก API key ใหม่');
      expect(saves()).toHaveLength(2);
      await general.locator('input[name=apiKey]').fill(replacement);
      await general.getByRole('button', { name: 'บันทึก connection', exact: true }).click();
      await expect.poll(() => state.connections[0]?.credentialEnvVar).toBe('DODO_GENERAL_ROTATED_KEY');
      await general.getByRole('button', { name: 'แก้ไข', exact: true }).click();
      await general.locator('select[name=storage]').selectOption('session');
      expect(await general.locator('input[name=credentialEnvVar]').isVisible()).toBe(false);
      await general.getByRole('button', { name: 'บันทึก connection', exact: true }).click();
      await expect.poll(() => page.locator('#wb-notice').textContent()).toContain('กรอก API key ใหม่');
      expect(saves()).toHaveLength(3);
      await general.locator('input[name=apiKey]').fill(replacement);
      await general.getByRole('button', { name: 'บันทึก connection', exact: true }).click();
      await expect.poll(() => state.connections[0]?.credentialStorage).toBe('session');
      expect(saves()[3]?.body?.['connection']).not.toHaveProperty('credentialEnvVar');
      expect(await panel.locator('input[name=mediaApiKey]').inputValue()).toBe('');
      const browserState = await page.evaluate('JSON.stringify({local:{...localStorage},session:{...sessionStorage}})');
      for (const secret of [key, replacement]) { expect(browserState).not.toContain(secret); expect(JSON.stringify(state)).not.toContain(secret); }
      expect(errors).toEqual([]);
    } finally { await browser.close(); }
  });

  it('offers editable official presets and saves Gemini without enabling compatibility video', async () => {
    const { browser, page, panel, state, requests, errors } = await fixture();
    const key = 'synthetic-gemini-ui-credential';
    try {
      expect(await panel.locator('input[name=mediaBaseUrl]').inputValue()).toBe('https://api.openai.com/v1');
      expect(await panel.locator('input[name=mediaBaseUrl]').isEditable()).toBe(true);
      expect(await panel.locator('input[name=mediaImageModel]').inputValue()).toBe('auto');
      expect(await panel.locator('input[name=mediaVideoEnabled]').isChecked()).toBe(false);
      expect(await panel.locator('input[name=mediaVideoModel]').inputValue()).toBe('');
      expect(await panel.locator('select[name=mediaModelPicker] option[value=auto]').textContent()).toContain('Auto');
      await panel.locator('summary').click();
      await panel.locator('select[name=mediaProviderPreset]').selectOption('gemini');
      expect(await panel.locator('select[name=mediaProtocol]').inputValue()).toBe('gemini');
      expect(await panel.locator('input[name=mediaBaseUrl]').inputValue()).toBe('https://generativelanguage.googleapis.com/v1beta');
      expect(await panel.locator('input[name=mediaProviderModel]').inputValue()).toBe('auto');
      await panel.locator('input[name=mediaApiKey]').fill(key);
      await panel.getByRole('button', { name: 'บันทึก Provider สำหรับภาพ', exact: true }).click();
      await expect.poll(() => state.media.connectionId).toBe('ai_fixture0001');
      expect(state.connections[0]).toMatchObject({ provider: 'gemini', protocol: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' });
      expect(state.media.imageModel).toBe('auto');
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
      expect(await panel.locator('input[name=mediaProviderModel]').inputValue()).toBe('auto');
      await panel.locator('input[name=mediaProviderName]').fill('Custom image fixture');
      await panel.locator('input[name=mediaBaseUrl]').fill(endpoint);
      await panel.locator('input[name=mediaProviderModel]').fill('');
      expect(await panel.locator('input[name=mediaBaseUrl]').inputValue()).toBe(endpoint);
      await panel.locator('input[name=mediaApiKey]').fill(key);
      await panel.getByRole('button', { name: 'บันทึก Provider สำหรับภาพ', exact: true }).click();
      await expect.poll(() => state.media.connectionId).toBe('ai_fixture0001');
      expect(state.media.imageModel).toBe('auto');
      expect(state.connections[0]).toMatchObject({ provider: 'custom', protocol: 'responses', baseUrl: endpoint, credentialPresent: true });
      await expect.poll(() => panel.locator('select[name=mediaConnection]').inputValue()).toBe('ai_fixture0001');
      await panel.locator('input[name=mediaImageModel]').fill('manual-model');
      await panel.getByRole('button', { name: 'โหลดโมเดลสำหรับภาพ', exact: true }).click();
      await expect.poll(() => panel.locator('select[name=mediaModelPicker] option[value=fixture-image-b]').count()).toBe(1);
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

  it('automatically discovers models once per connection, deduplicates pending loads and preserves Auto/manual fallback', async () => {
    const connections: Connection[] = ['a', 'b', 'c'].map((name, index) => ({ id: `ai_fixture000${index + 1}`, name: `Image fixture ${name}`, provider: 'custom', protocol: 'responses', baseUrl: `https://images-${name}.example/v1`, enabled: true, credentialPresent: true, credentialStorage: 'session', allowPrivateNetwork: false }));
    const counts = new Map<string, number>();
    let releaseA: (value: { data: Array<{ id: string }> }) => void = () => undefined;
    const first = new Promise<{ data: Array<{ id: string }> }>(resolve => { releaseA = resolve; });
    const { browser, page, panel, state, requests, errors } = await fixture({
      connections, media: { connectionId: 'ai_fixture0001', imageModel: 'auto' },
      models: async id => {
        counts.set(id, (counts.get(id) ?? 0) + 1);
        if (id === 'ai_fixture0001') return first;
        if (id === 'ai_fixture0002') return { data: [{ id: 'b-image' }] };
        return { status: 404, error: 'Model listing is unavailable' };
      },
    });
    try {
      await expect.poll(() => counts.get('ai_fixture0001')).toBe(1);
      expect(await panel.locator('select[name=mediaModelPicker]').inputValue()).toBe('auto');
      await panel.getByRole('button', { name: 'โหลดโมเดลสำหรับภาพ', exact: true }).click();
      expect(counts.get('ai_fixture0001')).toBe(1);
      await panel.locator('select[name=mediaConnection]').selectOption('ai_fixture0002');
      await expect.poll(() => panel.locator('select[name=mediaModelPicker] option[value=b-image]').count()).toBe(1);
      const firstResponse = page.waitForResponse(response => response.url().endsWith('/api/ai/models') && response.request().postDataJSON()?.connectionId === 'ai_fixture0001');
      releaseA({ data: [{ id: 'a-image' }] }); await firstResponse;
      await panel.locator('select[name=mediaConnection]').selectOption('ai_fixture0001');
      await expect.poll(() => panel.locator('select[name=mediaModelPicker] option[value=a-image]').count()).toBe(1);
      await panel.locator('select[name=mediaConnection]').selectOption('ai_fixture0002');
      await expect.poll(() => panel.locator('select[name=mediaModelPicker] option[value=b-image]').count()).toBe(1);
      expect(await panel.locator('select[name=mediaModelPicker] option[value=a-image]').count()).toBe(0);
      expect(counts.get('ai_fixture0001')).toBe(1); expect(counts.get('ai_fixture0002')).toBe(1);
      expect(await panel.locator('input[name=mediaImageModel]').inputValue()).toBe('auto');
      await panel.locator('select[name=mediaConnection]').selectOption('ai_fixture0003');
      await expect.poll(() => panel.textContent()).toContain('กรอก Model ID เองได้');
      expect(counts.get('ai_fixture0003')).toBe(1);
      expect(await panel.locator('select[name=mediaModelPicker] option[value=auto]').count()).toBe(1);
      await panel.locator('input[name=mediaImageModel]').fill('manual-fallback-image');
      await panel.getByRole('button', { name: 'บันทึก Creative Media', exact: true }).click();
      await expect.poll(() => state.media.imageModel).toBe('manual-fallback-image');
      await expect.poll(() => panel.locator('select[name=mediaConnection]').inputValue()).toBe('ai_fixture0003');
      await expect.poll(() => panel.textContent()).toContain('กรอก Model ID เองได้');
      expect(counts.get('ai_fixture0003')).toBe(1);
      await panel.getByRole('button', { name: 'โหลดโมเดลสำหรับภาพ', exact: true }).click();
      await expect.poll(() => counts.get('ai_fixture0003')).toBe(2);
      await panel.locator('select[name=mediaModelPicker]').selectOption('auto');
      expect(await panel.locator('input[name=mediaImageModel]').inputValue()).toBe('auto');
      await panel.getByRole('button', { name: 'บันทึก Creative Media', exact: true }).click();
      await expect.poll(() => state.media.imageModel).toBe('auto');
      expect(counts.get('ai_fixture0003')).toBe(2);
      expect(requests.every(request => ['/api/ai/state', '/api/ai/media', '/api/ai/models'].includes(request.path))).toBe(true);
      expect(errors).toEqual([]);
    } finally { releaseA({ data: [] }); await browser.close(); }
  });
});
