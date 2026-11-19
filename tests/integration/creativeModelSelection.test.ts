import http from 'node:http';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CreativeJobData } from '../../src/services/multimodal/creativeService.js';
import { ResourceInfo } from '../../src/services/resources/contracts.js';
import { assertOk } from '../helpers/multimodal.js';
import { callToolLegacy, launch, mcpRaw, obtainToken, parseMcpResponse, rpc, type TestContext, type TokenSet } from '../helpers/testServer.js';

const KEY = 'synthetic-model-selection-credential';
const CUSTOM_IMAGE = 'studio-art-v9';
const OTHER_IMAGE = 'custom/image-fast-v2';
const EDIT_IMAGE = 'background-edit-v4';
const VIDEO = 'cinema-render-v8';
const URL_MODEL = 'https://models-fixture.example/private-model-id';
const MP4 = Buffer.from('000000186674797069736f6d0000020069736f6d6d703432', 'hex');
type Result = Awaited<ReturnType<typeof callToolLegacy>>;
type Call = (name: string, args: Record<string, unknown>) => Promise<Result>;
interface Listing {
  models: Array<{ id: string; mediaHint: 'image' | 'video' | 'unknown'; hintSource: 'name' }>;
  imageModel: string;
  videoModel: string;
  videoEnabled: boolean;
  protocol: string;
  nextCursor: number | null;
  note: string;
}

/** Actual provider requests expose the selected model; no inference mock bypasses serialization. */
async function providerFixture() {
  const png = await sharp({ create: { width: 12, height: 10, channels: 4, background: '#3377bb80' } }).png().toBuffer();
  const models = ['gpt-image-2.5-flare', CUSTOM_IMAGE, OTHER_IMAGE, EDIT_IMAGE, VIDEO, 'fixture-text-model', URL_MODEL];
  const calls: Array<{ path: string; authorized: boolean; body: string }> = [];
  const state = { modelsStatus: 200, video: 0 };
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += String(chunk);
    const authorized = req.headers.authorization === `Bearer ${KEY}`;
    const requestPath = req.url ?? '';
    calls.push({ path: requestPath, authorized, body });
    res.setHeader('content-type', 'application/json');
    if (!authorized) { res.statusCode = 401; res.end('{}'); return; }
    if (requestPath === '/v1/models') {
      res.statusCode = state.modelsStatus;
      res.end(state.modelsStatus === 200 ? JSON.stringify({ data: models.map(id => ({ id })) }) : '{}'); return;
    }
    if (requestPath === '/v1/images/generations' || requestPath === '/v1/images/edits') {
      res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] })); return;
    }
    if (['/v1/videos', '/v1/videos/edits', '/v1/videos/extensions'].includes(requestPath)) {
      res.end(JSON.stringify({ id: `video_selection_${++state.video}`, status: 'queued', progress: 0 })); return;
    }
    const video = /^\/v1\/videos\/(video_selection_\d+)(\/content)?$/.exec(requestPath);
    if (video) {
      if (video[2]) { res.setHeader('content-type', 'video/mp4'); res.end(MP4); return; }
      res.end(JSON.stringify({ id: video[1], status: 'completed', progress: 100 })); return;
    }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, png, models, calls, state,
    close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }),
  };
}

async function configure(ctx: TestContext, baseUrl: string) {
  const settings = ctx.server.services.installation!.ai.settings;
  const connection = await settings.saveConnection({ name: 'Model selection fixture', provider: 'custom', protocol: 'responses', baseUrl, allowPrivateNetwork: true }, KEY);
  return settings.saveMedia({ connectionId: connection.id, imageModel: 'auto', videoEnabled: true, videoModel: 'configured-video-default' });
}
function job(result: Result) { return assertOk(result) as CreativeJobData & { replayed?: boolean }; }
function error(result: Result, code: string) {
  expect(result.isError).toBe(true); expect(result.envelope.error).toMatchObject({ code });
}
async function finished(call: Call, id: string) {
  for (let index = 0; index < 100; index++) {
    const data = job(await call('creative_job', { jobId: id }));
    if (['completed', 'failed', 'uncertain', 'interrupted'].includes(data.status)) {
      expect(data.status, data.error ?? data.note).toBe('completed'); return data;
    }
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  throw new Error('Model selection fixture did not complete');
}

describe('AI selects a creative model per request without a project', () => {
  let ctx: TestContext, provider: Awaited<ReturnType<typeof providerFixture>>, token: TokenSet, reader: TokenSet;
  const call = (name: string, args: Record<string, unknown>, accessToken = token.accessToken) => callToolLegacy(ctx, accessToken, name, args);
  const imageCalls = () => provider.calls.filter(item => item.path === '/v1/images/generations');
  beforeAll(async () => {
    provider = await providerFixture();
    ctx = await launch({ deferWorkspace: true, toolSurface: 'full', trust: 'inspect' });
    await configure(ctx, provider.baseUrl);
    token = await obtainToken(ctx, { grantWorkspaceAccess: false });
    reader = await obtainToken(ctx, { scope: 'dodo:read', grantWorkspaceAccess: false });
  });
  beforeEach(() => { provider.state.modelsStatus = 200; });
  afterAll(async () => { await ctx?.cleanup(); await provider?.close(); });

  it('lists actual models with bounded pagination/query, name-only hints and no provider endpoint or credential', async () => {
    const paidBefore = imageCalls().length;
    const response = await call('creative_models', { limit: 2 }, reader.accessToken);
    const first = assertOk(response) as Listing;
    expect(first).toMatchObject({ imageModel: 'auto', videoModel: 'configured-video-default', videoEnabled: true, protocol: 'responses', nextCursor: 2 });
    expect(first.models).toHaveLength(2);
    const second = assertOk(await call('creative_models', { limit: 10, cursor: first.nextCursor }, reader.accessToken)) as Listing;
    expect(new Set([...first.models, ...second.models].map(item => item.id))).toEqual(new Set(provider.models.filter(id => id !== URL_MODEL)));
    expect(second.nextCursor).toBeNull();
    for (const model of [...first.models, ...second.models]) {
      expect(model.hintSource).toBe('name'); expect(['image', 'video', 'unknown']).toContain(model.mediaHint);
    }
    const query = assertOk(await call('creative_models', { query: CUSTOM_IMAGE }, reader.accessToken)) as Listing;
    expect(query.models.map(item => item.id)).toEqual([CUSTOM_IMAGE]);
    expect(JSON.stringify(response.raw)).not.toContain(KEY);
    expect(JSON.stringify(response.raw)).not.toContain(provider.baseUrl);
    expect(imageCalls()).toHaveLength(paidBefore);
    expect(ctx.server.workspaceSelected).toBe(false);
    expect(provider.calls.every(item => item.authorized)).toBe(true);
  });

  it('filters URL-shaped provider model IDs and rejects selecting one before a paid request', async () => {
    const response = await call('creative_models', {});
    const listing = assertOk(response) as Listing;
    expect(listing.models.some(model => model.id === URL_MODEL)).toBe(false);
    expect(JSON.stringify(response.raw)).not.toContain(URL_MODEL);
    const paidBefore = imageCalls().length;
    const raw = await mcpRaw(ctx, rpc('tools/call', { name: 'image_generate', arguments: { prompt: 'A URL is not a model ID', model: URL_MODEL, idempotencyKey: 'model-selection-url-denied' } }), token.accessToken);
    const body = await parseMcpResponse(raw), result = body.result as { isError?: boolean } | undefined;
    expect(body.error !== undefined || result?.isError === true, JSON.stringify(body)).toBe(true);
    expect(imageCalls()).toHaveLength(paidBefore);
  });

  it('lets the caller list and choose a nonpreferred model, records it and replays only that paid request', async () => {
    const settings = ctx.server.services.installation!.ai.settings, original = settings.media();
    const listing = assertOk(await call('creative_models', {})) as Listing;
    const selected = listing.models.find(item => item.id === CUSTOM_IMAGE)!.id;
    const before = imageCalls().length;
    const args = { prompt: 'Choose the studio model for this image', model: selected, idempotencyKey: 'model-selection-image-one' };
    const started = job(await call('image_generate', args));
    const output = await finished(call, started.jobId);
    expect(started.model).toBe(selected); expect(output.model).toBe(selected);
    expect(JSON.parse(imageCalls().at(-1)!.body)).toMatchObject({ model: selected });
    expect(job(await call('image_generate', args))).toMatchObject({ jobId: started.jobId, replayed: true });
    error(await call('image_generate', { ...args, model: OTHER_IMAGE }), 'IDEMPOTENCY_CONFLICT');
    expect(imageCalls()).toHaveLength(before + 1);
    const other = job(await call('image_generate', { ...args, model: OTHER_IMAGE, idempotencyKey: 'model-selection-image-two' }));
    expect((await finished(call, other.jobId)).model).toBe(OTHER_IMAGE);
    expect(JSON.parse(imageCalls().at(-1)!.body).model).toBe(OTHER_IMAGE);
    expect(settings.media()).toEqual(original);
  });

  it('selects an independent edit model for background removal without changing defaults', async () => {
    const started = job(await call('image_generate', { prompt: 'Source for an edit', model: CUSTOM_IMAGE, idempotencyKey: 'model-selection-edit-source' }));
    const resource = ResourceInfo.parse((await finished(call, started.jobId)).resource);
    const editsBefore = provider.calls.filter(item => item.path === '/v1/images/edits').length;
    const args = { resourceId: resource.resourceId, model: EDIT_IMAGE, idempotencyKey: 'model-selection-edit' };
    const edited = job(await call('image_remove_background', args));
    expect((await finished(call, edited.jobId)).model).toBe(EDIT_IMAGE);
    expect(provider.calls.filter(item => item.path === '/v1/images/edits')).toHaveLength(editsBefore + 1);
    expect(provider.calls.findLast(item => item.path === '/v1/images/edits')!.body).toContain(`name="model"\r\n\r\n${EDIT_IMAGE}\r\n`);
    expect(job(await call('image_remove_background', args)).jobId).toBe(edited.jobId);
    expect(ctx.server.services.installation!.ai.settings.media().imageModel).toBe('auto');
  });

  it('uses an explicit custom model even when the provider does not support model listing', async () => {
    provider.state.modelsStatus = 404;
    error(await call('creative_models', {}), 'NOT_SUPPORTED');
    const listsBefore = provider.calls.filter(item => item.path === '/v1/models').length;
    const started = job(await call('image_generate', { prompt: 'Use a supplied custom model ID', model: 'unlisted-image-v9', idempotencyKey: 'model-selection-without-listing' }));
    expect((await finished(call, started.jobId)).model).toBe('unlisted-image-v9');
    expect(JSON.parse(imageCalls().at(-1)!.body).model).toBe('unlisted-image-v9');
    expect(provider.calls.filter(item => item.path === '/v1/models')).toHaveLength(listsBefore);
  });

  it('retains configured Auto fallback when the caller omits a model or explicitly requests auto', async () => {
    for (const [suffix, selection] of [['omitted', {}], ['auto', { model: 'auto' }]] as const) {
      const started = job(await call('image_generate', { prompt: 'Compatible Auto fallback', ...selection, idempotencyKey: `model-selection-fallback-${suffix}` }));
      expect((await finished(call, started.jobId)).model).toBe('gpt-image-2.5-flare');
      expect(JSON.parse(imageCalls().at(-1)!.body).model).toBe('gpt-image-2.5-flare');
    }
  });

  it('uses the selected video model and preserves its actual identity on video edits and extensions', async () => {
    const started = job(await call('video_generate', { prompt: 'Selected video model', model: VIDEO, idempotencyKey: 'model-selection-video' }));
    const parent = await finished(call, started.jobId);
    expect(started.model).toBe(VIDEO); expect(parent.model).toBe(VIDEO);
    expect(provider.calls.findLast(item => item.path === '/v1/videos')!.body).toContain(`name="model"\r\n\r\n${VIDEO}\r\n`);
    const edited = job(await call('video_edit', { jobId: parent.jobId, prompt: 'Keep the source render model', idempotencyKey: 'model-selection-video-edit' }));
    expect((await finished(call, edited.jobId)).model).toBe(VIDEO);
    const extended = job(await call('video_extend', { jobId: parent.jobId, prompt: 'Extend under the source model', seconds: 8, idempotencyKey: 'model-selection-video-extend' }));
    expect((await finished(call, extended.jobId)).model).toBe(VIDEO);
    expect(ctx.server.services.installation!.ai.settings.media().videoModel).toBe('configured-video-default');
  });

  it('keeps generation scope checks and rejects model injection or endpoint/key overrides before provider requests', async () => {
    const before = provider.calls.length;
    error(await call('image_generate', { prompt: 'Read-only listing does not grant generation', model: CUSTOM_IMAGE, idempotencyKey: 'model-selection-reader-denied' }, reader.accessToken), 'FORBIDDEN');
    for (const extra of [{ model: 'model\nInjected' }, { model: CUSTOM_IMAGE, baseUrl: 'https://other.example/v1' }, { model: CUSTOM_IMAGE, apiKey: 'must-not-be-forwarded' }]) {
      const raw = await mcpRaw(ctx, rpc('tools/call', { name: 'image_generate', arguments: { prompt: 'Invalid input', idempotencyKey: 'model-selection-invalid', ...extra } }), token.accessToken);
      const body = await parseMcpResponse(raw);
      const result = body.result as { isError?: boolean } | undefined;
      expect(body.error !== undefined || result?.isError === true, JSON.stringify(body)).toBe(true);
    }
    expect(provider.calls).toHaveLength(before);
  });
});

describe.each(['compact', 'hybrid'] as const)('%s exposes AI model selection without a project', surface => {
  it('discovers models and passes a selected model through the existing global media gateway', async () => {
    const provider = await providerFixture(), ctx = await launch({ deferWorkspace: true, toolSurface: surface, trust: 'inspect' });
    try {
      await configure(ctx, provider.baseUrl);
      const token = await obtainToken(ctx, { grantWorkspaceAccess: false });
      const call = (name: string, args: Record<string, unknown>) => callToolLegacy(ctx, token.accessToken, name, args);
      const models = assertOk(await call('dodo_discover', { operation: 'creative_models' })) as { gateway: string; callShape: { example: Record<string, unknown> } };
      expect(models.gateway).toBe('dodo_media'); expect(models.callShape.example.workspaceId).toBeUndefined();
      const generate = assertOk(await call('dodo_discover', { operation: 'image_generate' })) as { inputSchema: { properties: Record<string, unknown>; required: string[] } };
      expect(generate.inputSchema.properties.model).toBeDefined();
      expect(generate.inputSchema.required).not.toContain('model');
      const media: Call = (operation, args) => call('dodo_media', { operation, args });
      const listing = assertOk(await media('creative_models', { query: CUSTOM_IMAGE })) as Listing;
      expect(listing.models.map(model => model.id)).toEqual([CUSTOM_IMAGE]);
      const started = job(await media('image_generate', { prompt: 'The chat AI selected this model', model: listing.models[0]!.id, idempotencyKey: `model-selection-${surface}` }));
      expect((await finished(media, started.jobId)).model).toBe(CUSTOM_IMAGE);
      expect(JSON.parse(provider.calls.findLast(item => item.path === '/v1/images/generations')!.body).model).toBe(CUSTOM_IMAGE);
      const before = provider.calls.length;
      error(await media('image_generate', { prompt: 'No caller endpoint override', model: CUSTOM_IMAGE, baseUrl: 'https://other.example/v1', idempotencyKey: `model-selection-${surface}-endpoint` }), 'INVALID_INPUT');
      expect(provider.calls).toHaveLength(before);
      expect(ctx.server.workspaceSelected).toBe(false);
    } finally { await ctx.cleanup(); await provider.close(); }
  });
});
