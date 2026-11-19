import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProjectRegistry } from '../../src/projects/registry.js';
import type { CreativeJobData } from '../../src/services/multimodal/creativeService.js';
import { ResourceChunk, ResourceInfo } from '../../src/services/resources/contracts.js';
import { assertOk, blocks } from '../helpers/multimodal.js';
import { callToolLegacy, launch, mcpRaw, obtainToken, parseMcpResponse, rfetch, rpc, type TestContext, type TokenSet } from '../helpers/testServer.js';

interface Link { linkId: string; url: string; createdAt: number; expiresAt: number }
const KEY = 'synthetic-global-media-env-credential';

/** Real HTTP provider fixture: exercise discovery, serialization and credential use, without spending credits. */
async function providerFixture() {
  const png = await sharp({ create: { width: 16, height: 12, channels: 4, background: '#2266aa80' } }).png().toBuffer();
  const calls: Array<{ path: string; authorized: boolean; body: string }> = [];
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += String(chunk);
    const authorized = req.headers.authorization === `Bearer ${KEY}`;
    calls.push({ path: req.url ?? '', authorized, body });
    res.setHeader('content-type', 'application/json');
    if (!authorized) { res.statusCode = 401; res.end('{}'); return; }
    if (req.url === '/v1/models') { res.end(JSON.stringify({ data: [{ id: 'gpt-image-2.5-flare' }, { id: 'fixture-text-model' }] })); return; }
    if (req.url === '/v1/images/generations' || req.url === '/v1/images/edits') {
      res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] })); return;
    }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, png, calls,
    close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }),
  };
}

async function configure(ctx: TestContext, baseUrl: string) {
  const local = new URL(ctx.configUrl!), capability = local.hash.slice(1);
  const headers = { authorization: `Bearer ${capability}`, 'content-type': 'application/json', 'x-dodo-workspace': ctx.server.workspaceId, 'x-dodo-epoch': ctx.server.epoch };
  const saved = await rfetch(`${local.origin}/api/ai/connection`, { method: 'POST', headers, body: JSON.stringify({
    connection: { name: 'Global image fixture', provider: 'custom', protocol: 'responses', baseUrl, allowPrivateNetwork: true, credentialStorage: 'env' }, apiKey: KEY,
  }) });
  expect(saved.status).toBe(200);
  const connection = (await saved.json() as { data: { id: string } }).data;
  const media = await rfetch(`${local.origin}/api/ai/media`, { method: 'POST', headers, body: JSON.stringify({
    connectionId: connection.id, imageModel: 'auto', enabled: false, projectIds: [], allowImageUpload: false,
  }) });
  expect(media.status).toBe(200);
  return connection;
}

type Result = Awaited<ReturnType<typeof callToolLegacy>>;
function job(result: Result) { return assertOk(result) as CreativeJobData; }
function expectError(result: Result, code?: string) {
  expect(result.isError).toBe(true);
  if (code) expect(result.envelope.error).toMatchObject({ code });
}
async function finished(call: (name: string, args: Record<string, unknown>) => Promise<Result>, id: string) {
  for (let index = 0; index < 100; index++) {
    const result = await call('creative_job', { jobId: id }), data = job(result);
    if (['completed', 'failed', 'uncertain', 'interrupted'].includes(data.status)) {
      expect(data.status, data.error ?? data.note).toBe('completed');
      return { result, data };
    }
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  throw new Error('Global image fixture did not complete');
}

describe('installation media with no project or workspace context', () => {
  let ctx: TestContext, provider: Awaited<ReturnType<typeof providerFixture>>, token: TokenSet, other: TokenSet, reader: TokenSet;
  const call = (name: string, args: Record<string, unknown>, accessToken = token.accessToken) => callToolLegacy(ctx, accessToken, name, args);
  beforeAll(async () => {
    provider = await providerFixture();
    ctx = await launch({ deferWorkspace: true, toolSurface: 'full', configPort: 0, trust: 'inspect' });
    await configure(ctx, provider.baseUrl);
    token = await obtainToken(ctx, { grantWorkspaceAccess: false });
    other = await obtainToken(ctx, { grantWorkspaceAccess: false });
    reader = await obtainToken(ctx, { scope: 'dodo:read', grantWorkspaceAccess: false });
  });
  afterAll(async () => { await ctx?.cleanup(); await provider?.close(); });

  it('creates, crops, removes a background, previews and downloads without an overview, project or enablement switches', async () => {
    expect(ctx.server.workspaceSelected).toBe(false);
    expect(ctx.server.services.installation!.list(ctx.server.services.installation!.owner())).toEqual([]);
    expect(ctx.server.services.store.clientAccess(ctx.server.workspaceId, token.clientId)).toEqual([]);
    const before = provider.calls.filter(call => call.path === '/v1/images/generations').length;
    const args = { prompt: 'A transparent synthetic global image', idempotencyKey: 'global-image-complete-flow' };
    const started = job(await call('image_generate', args));
    const output = await finished(call, started.jobId), resource = ResourceInfo.parse(output.data.resource);
    expect(output.data.model).toBe('gpt-image-2.5-flare');
    const echoed = await call('creative_job', { jobId: started.jobId, workspaceId: output.result.envelope.workspaceId, workspaceEpoch: output.result.envelope.workspaceEpoch });
    expect(job(echoed).status).toBe('completed');
    expect(blocks(output.result).some(block => block.type === 'image' && Boolean(block.data))).toBe(true);
    const read = ResourceChunk.parse(assertOk(await call('resource_read', { resourceId: resource.resourceId })));
    expect(Buffer.from(read.data, 'base64')).toEqual(provider.png);
    expect(job(await call('image_generate', args)).jobId).toBe(started.jobId);
    expect(provider.calls.filter(call => call.path === '/v1/images/generations')).toHaveLength(before + 1);
    const cropped = assertOk(await call('image_crop', { resourceId: resource.resourceId, regions: [{ left: 2, top: 3, width: 4, height: 5 }], idempotencyKey: 'global-image-crop' })) as { resources: unknown[] };
    expect(ResourceInfo.parse(cropped.resources[0]).metadata).toMatchObject({ width: 4, height: 5 });
    const removed = job(await call('image_remove_background', { resourceId: resource.resourceId, idempotencyKey: 'global-image-remove-background' }));
    expect((await finished(call, removed.jobId)).data.kind).toBe('background_removal');
    const preview = await call('resource_preview', { resourceId: resource.resourceId }); assertOk(preview);
    expect(blocks(preview).some(block => block.type === 'image')).toBe(true);
    const link = assertOk(await call('download_link_create', { resourceId: resource.resourceId, expectedSha256: resource.sha256, expiresInDays: 2, fileName: 'global-image.png' })) as Link;
    expect(link.expiresAt - link.createdAt).toBe(2 * 86_400_000);
    const download = await rfetch(link.url);
    expect(download.status).toBe(200); expect(Buffer.from(await download.arrayBuffer())).toEqual(provider.png);
    assertOk(await call('download_link_revoke', { linkId: link.linkId }));
    expect((await rfetch(link.url)).status).toBe(404);
    expect(provider.calls.every(item => item.authorized)).toBe(true);
    expect(JSON.stringify(output.result.raw)).not.toContain(KEY);
    expect(ctx.server.workspaceSelected).toBe(false);
  });

  it('keeps token scopes, caller ownership and revocation effective without project ACL rows', async () => {
    expectError(await call('image_generate', { prompt: 'No exec scope', idempotencyKey: 'global-image-reader-denied' }, reader.accessToken), 'FORBIDDEN');
    const started = job(await call('image_generate', { prompt: 'Owned global image', idempotencyKey: 'global-image-owned' }));
    const resource = ResourceInfo.parse((await finished(call, started.jobId)).data.resource);
    expectError(await call('creative_job', { jobId: started.jobId }, other.accessToken), 'NOT_FOUND');
    expectError(await call('resource_read', { resourceId: resource.resourceId }, other.accessToken), 'NOT_FOUND');
    expectError(await call('download_link_create', { resourceId: resource.resourceId, expectedSha256: resource.sha256 }, reader.accessToken), 'FORBIDDEN');
    const privateToken = await obtainToken(ctx, { grantWorkspaceAccess: false });
    const privateCall = (name: string, args: Record<string, unknown>) => call(name, args, privateToken.accessToken);
    const own = job(await privateCall('image_generate', { prompt: 'Revocable global image', idempotencyKey: 'global-image-revocable' }));
    const ownResource = ResourceInfo.parse((await finished(privateCall, own.jobId)).data.resource);
    const link = assertOk(await privateCall('download_link_create', { resourceId: ownResource.resourceId, expectedSha256: ownResource.sha256 })) as Link;
    const activeDownload = await rfetch(link.url); expect(activeDownload.status).toBe(200); await activeDownload.arrayBuffer();
    ctx.server.services.store.revokeGrant(privateToken.grantId);
    expect((await rfetch(link.url)).status).toBe(404);
    const revoked = await mcpRaw(ctx, rpc('tools/call', { name: 'creative_job', arguments: { jobId: own.jobId } }), privateToken.accessToken);
    expect(revoked.status).toBe(401);
  });

  it('keeps global output available when the owner later switches the active workspace', async () => {
    const started = job(await call('image_generate', { prompt: 'Survive an unrelated workspace switch', idempotencyKey: 'global-image-before-switch' }));
    const output = await finished(call, started.jobId), resource = ResourceInfo.parse(output.data.resource);
    const changed = await ctx.server.switchWorkspace({ path: ctx.fixtureDir });
    expect(changed.changed).toBe(true);
    expect(job(await call('creative_job', { jobId: started.jobId })).status).toBe('completed');
    const preview = await call('resource_preview', { resourceId: resource.resourceId }); assertOk(preview);
    expect(blocks(preview).some(block => block.type === 'image')).toBe(true);
    expectError(await call('image_generate', { prompt: 'Incomplete explicit context', workspaceId: changed.workspaceId, idempotencyKey: 'global-incomplete-context' }));
  });

  it('retains completed global jobs, resource references, Env keys and token links after an actual server restart', async () => {
    const started = job(await call('image_generate', { prompt: 'Global image before real restart', idempotencyKey: 'global-image-before-restart' }));
    const resource = ResourceInfo.parse((await finished(call, started.jobId)).data.resource);
    const link = assertOk(await call('download_link_create', { resourceId: resource.resourceId, expectedSha256: resource.sha256, expiresInDays: 30 })) as Link;
    const count = provider.calls.filter(call => call.path === '/v1/images/generations').length;
    const restart = { fixtureDir: ctx.fixtureDir, configDir: ctx.configDir, port: ctx.port, deferWorkspace: true, toolSurface: 'full' as const, configPort: 0 };
    await ctx.cleanup(); ctx = await launch(restart);
    expect(ctx.server.workspaceSelected).toBe(false);
    expect(ctx.server.services.installation!.list(ctx.server.services.installation!.owner())).toEqual([]);
    expect(job(await call('creative_job', { jobId: started.jobId })).resource).toMatchObject({ resourceId: resource.resourceId });
    const read = ResourceChunk.parse(assertOk(await call('resource_read', { resourceId: resource.resourceId })));
    expect(Buffer.from(read.data, 'base64')).toEqual(provider.png);
    const download = await rfetch(link.url); expect(download.status).toBe(200);
    expect(Buffer.from(await download.arrayBuffer())).toEqual(provider.png);
    expect(provider.calls.filter(call => call.path === '/v1/images/generations')).toHaveLength(count);
    const next = job(await call('image_generate', { prompt: 'The Env credential survives restart', idempotencyKey: 'global-image-after-restart' }));
    await finished(call, next.jobId);
    expect(provider.calls.filter(call => call.path === '/v1/images/generations')).toHaveLength(count + 1);
  });

  it('exports a globally generated resource into an explicitly selected project with journal rollback and ownership checks', async () => {
    const started = job(await call('image_generate', { prompt: 'Global creation then explicit project export', idempotencyKey: 'global-image-export-to-project' }));
    const resource = ResourceInfo.parse((await finished(call, started.jobId)).data.resource);
    const registry = new ProjectRegistry(ctx.server.services.store);
    const project = registry.add(ctx.fixtureDir, 'Global image export destination').project;
    try {
      ctx.server.services.store.setClientAccess(project.workspaceId, token.clientId, ['dodo:read', 'dodo:write', 'dodo:exec']);
      ctx.server.services.store.setClientAccess(project.workspaceId, other.clientId, ['dodo:read', 'dodo:write', 'dodo:exec']);
      ctx.server.services.store.setTrustMode(project.workspaceId, 'trusted');
      const overview = await call('project_overview', { targetProjectId: project.projectId }); assertOk(overview);
      const context = { targetProjectId: project.projectId, workspaceId: overview.envelope.workspaceId, workspaceEpoch: overview.envelope.workspaceEpoch };
      const args = { ...context, resourceId: resource.resourceId, expectedSha256: resource.sha256, path: 'assets/global.png', idempotencyKey: 'global-save-explicit-project' };
      expectError(await call('media_save', { ...args, idempotencyKey: 'global-save-other-owner' }, other.accessToken), 'NOT_FOUND');
      const saved = assertOk(await call('media_save', args)) as { changesetId: string; hash: string; replayed: boolean };
      expect(saved.hash).toBe(resource.sha256);
      expect(fs.readFileSync(path.join(ctx.fixtureDir, 'assets', 'global.png'))).toEqual(provider.png);
      expect((assertOk(await call('media_save', args)) as { replayed: boolean }).replayed).toBe(true);
      assertOk(await call('rollback_changes', { ...context, changesetId: saved.changesetId, idempotencyKey: 'global-save-project-rollback' }));
      expect(fs.existsSync(path.join(ctx.fixtureDir, 'assets', 'global.png'))).toBe(false);
      expect(job(await call('creative_job', { jobId: started.jobId })).status).toBe('completed');
    } finally { registry.remove(project.projectId); }
  });
});

describe.each(['compact', 'hybrid'] as const)('project-free %s media gateway', surface => {
  it('discovers and runs global operations while preserving required context on project operations', async () => {
    const provider = await providerFixture();
    const ctx = await launch({ deferWorkspace: true, toolSurface: surface, configPort: 0, trust: 'inspect' });
    try {
      await configure(ctx, provider.baseUrl);
      const token = await obtainToken(ctx, { grantWorkspaceAccess: false });
      const call = (name: string, args: Record<string, unknown>) => callToolLegacy(ctx, token.accessToken, name, args);
      const discovery = assertOk(await call('dodo_discover', { operation: 'image_generate' })) as { operation: string; callShape: { example: Record<string, unknown> } };
      expect(discovery.operation).toBe('image_generate');
      expect(discovery.callShape.example.workspaceId).toBeUndefined();
      expect(discovery.callShape.example.workspaceEpoch).toBeUndefined();
      const response = await mcpRaw(ctx, rpc('tools/list'), token.accessToken);
      const catalog = (await parseMcpResponse(response)).result as { tools: Array<{ name: string; inputSchema: { required?: string[] } }> };
      const media = catalog.tools.find(tool => tool.name === 'dodo_media')!;
      expect(media.inputSchema.required ?? []).not.toContain('workspaceId');
      expect(media.inputSchema.required ?? []).not.toContain('workspaceEpoch');
      const mediaCall = (operation: string, args: Record<string, unknown>) => call('dodo_media', { operation, args });
      const started = job(await mediaCall('image_generate', { prompt: 'Image directly from chat', idempotencyKey: `global-${surface}-image` }));
      const resource = ResourceInfo.parse((await finished(mediaCall, started.jobId)).data.resource);
      const preview = await mediaCall('resource_preview', { resourceId: resource.resourceId }); assertOk(preview);
      expect(blocks(preview).some(block => block.type === 'image')).toBe(true);
      expectError(await mediaCall('image_generate', { prompt: 'Nested workspace routing', workspaceId: ctx.server.workspaceId, idempotencyKey: `global-${surface}-nested` }), 'INVALID_INPUT');
      const globalContext = { workspaceId: preview.envelope.workspaceId, workspaceEpoch: preview.envelope.workspaceEpoch };
      const global = ctx.server.services.installation!.globalServices();
      const countRows = () => Object.fromEntries(['changesets', 'change_plans', 'jobs'].map(table => [table, global.store.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()]));
      const beforeRows = countRows(), beforeFiles = fs.readdirSync(global.wfs.root).sort();
      const beforeDirectories = global.multimodal!.storage.directories.size;
      const beforeSources = global.multimodal!.media.sources.size, beforeJobs = global.multimodal!.media.jobs.size;
      const saveArgs = { resourceId: resource.resourceId, expectedSha256: resource.sha256, path: 'misrouted-global.png', idempotencyKey: `global-${surface}-must-not-save` };
      expectError(await call('dodo_media', { ...globalContext, operation: 'media_save', args: saveArgs }), 'INVALID_INPUT');
      expectError(await call('dodo_media', { ...globalContext, operation: 'media_open', args: { path: 'video.mp4', idempotencyKey: `global-${surface}-must-not-open` } }), 'INVALID_INPUT');
      expectError(await mediaCall('media_save', { ...saveArgs, idempotencyKey: `global-${surface}-save-no-context` }), 'INVALID_INPUT');
      expectError(await mediaCall('media_open', { path: 'video.mp4', idempotencyKey: `global-${surface}-file` }), 'INVALID_INPUT');
      expect(countRows()).toEqual(beforeRows);
      expect(fs.readdirSync(global.wfs.root).sort()).toEqual(beforeFiles);
      expect(global.multimodal!.storage.directories.size).toBe(beforeDirectories);
      expect(global.multimodal!.media.sources.size).toBe(beforeSources); expect(global.multimodal!.media.jobs.size).toBe(beforeJobs);
      for (const root of [global.wfs.root, ctx.server.root, ctx.fixtureDir]) expect(fs.existsSync(path.join(root, 'misrouted-global.png'))).toBe(false);
      expect(ctx.server.workspaceSelected).toBe(false);
    } finally { await ctx.cleanup(); await provider.close(); }
  });
});
