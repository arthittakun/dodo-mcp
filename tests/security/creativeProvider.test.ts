import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import sharp from 'sharp';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ProviderInput, type Provider } from '../../src/services/ai/contracts.js';
import { CreativeProvider } from '../../src/services/multimodal/creativeProvider.js';

const key = 'synthetic-creative-test-credential';
const imageInput = { model: 'fixture-image', prompt: 'A blue circle', size: '1024x1024', quality: 'low' as const, background: 'transparent' as const };
const videoInput = { model: 'fixture-video', prompt: 'A blue circle moving slowly', size: '1280x720', seconds: 4 };
const mp4 = Buffer.from('000000186674797069736f6d0000020069736f6d69736f32', 'hex');
let png: Buffer;
const servers: http.Server[] = [];

async function fixture(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>) {
  const server = http.createServer((req, res) => { void handler(req, res); });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
}
function connection(baseUrl: string): Provider {
  return { ...ProviderInput.parse({ name: 'creative fixture', provider: 'custom', protocol: 'responses', baseUrl, allowPrivateNetwork: true }), id: 'ai_creativefixture' };
}
async function body(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk as Buffer)); return Buffer.concat(chunks);
}
function image(res: http.ServerResponse) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] })); }

beforeAll(async () => { png = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#0088ff80' } }).png().toBuffer(); });
afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
});

describe('bounded creative media provider', () => {
  it('generates one real PNG with fixed endpoint and bounded output settings', async () => {
    const captured: Array<{ path: string; auth: string | undefined; data: unknown }> = [];
    const url = await fixture(async (req, res) => { captured.push({ path: req.url!, auth: req.headers.authorization, data: JSON.parse((await body(req)).toString()) }); image(res); });
    const before = vi.fn(); const result = await new CreativeProvider(connection(url), key, []).generateImage(imageInput, undefined, before);
    expect(result.bytes.equals(png)).toBe(true); expect(result.mimeType).toBe('image/png'); expect(before).toHaveBeenCalledTimes(1);
    expect(captured).toEqual([{ path: '/v1/images/generations', auth: `Bearer ${key}`, data: { ...imageInput, n: 1, output_format: 'png' } }]);
  });

  it('uploads normalized PNG to image edits with explicit transparent-background instructions', async () => {
    let uploaded: Buffer | undefined, contentType: string | undefined;
    const url = await fixture(async (req, res) => { expect(req.url).toBe('/v1/images/edits'); contentType = req.headers['content-type']; uploaded = await body(req); image(res); });
    const output = await new CreativeProvider(connection(url), key, []).removeBackground({ model: 'fixture-image', image: png });
    expect(contentType).toMatch(/^multipart\/form-data; boundary=dodo-/);
    expect(uploaded!.includes(png)).toBe(true); expect(uploaded!.toString()).toContain('name="image[]"; filename="input.png"');
    expect(uploaded!.toString()).toContain('Remove only the background'); expect(uploaded!.toString()).toContain('name="background"\r\n\r\ntransparent');
    expect(output.bytes.equals(png)).toBe(true);
  });

  it('creates a video once then explicitly fetches the same job and bounded MP4 content', async () => {
    const paths: string[] = []; let fields = '';
    const url = await fixture(async (req, res) => {
      paths.push(req.url!);
      if (req.method === 'POST') { fields = (await body(req)).toString(); res.end(JSON.stringify({ id: 'video_fixture01', status: 'queued', progress: 0 })); }
      else if (req.url!.endsWith('/content')) { res.setHeader('content-type', 'video/mp4'); res.end(mp4); }
      else res.end(JSON.stringify({ id: 'video_fixture01', status: 'completed', progress: 100, url: 'https://untrusted.invalid/video.mp4' }));
    });
    const provider = new CreativeProvider(connection(url), key, []);
    const created = await provider.createVideo(videoInput);
    expect(created).toEqual({ id: 'video_fixture01', status: 'queued', progress: 0 });
    expect(paths).toEqual(['/v1/videos']); expect(fields).toContain('name="seconds"\r\n\r\n4');
    expect(await provider.videoStatus(created.id)).toEqual({ id: created.id, status: 'completed', progress: 100 });
    expect((await provider.videoContent(created.id)).equals(mp4)).toBe(true);
    expect(paths).toEqual(['/v1/videos', '/v1/videos/video_fixture01', '/v1/videos/video_fixture01/content']);
  });

  it('uploads exactly the selected PNG reference using the fixed input_reference field', async () => {
    let uploaded: Buffer | undefined, contentType: string | undefined;
    const url = await fixture(async (req, res) => {
      expect(req.method).toBe('POST'); expect(req.url).toBe('/v1/videos');
      contentType = req.headers['content-type']; uploaded = await body(req);
      res.end(JSON.stringify({ id: 'video_reference01', status: 'queued' }));
    });
    const before = vi.fn();
    const result = await new CreativeProvider(connection(url), key, []).createVideo({ ...videoInput, reference: png }, undefined, before);
    expect(result.id).toBe('video_reference01'); expect(before).toHaveBeenCalledTimes(1);
    expect(contentType).toMatch(/^multipart\/form-data; boundary=dodo-/);
    expect(uploaded!.includes(png)).toBe(true);
    expect(uploaded!.toString()).toContain('name="input_reference"; filename="input.png"');
    expect(uploaded!.toString()).not.toContain('name="image[]"');
    expect(uploaded!.toString()).not.toContain('referenceImageUrls');
    expect(uploaded!.toString()).toContain('name="seconds"\r\n\r\n4');
  });

  it('edits and extends an existing video via fixed JSON endpoints without remix or automatic follow-up calls', async () => {
    const captured: Array<{ path: string; auth: string | undefined; contentType: string | undefined; data: unknown }> = [];
    const url = await fixture(async (req, res) => {
      captured.push({ path: req.url!, auth: req.headers.authorization, contentType: req.headers['content-type'], data: JSON.parse((await body(req)).toString()) });
      res.end(JSON.stringify({ id: `video_derived${captured.length}`, status: 'queued' }));
    });
    const provider = new CreativeProvider(connection(url), key, []), before = vi.fn();
    expect(await provider.editVideo({ id: 'video_source01', prompt: 'Use warmer lighting' }, undefined, before)).toMatchObject({ id: 'video_derived1', status: 'queued' });
    expect(await provider.extendVideo({ id: 'video_source01', prompt: 'Continue the camera move', seconds: 8 }, undefined, before)).toMatchObject({ id: 'video_derived2', status: 'queued' });
    expect(before).toHaveBeenCalledTimes(2);
    expect(captured).toEqual([
      { path: '/v1/videos/edits', auth: `Bearer ${key}`, contentType: 'application/json', data: { video: { id: 'video_source01' }, prompt: 'Use warmer lighting' } },
      { path: '/v1/videos/extensions', auth: `Bearer ${key}`, contentType: 'application/json', data: { video: { id: 'video_source01' }, prompt: 'Continue the camera move', seconds: '8' } },
    ]);
  });

  it('refuses every retired official OpenAI video operation before DNS, hooks or HTTP effects', async () => {
    const lookup = vi.spyOn(dns, 'lookup').mockImplementation(() => { throw new Error('unexpected DNS effect'); });
    const insecure = vi.spyOn(http, 'request').mockImplementation(() => { throw new Error('unexpected HTTP effect'); });
    const secure = vi.spyOn(https, 'request').mockImplementation(() => { throw new Error('unexpected HTTPS effect'); });
    const before = vi.fn();
    for (const baseUrl of ['https://api.openai.com/v1', 'https://API.OPENAI.COM./v1']) {
      const provider = new CreativeProvider({ ...connection(baseUrl), provider: 'openai', allowPrivateNetwork: false }, key, []);
      const operations = [
        () => provider.createVideo(videoInput, undefined, before),
        () => provider.editVideo({ id: 'video_source01', prompt: 'A change' }, undefined, before),
        () => provider.extendVideo({ id: 'video_source01', prompt: 'Continue', seconds: 4 }, undefined, before),
        () => provider.videoStatus('video_source01', undefined, before),
        () => provider.videoContent('video_source01', undefined, before),
      ];
      for (const operation of operations) await expect(operation()).rejects.toMatchObject({ code: 'NOT_SUPPORTED', message: expect.stringContaining('retired on 2026-09-24') });
    }
    expect(lookup).not.toHaveBeenCalled(); expect(insecure).not.toHaveBeenCalled(); expect(secure).not.toHaveBeenCalled(); expect(before).not.toHaveBeenCalled();
  });

  it('validates reference uploads and owned-video ID syntax before any compatibility request', async () => {
    let calls = 0; const url = await fixture((_req, res) => { calls++; res.end(JSON.stringify({ id: 'video_fixture01', status: 'queued' })); });
    const provider = new CreativeProvider(connection(url), key, []), before = vi.fn();
    await expect(provider.createVideo({ ...videoInput, reference: Buffer.alloc(16 * 1024 * 1024 + 1) }, undefined, before)).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' });
    await expect(provider.createVideo({ ...videoInput, reference: Buffer.from('<svg/>') }, undefined, before)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    for (const id of ['../models', 'video_x/content', 'video_x?key=bad', 'https://bad.invalid']) {
      await expect(provider.editVideo({ id, prompt: 'A change' }, undefined, before)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      await expect(provider.extendVideo({ id, prompt: 'Continue', seconds: 4 }, undefined, before)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
    await expect(provider.editVideo({ id: 'video_source01', prompt: ' ' }, undefined, before)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(provider.extendVideo({ id: 'video_source01', prompt: 'Continue', seconds: 0 }, undefined, before)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(calls).toBe(0); expect(before).not.toHaveBeenCalled();
  });

  it('does not follow provider-selected image URLs or video IDs containing paths', async () => {
    let destinationCalls = 0; const target = await fixture((_req, res) => { destinationCalls++; image(res); });
    let calls = 0; const url = await fixture((_req, res) => { calls++; res.end(JSON.stringify({ data: [{ url: target }] })); });
    const provider = new CreativeProvider(connection(url), key, []);
    await expect(provider.generateImage(imageInput)).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
    for (const id of ['../models', 'video_x/content', 'video_x?key=bad', 'https://bad.invalid']) {
      await expect(provider.videoStatus(id)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      await expect(provider.videoContent(id)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
    expect(calls).toBe(1); expect(destinationCalls).toBe(0);
  });

  it('refuses redirects without forwarding credentials or reissuing a generation', async () => {
    let forwarded = 0; const target = await fixture((_req, res) => { forwarded++; image(res); });
    let calls = 0; const url = await fixture((_req, res) => { calls++; res.writeHead(307, { location: target }); res.end(); });
    const before = vi.fn();
    await expect(new CreativeProvider(connection(url), key, []).generateImage(imageInput, undefined, before)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(calls).toBe(1); expect(forwarded).toBe(0); expect(before).toHaveBeenCalledTimes(1);
  });

  it('sanitizes non-success responses, malformed output and escaped credential echoes without retry', async () => {
    let count = 0;
    const url = await fixture((_req, res) => {
      count++;
      if (count === 1) { res.writeHead(429); res.end(`${key} https://private-provider.invalid`); }
      else if (count === 2) res.end('{bad json');
      else res.end(JSON.stringify({ data: [], secret: key }).replace(JSON.stringify(key), `"${[...key].map(c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join('')}"`));
    });
    const provider = new CreativeProvider(connection(url), key, []);
    await expect(provider.generateImage(imageInput)).rejects.toThrow('HTTP 429'); expect(count).toBe(1);
    await expect(provider.generateImage(imageInput)).rejects.toMatchObject({ code: 'NOT_SUPPORTED' }); expect(count).toBe(2);
    await expect(provider.generateImage(imageInput)).rejects.toMatchObject({ code: 'FORBIDDEN' }); expect(count).toBe(3);
  });

  it('rejects oversized declared responses without retaining unbounded data', async () => {
    let calls = 0;
    const url = await fixture((_req, res) => {
      calls++;
      if (calls === 1) { res.setHeader('content-length', String(24 * 1024 * 1024 + 1)); res.flushHeaders(); }
      else { res.setHeader('content-length', String(64 * 1024 * 1024 + 1)); res.flushHeaders(); }
    });
    const provider = new CreativeProvider(connection(url), key, []);
    await expect(provider.generateImage(imageInput)).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' });
    await expect(provider.videoContent('video_fixture01')).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' }); expect(calls).toBe(2);
  });

  it('denies private/reserved/mixed DNS and DODO ports before an HTTP effect', async () => {
    let calls = 0; const url = await fixture((_req, res) => { calls++; image(res); }); const before = vi.fn();
    const port = Number(new URL(url).port);
    expect(() => new CreativeProvider(connection(url), key, [port])).toThrow('DODO control');
    await expect(new CreativeProvider({ ...connection(url), baseUrl: url.replace('http:', 'https:'), allowPrivateNetwork: false }, key, []).generateImage(imageInput, undefined, before)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    for (const ip of ['169.254.169.254', '100.100.100.200', '224.0.0.1']) {
      await expect(new CreativeProvider(connection(`http://${ip}/v1`), key, []).generateImage(imageInput, undefined, before)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    vi.spyOn(dns, 'lookup').mockResolvedValue([{ address: '1.1.1.1', family: 4 }, { address: '127.0.0.1', family: 4 }] as never);
    await expect(new CreativeProvider({ ...connection('https://provider.fixture/v1'), allowPrivateNetwork: false }, key, []).generateImage(imageInput, undefined, before)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(before).not.toHaveBeenCalled(); expect(calls).toBe(0);
  });

  it('pins the reviewed DNS lookup result and does not resolve independently on the socket', async () => {
    const url = await fixture((_req, res) => image(res)); const port = new URL(url).port;
    const lookup = vi.spyOn(dns, 'lookup').mockResolvedValue([{ address: '127.0.0.1', family: 4 }] as never);
    const result = await new CreativeProvider(connection(`http://provider.fixture:${port}/v1`), key, []).generateImage(imageInput);
    expect(result.bytes.equals(png)).toBe(true); expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('cancels before send or during a request without automatic retries', async () => {
    let calls = 0; const url = await fixture((_req, res) => { calls++; res.write(' '); });
    const provider = new CreativeProvider(connection(url), key, []); const before = vi.fn();
    const stopped = new AbortController(); stopped.abort();
    await expect(provider.generateImage(imageInput, stopped.signal, before)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(before).not.toHaveBeenCalled(); expect(calls).toBe(0);
    const controller = new AbortController(); const pending = provider.generateImage(imageInput, controller.signal, before);
    setTimeout(() => controller.abort(), 30);
    await expect(pending).rejects.toMatchObject({ code: 'CONFLICT' }); expect(calls).toBe(1); expect(before).toHaveBeenCalledTimes(1);
  });

  it('cancels an unfinished DNS lookup before any HTTP effect', async () => {
    vi.spyOn(dns, 'lookup').mockImplementation(() => new Promise(() => undefined));
    const provider = new CreativeProvider(connection('https://provider.fixture/v1'), key, []);
    const controller = new AbortController(), before = vi.fn();
    const pending = provider.generateImage(imageInput, controller.signal, before);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'CONFLICT' }); expect(before).not.toHaveBeenCalled();
  });

  it('rejects noncanonical base64, wrong raster output and mismatched video jobs', async () => {
    let calls = 0;
    const url = await fixture((_req, res) => {
      calls++;
      if (calls === 1) res.end(JSON.stringify({ data: [{ b64_json: `${png.toString('base64')}garbage` }] }));
      else if (calls === 2) res.end(JSON.stringify({ data: [{ b64_json: Buffer.from('<svg/>').toString('base64') }] }));
      else if (calls === 3) res.end(JSON.stringify({ id: 'video_other', status: 'completed' }));
      else res.end('{"error":"bad video output"}');
    });
    const provider = new CreativeProvider(connection(url), key, []);
    await expect(provider.generateImage(imageInput)).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
    await expect(provider.generateImage(imageInput)).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
    await expect(provider.videoStatus('video_fixture01')).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
    await expect(provider.videoContent('video_fixture01')).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
    expect(calls).toBe(4);
  });

  it('validates protocol, key, upload and options before calling the provider', async () => {
    let calls = 0; const url = await fixture((_req, res) => { calls++; image(res); });
    expect(() => new CreativeProvider({ ...connection(url), protocol: 'anthropic' }, key, [])).toThrow('OpenAI-compatible');
    expect(() => new CreativeProvider(connection(url), '', [])).toThrow('API key');
    expect(() => new CreativeProvider(connection(url), 'bad\r\nheader', [])).toThrow('credential');
    const provider = new CreativeProvider(connection(url), key, []);
    await expect(provider.generateImage({ ...imageInput, prompt: ' ' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(provider.generateImage({ ...imageInput, size: '100000x100000' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(provider.removeBackground({ model: 'fixture-image', image: Buffer.alloc(16 * 1024 * 1024 + 1) })).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' });
    await expect(provider.removeBackground({ model: 'fixture-image', image: Buffer.from('fake image') })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(provider.createVideo({ ...videoInput, seconds: 1000 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(calls).toBe(0);
  });
});
