import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { openDatabase } from '../../src/store/db.js';
import { Store } from '../../src/store/store.js';
import { AISettings } from '../../src/services/ai/settings.js';
import { CREATIVE_IMAGE_PRESETS, CREATIVE_MEDIA_DEFAULTS, CreativeSettingsInput, isCreativeConnection, isOfficialOpenAIVideoConnection, supportsCreativeVideoConnection } from '../../src/services/multimodal/creativeSettings.js';

describe('creative media owner configuration', () => {
  let settings: AISettings;
  beforeEach(() => { settings = new AISettings(new Store(openDatabase(':memory:')), [21731, 21740]); });
  afterEach(() => { vi.restoreAllMocks(); settings.credentials.close(); settings.store.db.close(); });

  it('defaults to public OpenAI with cloud disabled and no selected projects', () => {
    expect(settings.media()).toEqual({ enabled: false, connectionId: null, imageModel: 'gpt-image-2.5-flare', videoEnabled: false, videoModel: '', allowImageUpload: false, projectIds: [] });
    expect(settings.state().mediaDefaults.baseUrl).toBe('https://api.openai.com/v1');
    expect(settings.state().mediaDefaults).toEqual(CREATIVE_MEDIA_DEFAULTS);
  });

  it('persists settings independently of session-only credentials and never returns a key', async () => {
    const key = 'synthetic-creative-settings-credential';
    const saved = await settings.saveConnection({ name: 'OpenAI Media', provider: 'openai', protocol: 'responses', baseUrl: CREATIVE_MEDIA_DEFAULTS.baseUrl }, key);
    const value = settings.saveMedia({ enabled: true, connectionId: saved.id, projectIds: ['prj_fixture0001', 'prj_fixture0001'], allowImageUpload: true });
    expect(value.projectIds).toEqual(['prj_fixture0001']);
    expect(settings.state().connections[0]?.credentialPresent).toBe(true);
    const restarted = new AISettings(settings.store, settings.ports);
    expect(restarted.media()).toEqual(value);
    expect(restarted.state().connections[0]?.credentialPresent).toBe(false);
    expect(JSON.stringify(settings.state())).not.toContain(key);
    expect(JSON.stringify(settings.store.db.prepare('SELECT payload FROM ai_settings').all())).not.toContain(key);
    restarted.credentials.close();
  });

  it('rejects enabled missing, disabled or incompatible connections', async () => {
    expect(() => settings.saveMedia({ enabled: true })).toThrow(/enabled image connection/);
    for (const protocol of ['anthropic', 'ollama'] as const) {
      const c = await settings.saveConnection({ name: protocol, provider: 'custom', protocol, baseUrl: 'https://example.com/v1' });
      expect(() => settings.saveMedia({ enabled: true, connectionId: c.id })).toThrow(/enabled image connection/);
    }
    const c = await settings.saveConnection({ name: 'disabled', provider: 'openai', protocol: 'responses', baseUrl: CREATIVE_MEDIA_DEFAULTS.baseUrl, enabled: false });
    expect(() => settings.saveMedia({ enabled: true, connectionId: c.id })).toThrow(/enabled image connection/);
  });

  it('accepts compatible custom connections and prevents removing or disabling the selected connection', async () => {
    const c = await settings.saveConnection({ name: 'Compatible', provider: 'custom', protocol: 'chat-completions', baseUrl: 'https://example.com/v1' });
    settings.saveMedia({ enabled: true, connectionId: c.id, imageModel: 'custom-image', videoEnabled: true, videoModel: 'custom-video' });
    await expect(settings.remove('connection', c.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(settings.saveConnection({ ...c, enabled: false })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(settings.saveConnection({ ...c, baseUrl: CREATIVE_MEDIA_DEFAULTS.baseUrl }, 'synthetic-replacement-key')).rejects.toMatchObject({ code: 'CONFLICT' });
    settings.saveMedia({ enabled: false, connectionId: null });
    await settings.remove('connection', c.id);
    expect(settings.get('connection', c.id)).toBeUndefined();
  });

  it('rejects arbitrary fields, credentials, URLs and malformed project/model identifiers', () => {
    for (const value of [{ baseUrl: 'https://example.com' }, { apiKey: 'synthetic-key' }, { projectIds: ['../outside'] }, { imageModel: 'model\nInjected' }, { videoEnabled: true, videoModel: '' }, { videoModel: 'unsupported model name' }]) expect(CreativeSettingsInput.safeParse(value).success).toBe(false);
    expect(CreativeSettingsInput.safeParse({ videoEnabled: false, videoModel: '' }).success).toBe(true);
  });

  it('keeps image access independent from retired official video even when provider labels differ', async () => {
    for (const baseUrl of ['https://api.openai.com/v1', 'https://API.OPENAI.COM./v1']) {
      const c = await settings.saveConnection({ name: 'Official endpoint under custom label', provider: 'custom', protocol: 'responses', baseUrl });
      expect(isOfficialOpenAIVideoConnection(c)).toBe(true);
      expect(supportsCreativeVideoConnection(c)).toBe(false);
      expect(settings.saveMedia({ enabled: true, connectionId: c.id })).toMatchObject({ enabled: true, videoEnabled: false, videoModel: '' });
      expect(() => settings.saveMedia({ enabled: true, connectionId: c.id, videoEnabled: true, videoModel: 'sora-2' })).toThrow(/official OpenAI Videos API is retired/);
    }
  });

  it('requires a reviewed compatible video connection and model before enabling it', async () => {
    expect(() => settings.saveMedia({ videoEnabled: true, videoModel: 'fixture-video' })).toThrow(/enabled image connection/);
    const c = await settings.saveConnection({ name: 'Compatibility fixture', provider: 'custom', protocol: 'chat-completions', baseUrl: 'https://media-fixture.example/v1' });
    expect(supportsCreativeVideoConnection(c)).toBe(true);
    expect(settings.saveMedia({ enabled: true, connectionId: c.id, videoEnabled: true, videoModel: 'fixture-video' })).toMatchObject({ enabled: true, videoEnabled: true, videoModel: 'fixture-video' });
  });

  it('exposes official and editable custom image starting points without fixing the saved URL', async () => {
    expect(settings.state().mediaPresets).toEqual(CREATIVE_IMAGE_PRESETS);
    expect(CREATIVE_IMAGE_PRESETS.map(p => p.id)).toEqual(['openai', 'gemini', 'custom']);
    const custom = CREATIVE_IMAGE_PRESETS.find(p => p.id === 'custom')!;
    expect(custom).toMatchObject({ provider: 'custom', protocol: 'responses', baseUrl: '', imageModel: '' });
    const c = await settings.saveConnection({ name: 'Independent image service', provider: 'custom', protocol: 'responses', baseUrl: 'https://image-fixture.example/proxy/v3' }, 'synthetic-first-key');
    expect(settings.saveMedia({ enabled: true, connectionId: c.id, imageModel: 'independent-image-model' })).toMatchObject({ connectionId: c.id, imageModel: 'independent-image-model' });
    expect(settings.connection(c.id).baseUrl).toBe('https://image-fixture.example/proxy/v3');
  });

  it('keeps an unchanged connection key and requires reentry before changing URL or protocol', async () => {
    const c = await settings.saveConnection({ name: 'Custom image service', provider: 'custom', protocol: 'responses', baseUrl: 'https://first-image.example/v1' }, 'synthetic-original-key');
    await settings.saveConnection({ ...c, name: 'Renamed image service' });
    expect(await settings.credentials.get(c.id, 'session')).toBe('synthetic-original-key');
    await expect(settings.saveConnection({ ...c, baseUrl: 'https://second-image.example/v1' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(settings.saveConnection({ ...c, protocol: 'gemini' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(settings.connection(c.id).baseUrl).toBe(c.baseUrl);
    expect(await settings.credentials.get(c.id, 'session')).toBe('synthetic-original-key');
    const updated = await settings.saveConnection({ ...c, baseUrl: 'https://second-image.example/v1', protocol: 'chat-completions' }, 'synthetic-replacement-key');
    expect(updated.baseUrl).toBe('https://second-image.example/v1');
    expect(await settings.credentials.get(c.id, 'session')).toBe('synthetic-replacement-key');
    expect(JSON.stringify(settings.state())).not.toMatch(/synthetic-(?:original|replacement)-key/);
  });

  it('supports native Gemini images without claiming its protocol supports video', async () => {
    const preset = CREATIVE_IMAGE_PRESETS.find(p => p.id === 'gemini')!;
    const c = await settings.saveConnection({ name: preset.name, provider: preset.provider, protocol: preset.protocol, baseUrl: preset.baseUrl }, 'synthetic-gemini-key');
    expect(isCreativeConnection(c)).toBe(true); expect(supportsCreativeVideoConnection(c)).toBe(false);
    expect(settings.saveMedia({ enabled: true, connectionId: c.id, imageModel: preset.imageModel })).toMatchObject({ connectionId: c.id, imageModel: preset.imageModel, videoEnabled: false });
    expect(() => settings.saveMedia({ enabled: true, connectionId: c.id, imageModel: preset.imageModel, videoEnabled: true, videoModel: 'fixture-video' })).toThrow(/OpenAI-compatible video protocol/);
    const release = settings.lease(c.id);
    await expect(settings.saveConnection({ ...c, baseUrl: 'https://gemini-image.example/v1beta' }, 'synthetic-new-key')).rejects.toMatchObject({ code: 'CONFLICT' });
    release();
    expect(isCreativeConnection({ ...c, provider: 'openai' })).toBe(true);
    expect(settings.saveMedia({ enabled: true, connectionId: (await settings.saveConnection({ ...c, provider: 'openai' })).id, imageModel: preset.imageModel })).toMatchObject({ imageModel: preset.imageModel });
  });

  it('uses the selected image wire protocol rather than restricting official provider labels', async () => {
    for (const provider of ['glm', 'minimax', 'kimi', 'gemini'] as const) {
      const c = await settings.saveConnection({ name: `${provider} compatible image endpoint`, provider, protocol: 'chat-completions', baseUrl: 'https://image-fixture.example/v1' });
      expect(isCreativeConnection(c)).toBe(true);
      expect(settings.saveMedia({ enabled: true, connectionId: c.id, imageModel: 'fixture-image' }).connectionId).toBe(c.id);
    }
  });

  it('rejects operation URLs before saving credentials and accepts custom API-base paths', async () => {
    for (const endpoint of ['images', 'images/generations', 'images/edits', 'interactions', 'interactions/fixture-id', 'videos', 'videos/edits', 'videos/extensions', 'videos/fixture-id/content', 'models/gemini-fixture:generateContent']) {
      await expect(settings.saveConnection({ name: 'Incorrect full endpoint', provider: 'custom', protocol: 'responses', baseUrl: `https://image-fixture.example/v1/${endpoint}` }, 'synthetic-never-stored-key')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
    expect(settings.state().connections).toHaveLength(0);
    const c = await settings.saveConnection({ name: 'Custom prefix', provider: 'custom', protocol: 'responses', baseUrl: 'https://image-fixture.example/service/image-api/v2/' });
    expect(c.baseUrl).toBe('https://image-fixture.example/service/image-api/v2/');
  });

  it('normalizes Gemini model-list resource names while preserving other provider model IDs', async () => {
    const requests: Array<{ url: string | undefined; key: string | string[] | undefined }> = [];
    const server = http.createServer((req, res) => {
      requests.push({ url: req.url, key: req.headers['x-goog-api-key'] });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ models: [{ name: 'models/gemini-nano-banana-2.1' }, { name: 'gemini-fixture' }] }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1beta`;
      const c = await settings.saveConnection({ name: 'Gemini listing fixture', provider: 'custom', protocol: 'gemini', baseUrl, allowPrivateNetwork: true }, 'synthetic-listing-key');
      expect(await settings.models(c.id)).toEqual([{ id: 'gemini-nano-banana-2.1' }, { id: 'gemini-fixture' }]);
      expect(requests).toEqual([{ url: '/v1beta/models', key: 'synthetic-listing-key' }]);
      const compatible = await settings.saveConnection({ name: 'Other listing fixture', provider: 'custom', protocol: 'responses', baseUrl, allowPrivateNetwork: true }, 'synthetic-other-listing-key');
      expect(await settings.models(compatible.id)).toEqual([{ id: 'models/gemini-nano-banana-2.1' }, { id: 'gemini-fixture' }]);
    } finally {
      await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    }
  });

  it('quarantines a new key durably when connection metadata fails and repairs only with explicit reentry', async () => {
    const originalKey = 'synthetic-binding-original', changedKey = 'synthetic-binding-changed', repairedKey = 'synthetic-binding-repaired';
    const c = await settings.saveConnection({ name: 'Credential binding fixture', provider: 'custom', protocol: 'responses', baseUrl: 'https://original-binding.example/v1' }, originalKey);
    const profile = settings.saveProfile({ name: 'Binding profile', connectionId: c.id, model: 'fixture-model' });
    const changed = { ...c, baseUrl: 'https://replacement-binding.example/v1' };
    settings.store.db.exec("CREATE TRIGGER credential_binding_failure BEFORE UPDATE ON ai_settings WHEN NEW.kind='connection' BEGIN SELECT RAISE(ABORT,'synthetic connection metadata failure'); END");
    const restarted = new AISettings(settings.store, settings.ports);
    try {
      const failure = await settings.saveConnection(changed, changedKey).catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: 'AUTH_REQUIRED', recovery: expect.stringContaining('enter its API key again') });
      const message = String(failure);
      for (const secret of [originalKey, changedKey, c.baseUrl, changed.baseUrl]) expect(message).not.toContain(secret);
      expect(settings.get<{ baseUrl: string }>('connection', c.id)?.baseUrl).toBe(c.baseUrl);
      expect(await settings.credentials.get(c.id, 'session')).toBe(changedKey);
      expect(settings.get('credential-update', c.id)).toEqual({ storage: 'session' });
      expect(settings.state().connections.find(item => item.id === c.id)).toMatchObject({ credentialPresent: false, credentialNeedsReentry: true });
      const getKey = vi.spyOn(settings.credentials, 'get');
      expect(() => settings.connection(c.id)).toThrow(/credentials need to be entered again/);
      await expect(settings.models(c.id)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
      await expect(settings.probe(profile.id, 'inference')).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
      expect(getKey).not.toHaveBeenCalled();
      // The durable marker gates access even if an OS credential store restores a key.
      await restarted.credentials.set(c.id, 'session', changedKey);
      expect(() => restarted.connection(c.id)).toThrow(/credentials need to be entered again/);
      expect(restarted.state().connections.find(item => item.id === c.id)).toMatchObject({ credentialPresent: false, credentialNeedsReentry: true });
      await expect(settings.saveConnection(changed)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
      expect(settings.get('credential-update', c.id)).toEqual({ storage: 'session' });
      settings.store.db.exec('DROP TRIGGER credential_binding_failure');
      await settings.saveConnection(changed, repairedKey);
      expect(settings.connection(c.id).baseUrl).toBe(changed.baseUrl);
      expect(await settings.credentials.get(c.id, 'session')).toBe(repairedKey);
      expect(settings.get('credential-update', c.id)).toBeUndefined();
      expect(settings.state().connections.find(item => item.id === c.id)).toMatchObject({ credentialPresent: true, credentialNeedsReentry: false });
      const stored = JSON.stringify(settings.store.db.prepare('SELECT payload FROM ai_settings').all());
      for (const secret of [originalKey, changedKey, repairedKey]) expect(stored).not.toContain(secret);
    } finally {
      settings.store.db.exec('DROP TRIGGER IF EXISTS credential_binding_failure');
      restarted.credentials.close();
    }
  });

  it('does not touch a credential if the durable quarantine marker cannot be written', async () => {
    const c = await settings.saveConnection({ name: 'Marker failure fixture', provider: 'custom', protocol: 'responses', baseUrl: 'https://original-marker.example/v1' }, 'synthetic-marker-original');
    const setKey = vi.spyOn(settings.credentials, 'set');
    settings.store.db.exec("CREATE TRIGGER credential_marker_failure BEFORE INSERT ON ai_settings WHEN NEW.kind='credential-update' BEGIN SELECT RAISE(ABORT,'synthetic quarantine marker failure'); END");
    try {
      await expect(settings.saveConnection({ ...c, baseUrl: 'https://replacement-marker.example/v1' }, 'synthetic-marker-changed')).rejects.toThrow(/synthetic quarantine marker failure/);
      expect(setKey).not.toHaveBeenCalled();
      expect(settings.connection(c.id).baseUrl).toBe(c.baseUrl);
      expect(await settings.credentials.get(c.id, 'session')).toBe('synthetic-marker-original');
      expect(settings.get('credential-update', c.id)).toBeUndefined();
      expect(settings.state().connections.find(item => item.id === c.id)).toMatchObject({ credentialPresent: true, credentialNeedsReentry: false });
    } finally { settings.store.db.exec('DROP TRIGGER credential_marker_failure'); }
  });

  it('preserves the old storage until replacement metadata commits and repairs a failed storage change', async () => {
    const newStore = new Map<string, string>();
    const actualSet = settings.credentials.set.bind(settings.credentials), actualGet = settings.credentials.get.bind(settings.credentials);
    vi.spyOn(settings.credentials, 'set').mockImplementation(async (id, storage, key) => { if (storage === 'keychain') newStore.set(id, key); else await actualSet(id, storage, key); });
    vi.spyOn(settings.credentials, 'get').mockImplementation(async (id, storage) => storage === 'keychain' ? newStore.get(id) ?? '' : actualGet(id, storage));
    const deleteKey = vi.spyOn(settings.credentials, 'delete');
    const c = await settings.saveConnection({ name: 'Storage binding fixture', provider: 'custom', protocol: 'responses', baseUrl: 'https://storage-original.example/v1', credentialStorage: 'session' }, 'synthetic-storage-original');
    const changed = { ...c, baseUrl: 'https://storage-replacement.example/v1', credentialStorage: 'keychain' as const };
    settings.store.db.exec("CREATE TRIGGER credential_storage_metadata_failure BEFORE UPDATE ON ai_settings WHEN NEW.kind='connection' BEGIN SELECT RAISE(ABORT,'synthetic storage metadata failure'); END");
    try {
      await expect(settings.saveConnection(changed, 'synthetic-storage-changed')).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
      expect(deleteKey).not.toHaveBeenCalled();
      expect(await settings.credentials.get(c.id, 'session')).toBe('synthetic-storage-original');
      expect(newStore.get(c.id)).toBe('synthetic-storage-changed');
      expect(settings.get<{ credentialStorage: string }>('connection', c.id)?.credentialStorage).toBe('session');
      expect(() => settings.connection(c.id)).toThrow(/credentials need to be entered again/);
      settings.store.db.exec('DROP TRIGGER credential_storage_metadata_failure');
      await settings.saveConnection(changed, 'synthetic-storage-repaired');
      expect(settings.connection(c.id)).toMatchObject({ baseUrl: changed.baseUrl, credentialStorage: 'keychain' });
      expect(await settings.credentials.get(c.id, 'keychain')).toBe('synthetic-storage-repaired');
      expect(await settings.credentials.get(c.id, 'session')).toBe('');
      expect(deleteKey).toHaveBeenCalledExactlyOnceWith(c.id, 'session');
      expect(settings.get('credential-update', c.id)).toBeUndefined();
      expect(settings.state().connections.find(item => item.id === c.id)).toMatchObject({ credentialPresent: true, credentialNeedsReentry: false });
    } finally { settings.store.db.exec('DROP TRIGGER IF EXISTS credential_storage_metadata_failure'); }
  });

  it('retains quarantine when credential removal fails and clears it only after successful removal', async () => {
    const c = await settings.saveConnection({ name: 'Removal fixture', provider: 'custom', protocol: 'responses', baseUrl: 'https://removal-fixture.example/v1' }, 'synthetic-removal-key');
    settings.put('credential-update', c.id, { storage: 'session' });
    vi.spyOn(settings.credentials, 'delete').mockRejectedValueOnce(new Error('synthetic credential deletion failure'));
    await expect(settings.remove('connection', c.id)).rejects.toThrow(/synthetic credential deletion failure/);
    expect(settings.get('connection', c.id)).toBeDefined(); expect(settings.get('credential-update', c.id)).toBeDefined();
    expect(() => settings.connection(c.id)).toThrow(/credentials need to be entered again/);
    await settings.remove('connection', c.id);
    expect(settings.get('connection', c.id)).toBeUndefined(); expect(settings.get('credential-update', c.id)).toBeUndefined();
  });
});
