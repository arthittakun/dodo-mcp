import { describe, expect, it } from 'vitest';
import { launch } from '../helpers/testServer.js';
import { CREATIVE_IMAGE_PRESETS, CREATIVE_MEDIA_DEFAULTS } from '../../src/services/multimodal/creativeSettings.js';
import { ProjectRegistry } from '../../src/projects/registry.js';

describe('owner-only creative media settings API', () => {
  it('requires owner authentication, reviewed context and available projects without any model call', async () => {
    const ctx = await launch({ trust: 'trusted', configPort: 0 });
    try {
      const url = new URL(ctx.configUrl!), token = url.hash.slice(1);
      const settings = ctx.server.services.installation!.ai.settings;
      const connection = await settings.saveConnection({ name: 'OpenAI Media', provider: 'openai', protocol: 'responses', baseUrl: CREATIVE_MEDIA_DEFAULTS.baseUrl });
      const project = new ProjectRegistry(settings.store).add(ctx.fixtureDir, 'Creative fixture').project;
      const value = { enabled: true, connectionId: connection.id, projectIds: [project.projectId] };
      const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-dodo-workspace': ctx.server.workspaceId, 'x-dodo-epoch': ctx.server.epoch };
      const post = (body: unknown, overrides: Record<string, string> = {}) => fetch(`${url.origin}/api/ai/media`, { method: 'POST', headers: { ...headers, ...overrides }, body: JSON.stringify(body) });
      expect((await post(value, { authorization: '' })).status).toBe(401);
      expect((await post(value, { 'x-dodo-epoch': 'old-epoch' })).status).toBe(409);
      expect((await post({ ...value, projectIds: ['prj_unavailable00'] })).status).toBe(400);
      expect((await post({ ...value, apiKey: 'synthetic-key' })).status).toBe(400);
      expect((await post(value)).status).toBe(200);
      expect(settings.media()).toMatchObject(value);
      expect(settings.media()).toMatchObject({ videoEnabled: false, videoModel: '' });
      expect((await post({ ...value, videoEnabled: true, videoModel: 'sora-2' })).status).toBe(400);
      expect(settings.media().videoEnabled).toBe(false);
      const compatible = await settings.saveConnection({ name: 'Compatible media fixture', provider: 'custom', protocol: 'responses', baseUrl: 'https://media-fixture.example/v1' });
      expect((await post({ ...value, connectionId: compatible.id, videoEnabled: true, videoModel: '' })).status).toBe(400);
      expect((await post({ ...value, connectionId: compatible.id, videoEnabled: true, videoModel: 'fixture-video' })).status).toBe(200);
      expect(settings.media()).toMatchObject({ videoEnabled: true, videoModel: 'fixture-video', connectionId: compatible.id });
      const state = await (await fetch(`${url.origin}/api/ai/state`, { headers: { authorization: `Bearer ${token}` } })).json() as { data: { media: unknown; mediaDefaults: typeof CREATIVE_MEDIA_DEFAULTS } };
      expect(state.data.media).toEqual(settings.media());
      expect(state.data.mediaDefaults.baseUrl).toBe('https://api.openai.com/v1');
    } finally { await ctx.cleanup(); }
  });

  it('saves and edits an owner-selected external URL/key and supports native Gemini without exposing credentials', async () => {
    const ctx = await launch({ trust: 'trusted', configPort: 0 });
    try {
      const url = new URL(ctx.configUrl!), token = url.hash.slice(1);
      const settings = ctx.server.services.installation!.ai.settings;
      const project = new ProjectRegistry(settings.store).add(ctx.fixtureDir, 'Configurable image fixture').project;
      const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-dodo-workspace': ctx.server.workspaceId, 'x-dodo-epoch': ctx.server.epoch };
      const post = (path: string, body: unknown, overrides: Record<string, string> = {}) => fetch(`${url.origin}/api/ai/${path}`, { method: 'POST', headers: { ...headers, ...overrides }, body: JSON.stringify(body) });
      const connection = { name: 'External image fixture', provider: 'custom', protocol: 'responses', baseUrl: 'https://image-fixture.example/proxy/v3', credentialStorage: 'session' };
      const key = 'synthetic-owner-image-key', replacement = 'synthetic-owner-image-replacement';
      expect((await post('connection', { connection, apiKey: key }, { authorization: '' })).status).toBe(401);
      expect((await post('connection', { connection, apiKey: key }, { 'x-dodo-epoch': 'old-epoch' })).status).toBe(409);
      const savedResponse = await post('connection', { connection, apiKey: key });
      expect(savedResponse.status).toBe(200);
      const savedText = await savedResponse.text(); expect(savedText).not.toContain(key);
      const saved = (JSON.parse(savedText) as { data: { id: string; baseUrl: string } }).data;
      expect(saved.baseUrl).toBe(connection.baseUrl);
      expect((await post('media', { enabled: true, connectionId: saved.id, imageModel: 'fixture-external-image', projectIds: [project.projectId] })).status).toBe(200);
      expect((await post('connection', { connection: { ...connection, id: saved.id, name: 'Edited display name' } })).status).toBe(200);
      expect(await settings.credentials.get(saved.id, 'session')).toBe(key);
      const changed = { ...connection, id: saved.id, baseUrl: 'https://second-image-fixture.example/api/v2', protocol: 'chat-completions' };
      expect((await post('connection', { connection: changed })).status).toBe(400);
      expect(settings.connection(saved.id).baseUrl).toBe(connection.baseUrl);
      expect((await post('connection', { connection: changed, apiKey: replacement })).status).toBe(200);
      expect(settings.connection(saved.id).baseUrl).toBe(changed.baseUrl);
      expect(await settings.credentials.get(saved.id, 'session')).toBe(replacement);

      const gemini = CREATIVE_IMAGE_PRESETS.find(p => p.id === 'gemini')!;
      const nativeResponse = await post('connection', { connection: { name: gemini.name, provider: gemini.provider, protocol: gemini.protocol, baseUrl: gemini.baseUrl }, apiKey: 'synthetic-owner-gemini-key' });
      expect(nativeResponse.status).toBe(200);
      const native = (await nativeResponse.json() as { data: { id: string } }).data;
      const nativeMedia = { enabled: true, connectionId: native.id, imageModel: gemini.imageModel, projectIds: [project.projectId] };
      expect((await post('media', nativeMedia)).status).toBe(200);
      expect((await post('media', { ...nativeMedia, videoEnabled: true, videoModel: 'fixture-video' })).status).toBe(400);
      const stateResponse = await fetch(`${url.origin}/api/ai/state`, { headers: { authorization: `Bearer ${token}` } });
      const stateText = await stateResponse.text();
      for (const secret of [key, replacement, 'synthetic-owner-gemini-key']) expect(stateText).not.toContain(secret);
      const state = JSON.parse(stateText) as { data: { mediaPresets: unknown; connections: Array<{ id: string; baseUrl: string; credentialPresent: boolean }> } };
      expect(state.data.mediaPresets).toEqual(CREATIVE_IMAGE_PRESETS);
      expect(state.data.connections.find(c => c.id === saved.id)).toMatchObject({ baseUrl: changed.baseUrl, credentialPresent: true });
      const privateState = JSON.stringify(settings.store.db.prepare('SELECT payload FROM ai_settings').all());
      for (const secret of [key, replacement, 'synthetic-owner-gemini-key']) expect(privateState).not.toContain(secret);
      expect((await post('connection', { connection: { ...changed, baseUrl: `${changed.baseUrl}/images/generations` }, apiKey: 'synthetic-invalid-url-key' })).status).toBe(400);
      expect(settings.connection(saved.id).baseUrl).toBe(changed.baseUrl);
    } finally { await ctx.cleanup(); }
  });
});
