import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { ProjectRegistry } from '../../src/projects/registry.js';
import { removeWithRetry } from '../../src/platform/fsRetry.js';
import { ResourceChunk, ResourceInfo } from '../../src/services/resources/contracts.js';
import { newId } from '../../src/util/hash.js';
import { assertOk, tool } from '../helpers/multimodal.js';
import { launch, obtainToken, rfetch, type TestContext } from '../helpers/testServer.js';

interface SavedConnection {
  id: string;
  name: string;
  provider: string;
  protocol: string;
  baseUrl: string;
  enabled: boolean;
  allowPrivateNetwork: boolean;
  credentialStorage: string;
  credentialEnvVar?: string;
}
interface State {
  connections: Array<SavedConnection & { credentialPresent: boolean; credentialNeedsReentry: boolean }>;
  credentialStorageOptions: Array<{ id: string; available: boolean }>;
}

function ownerApi(ctx: TestContext) {
  const local = new URL(ctx.configUrl!), capability = local.hash.slice(1);
  const headers = { authorization: `Bearer ${capability}`, 'content-type': 'application/json', 'x-dodo-workspace': ctx.server.workspaceId, 'x-dodo-epoch': ctx.server.epoch };
  return {
    origin: local.origin,
    capability,
    post: (operation: string, body: unknown, overrides: Record<string, string> = {}) => rfetch(`${local.origin}/api/ai/${operation}`, { method: 'POST', headers: { ...headers, ...overrides }, body: JSON.stringify(body) }),
    state: () => rfetch(`${local.origin}/api/ai/state`, { headers: { authorization: headers.authorization } }),
  };
}

async function data<T>(response: Response): Promise<T> {
  const body = await response.json() as { ok?: boolean; data?: T; code?: string };
  expect(response.status, body.code).toBe(200); expect(body.ok).toBe(true);
  return body.data!;
}

function envFiles(ctx: TestContext): string[] {
  const directory = path.join(ctx.configDir, 'credentials', 'ai');
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isFile() && entry.name.endsWith('.env')).map(entry => path.join(directory, entry.name));
}

async function cleanup(ctx: TestContext): Promise<void> {
  await ctx.cleanup();
  const temporaryRoot = fs.realpathSync.native(os.tmpdir());
  for (const directory of [ctx.fixtureDir, ctx.configDir]) {
    if (!fs.existsSync(directory)) continue;
    const actual = fs.realpathSync.native(directory);
    if (path.dirname(actual) !== temporaryRoot || !/^dodo-(?:fix|cfg)-/.test(path.basename(actual))) throw new Error('refusing cleanup outside owned temporary fixture');
    removeWithRetry(actual, true);
  }
}

async function providerFixture(initialKey: string) {
  const png = await sharp({ create: { width: 24, height: 16, channels: 4, background: '#2070c0' } }).png().toBuffer();
  const calls: Array<{ path: string; authorized: boolean; body: Record<string, unknown> }> = [];
  let expectedKey = initialKey;
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += String(chunk);
    const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    const authorized = req.headers.authorization === `Bearer ${expectedKey}`;
    calls.push({ path: req.url ?? '', authorized, body });
    res.setHeader('content-type', 'application/json');
    if (!authorized) { res.statusCode = 401; res.end(JSON.stringify({ error: 'synthetic fixture credential missing' })); return; }
    if (req.url === '/v1/models') { res.end(JSON.stringify({ data: [{ id: 'gpt-image-2.5-flare' }, { id: 'fixture-chat-model' }] })); return; }
    if (req.url === '/v1/images/generations') { res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] })); return; }
    if (req.url === '/v1/responses') { res.end(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK from the local synthetic provider' }] }], usage: { input_tokens: 3, output_tokens: 2 } })); return; }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, png, calls,
    setKey: (key: string) => { expectedKey = key; },
    close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }),
  };
}

function connection(baseUrl: string, credentialEnvVar?: string) {
  return { name: 'Persistent Env fixture', provider: 'custom', protocol: 'responses', baseUrl, allowPrivateNetwork: true, credentialStorage: 'env', ...(credentialEnvVar ? { credentialEnvVar } : {}) };
}

describe('permanent provider Env credentials through real owner HTTP and MCP', () => {
  it('persists an owner-entered key across server restart and uses it for models, AI inference and Auto images', async () => {
    const key = 'synthetic-persistent-env-credential';
    const provider = await providerFixture(key);
    let ctx = await launch({ trust: 'trusted', toolSurface: 'full', configPort: 0 });
    try {
      let owner = ownerApi(ctx);
      const savedResponse = await owner.post('connection', { connection: connection(provider.baseUrl), apiKey: key });
      const savedText = await savedResponse.text(); expect(savedResponse.status).toBe(200); expect(savedText).not.toContain(key);
      const saved = (JSON.parse(savedText) as { data: SavedConnection }).data;
      expect(saved.credentialStorage).toBe('env'); expect(saved.credentialEnvVar).toMatch(/^DODO_AI_KEY_[A-Z0-9_]+$/);
      expect(process.env[saved.credentialEnvVar!]).toBeUndefined();
      expect(envFiles(ctx)).toHaveLength(1);
      const project = new ProjectRegistry(ctx.server.services.store).add(ctx.fixtureDir, 'Persistent Env image project').project;
      const token = await obtainToken(ctx);
      const profile = await data<{ id: string }>(await owner.post('profile', { name: 'Persistent Env inference', connectionId: saved.id, model: 'fixture-chat-model' }));
      await data(await owner.post('permission', { projectId: project.projectId, profileIds: [profile.id], allowSourceEgress: true, allowedClientIds: [token.clientId] }));
      await data(await owner.post('media', { enabled: true, connectionId: saved.id, projectIds: [project.projectId], imageModel: 'auto' }));
      const originalCapability = owner.capability;
      const restartOptions = { fixtureDir: ctx.fixtureDir, configDir: ctx.configDir, port: ctx.port, trust: 'trusted' as const, toolSurface: 'full' as const, configPort: 0 };
      await ctx.cleanup(); ctx = await launch(restartOptions); owner = ownerApi(ctx);
      expect((await owner.post('models', { connectionId: saved.id }, { authorization: `Bearer ${originalCapability}` })).status).toBe(401);
      const stateResponse = await owner.state(), stateText = await stateResponse.text();
      expect(stateResponse.status).toBe(200); expect(stateText).not.toContain(key);
      const state = (JSON.parse(stateText) as { data: State }).data;
      expect(state.connections.find(item => item.id === saved.id)).toMatchObject({ credentialStorage: 'env', credentialPresent: true, credentialNeedsReentry: false });
      expect(state.credentialStorageOptions).toContainEqual(expect.objectContaining({ id: 'env', available: true }));
      expect(state.credentialStorageOptions).toContainEqual(expect.objectContaining({ id: 'keychain', available: process.platform === 'darwin' }));
      expect(await data(await owner.post('models', { connectionId: saved.id }))).toEqual([{ id: 'gpt-image-2.5-flare' }, { id: 'fixture-chat-model' }]);
      expect(await data(await owner.post('probe', { profileId: profile.id, mode: 'inference', confirmUsage: true }))).toMatchObject({ passed: true });
      const started = assertOk(await tool(ctx, token.accessToken, 'image_generate', { prompt: 'A synthetic blue test image', idempotencyKey: 'persistent-env-image-after-restart' })) as { jobId: string };
      let completed: { status: string; model: string; resource: unknown } | undefined;
      for (let index = 0; index < 100; index++) {
        completed = assertOk(await tool(ctx, token.accessToken, 'creative_job', { jobId: started.jobId })) as typeof completed;
        if (completed?.status === 'completed' || completed?.status === 'failed') break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(completed).toMatchObject({ status: 'completed', model: 'gpt-image-2.5-flare' });
      const resource = ResourceInfo.parse(completed!.resource);
      const read = ResourceChunk.parse(assertOk(await tool(ctx, token.accessToken, 'resource_read', { resourceId: resource.resourceId, expectedSha256: resource.sha256 })));
      expect(Buffer.from(read.data, 'base64')).toEqual(provider.png);
      expect(provider.calls.filter(item => item.path === '/v1/images/generations')).toHaveLength(1);
      expect(provider.calls.every(item => item.authorized)).toBe(true);
      expect(provider.calls.find(item => item.path === '/v1/images/generations')!.body.model).toBe('gpt-image-2.5-flare');
      expect(JSON.stringify(ctx.server.services.store.db.prepare('SELECT payload FROM ai_settings').all())).not.toContain(key);
      expect(process.env[saved.credentialEnvVar!]).toBeUndefined();
    } finally { await cleanup(ctx); await provider.close(); }
  });

  it('retains a blank-key edit, requires explicit rebinding, rotates and removes only owned Env files', async () => {
    const first = 'synthetic-env-rotation-original', second = 'synthetic-env-rotation-replacement';
    const variable = 'DODO_AI_TEST_ROTATION_FIRST', changedVariable = 'DODO_AI_TEST_ROTATION_SECOND';
    const originalProcessValue = process.env[variable];
    const provider = await providerFixture(first);
    const ctx = await launch({ trust: 'trusted', configPort: 0 });
    try {
      const owner = ownerApi(ctx);
      const saved = await data<SavedConnection>(await owner.post('connection', { connection: connection(provider.baseUrl, variable), apiKey: first }));
      expect(envFiles(ctx)).toHaveLength(1);
      await data(await owner.post('connection', { connection: { ...saved, name: 'Renamed Env connection' } }));
      expect((await owner.post('models', { connectionId: saved.id })).status).toBe(200);
      expect((await owner.post('connection', { connection: { ...saved, baseUrl: `${provider.baseUrl}/other-api` } })).status).toBe(400);
      expect((await owner.post('connection', { connection: { ...saved, credentialEnvVar: changedVariable } })).status).toBe(400);
      expect(envFiles(ctx)).toHaveLength(1);
      const rotated = await data<SavedConnection>(await owner.post('connection', { connection: { ...saved, credentialEnvVar: changedVariable }, apiKey: second }));
      provider.setKey(second);
      expect((await owner.post('models', { connectionId: saved.id })).status).toBe(200);
      expect(envFiles(ctx)).toHaveLength(1);
      expect(fs.readFileSync(envFiles(ctx)[0]!, 'utf8')).not.toContain(first);
      expect(rotated.credentialEnvVar).toBe(changedVariable);
      await data(await owner.post('connection', { connection: { ...connection(provider.baseUrl), id: saved.id, credentialStorage: 'session' }, apiKey: second }));
      expect(envFiles(ctx)).toHaveLength(0);
      expect((await owner.post('models', { connectionId: saved.id })).status).toBe(200);
      await data(await owner.post('connection', { connection: { ...connection(provider.baseUrl, changedVariable), id: saved.id }, apiKey: second }));
      expect(envFiles(ctx)).toHaveLength(1);
      await data(await owner.post('remove', { kind: 'connection', id: saved.id, confirmId: saved.id }));
      expect(envFiles(ctx)).toHaveLength(0);
      expect(process.env[variable]).toBe(originalProcessValue);
      expect(provider.calls.every(item => item.authorized)).toBe(true);
      const state = await data<State>(await owner.state()); expect(state.connections).toEqual([]);
      for (const secret of [first, second]) expect(JSON.stringify(ctx.server.services.store.db.prepare('SELECT payload FROM ai_settings').all())).not.toContain(secret);
    } finally { await cleanup(ctx); await provider.close(); }
  });

  it('uses an existing server environment reference after restart without overwriting or deleting it', async () => {
    const variable = `DODO_AI_TEST_INHERITED_${newId('env').replaceAll('-', '_').toUpperCase()}`;
    const original = process.env[variable], key = 'synthetic-inherited-env-credential';
    process.env[variable] = key;
    const provider = await providerFixture(key);
    let ctx = await launch({ trust: 'trusted', configPort: 0 });
    try {
      let owner = ownerApi(ctx);
      const saved = await data<SavedConnection>(await owner.post('connection', { connection: connection(provider.baseUrl, variable) }));
      expect(envFiles(ctx)).toHaveLength(0);
      expect((await owner.post('models', { connectionId: saved.id })).status).toBe(200);
      const restartOptions = { fixtureDir: ctx.fixtureDir, configDir: ctx.configDir, port: ctx.port, trust: 'trusted' as const, configPort: 0 };
      await ctx.cleanup(); ctx = await launch(restartOptions); owner = ownerApi(ctx);
      expect((await owner.post('models', { connectionId: saved.id })).status).toBe(200);
      expect((await data<State>(await owner.state())).connections[0]).toMatchObject({ credentialPresent: true, credentialEnvVar: variable });
      delete process.env[variable];
      expect((await data<State>(await owner.state())).connections[0]).toMatchObject({ credentialPresent: false });
      const rotated = 'synthetic-inherited-env-replacement';
      process.env[variable] = rotated;
      expect((await data<State>(await owner.state())).connections[0]).toMatchObject({ credentialPresent: false });
      const callsBefore = provider.calls.length;
      expect((await owner.post('models', { connectionId: saved.id })).status).toBe(401);
      expect(provider.calls).toHaveLength(callsBefore);
      await data(await owner.post('connection', { connection: saved }));
      provider.setKey(rotated);
      expect((await owner.post('models', { connectionId: saved.id })).status).toBe(200);
      expect(envFiles(ctx)).toHaveLength(0);
      await data(await owner.post('remove', { kind: 'connection', id: saved.id, confirmId: saved.id }));
      expect(process.env[variable]).toBe(rotated); expect(envFiles(ctx)).toHaveLength(0);
      expect(provider.calls.every(item => item.authorized)).toBe(true);
    } finally {
      await cleanup(ctx); await provider.close();
      if (original === undefined) delete process.env[variable]; else process.env[variable] = original;
    }
  });

  it('enforces the owner capability, reviewed epoch and variable validation before writing permanent keys', async () => {
    const key = 'synthetic-owner-env-credential', provider = await providerFixture(key);
    const ctx = await launch({ trust: 'trusted', configPort: 0 });
    try {
      const owner = ownerApi(ctx), body = { connection: connection(provider.baseUrl), apiKey: key };
      const token = await obtainToken(ctx);
      expect((await owner.post('connection', body, { authorization: '' })).status).toBe(401);
      expect((await owner.post('connection', body, { authorization: `Bearer ${token.accessToken}` })).status).toBe(401);
      expect((await owner.post('connection', body, { 'x-dodo-epoch': 'old-review' })).status).toBe(409);
      for (const credentialEnvVar of ['../outside', 'BAD\nNAME', 'PATH']) {
        const response = await owner.post('connection', { ...body, connection: { ...body.connection, credentialEnvVar } });
        expect(response.status).toBe(400); expect(await response.text()).not.toContain(key);
      }
      expect(envFiles(ctx)).toHaveLength(0); expect(provider.calls).toHaveLength(0);
      expect((await rfetch(`${ctx.baseUrl}/api/ai/connection`, { method: 'POST', headers: { authorization: `Bearer ${token.accessToken}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })).status).toBe(404);
      const state = await data<State>(await owner.state()); expect(state.connections).toEqual([]);
    } finally { await cleanup(ctx); await provider.close(); }
  });
});
