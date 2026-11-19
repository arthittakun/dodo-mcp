import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { launch, obtainToken, callToolLegacy, type TestContext, type TokenSet } from '../helpers/testServer.js';
import { assertOk } from '../helpers/multimodal.js';
import { TOOL_CATALOG } from '../../src/tools/catalog.js';
import { invokeToolDefinition, type Principal } from '../../src/tools/context.js';
import type { CreativeJobData } from '../../src/services/multimodal/creativeService.js';
import { CreativeService } from '../../src/services/multimodal/creativeService.js';
import { CreativeProvider } from '../../src/services/multimodal/creativeProvider.js';
import { CreativeArtifacts } from '../../src/services/multimodal/creativeArtifacts.js';
import { RESOURCE_STORE_MAX_BYTES } from '../../src/services/resources/casStore.js';
import { actorKey, MediaStorage } from '../../src/services/multimodal/storage.js';
import { newId } from '../../src/util/hash.js';
import { ResourceService } from '../../src/services/resources/resourceService.js';
import { providerFailure } from '../../src/services/multimodal/creativeDiagnostics.js';

const KEY = 'synthetic-reliability-key';
const MP4 = Buffer.from('000000186674797069736f6d0000020069736f6d6d703432', 'hex');
describe('creative paid-output reliability', () => {
  let ctx: TestContext, token: TokenSet, connectionId: string, server: http.Server, png: Buffer;
  const state = { mode: 'ok', delay: 0, posts: 0, video: 0, contents: 0 };
  const call = (name: string, args: Record<string, unknown>) => callToolLegacy(ctx, token.accessToken, name, args);
  const settings = () => ctx.server.services.installation!.ai.settings;
  const global = () => ctx.server.services.installation!.globalServices();
  const job = (result: Awaited<ReturnType<typeof call>>) => assertOk(result) as CreativeJobData;
  async function waitFor(check: () => boolean) { for (let n = 0; n < 300; n++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('fixture condition did not settle'); }
  async function collect(id: string) {
    for (let n = 0; n < 300; n++) {
      const value = job(await call('creative_job', { jobId: id }));
      if (['completed', 'failed', 'uncertain', 'stopped'].includes(value.status)) return value;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('fixture render did not finish');
  }
  beforeAll(async () => {
    png = await sharp({ create: { width: 10, height: 8, channels: 4, background: '#2255aa80' } }).png().toBuffer();
    server = http.createServer(async (req, res) => {
      for await (const _chunk of req) { /* consume the bounded fixture body */ }
      if (req.headers.authorization !== `Bearer ${KEY}`) { res.writeHead(401).end('{}'); return; }
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/models') { res.end(JSON.stringify({ data: [{ id: 'fixture-image' }] })); return; }
      if (req.url === '/v1/images/generations' || req.url === '/v1/images/edits') {
        state.posts++; if (state.delay) await new Promise(resolve => setTimeout(resolve, state.delay));
        if (state.mode === 'rate' || state.mode === 'quota') {
          res.writeHead(429, { 'retry-after': '3', 'x-request-id': 'req_fixture_123' });
          res.end(JSON.stringify({ error: { code: state.mode === 'quota' ? 'insufficient_quota' : 'rate_limit_exceeded', message: `Fixture ${state.mode} ${KEY} https://private.example/secret` } })); return;
        }
        if (state.mode === 'reset') { req.socket.destroy(); return; }
        res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] })); return;
      }
      if (req.url === '/v1/videos' && req.method === 'POST') { state.video++; res.end(JSON.stringify({ id: `video_${state.video}`, status: 'queued', progress: 0 })); return; }
      if (req.url?.endsWith('/content')) { state.contents++; res.setHeader('content-type', 'video/mp4'); res.end(MP4); return; }
      if (req.url?.startsWith('/v1/videos/')) { res.end(JSON.stringify({ id: req.url.split('/').at(-1), status: 'completed', progress: 100 })); return; }
      res.writeHead(404).end('{}');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    ctx = await launch({ deferWorkspace: true, toolSurface: 'full', configPort: 0, trust: 'trusted' });
    connectionId = (await settings().saveConnection({ name: 'Reliability fixture', provider: 'custom', protocol: 'responses', baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, allowPrivateNetwork: true }, KEY)).id;
    settings().saveMedia({ connectionId, imageModel: 'fixture-image', videoEnabled: true, videoModel: 'fixture-video' });
    token = await obtainToken(ctx, { grantWorkspaceAccess: false });
  });
  afterAll(async () => { await ctx?.cleanup(); await new Promise<void>(resolve => { server?.close(() => resolve()); server?.closeAllConnections(); }); });
  beforeEach(() => { state.mode = 'ok'; state.delay = 0; });

  it('retains rate/quota diagnostics without secrets and does not retry paid requests', async () => {
    for (const mode of ['rate', 'quota']) {
      state.mode = mode; const before = state.posts;
      const started = job(await call('image_generate', { prompt: 'diagnostic fixture', idempotencyKey: `reliable-${mode}` }));
      const output = await collect(started.jobId);
      expect(output.status).toBe('failed'); expect(output.error).toBe(mode === 'rate' ? 'RATE_LIMITED' : 'QUOTA_EXCEEDED');
      expect(output.diagnostics).toMatchObject({ httpStatus: 429, requestId: 'req_fixture_123', retryAfterMs: 3000, outcome: 'rejected', retryable: mode === 'rate' });
      expect(JSON.stringify(output)).not.toContain(KEY); expect(JSON.stringify(output)).not.toContain('private.example');
      expect(state.posts).toBe(before + 1);
    }
  });

  it('stores an accepted image when the submission token expires, while collection still requires current authority', async () => {
    state.delay = 2500;
    const principal: Principal = { grantId: token.grantId, clientId: token.clientId, sub: 'owner', scopes: ['dodo:read', 'dodo:write', 'dodo:exec'], tokenScopes: ['dodo:read', 'dodo:write', 'dodo:exec'], identityGrant: true, expiresAt: Date.now() / 1000 + 1.5 };
    const result = await invokeToolDefinition({ def: TOOL_CATALOG.find(tool => tool.name === 'image_generate')!, services: ctx.server.services, principal: () => principal, args: { prompt: 'token expiry output fixture', idempotencyKey: 'reliable-token-expiry' } });
    expect(result.envelope.ok).toBe(true);
    const started = result.envelope.data as CreativeJobData, output = await collect(started.jobId);
    expect(output.status).toBe('completed'); expect(output.resource?.mimeType).toBe('image/png');
  });

  it('does not widen detached job authority when the original grant is revoked during rendering', async () => {
    const other = await obtainToken(ctx, { grantWorkspaceAccess: false }); state.delay = 400;
    const started = job(await callToolLegacy(ctx, other.accessToken, 'image_generate', { prompt: 'revoked grant fixture', idempotencyKey: 'reliable-revoked-grant' }));
    ctx.server.services.store.revokeGrant(other.grantId);
    await new Promise(resolve => setTimeout(resolve, 700));
    const row = global().store.db.prepare('SELECT payload FROM creative_jobs WHERE id=?').get(started.jobId) as { payload: string };
    expect(JSON.parse(row.payload)).toMatchObject({ status: 'uncertain', error: 'AUTH_REQUIRED', resource: null });
    expect((global().store.db.prepare('SELECT COUNT(*) AS n FROM resource_refs WHERE source_label=?').get(started.jobId) as { n: number }).n).toBe(0);
    expect((await call('creative_job', { jobId: started.jobId })).envelope.error).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rejects insufficient output capacity before a provider POST', async () => {
    const hash = `sha256:${'e'.repeat(64)}`, db = global().store.db;
    const used = db.prepare('SELECT COALESCE(SUM(bytes),0) AS n FROM resource_objects').get() as { n: number };
    const amount = RESOURCE_STORE_MAX_BYTES - used.n - 1024;
    db.prepare('INSERT INTO resource_objects(hash,bytes,created_at,verified_at) VALUES(?,?,?,?)').run(hash, amount, Date.now(), Date.now());
    const before = state.posts;
    try { const result = await call('image_generate', { prompt: 'capacity fixture', idempotencyKey: 'reliable-full-storage' }); expect(result.envelope.error).toMatchObject({ code: 'RESOURCE_LIMIT' }); expect(state.posts).toBe(before); }
    finally { db.prepare('DELETE FROM resource_objects WHERE hash=?').run(hash); }
    const source = db.prepare('SELECT * FROM resource_refs WHERE workspace_id=? AND principal=? LIMIT 1').get(global().workspaceId, actorKey(token)) as Record<string, unknown>;
    const count = (db.prepare('SELECT COUNT(*) AS n FROM resource_refs WHERE workspace_id=? AND principal=? AND expires_at>?').get(global().workspaceId, actorKey(token), Date.now()) as { n: number }).n;
    const ids: string[] = [];
    try {
      for (let n = count; n < 512; n++) { const id = newId('res'); ids.push(id); db.prepare('INSERT INTO resource_refs VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id, source.workspace_id, source.principal, source.object_hash, source.mime_type, source.source_kind, 'capacity-fixture', source.capabilities, source.metadata, Date.now(), Date.now() + 60000); }
      expect((await call('image_generate', { prompt: 'reference capacity fixture', idempotencyKey: 'reliable-full-references' })).envelope.error).toMatchObject({ code: 'RESOURCE_LIMIT' });
      expect(state.posts).toBe(before);
    } finally { for (const id of ids) db.prepare('DELETE FROM resource_refs WHERE id=?').run(id); }
  });

  it('terminal history does not consume render slots and active jobs are not silently expired', async () => {
    const s = global(), db = s.store.db, now = Date.now();
    const template = { kind: 'image', status: 'failed', model: 'fixture-image', progress: 0, resource: null, error: 'fixture', createdAt: now, expiresAt: now + 86400000, note: 'synthetic retained history', epoch: s.epoch, connectionId, configuration: 'fixture' };
    for (let n = 0; n < 35; n++) { const id = newId('creative'); db.prepare('INSERT INTO creative_jobs VALUES(?,?,?,?,?,?)').run(id, s.workspaceId, actorKey(token), JSON.stringify({ ...template, jobId: id }), now, now + 86400000); }
    const pending = newId('creative'); db.prepare('INSERT INTO creative_jobs VALUES(?,?,?,?,?,?)').run(pending, s.workspaceId, actorKey(token), JSON.stringify({ ...template, jobId: pending, status: 'running', expiresAt: 1 }), now, 1);
    s.multimodal!.creative.sweep(); expect(db.prepare('SELECT 1 FROM creative_jobs WHERE id=?').get(pending)).toBeTruthy();
    const started = job(await call('image_generate', { prompt: 'after retained history fixture', idempotencyKey: 'reliable-history-capacity' }));
    expect((await collect(started.jobId)).status).toBe('completed');
    db.prepare('DELETE FROM creative_jobs WHERE id=?').run(pending);
  });

  it('reconciles finished uncollected video slots and keeps original jobs collectible after cosmetic/default changes', async () => {
    const first = job(await call('video_generate', { prompt: 'video one fixture', idempotencyKey: 'reliable-video-one' }));
    const second = job(await call('video_generate', { prompt: 'video two fixture', idempotencyKey: 'reliable-video-two' }));
    await new Promise(resolve => setTimeout(resolve, 100));
    const current = settings().connection(connectionId); await settings().saveConnection({ ...current, name: 'Renamed fixture' }); settings().saveMedia({ imageModel: 'different-image-default' });
    const third = job(await call('video_generate', { prompt: 'video three fixture', idempotencyKey: 'reliable-video-three' }));
    const db = global().store.db;
    db.prepare(`UPDATE creative_jobs SET expires_at=1,payload=json_set(payload,'$.createdAt',?,'$.expiresAt',1) WHERE id=?`).run(Date.now() - 2 * 86400000, first.jobId);
    expect((await collect(first.jobId)).status).toBe('completed'); expect((await collect(second.jobId)).status).toBe('completed'); expect((await collect(third.jobId)).status).toBe('completed');
    const stored = db.prepare('SELECT expires_at FROM creative_jobs WHERE id=?').get(first.jobId) as { expires_at: number };
    expect(stored.expires_at).toBeGreaterThan(Date.now() + 23 * 3600000);
    global().multimodal!.creative.sweep(); expect(db.prepare('SELECT 1 FROM creative_jobs WHERE id=?').get(first.jobId)).toBeTruthy();
    settings().saveMedia({ imageModel: 'fixture-image' });
  });

  it('keeps cleanup failures retryable without breaking the server or leaving live metadata for unlinked objects', async () => {
    const s = global(), resource = s.resources!, db = s.store.db;
    const orphan = await resource.cas.ingestBuffer(Buffer.from('unreferenced retryable GC fixture'));
    db.prepare('UPDATE resource_objects SET verified_at=0 WHERE hash=?').run(orphan.hash);
    const remove = vi.spyOn(resource.cas, 'removeObject').mockImplementationOnce(() => { throw Object.assign(new Error('fixture locked file'), { code: 'EACCES' }); });
    expect(() => resource.gc()).toThrow();
    expect(db.prepare('SELECT 1 FROM resource_gc_queue WHERE hash=?').get(orphan.hash)).toBeTruthy();
    expect(db.prepare('SELECT 1 FROM resource_objects WHERE hash=?').get(orphan.hash)).toBeUndefined();
    expect(fs.existsSync(orphan.path)).toBe(true); remove.mockRestore();
    resource.gc(); expect(fs.existsSync(orphan.path)).toBe(false); expect(db.prepare('SELECT 1 FROM resource_gc_queue WHERE hash=?').get(orphan.hash)).toBeUndefined();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const maintenance = new ResourceService(s, ctx.configDir, resource.cas.objectsDir, resource.cas.stagingDir, s.store.installSecret());
    const gc = vi.spyOn(maintenance, 'gc').mockImplementationOnce(() => { throw new Error('fixture cleanup error'); });
    try { expect(() => vi.advanceTimersByTime(15 * 60000)).not.toThrow(); expect(gc).toHaveBeenCalledTimes(1); }
    finally { maintenance.close(); vi.useRealTimers(); gc.mockRestore(); }
    expect((await call('multimodal_status', {})).envelope.ok).toBe(true);
  });

  it('redacts credential-looking request IDs and provider error codes as well as message values', () => {
    const error = providerFailure(429, Buffer.from(JSON.stringify({ error: { code: 'sk-other-private-key', message: 'Bearer another-secret https://private.example/path' } })), { 'x-request-id': 'sk-other-private-key' }, [KEY]);
    expect(error.detail?.providerCode).toBeUndefined(); expect(error.detail?.requestId).toBeUndefined(); expect(JSON.stringify(error.toInfo())).not.toContain('private.example'); expect(JSON.stringify(error.toInfo())).not.toContain('other-private-key');
  });

  it('recovers a complete output blob published before its manifest', async () => {
    const s = global(), id = newId('creative'), artifacts = new CreativeArtifacts(ctx.configDir);
    artifacts.write(s.workspaceId, actorKey(token), id, png, 'image/png', { format: 'png' });
    fs.unlinkSync(path.join(ctx.configDir, 'creative-output', id, 'receipt.json'));
    const recovered = artifacts.read(s.workspaceId, actorKey(token), id, 'image/png');
    expect(recovered?.bytes).toEqual(png); expect(fs.existsSync(path.join(ctx.configDir, 'creative-output', id, 'receipt.json'))).toBe(true);
    artifacts.remove(id);
  });

  it('cleans an interrupted private stage so a save retry can publish the same output', () => {
    const id = newId('creative'), artifacts = new CreativeArtifacts(ctx.configDir);
    const sync = vi.spyOn(fs, 'fsyncSync').mockImplementationOnce(() => { throw new Error('fixture sync failure'); });
    try { expect(() => artifacts.write(global().workspaceId, actorKey(token), id, png, 'image/png', {})).toThrow('fixture sync failure'); }
    finally { sync.mockRestore(); }
    artifacts.write(global().workspaceId, actorKey(token), id, png, 'image/png', {});
    expect(artifacts.read(global().workspaceId, actorKey(token), id)?.bytes).toEqual(png);
    expect(fs.readdirSync(path.join(ctx.configDir, 'creative-output', id)).some(name => name.endsWith('.part'))).toBe(false);
    artifacts.remove(id);
  });

  it('keeps stopped tracking authoritative after an in-flight submission settles', async () => {
    state.delay = 500; const before = state.posts;
    const started = job(await call('image_generate', { prompt: 'stopped in-flight fixture', idempotencyKey: 'reliable-stop-submission' }));
    await waitFor(() => state.posts > before);
    expect(job(await call('creative_job_control', { jobId: started.jobId, action: 'stop_tracking' })).status).toBe('stopped');
    await new Promise(resolve => setTimeout(resolve, 700));
    expect(job(await call('creative_job', { jobId: started.jobId }))).toMatchObject({ status: 'stopped', error: 'CANCELED' });
    expect(state.posts).toBe(before + 1);
  });

  it('honors another service stopping a queued job before its provider dispatch', async () => {
    const s = global(), other = new CreativeService(new MediaStorage(s, ctx.configDir)), before = state.posts;
    const original = CreativeProvider.prototype.generateImage;
    let release!: () => void, settled!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), done = new Promise<void>(resolve => { settled = resolve; });
    const generate = vi.spyOn(CreativeProvider.prototype, 'generateImage').mockImplementationOnce(async function (this: CreativeProvider, ...args) { await gate; try { return await original.apply(this, args); } finally { settled(); } });
    try {
      const started = job(await call('image_generate', { prompt: 'cross-service pre-send stop fixture', idempotencyKey: 'reliable-cross-service-stop' }));
      await waitFor(() => generate.mock.calls.length === 1);
      const principal: Principal = { grantId: token.grantId, clientId: token.clientId, sub: 'owner', scopes: ['dodo:read', 'dodo:write', 'dodo:exec'], tokenScopes: ['dodo:read', 'dodo:write', 'dodo:exec'], identityGrant: true };
      expect((await other.control({ services: s, principal, trustMode: 'trusted' }, { jobId: started.jobId, action: 'stop_tracking' })).status).toBe('stopped');
      release(); await done;
      expect(job(await call('creative_job', { jobId: started.jobId })).status).toBe('stopped'); expect(state.posts).toBe(before);
    } finally { release(); generate.mockRestore(); await other.close(); }
  });

  it('serializes simultaneous output recovery and preserves a stop during delayed finalization', async () => {
    const s = global(), started = job(await call('video_generate', { prompt: 'serialized recovery fixture', idempotencyKey: 'reliable-stop-collection' }));
    await waitFor(() => Boolean((s.store.db.prepare(`SELECT json_extract(payload,'$.remoteId') AS id FROM creative_jobs WHERE id=?`).get(started.jobId) as { id?: string }).id));
    const resource = s.resources!, original = resource.ingestGenerated.bind(resource), before = state.contents;
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const ingest = vi.spyOn(resource, 'ingestGenerated').mockImplementationOnce(async (...args) => { const saved = await original(...args); await gate; return saved; });
    try {
      const first = call('creative_job_control', { jobId: started.jobId, action: 'retry_save' });
      const second = call('creative_job_control', { jobId: started.jobId, action: 'retry_save' });
      const report = call('creative_job', { jobId: started.jobId });
      await waitFor(() => ingest.mock.calls.length === 1);
      expect(job(await call('creative_job_control', { jobId: started.jobId, action: 'stop_tracking' })).status).toBe('stopped');
      release();
      const outputs = await Promise.all([first, second, report]);
      for (const output of outputs) expect(job(output)).toMatchObject({ status: 'stopped', error: 'CANCELED' });
      const final = job(await call('creative_job', { jobId: started.jobId })); expect(final.status).toBe('stopped'); expect(final.resource?.mimeType).toBe('video/mp4');
      expect(state.contents).toBe(before + 1); expect(ingest).toHaveBeenCalledTimes(1);
      expect((s.store.db.prepare('SELECT COUNT(*) AS n FROM resource_refs WHERE source_label=?').get(started.jobId) as { n: number }).n).toBe(1);
    } finally { release(); ingest.mockRestore(); }
  });

  it('keeps aged recoverable output discoverable and finalizes it without another paid request', async () => {
    const s = global(), db = s.store.db, id = newId('creative'), artifacts = new CreativeArtifacts(ctx.configDir), before = state.posts;
    const old = db.prepare(`SELECT owner,payload FROM creative_jobs WHERE workspace_id=? AND owner=? AND json_extract(payload,'$.kind')='image' LIMIT 1`).get(s.workspaceId, actorKey(token)) as { owner: string; payload: string };
    const value = { ...JSON.parse(old.payload), jobId: id, status: 'uncertain', resource: null, completedAt: 1, expiresAt: 1, error: 'STORAGE_UNAVAILABLE' };
    db.prepare('INSERT INTO creative_jobs VALUES(?,?,?,?,?,?)').run(id, s.workspaceId, old.owner, JSON.stringify(value), Date.now(), 1);
    db.prepare('INSERT INTO creative_output_reservations VALUES(?,?,?,?,?)').run(id, s.workspaceId, old.owner, 64 * 1024 * 1024, Date.now());
    artifacts.write(s.workspaceId, old.owner, id, png, 'image/png', { format: 'png' });
    s.multimodal!.creative.sweep();
    const listing = assertOk(await call('creative_jobs', {})) as { jobs: CreativeJobData[] }; expect(listing.jobs.some(entry => entry.jobId === id)).toBe(true);
    const output = job(await call('creative_job_control', { jobId: id, action: 'retry_save' })); expect(output.status).toBe('completed'); expect(output.resource?.mimeType).toBe('image/png'); expect(state.posts).toBe(before); expect(output.expiresAt).toBeGreaterThan(Date.now() + 23 * 3600000);
  });

  it('retries terminal private-artifact cleanup before removing expired job metadata', () => {
    const s = global(), db = s.store.db, id = newId('creative'), artifacts = new CreativeArtifacts(ctx.configDir);
    const old = db.prepare('SELECT owner,payload FROM creative_jobs WHERE workspace_id=? AND owner=? LIMIT 1').get(s.workspaceId, actorKey(token)) as { owner: string; payload: string };
    db.prepare('INSERT INTO creative_jobs VALUES(?,?,?,?,?,?)').run(id, s.workspaceId, old.owner, JSON.stringify({ ...JSON.parse(old.payload), jobId: id, status: 'stopped', expiresAt: 1 }), 1, 1);
    artifacts.write(s.workspaceId, old.owner, id, png, 'image/png', {});
    const directory = path.join(ctx.configDir, 'creative-output', id); fs.writeFileSync(path.join(directory, `output.bin.${process.pid}.part`), 'stale', { mode: 0o600 });
    const remove = vi.spyOn(CreativeArtifacts.prototype, 'remove').mockImplementationOnce(() => { throw new Error('fixture locked private output'); });
    s.multimodal!.creative.sweep(); expect(db.prepare('SELECT 1 FROM creative_jobs WHERE id=?').get(id)).toBeTruthy(); expect(fs.existsSync(directory)).toBe(true); remove.mockRestore();
    s.multimodal!.creative.sweep(); expect(db.prepare('SELECT 1 FROM creative_jobs WHERE id=?').get(id)).toBeUndefined(); expect(fs.existsSync(directory)).toBe(false);
  });

  it('keeps durable artifacts and same-key receipts available through a restart after final receipt failure', async () => {
    const db = global().store.db;
    db.exec(`CREATE TRIGGER reliable_receipt_failure BEFORE UPDATE ON creative_jobs WHEN json_extract(new.payload,'$.status')='completed' BEGIN SELECT RAISE(FAIL,'synthetic final receipt failure'); END;`);
    const args = { prompt: 'durable receipt fixture', idempotencyKey: 'reliable-restart-receipt' }, before = state.posts;
    const started = job(await call('image_generate', args));
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(job(await call('creative_job', { jobId: started.jobId })).status).toBe('uncertain');
    expect(db.prepare('SELECT max_bytes FROM creative_output_reservations WHERE job_id=?').get(started.jobId)).toMatchObject({ max_bytes: 0 });
    db.prepare('UPDATE resource_refs SET expires_at=1 WHERE source_label=?').run(started.jobId);
    db.prepare(`UPDATE creative_jobs SET expires_at=1,payload=json_set(payload,'$.expiresAt',1) WHERE id=?`).run(started.jobId);
    global().resources!.gc(); global().multimodal!.creative.sweep();
    expect(db.prepare('SELECT 1 FROM resource_refs WHERE source_label=?').get(started.jobId)).toBeTruthy(); expect(db.prepare('SELECT 1 FROM creative_jobs WHERE id=?').get(started.jobId)).toBeTruthy();
    db.exec('DROP TRIGGER reliable_receipt_failure');
    const previous = ctx; await previous.cleanup();
    ctx = await launch({ deferWorkspace: true, toolSurface: 'full', configPort: 0, trust: 'trusted', fixtureDir: previous.fixtureDir, configDir: previous.configDir, port: previous.port });
    const replay = job(await call('image_generate', args)); expect(replay.jobId).toBe(started.jobId);
    const recovered = await collect(started.jobId); expect(recovered.status).toBe('completed'); expect(recovered.resource?.mimeType).toBe('image/png'); expect(state.posts).toBe(before + 1);
    const listing = assertOk(await call('creative_jobs', { idempotencyKey: args.idempotencyKey })) as { jobs: CreativeJobData[] };
    expect(listing.jobs[0]?.jobId).toBe(started.jobId);
  });
});
