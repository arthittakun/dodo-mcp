import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectRegistry } from '../../src/projects/registry.js';
import { ProviderInput } from '../../src/services/ai/contracts.js';
import { CreativeProvider } from '../../src/services/multimodal/creativeProvider.js';
import type { CreativeJobData } from '../../src/services/multimodal/creativeService.js';
import { assertOk, tool } from '../helpers/multimodal.js';
import { launch, obtainToken, type TestContext, type TokenSet } from '../helpers/testServer.js';

const MiB = 1024 * 1024;
const KEY = 'synthetic-image-edit-safety-credential';

describe('paid image edit preflight and serialization', () => {
  let ctx: TestContext, token: TokenSet, providerServer: http.Server, baseUrl: string, image: Buffer;
  const requests: Array<{ headers: http.IncomingHttpHeaders; bytes: Buffer }> = [];
  const call = (args: Record<string, unknown>) => tool(ctx, token.accessToken, 'image_edit', args);
  const counts = () => {
    const db = ctx.server.services.store.db;
    return {
      jobs: (db.prepare('SELECT COUNT(*) AS n FROM creative_jobs').get() as { n: number }).n,
      reservations: (db.prepare('SELECT COUNT(*) AS n FROM creative_output_reservations').get() as { n: number }).n,
    };
  };
  const input = (key: string) => ({ images: [{ path: 'canvas.png' }], mask: { path: 'mask.png' }, prompt: 'Replace only the editable region', model: 'fixture-image', idempotencyKey: key });

  beforeAll(async () => {
    image = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#137e90' } }).png().toBuffer();
    providerServer = http.createServer((req, res) => {
      void (async () => {
        const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk as Buffer));
        requests.push({ headers: req.headers, bytes: Buffer.concat(chunks) });
        res.setHeader('content-type', 'application/json');
        if (req.url !== '/v1/images/edits' || req.headers.authorization !== `Bearer ${KEY}`) { res.statusCode = 400; res.end('{}'); return; }
        res.end(JSON.stringify({ data: [{ b64_json: image.toString('base64') }] }));
      })().catch(() => { res.statusCode = 500; res.end('{}'); });
    });
    await new Promise<void>(resolve => providerServer.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(providerServer.address() as { port: number }).port}/v1`;
    ctx = await launch({ toolSurface: 'full', trust: 'trusted', limitsPatch: { readFileBytes: 16 * MiB } });
    fs.writeFileSync(path.join(ctx.fixtureDir, 'canvas.png'), image);
    new ProjectRegistry(ctx.server.services.store).add(ctx.fixtureDir, 'Image edit safety fixture');
    token = await obtainToken(ctx);
    const settings = ctx.server.services.installation!.ai.settings;
    const connection = await settings.saveConnection({ name: 'Synthetic edit fixture', provider: 'custom', protocol: 'responses', baseUrl, allowPrivateNetwork: true, credentialStorage: 'env' }, KEY);
    settings.saveMedia({ connectionId: connection.id, imageModel: 'fixture-image' });
  });
  beforeEach(() => requests.splice(0));
  afterAll(async () => {
    await ctx?.cleanup();
    if (providerServer) await new Promise<void>(resolve => { providerServer.close(() => resolve()); providerServer.closeAllConnections(); });
  });

  it.each(['rgb-png', 'opaque-rgba', 'partial-alpha', 'jpeg', 'broken-png'])('rejects %s masks before creating a job or contacting the provider', async kind => {
    const before = counts();
    let mask: Buffer;
    if (kind === 'broken-png') mask = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    else {
      const source = sharp({ create: { width: 64, height: 64, channels: kind === 'rgb-png' || kind === 'jpeg' ? 3 : 4, background: { r: 255, g: 255, b: 255, alpha: kind === 'partial-alpha' ? 0.5 : 1 } } });
      mask = await (kind === 'jpeg' ? source.jpeg() : source.png()).toBuffer();
    }
    fs.writeFileSync(path.join(ctx.fixtureDir, 'mask.png'), mask);
    const result = await call(input(`edit-invalid-${kind}`));
    expect(result.envelope.error).toMatchObject({ code: 'INVALID_INPUT' });
    expect(requests).toHaveLength(0); expect(counts()).toEqual(before);
  });

  it('rejects a transparent mask with different dimensions before submission', async () => {
    const before = counts();
    fs.writeFileSync(path.join(ctx.fixtureDir, 'mask.png'), await sharp({ create: { width: 32, height: 64, channels: 4, background: '#ffffff00' } }).png().toBuffer());
    expect((await call(input('edit-mask-size'))).envelope.error).toMatchObject({ code: 'INVALID_INPUT' });
    expect(requests).toHaveLength(0); expect(counts()).toEqual(before);
  });

  it('allows the same key after correcting a mask, then submits four references and one mask only once', async () => {
    const args = { ...input('edit-correct-mask'), images: Array.from({ length: 4 }, () => ({ path: 'canvas.png' })) };
    fs.writeFileSync(path.join(ctx.fixtureDir, 'mask.png'), image);
    expect((await call(args)).envelope.error).toMatchObject({ code: 'INVALID_INPUT' });
    expect(requests).toHaveLength(0);
    // An explicit alpha-zero region is editable; retain an opaque region too.
    const pixels = Buffer.alloc(64 * 64 * 4, 255);
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) pixels[(y * 64 + x) * 4 + 3] = 0;
    fs.writeFileSync(path.join(ctx.fixtureDir, 'mask.png'), await sharp(pixels, { raw: { width: 64, height: 64, channels: 4 } }).png().toBuffer());
    let job = assertOk(await call(args)) as CreativeJobData;
    const id = job.jobId;
    for (let n = 0; n < 100 && ['queued', 'running'].includes(job.status); n++) {
      await new Promise(resolve => setTimeout(resolve, 20));
      job = assertOk(await tool(ctx, token.accessToken, 'creative_job', { jobId: id })) as CreativeJobData;
    }
    expect(job.status, job.error ?? '').toBe('completed'); expect(job.kind).toBe('image_edit');
    expect(requests).toHaveLength(1);
    const uploaded = requests[0]!;
    expect(uploaded.headers['content-type']).toMatch(/^multipart\/form-data; boundary=dodo-/);
    expect(uploaded.bytes.toString().match(/name="image\[\]";/g)).toHaveLength(4);
    const marker = Buffer.from('name="mask"; filename="mask.png"\r\nContent-Type: image/png\r\n\r\n');
    const start = uploaded.bytes.indexOf(marker) + marker.length, end = uploaded.bytes.indexOf('\r\n--dodo-', start);
    expect(start).toBeGreaterThan(marker.length);
    const sentMask = sharp(uploaded.bytes.subarray(start, end));
    expect((await sentMask.metadata()).hasAlpha).toBe(true);
    expect((await sentMask.stats()).channels.at(-1)?.min).toBe(0);
    expect(assertOk(await call(args))).toMatchObject({ jobId: id, replayed: true });
    expect(requests).toHaveLength(1);
  });

  it('enforces the combined normalized budget before jobs, leases or provider requests', async () => {
    const before = counts(), settings = ctx.server.services.installation!.ai.settings;
    const noise = await sharp(randomBytes(2048 * 1536 * 3), { raw: { width: 2048, height: 1536, channels: 3 } }).png().toBuffer();
    expect(noise.length).toBeGreaterThan(8 * MiB); expect(noise.length).toBeLessThan(16 * MiB);
    fs.writeFileSync(path.join(ctx.fixtureDir, 'noise.png'), noise);
    const lease = vi.spyOn(settings, 'lease');
    try {
      const result = await call({ images: [{ path: 'noise.png' }, { path: 'noise.png' }], prompt: 'Compare these references', model: 'fixture-image', idempotencyKey: 'edit-input-budget' });
      expect(result.envelope.error).toMatchObject({ code: 'RESOURCE_LIMIT' });
      expect(lease).not.toHaveBeenCalled(); expect(counts()).toEqual(before); expect(requests).toHaveLength(0);
    } finally { lease.mockRestore(); }
    const provider = new CreativeProvider({ ...ProviderInput.parse({ name: 'Synthetic direct fixture', provider: 'custom', protocol: 'responses', baseUrl, allowPrivateNetwork: true }), id: 'ai_directfixture' }, KEY, []);
    await expect(provider.editImage({ images: [noise, noise], prompt: 'Compare', model: 'fixture-image', size: 'auto', quality: 'auto', background: 'auto' })).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' });
    expect(requests).toHaveLength(0);
  });
});
