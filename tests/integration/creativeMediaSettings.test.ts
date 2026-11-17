import { describe, expect, it } from 'vitest';
import { launch } from '../helpers/testServer.js';
import { CREATIVE_MEDIA_DEFAULTS } from '../../src/services/multimodal/creativeSettings.js';
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
});
