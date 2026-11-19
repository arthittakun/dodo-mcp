import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DodoError } from '../../src/errors.js';
import { ProjectRegistry } from '../../src/projects/registry.js';
import { CreativeProvider } from '../../src/services/multimodal/creativeProvider.js';
import type { CreativeJobData } from '../../src/services/multimodal/creativeService.js';
import { ResourceChunk, ResourceInfo } from '../../src/services/resources/contracts.js';
import { newId, sha256Bytes } from '../../src/util/hash.js';
import { assertOk, blocks, tool } from '../helpers/multimodal.js';
import { launch, mkTmpDir, obtainToken, type TestContext, type TokenSet } from '../helpers/testServer.js';

const MP4 = Buffer.from('000000186674797069736f6d0000020069736f6d6d703432', 'hex');
const PIXELS = Buffer.from([
  255, 0, 0, 255, 0, 255, 0, 0, 0, 0, 255, 128,
  255, 255, 0, 255, 0, 255, 255, 64, 255, 0, 255, 255,
]);

describe('creative media real MCP jobs, immutable outputs and journaled export', () => {
  let ctx: TestContext, token: TokenSet, other: TokenSet, reader: TokenSet;
  let connectionId: string, projectId: string, png: Buffer, opaque: Buffer;
  const call = (name: string, args: Record<string, unknown>, accessToken = token.accessToken) => tool(ctx, accessToken, name, args);
  const settings = () => ctx.server.services.installation!.ai.settings;
  const media = (patch: Record<string, unknown> = {}) => settings().saveMedia({
    enabled: true, connectionId, projectIds: [projectId], imageModel: 'fixture-image', videoEnabled: true, videoModel: 'fixture-video', allowImageUpload: false, ...patch,
  });
  const job = (result: Awaited<ReturnType<typeof call>>) => assertOk(result) as CreativeJobData & { replayed?: boolean };
  async function finished(id: string) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const response = await call('creative_job', { jobId: id }), data = job(response);
      if (['completed', 'failed', 'uncertain', 'interrupted'].includes(data.status)) return { response, data };
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('creative test job did not reach a terminal state');
  }
  function error(result: Awaited<ReturnType<typeof call>>, code: string) {
    expect(result.isError).toBe(true); expect(result.envelope.error).toMatchObject({ code });
  }

  beforeAll(async () => {
    ctx = await launch({ toolSurface: 'full', trust: 'trusted', fixtureFiles: { '.env': 'DO_NOT_UPLOAD=private' } });
    png = await sharp(PIXELS, { raw: { width: 3, height: 2, channels: 4 } }).png().toBuffer();
    opaque = await sharp({ create: { width: 3, height: 2, channels: 4, background: '#ff0000' } }).png().toBuffer();
    fs.writeFileSync(path.join(ctx.fixtureDir, 'source.png'), png);
    new ProjectRegistry(ctx.server.services.store).add(ctx.fixtureDir, 'Creative fixture');
    token = await obtainToken(ctx); other = await obtainToken(ctx); reader = await obtainToken(ctx, { scope: 'dodo:read' });
    const installation = ctx.server.services.installation!;
    projectId = installation.list(installation.owner()).find(p => p.workspaceId === ctx.server.workspaceId)!.projectId;
    connectionId = (await settings().saveConnection({ name: 'Creative fixture', provider: 'custom', protocol: 'responses', baseUrl: 'https://media-fixture.example/v1' }, 'fixture-media-credential')).id;
    settings().savePermission({ projectId, profileIds: [], allowedClientIds: [token.clientId, other.clientId] });
  });
  afterAll(async () => ctx?.cleanup());
  beforeEach(() => {
    media();
    vi.spyOn(CreativeProvider.prototype, 'generateImage').mockImplementation(async (_input, _signal, beforeSend) => { beforeSend?.(); return { bytes: png, mimeType: 'image/png' }; });
    vi.spyOn(CreativeProvider.prototype, 'removeBackground').mockImplementation(async (_input, _signal, beforeSend) => { beforeSend?.(); return { bytes: png, mimeType: 'image/png' }; });
    vi.spyOn(CreativeProvider.prototype, 'createVideo').mockImplementation(async (_input, _signal, beforeSend) => { beforeSend?.(); return { id: 'video_fixture', status: 'queued', progress: 0 }; });
    vi.spyOn(CreativeProvider.prototype, 'editVideo').mockImplementation(async (_input, _signal, beforeSend) => { beforeSend?.(); return { id: 'video_edit_fixture', status: 'queued', progress: 0 }; });
    vi.spyOn(CreativeProvider.prototype, 'extendVideo').mockImplementation(async (_input, _signal, beforeSend) => { beforeSend?.(); return { id: 'video_extend_fixture', status: 'queued', progress: 0 }; });
    vi.spyOn(CreativeProvider.prototype, 'videoStatus').mockImplementation(async (id, _signal, beforeSend) => { beforeSend?.(); return { id, status: 'completed', progress: 100 }; });
    vi.spyOn(CreativeProvider.prototype, 'videoContent').mockImplementation(async (_id, _signal, beforeSend) => { beforeSend?.(); return MP4; });
  });
  afterEach(() => vi.restoreAllMocks());

  it('generates one image, exposes actual resource/preview bytes and replays the paid receipt', async () => {
    const args = { prompt: 'A synthetic transparent square', background: 'transparent', idempotencyKey: 'creative-image-one' };
    const started = job(await call('image_generate', args));
    const output = await finished(started.jobId);
    expect(output.data.status).toBe('completed'); expect(output.data.progress).toBe(100);
    const resource = ResourceInfo.parse(output.data.resource);
    expect(resource).toMatchObject({ mimeType: 'image/png', source: { kind: 'generated' }, metadata: { width: 3, height: 2 } });
    expect(blocks(output.response).some(block => block.type === 'image' && Boolean(block.data))).toBe(true);
    const read = ResourceChunk.parse(assertOk(await call('resource_read', { resourceId: resource.resourceId, expectedSha256: resource.sha256 })));
    expect(await sharp(Buffer.from(read.data, 'base64')).raw().toBuffer()).toEqual(PIXELS);
    const duplicate = job(await call('image_generate', args));
    expect(duplicate.jobId).toBe(started.jobId); expect(duplicate.replayed).toBe(true);
    expect(CreativeProvider.prototype.generateImage).toHaveBeenCalledTimes(1);
    expect(vi.mocked(CreativeProvider.prototype.generateImage).mock.calls[0]?.[0]).toMatchObject({ model: 'fixture-image', size: '1024x1024', quality: 'auto', background: 'transparent' });
    error(await call('image_generate', { ...args, prompt: 'different prompt' }), 'IDEMPOTENCY_CONFLICT');
  });

  it('resolves Auto from advertised image models once and records the actual model without a second paid call', async () => {
    media({ imageModel: 'auto' });
    const listing = vi.spyOn(settings(), 'models').mockResolvedValue([{ id: 'gpt-4o' }, { id: 'sora-2' }, { id: 'gpt-image-2.5-flare' }]);
    const args = { prompt: 'Auto image fixture', idempotencyKey: 'creative-auto-image' };
    const started = job(await call('image_generate', args)), output = await finished(started.jobId);
    expect(output.data.status).toBe('completed'); expect(output.data.model).toBe('gpt-image-2.5-flare');
    expect(vi.mocked(CreativeProvider.prototype.generateImage).mock.calls[0]?.[0].model).toBe('gpt-image-2.5-flare');
    expect(job(await call('image_generate', args)).jobId).toBe(started.jobId);
    expect(listing).toHaveBeenCalledTimes(1); expect(CreativeProvider.prototype.generateImage).toHaveBeenCalledTimes(1);
  });

  it('refuses Auto before paid creation when discovery finds only text/video models and permits a manual repair', async () => {
    media({ imageModel: 'auto' });
    vi.spyOn(settings(), 'models').mockResolvedValue([{ id: 'gpt-4o' }, { id: 'sora-2' }]);
    const args = { prompt: 'Auto cannot guess a model', idempotencyKey: 'creative-auto-no-model' };
    error(await call('image_generate', args), 'NOT_SUPPORTED');
    expect(CreativeProvider.prototype.generateImage).not.toHaveBeenCalled();
    media({ imageModel: 'fixture-image' });
    const started = job(await call('image_generate', args)); expect((await finished(started.jobId)).data.status).toBe('completed');
    expect(CreativeProvider.prototype.generateImage).toHaveBeenCalledTimes(1);
  });

  it('retries a failed Auto discovery with the same key without modifying configuration or repeating paid creation', async () => {
    media({ imageModel: 'auto' });
    const original = settings().media();
    const listing = vi.spyOn(settings(), 'models').mockRejectedValueOnce(new DodoError('CONFLICT', 'synthetic metadata connection interruption')).mockResolvedValueOnce([{ id: 'gpt-image-2.5-flare' }]);
    const args = { prompt: 'Retry only metadata discovery', idempotencyKey: 'creative-auto-discovery-retry' };
    error(await call('image_generate', args), 'NOT_SUPPORTED');
    expect(listing).toHaveBeenCalledTimes(1); expect(CreativeProvider.prototype.generateImage).not.toHaveBeenCalled();
    expect(settings().media()).toEqual(original);
    const started = job(await call('image_generate', args)), output = await finished(started.jobId);
    expect(output.data.status).toBe('completed'); expect(output.data.model).toBe('gpt-image-2.5-flare');
    expect(listing).toHaveBeenCalledTimes(2); expect(CreativeProvider.prototype.generateImage).toHaveBeenCalledTimes(1);
    expect(settings().media()).toEqual(original);
    expect(job(await call('image_generate', args)).jobId).toBe(started.jobId);
    expect(listing).toHaveBeenCalledTimes(2); expect(CreativeProvider.prototype.generateImage).toHaveBeenCalledTimes(1);
  });

  it('crops exact alpha pixels locally, saves through the journal and rolls back without changing source', async () => {
    const output = assertOk(await call('image_crop', { path: 'source.png', regions: [{ left: 1, top: 0, width: 2, height: 2 }], idempotencyKey: 'creative-crop-save' })) as { resources: unknown[] };
    const resource = ResourceInfo.parse(output.resources[0]);
    const read = ResourceChunk.parse(assertOk(await call('resource_read_range', { resourceId: resource.resourceId, length: resource.bytes })));
    const cropped = Buffer.from(read.data, 'base64');
    expect(await sharp(cropped).raw().toBuffer()).toEqual(Buffer.concat([PIXELS.subarray(4, 12), PIXELS.subarray(16, 24)]));
    expect(CreativeProvider.prototype.generateImage).not.toHaveBeenCalled(); expect(CreativeProvider.prototype.removeBackground).not.toHaveBeenCalled();
    const args = { resourceId: resource.resourceId, expectedSha256: resource.sha256, path: 'assets/cropped.png', idempotencyKey: 'creative-save-new' };
    const saved = assertOk(await call('media_save', args)) as { changesetId: string; bytes: number; hash: string };
    expect(fs.readFileSync(path.join(ctx.fixtureDir, 'assets/cropped.png'))).toEqual(cropped);
    expect(saved.bytes).toBe(cropped.length); expect(saved.hash).toBe(resource.sha256);
    expect((assertOk(await call('media_save', args)) as { replayed: boolean }).replayed).toBe(true);
    assertOk(await call('rollback_changes', { changesetId: saved.changesetId, idempotencyKey: 'creative-rollback-new' }));
    expect(fs.existsSync(path.join(ctx.fixtureDir, 'assets/cropped.png'))).toBe(false);
    expect(fs.readFileSync(path.join(ctx.fixtureDir, 'source.png'))).toEqual(png);
    expect((await call('resource_read', { resourceId: resource.resourceId })).isError).toBe(false);
  });

  it('exports with expected hashes and refuses unsafe destinations or other callers', async () => {
    const output = assertOk(await call('image_crop', { path: 'source.png', regions: [{ left: 0, top: 0, width: 1, height: 1 }], idempotencyKey: 'creative-crop-overwrite' })) as { resources: unknown[] };
    const resource = ResourceInfo.parse(output.resources[0]);
    const args = { resourceId: resource.resourceId, expectedSha256: resource.sha256, path: 'existing.png', idempotencyKey: 'creative-save-overwrite' };
    fs.writeFileSync(path.join(ctx.fixtureDir, 'existing.png'), opaque);
    error(await call('media_save', args), 'INVALID_INPUT');
    error(await call('media_save', { ...args, expectedHash: `sha256:${'0'.repeat(64)}` }), 'FILE_CHANGED');
    expect(fs.readFileSync(path.join(ctx.fixtureDir, 'existing.png'))).toEqual(opaque);
    const saved = assertOk(await call('media_save', { ...args, expectedHash: sha256Bytes(opaque) })) as { changesetId: string };
    assertOk(await call('rollback_changes', { changesetId: saved.changesetId, idempotencyKey: 'creative-rollback-overwrite' }));
    expect(fs.readFileSync(path.join(ctx.fixtureDir, 'existing.png'))).toEqual(opaque);
    error(await call('media_save', { ...args, idempotencyKey: 'creative-export-wrong-sha', expectedSha256: `sha256:${'f'.repeat(64)}` }), 'FILE_CHANGED');
    error(await call('media_save', { ...args, idempotencyKey: 'creative-export-wrong-ext', path: 'wrong.js' }), 'INVALID_INPUT');
    error(await call('media_save', { ...args, idempotencyKey: 'creative-export-traversal', path: '../outside.png' }), 'PATH_DENIED');
    error(await call('media_save', { ...args, idempotencyKey: 'creative-export-other' }, other.accessToken), 'NOT_FOUND');
    error(await call('image_crop', { resourceId: resource.resourceId, regions: [{ left: 0, top: 0, width: 1, height: 1 }], idempotencyKey: 'creative-crop-other' }, other.accessToken), 'NOT_FOUND');
  });

  it('splits a grid into exact ordered alpha cells and rejects ambiguous or missing crop selection', async () => {
    const grid = { rows: 2, columns: 3 };
    const output = assertOk(await call('image_crop', { path: 'source.png', grid, idempotencyKey: 'creative-grid-cells' })) as { resources: unknown[] };
    expect(output.resources).toHaveLength(6);
    for (let index = 0; index < output.resources.length; index++) {
      const resource = ResourceInfo.parse(output.resources[index]);
      expect(resource.metadata).toMatchObject({ width: 1, height: 1, format: 'png' });
      const read = ResourceChunk.parse(assertOk(await call('resource_read_range', { resourceId: resource.resourceId, length: resource.bytes })));
      const bytes = Buffer.from(read.data, 'base64');
      expect((await sharp(bytes).metadata()).hasAlpha).toBe(true);
      expect(await sharp(bytes).raw().toBuffer()).toEqual(PIXELS.subarray(index * 4, index * 4 + 4));
    }
    error(await call('image_crop', { path: 'source.png', grid, regions: [{ left: 0, top: 0, width: 1, height: 1 }], idempotencyKey: 'creative-grid-ambiguous' }), 'INVALID_INPUT');
    error(await call('image_crop', { path: 'source.png', idempotencyKey: 'creative-grid-missing' }), 'INVALID_INPUT');
    expect(CreativeProvider.prototype.generateImage).not.toHaveBeenCalled(); expect(CreativeProvider.prototype.createVideo).not.toHaveBeenCalled();
  });

  it('requires explicit upload permission and returns real transparency from background removal', async () => {
    const args = { path: 'source.png', idempotencyKey: 'creative-background-one' };
    error(await call('image_remove_background', args), 'FORBIDDEN');
    expect(CreativeProvider.prototype.removeBackground).not.toHaveBeenCalled();
    media({ allowImageUpload: true });
    const started = job(await call('image_remove_background', args)), output = await finished(started.jobId);
    expect(output.data.status).toBe('completed'); expect(output.data.kind).toBe('background_removal');
    const resource = ResourceInfo.parse(output.data.resource);
    const read = ResourceChunk.parse(assertOk(await call('resource_read', { resourceId: resource.resourceId })));
    expect((await sharp(Buffer.from(read.data, 'base64')).stats()).isOpaque).toBe(false);
    expect(CreativeProvider.prototype.removeBackground).toHaveBeenCalledTimes(1);
    expect(vi.mocked(CreativeProvider.prototype.removeBackground).mock.calls[0]?.[0].image.subarray(0, 8)).toEqual(png.subarray(0, 8));
    error(await call('image_remove_background', { path: '.env', idempotencyKey: 'creative-background-secret' }), 'SECRET_PATH_DENIED');
    expect(CreativeProvider.prototype.removeBackground).toHaveBeenCalledTimes(1);
  });

  it('never reports opaque background-removal output as success or retries the edit', async () => {
    media({ allowImageUpload: true });
    vi.mocked(CreativeProvider.prototype.removeBackground).mockImplementation(async (_input, _signal, beforeSend) => { beforeSend?.(); return { bytes: opaque, mimeType: 'image/png' }; });
    const args = { path: 'source.png', idempotencyKey: 'creative-background-opaque' };
    const started = job(await call('image_remove_background', args)), output = await finished(started.jobId);
    expect(output.data.status).toBe('uncertain'); expect(output.data.error).toBe('UNSUPPORTED_ENCODING'); expect(output.data.resource).toBeNull();
    expect(job(await call('image_remove_background', args)).jobId).toBe(started.jobId);
    await call('creative_job', { jobId: started.jobId });
    expect(CreativeProvider.prototype.removeBackground).toHaveBeenCalledTimes(1);
  });

  it('does not report transparent generation as success when a provider returns opaque pixels', async () => {
    vi.mocked(CreativeProvider.prototype.generateImage).mockImplementation(async (_input, _signal, beforeSend) => { beforeSend?.(); return { bytes: opaque, mimeType: 'image/png' }; });
    const args = { prompt: 'Transparent output fixture', background: 'transparent', idempotencyKey: 'creative-generate-opaque' };
    const started = job(await call('image_generate', args)), output = await finished(started.jobId);
    expect(output.data.status).toBe('uncertain'); expect(output.data.error).toBe('UNSUPPORTED_ENCODING'); expect(output.data.resource).toBeNull();
    expect(job(await call('image_generate', args)).jobId).toBe(started.jobId);
    expect(CreativeProvider.prototype.generateImage).toHaveBeenCalledTimes(1);
  });

  it('submits one video and only polls/downloads that render into an owned MP4 resource', async () => {
    let polls = 0;
    vi.mocked(CreativeProvider.prototype.videoStatus).mockImplementation(async (id, _signal, beforeSend) => { beforeSend?.(); polls++; return { id, status: polls === 1 ? 'in_progress' : 'completed', progress: polls === 1 ? 50 : 100 }; });
    const args = { prompt: 'Synthetic render protocol fixture', seconds: 4, idempotencyKey: 'creative-video-one' };
    const started = job(await call('video_generate', args)), output = await finished(started.jobId);
    expect(output.data.status).toBe('completed'); expect(output.data.kind).toBe('video');
    const resource = ResourceInfo.parse(output.data.resource);
    expect(resource.mimeType).toBe('video/mp4');
    const read = ResourceChunk.parse(assertOk(await call('resource_read_range', { resourceId: resource.resourceId, length: MP4.length })));
    expect(Buffer.from(read.data, 'base64')).toEqual(MP4);
    expect(job(await call('video_generate', args)).jobId).toBe(started.jobId);
    expect(job(await call('creative_job', { jobId: started.jobId })).status).toBe('completed');
    expect(CreativeProvider.prototype.createVideo).toHaveBeenCalledTimes(1); expect(CreativeProvider.prototype.videoStatus).toHaveBeenCalledTimes(2); expect(CreativeProvider.prototype.videoContent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(CreativeProvider.prototype.videoStatus).mock.calls.every(([id]) => id === 'video_fixture')).toBe(true);
    error(await call('creative_job', { jobId: started.jobId }, other.accessToken), 'NOT_FOUND');
    error(await call('resource_read', { resourceId: resource.resourceId }, other.accessToken), 'NOT_FOUND');
  });

  it('uploads only an explicitly allowed owned reference with dimensions matching the generated video', async () => {
    const reference = await sharp({ create: { width: 1280, height: 720, channels: 4, background: '#11447780' } }).png().toBuffer();
    fs.writeFileSync(path.join(ctx.fixtureDir, 'video-reference.png'), reference);
    const args = { prompt: 'Image-guided protocol fixture', reference: { path: 'video-reference.png' }, size: '1280x720', idempotencyKey: 'creative-video-reference' };
    error(await call('video_generate', args), 'FORBIDDEN');
    expect(CreativeProvider.prototype.createVideo).not.toHaveBeenCalled();
    media({ allowImageUpload: true });
    error(await call('video_generate', { ...args, reference: { path: 'source.png' }, idempotencyKey: 'creative-video-reference-size' }), 'INVALID_INPUT');
    error(await call('video_generate', { ...args, reference: { path: '.env' }, idempotencyKey: 'creative-video-reference-secret' }), 'SECRET_PATH_DENIED');
    error(await call('video_generate', { ...args, reference: { path: '../outside.png' }, idempotencyKey: 'creative-video-reference-path' }), 'PATH_DENIED');
    const asset = ctx.server.services.multimodal!.storage.put(token, 'image', 'image/png', reference);
    error(await call('video_generate', { ...args, reference: { assetId: asset.assetId }, idempotencyKey: 'creative-video-reference-actor' }, other.accessToken), 'NOT_FOUND');
    expect(CreativeProvider.prototype.createVideo).not.toHaveBeenCalled();
    const started = job(await call('video_generate', args));
    expect((await finished(started.jobId)).data.status).toBe('completed');
    expect(CreativeProvider.prototype.createVideo).toHaveBeenCalledTimes(1);
    const sent = vi.mocked(CreativeProvider.prototype.createVideo).mock.calls[0]![0];
    expect(sent).toMatchObject({ model: 'fixture-video', size: '1280x720', seconds: 4 });
    expect(await sharp(sent.reference!).metadata()).toMatchObject({ format: 'png', width: 1280, height: 720 });
    expect(fs.readFileSync(path.join(ctx.fixtureDir, 'video-reference.png'))).toEqual(reference);
  });

  it('edits and extends only a completed owned source under its original connection without changing it', async () => {
    const parent = job(await call('video_generate', { prompt: 'Transform parent fixture', idempotencyKey: 'creative-transform-parent' }));
    error(await call('video_edit', { jobId: parent.jobId, prompt: 'Premature edit', idempotencyKey: 'creative-transform-pending' }), 'INVALID_INPUT');
    expect(CreativeProvider.prototype.editVideo).not.toHaveBeenCalled();
    const completed = (await finished(parent.jobId)).data;
    const db = ctx.server.services.store.db;
    const originalPayload = (db.prepare('SELECT payload FROM creative_jobs WHERE id=?').get(parent.jobId) as { payload: string }).payload;
    error(await call('video_edit', { jobId: parent.jobId, prompt: 'Wrong owner', idempotencyKey: 'creative-transform-other' }, other.accessToken), 'NOT_FOUND');
    media({ videoModel: 'different-video-model' });
    error(await call('video_edit', { jobId: parent.jobId, prompt: 'Wrong model', idempotencyKey: 'creative-transform-model' }), 'FORBIDDEN');
    const alternative = await settings().saveConnection({ name: 'Other compatibility fixture', provider: 'custom', protocol: 'responses', baseUrl: 'https://other-media-fixture.example/v1' }, 'other-fixture-media-credential');
    media({ connectionId: alternative.id });
    error(await call('video_extend', { jobId: parent.jobId, prompt: 'Wrong connection', idempotencyKey: 'creative-transform-connection' }), 'FORBIDDEN');
    media(); await settings().remove('connection', alternative.id);
    const editArgs = { jobId: parent.jobId, prompt: 'Change the color', idempotencyKey: 'creative-transform-edit' };
    const extendArgs = { jobId: parent.jobId, prompt: 'Continue the movement', seconds: 8, idempotencyKey: 'creative-transform-extend' };
    const edited = job(await call('video_edit', editArgs)), extended = job(await call('video_extend', extendArgs));
    expect(edited.jobId).not.toBe(parent.jobId); expect(extended.jobId).not.toBe(parent.jobId); expect(extended.jobId).not.toBe(edited.jobId);
    expect((await finished(edited.jobId)).data.status).toBe('completed'); expect((await finished(extended.jobId)).data.status).toBe('completed');
    expect(job(await call('video_edit', editArgs)).jobId).toBe(edited.jobId);
    expect(job(await call('video_extend', extendArgs)).jobId).toBe(extended.jobId);
    expect(CreativeProvider.prototype.createVideo).toHaveBeenCalledTimes(1); expect(CreativeProvider.prototype.editVideo).toHaveBeenCalledTimes(1); expect(CreativeProvider.prototype.extendVideo).toHaveBeenCalledTimes(1);
    expect(vi.mocked(CreativeProvider.prototype.editVideo).mock.calls[0]![0]).toEqual({ id: 'video_fixture', prompt: editArgs.prompt });
    expect(vi.mocked(CreativeProvider.prototype.extendVideo).mock.calls[0]![0]).toEqual({ id: 'video_fixture', prompt: extendArgs.prompt, seconds: 8 });
    const unchanged = job(await call('creative_job', { jobId: parent.jobId }));
    expect(unchanged.resource?.resourceId).toBe(completed.resource?.resourceId);
    expect((db.prepare('SELECT payload FROM creative_jobs WHERE id=?').get(parent.jobId) as { payload: string }).payload).toBe(originalPayload);
  });

  it('rejects retired official video before any request while preserving independent OpenAI image access', async () => {
    const official = await settings().saveConnection({ name: 'Official image fixture', provider: 'openai', protocol: 'responses', baseUrl: 'https://api.openai.com/v1' }, 'official-image-fixture-credential');
    media({ connectionId: official.id, videoEnabled: false, videoModel: '' });
    error(await call('video_generate', { prompt: 'Unavailable official video', idempotencyKey: 'creative-official-video' }), 'NOT_SUPPORTED');
    expect(CreativeProvider.prototype.createVideo).not.toHaveBeenCalled();
    const status = assertOk(await call('multimodal_status', {})) as { creative: { available: boolean; videoAvailable: boolean; videoModel: string } };
    expect(status.creative).toMatchObject({ available: true, videoAvailable: false, videoModel: '' });
    const image = job(await call('image_generate', { prompt: 'Independent OpenAI image fixture', idempotencyKey: 'creative-official-image' }));
    expect((await finished(image.jobId)).data.status).toBe('completed');
    expect(CreativeProvider.prototype.generateImage).toHaveBeenCalledTimes(1);
    media(); await settings().remove('connection', official.id);
  });

  it('stops video submission when the owner turns compatibility video off', async () => {
    media({ videoEnabled: false, videoModel: '' });
    error(await call('video_generate', { prompt: 'Disabled compatibility video', idempotencyKey: 'creative-video-off' }), 'NOT_SUPPORTED');
    const status = assertOk(await call('multimodal_status', {})) as { creative: { available: boolean; videoAvailable: boolean } };
    expect(status.creative).toMatchObject({ available: true, videoAvailable: false });
    expect(CreativeProvider.prototype.createVideo).not.toHaveBeenCalled(); expect(CreativeProvider.prototype.editVideo).not.toHaveBeenCalled(); expect(CreativeProvider.prototype.extendVideo).not.toHaveBeenCalled();
  });

  it('blocks disabled/project/client/scope access before calling any model while crop stays local', async () => {
    media({ enabled: false });
    error(await call('image_generate', { prompt: 'Disabled', idempotencyKey: 'creative-disabled' }), 'FORBIDDEN');
    media({ projectIds: [] });
    error(await call('video_generate', { prompt: 'Project denied', idempotencyKey: 'creative-project-denied' }), 'FORBIDDEN');
    media(); settings().savePermission({ projectId, profileIds: [], allowedClientIds: [token.clientId] });
    error(await call('image_generate', { prompt: 'Client denied', idempotencyKey: 'creative-client-denied' }, other.accessToken), 'FORBIDDEN');
    settings().savePermission({ projectId, profileIds: [], allowedClientIds: [token.clientId, other.clientId] });
    error(await call('image_generate', { prompt: 'Read only', idempotencyKey: 'creative-reader-denied' }, reader.accessToken), 'FORBIDDEN');
    media({ enabled: false });
    const crop = assertOk(await call('image_crop', { path: 'source.png', regions: [{ left: 0, top: 0, width: 1, height: 1 }], idempotencyKey: 'creative-local-when-disabled' })) as { resources: unknown[] };
    expect(crop.resources).toHaveLength(1);
    expect(CreativeProvider.prototype.generateImage).not.toHaveBeenCalled(); expect(CreativeProvider.prototype.createVideo).not.toHaveBeenCalled();
  });

  it('limits pending remote renders to two and frees a slot only after collecting an existing job', async () => {
    let creates = 0;
    vi.mocked(CreativeProvider.prototype.createVideo).mockImplementation(async (_input, _signal, beforeSend) => { beforeSend?.(); creates++; return { id: `video_capacity_${creates}`, status: 'queued', progress: 0 }; });
    const first = job(await call('video_generate', { prompt: 'Capacity first', idempotencyKey: 'creative-capacity-first' }));
    const second = job(await call('video_generate', { prompt: 'Capacity second', idempotencyKey: 'creative-capacity-second' }));
    const args = { prompt: 'Capacity third', idempotencyKey: 'creative-capacity-third' };
    error(await call('video_generate', args), 'RESOURCE_LIMIT');
    expect(CreativeProvider.prototype.createVideo).toHaveBeenCalledTimes(2);
    expect((await finished(first.jobId)).data.status).toBe('completed');
    const third = job(await call('video_generate', args));
    expect(third.jobId).not.toBe(first.jobId); expect(third.jobId).not.toBe(second.jobId);
    const results = await Promise.all([finished(second.jobId), finished(third.jobId)]);
    expect(results.every(result => result.data.status === 'completed')).toBe(true);
    expect(CreativeProvider.prototype.createVideo).toHaveBeenCalledTimes(3);
    expect(CreativeProvider.prototype.videoStatus).toHaveBeenCalledTimes(3);
    expect(CreativeProvider.prototype.videoContent).toHaveBeenCalledTimes(3);
  });

  it('keeps an uncertain paid operation inspectable without automatic resubmission', async () => {
    vi.mocked(CreativeProvider.prototype.generateImage).mockImplementation(async (_input, _signal, beforeSend) => { beforeSend?.(); throw new DodoError('CONFLICT', 'synthetic lost provider response'); });
    const args = { prompt: 'An uncertain fixture', idempotencyKey: 'creative-uncertain-one' };
    const started = job(await call('image_generate', args)), output = await finished(started.jobId);
    expect(output.data.status).toBe('uncertain'); expect(output.data.error).toBe('CONFLICT'); expect(output.data.resource).toBeNull();
    expect(job(await call('image_generate', args)).jobId).toBe(started.jobId);
    for (let n = 0; n < 3; n++) expect(job(await call('creative_job', { jobId: started.jobId })).status).toBe('uncertain');
    expect(CreativeProvider.prototype.generateImage).toHaveBeenCalledTimes(1);
  });

  it('enforces both file and aggregate export budgets before creating a plan or writing', async () => {
    const largeImage = await sharp(randomBytes(96 * 96 * 3), { raw: { width: 96, height: 96, channels: 3 } }).png().toBuffer();
    vi.mocked(CreativeProvider.prototype.generateImage).mockImplementation(async (_input, _signal, beforeSend) => { beforeSend?.(); return { bytes: largeImage, mimeType: 'image/png' }; });
    const started = job(await call('image_generate', { prompt: 'Export budget fixture', idempotencyKey: 'creative-export-budget-image' }));
    const resource = ResourceInfo.parse((await finished(started.jobId)).data.resource);
    expect(resource.bytes).toBeGreaterThan(16 * 1024); expect(resource.bytes).toBeLessThan(64 * 1024);
    const limits = ctx.server.services.limits, previousRead = limits.readFileBytes, previousAggregate = limits.previewAggregateBytes;
    const putPlan = vi.spyOn(ctx.server.services.store, 'putPlan'), apply = vi.spyOn(ctx.server.services.applier, 'apply');
    const args = { resourceId: resource.resourceId, expectedSha256: resource.sha256, path: 'budget.png', idempotencyKey: 'creative-export-budget-save' };
    try {
      limits.readFileBytes = 16 * 1024; limits.previewAggregateBytes = 64 * 1024;
      error(await call('media_save', args), 'RESOURCE_LIMIT');
      limits.readFileBytes = 64 * 1024; limits.previewAggregateBytes = 16 * 1024;
      error(await call('media_save', args), 'RESOURCE_LIMIT');
      expect(putPlan).not.toHaveBeenCalled(); expect(apply).not.toHaveBeenCalled(); expect(fs.existsSync(path.join(ctx.fixtureDir, 'budget.png'))).toBe(false);
    } finally { limits.readFileBytes = previousRead; limits.previewAggregateBytes = previousAggregate; }
    assertOk(await call('media_save', args));
    expect(putPlan).toHaveBeenCalledTimes(1); expect(apply).toHaveBeenCalledTimes(1);
  });

  it('returns AUTH_REQUIRED before submitting and permits the same key after credentials are added', async () => {
    await settings().credentials.delete(connectionId, 'session');
    const args = { prompt: 'Missing credential fixture', idempotencyKey: 'creative-key-preflight' };
    try {
      error(await call('image_generate', args), 'AUTH_REQUIRED');
      expect(CreativeProvider.prototype.generateImage).not.toHaveBeenCalled();
    } finally { await settings().credentials.set(connectionId, 'session', 'fixture-media-credential'); }
    const started = job(await call('image_generate', args));
    expect((await finished(started.jobId)).data.status).toBe('completed');
    expect(CreativeProvider.prototype.generateImage).toHaveBeenCalledTimes(1);
  });

  it('retains actual output after a final receipt write fails and retries bookkeeping without another paid call', async () => {
    const db = ctx.server.services.store.db;
    db.exec(`CREATE TRIGGER creative_test_receipt_failure BEFORE UPDATE ON creative_jobs
      WHEN json_extract(NEW.payload,'$.status')='completed'
      BEGIN SELECT RAISE(ABORT,'synthetic final creative receipt failure'); END`);
    try {
      const args = { prompt: 'Receipt persistence fixture', idempotencyKey: 'creative-final-receipt-failure' };
      const started = job(await call('image_generate', args)), output = await finished(started.jobId);
      expect(output.data.status).toBe('uncertain'); expect(output.data.error).toBe('RECEIPT_PERSISTENCE_FAILED');
      const resource = ResourceInfo.parse(output.data.resource);
      expect(blocks(output.response).some(block => block.type === 'image' && Boolean(block.data))).toBe(true);
      const refs = db.prepare('SELECT count(*) AS n FROM resource_refs WHERE source_kind=? AND source_label=?').get('generated', started.jobId) as { n: number };
      expect(refs.n).toBe(1); expect(CreativeProvider.prototype.generateImage).toHaveBeenCalledTimes(1);
      db.exec('DROP TRIGGER creative_test_receipt_failure');
      const recovered = job(await call('creative_job', { jobId: started.jobId }));
      expect(recovered.status).toBe('uncertain'); expect(recovered.error).toBe('RECEIPT_PERSISTENCE_FAILED'); expect(recovered.resource?.resourceId).toBe(resource.resourceId);
      const stored = db.prepare('SELECT payload FROM creative_jobs WHERE id=?').get(started.jobId) as { payload: string };
      expect(JSON.parse(stored.payload)).toMatchObject({ status: 'uncertain', error: 'RECEIPT_PERSISTENCE_FAILED', resource: { resourceId: resource.resourceId } });
      expect(job(await call('image_generate', args)).jobId).toBe(started.jobId);
      expect(CreativeProvider.prototype.generateImage).toHaveBeenCalledTimes(1);
      const read = ResourceChunk.parse(assertOk(await call('resource_read', { resourceId: resource.resourceId, expectedSha256: resource.sha256 })));
      expect(await sharp(Buffer.from(read.data, 'base64')).raw().toBuffer()).toEqual(PIXELS);
      // Both live slots remain usable despite the failed completion receipt.
      const first = job(await call('video_generate', { prompt: 'Receipt slot first', idempotencyKey: 'creative-receipt-slot-one' }));
      const second = job(await call('video_generate', { prompt: 'Receipt slot second', idempotencyKey: 'creative-receipt-slot-two' }));
      expect(CreativeProvider.prototype.createVideo).toHaveBeenCalledTimes(2);
      expect((await finished(first.jobId)).data.status).toBe('completed'); expect((await finished(second.jobId)).data.status).toBe('completed');
      const pending = db.prepare("SELECT count(*) AS n FROM creative_jobs WHERE workspace_id=? AND json_extract(payload,'$.status') IN ('queued','running')").get(ctx.server.workspaceId) as { n: number };
      expect(pending.n).toBe(0);
    } finally { db.exec('DROP TRIGGER IF EXISTS creative_test_receipt_failure'); }
  });

  it('ignores stale handleless work in an unopened workspace when counting global render capacity', async () => {
    const seed = job(await call('image_generate', { prompt: 'Stale receipt template', idempotencyKey: 'creative-stale-template' }));
    expect((await finished(seed.jobId)).data.status).toBe('completed');
    const db = ctx.server.services.store.db;
    const row = db.prepare('SELECT owner,payload FROM creative_jobs WHERE id=?').get(seed.jobId) as { owner: string; payload: string };
    const template = JSON.parse(row.payload) as Record<string, unknown>;
    const unopened = new ProjectRegistry(ctx.server.services.store).add(mkTmpDir('dodo-creative-unopened-'), 'Unopened creative fixture').project;
    const ids: string[] = [];
    try {
      const insert = db.prepare('INSERT INTO creative_jobs(id,workspace_id,owner,payload,updated_at,expires_at) VALUES(?,?,?,?,?,?)');
      for (let index = 0; index < 4; index++) {
        const id = newId('creative'), expiresAt = Date.now() + 60000;
        const stale = { ...template, jobId: id, epoch: 'boot_stale_fixture', status: index % 2 ? 'running' : 'queued', resource: null, error: null, progress: 0, expiresAt };
        insert.run(id, unopened.workspaceId, row.owner, JSON.stringify(stale), Date.now(), expiresAt); ids.push(id);
      }
      const staleCount = db.prepare("SELECT count(*) AS n FROM creative_jobs WHERE workspace_id=? AND json_extract(payload,'$.remoteId') IS NULL AND json_extract(payload,'$.status') IN ('queued','running')").get(unopened.workspaceId) as { n: number };
      expect(staleCount.n).toBe(4);
      const active = job(await call('image_generate', { prompt: 'Active workspace still works', idempotencyKey: 'creative-ignore-stale-other-project' }));
      expect((await finished(active.jobId)).data.status).toBe('completed');
      expect(CreativeProvider.prototype.generateImage).toHaveBeenCalledTimes(2);
    } finally {
      const remove = db.prepare('DELETE FROM creative_jobs WHERE id=?');
      db.transaction(() => { for (const id of ids) remove.run(id); })();
    }
  });

  it('preserves a collected MP4 after final receipt failure without polling or downloading it twice', async () => {
    const db = ctx.server.services.store.db;
    db.exec(`CREATE TRIGGER creative_test_video_receipt_failure BEFORE UPDATE ON creative_jobs
      WHEN json_extract(NEW.payload,'$.status')='completed'
      BEGIN SELECT RAISE(ABORT,'synthetic final video receipt failure'); END`);
    try {
      const args = { prompt: 'Video receipt persistence fixture', idempotencyKey: 'creative-video-receipt-failure' };
      const started = job(await call('video_generate', args)), output = await finished(started.jobId);
      expect(output.data.status).toBe('uncertain'); expect(output.data.error).toBe('RECEIPT_PERSISTENCE_FAILED');
      const resource = ResourceInfo.parse(output.data.resource);
      expect(resource.mimeType).toBe('video/mp4');
      const read = ResourceChunk.parse(assertOk(await call('resource_read_range', { resourceId: resource.resourceId, length: MP4.length })));
      expect(Buffer.from(read.data, 'base64')).toEqual(MP4);
      expect(CreativeProvider.prototype.createVideo).toHaveBeenCalledTimes(1); expect(CreativeProvider.prototype.videoStatus).toHaveBeenCalledTimes(1); expect(CreativeProvider.prototype.videoContent).toHaveBeenCalledTimes(1);
      db.exec('DROP TRIGGER creative_test_video_receipt_failure');
      for (let index = 0; index < 2; index++) {
        const recovered = job(await call('creative_job', { jobId: started.jobId }));
        expect(recovered.status).toBe('uncertain'); expect(recovered.error).toBe('RECEIPT_PERSISTENCE_FAILED'); expect(recovered.resource?.resourceId).toBe(resource.resourceId);
      }
      expect(job(await call('video_generate', args)).jobId).toBe(started.jobId);
      const stored = db.prepare('SELECT payload FROM creative_jobs WHERE id=?').get(started.jobId) as { payload: string };
      expect(JSON.parse(stored.payload)).toMatchObject({ status: 'uncertain', resource: { resourceId: resource.resourceId } });
      const refs = db.prepare('SELECT count(*) AS n FROM resource_refs WHERE source_kind=? AND source_label=?').get('generated', started.jobId) as { n: number };
      expect(refs.n).toBe(1);
      expect(CreativeProvider.prototype.createVideo).toHaveBeenCalledTimes(1); expect(CreativeProvider.prototype.videoStatus).toHaveBeenCalledTimes(1); expect(CreativeProvider.prototype.videoContent).toHaveBeenCalledTimes(1);
    } finally { db.exec('DROP TRIGGER IF EXISTS creative_test_video_receipt_failure'); }
  });

  it('rechecks a source resource expiry before sending an image-guided video upload', async () => {
    media({ allowImageUpload: true });
    const reference = await sharp({ create: { width: 1280, height: 720, channels: 4, background: '#33669980' } }).png().toBuffer();
    fs.writeFileSync(path.join(ctx.fixtureDir, 'expiring-video-reference.png'), reference);
    const resource = ResourceInfo.parse(assertOk(await call('resource_inspect', { path: 'expiring-video-reference.png' })));
    const inspect = vi.spyOn(ctx.server.services.resources!, 'inspect').mockResolvedValueOnce({ ...resource, expiresAt: Date.now() - 1 });
    error(await call('video_generate', { prompt: 'Expired resource upload fixture', reference: { resourceId: resource.resourceId }, idempotencyKey: 'creative-video-reference-expired' }), 'NOT_FOUND');
    expect(inspect).toHaveBeenCalledTimes(1); expect(CreativeProvider.prototype.createVideo).not.toHaveBeenCalled();
  });

  it('retains completed job/resource bytes across a real server restart without provider credentials', async () => {
    const started = job(await call('image_generate', { prompt: 'Durable fixture', idempotencyKey: 'creative-durable-one' }));
    const output = await finished(started.jobId), resource = ResourceInfo.parse(output.data.resource), oldEpoch = ctx.server.epoch;
    const previous = ctx;
    await previous.cleanup();
    ctx = await launch({ toolSurface: 'full', trust: 'trusted', locked: true, fixtureDir: previous.fixtureDir, configDir: previous.configDir, port: previous.port });
    expect(ctx.server.epoch).not.toBe(oldEpoch);
    expect(settings().media()).toMatchObject({ enabled: true, connectionId, projectIds: [projectId] });
    expect(settings().credentials.hasSession(connectionId)).toBe(false);
    const restored = job(await call('creative_job', { jobId: started.jobId }));
    expect(restored.status).toBe('completed'); expect(restored.resource?.sha256).toBe(resource.sha256);
    const read = ResourceChunk.parse(assertOk(await call('resource_read', { resourceId: resource.resourceId, expectedSha256: resource.sha256 })));
    expect(await sharp(Buffer.from(read.data, 'base64')).raw().toBuffer()).toEqual(PIXELS);
    expect(CreativeProvider.prototype.generateImage).toHaveBeenCalledTimes(1);
  });
});
