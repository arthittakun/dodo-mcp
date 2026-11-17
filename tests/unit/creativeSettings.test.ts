import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/store/db.js';
import { Store } from '../../src/store/store.js';
import { AISettings } from '../../src/services/ai/settings.js';
import { CREATIVE_MEDIA_DEFAULTS, CreativeSettingsInput, isOfficialOpenAIVideoConnection, supportsCreativeVideoConnection } from '../../src/services/multimodal/creativeSettings.js';

describe('creative media owner configuration', () => {
  let settings: AISettings;
  beforeEach(() => { settings = new AISettings(new Store(openDatabase(':memory:')), [21731, 21740]); });
  afterEach(() => { settings.credentials.close(); settings.store.db.close(); });

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
    expect(() => settings.saveMedia({ enabled: true })).toThrow(/enabled OpenAI-compatible/);
    for (const protocol of ['anthropic', 'gemini', 'ollama'] as const) {
      const c = await settings.saveConnection({ name: protocol, provider: 'custom', protocol, baseUrl: 'https://example.com/v1' });
      expect(() => settings.saveMedia({ enabled: true, connectionId: c.id })).toThrow(/enabled OpenAI-compatible/);
    }
    const c = await settings.saveConnection({ name: 'disabled', provider: 'openai', protocol: 'responses', baseUrl: CREATIVE_MEDIA_DEFAULTS.baseUrl, enabled: false });
    expect(() => settings.saveMedia({ enabled: true, connectionId: c.id })).toThrow(/enabled OpenAI-compatible/);
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
    expect(() => settings.saveMedia({ videoEnabled: true, videoModel: 'fixture-video' })).toThrow(/enabled OpenAI-compatible/);
    const c = await settings.saveConnection({ name: 'Compatibility fixture', provider: 'custom', protocol: 'chat-completions', baseUrl: 'https://media-fixture.example/v1' });
    expect(supportsCreativeVideoConnection(c)).toBe(true);
    expect(settings.saveMedia({ enabled: true, connectionId: c.id, videoEnabled: true, videoModel: 'fixture-video' })).toMatchObject({ enabled: true, videoEnabled: true, videoModel: 'fixture-video' });
  });
});
