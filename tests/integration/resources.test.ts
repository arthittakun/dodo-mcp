import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import sharp from 'sharp';
import { launch, obtainToken, type TestContext, type TokenSet } from '../helpers/testServer.js';
import { tool, assertOk, blocks } from '../helpers/multimodal.js';
import { ResourceChunk, ResourceExtract, ResourceInfo, ResourcePreview } from '../../src/services/resources/contracts.js';
import { TOOL_CATALOG } from '../../src/tools/catalog.js';

function wavFixture(): Buffer {
  const samples = Buffer.alloc(1600 * 2);
  const out = Buffer.alloc(44 + samples.length);
  out.write('RIFF', 0); out.writeUInt32LE(out.length - 8, 4); out.write('WAVEfmt ', 8);
  out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22);
  out.writeUInt32LE(16000, 24); out.writeUInt32LE(32000, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34);
  out.write('data', 36); out.writeUInt32LE(samples.length, 40); samples.copy(out, 44);
  return out;
}

async function retryReset<T>(operation: () => Promise<T>, attempts = 4): Promise<T> {
  for (let index = 0; ; index += 1) {
    try { return await operation(); }
    catch (error) {
      const code = (error as { cause?: { code?: string }; code?: string }).cause?.code ?? (error as { code?: string }).code;
      if (index >= attempts || !['ECONNRESET', 'UND_ERR_SOCKET', 'ECONNREFUSED'].includes(code ?? '')) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100 * (index + 1)));
    }
  }
}

describe('Phase 04 universal resources over real HTTP + OAuth', () => {
  let ctx: TestContext;
  let token: TokenSet;
  beforeAll(async () => {
    ctx = await launch({ toolSurface: 'full', trust: 'trusted', fixtureFiles: {
      'note.txt': 'สวัสดี from DODO resource\n',
      'large.txt': '0123456789abcdef'.repeat(20_000),
      'empty.zip': Buffer.from('504b0506000000000000000000000000000000000000', 'hex').toString('latin1'),
      'document.pdf': '%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n',
    } });
    fs.writeFileSync(path.join(ctx.fixtureDir, 'picture.png'), await sharp({ create: { width: 640, height: 360, channels: 3, background: '#345678' } }).png().toBuffer());
    fs.writeFileSync(path.join(ctx.fixtureDir, 'speech.wav'), wavFixture());
    token = await obtainToken(ctx);
  });
  afterAll(async () => ctx?.cleanup());
  const call = (name: string, args: Record<string, unknown>) => tool(ctx, token.accessToken, name, args);

  it('adds six exact resource tools to the full surface and keeps one compact gateway family', async () => {
    expect(TOOL_CATALOG).toHaveLength(94);
    expect(TOOL_CATALOG.slice(-6).map((entry) => entry.name)).toEqual(['resource_inspect', 'resource_read', 'resource_read_range', 'resource_preview', 'resource_extract', 'resource_transform']);
  });

  it('ingests guarded UTF-8, deduplicates bytes and reads text with immutable identity', async () => {
    const first = ResourceInfo.parse(assertOk(await call('resource_inspect', { path: 'note.txt' })));
    const second = ResourceInfo.parse(assertOk(await call('resource_inspect', { path: 'note.txt', expectedSha256: first.sha256, expectedMimeType: 'text/plain' })));
    expect(first.resourceId).not.toBe(second.resourceId);
    expect(second).toMatchObject({ sha256: first.sha256, bytes: first.bytes, deduplicated: true, source: { kind: 'workspace', label: 'note.txt' } });
    const read = ResourceChunk.parse(assertOk(await call('resource_read', { resourceId: first.resourceId, expectedSha256: first.sha256 })));
    expect(read).toMatchObject({ encoding: 'utf8', data: 'สวัสดี from DODO resource\n', eof: true, nextOffset: null, resumeToken: null });
    expect(read.chunkSha256).toBe(first.sha256);
  });

  it('streams a large resource in bounded ranges and resumes with a principal-bound token', async () => {
    const resource = ResourceInfo.parse(assertOk(await call('resource_inspect', { path: 'large.txt' })));
    const first = ResourceChunk.parse(assertOk(await call('resource_read_range', { resourceId: resource.resourceId, length: 32 })));
    expect(Buffer.from(first.data, 'base64').toString()).toBe('0123456789abcdef0123456789abcdef');
    expect(first).toMatchObject({ eof: false, nextOffset: 32 });
    expect(first.resumeToken).toMatch(/^r1\./);
    const second = ResourceChunk.parse(assertOk(await call('resource_read_range', { cursor: first.resumeToken, length: 16 })));
    expect(second.range.start).toBe(32);
    expect(Buffer.from(second.data, 'base64').toString()).toBe('0123456789abcdef');
  });

  it('returns real image and audio MCP blocks and stores a bounded image transform', async () => {
    const image = ResourceInfo.parse(assertOk(await call('resource_inspect', { path: 'picture.png', expectedMimeType: 'image/png' })));
    expect(image.metadata).toMatchObject({ width: 640, height: 360, format: 'png' });
    const imageResult = await call('resource_preview', { resourceId: image.resourceId, maxEdge: 320 });
    const imagePreview = ResourcePreview.parse(assertOk(imageResult));
    expect(imagePreview).toMatchObject({ previewKind: 'image', width: 320, height: 180, previewMimeType: 'image/jpeg' });
    const imageBlock = blocks(imageResult).find((block) => block.type === 'image');
    expect(imageBlock?.mimeType).toBe('image/jpeg');
    expect((await sharp(Buffer.from(imageBlock!.data!, 'base64')).metadata()).width).toBe(320);

    const transformed = ResourceInfo.parse(assertOk(await call('resource_transform', { resourceId: image.resourceId, maxEdge: 160, expectedSha256: image.sha256 })));
    expect(transformed).toMatchObject({ mimeType: 'image/jpeg', source: { kind: 'transform', label: image.resourceId }, metadata: { width: 160, height: 90 } });

    const audio = ResourceInfo.parse(assertOk(await call('resource_inspect', { path: 'speech.wav' })));
    const audioResult = await call('resource_preview', { resourceId: audio.resourceId });
    expect(ResourcePreview.parse(assertOk(audioResult)).previewKind).toBe('audio');
    const audioBlock = blocks(audioResult).find((block) => block.type === 'audio');
    expect(Buffer.from(audioBlock!.data!, 'base64').subarray(0, 4).toString()).toBe('RIFF');
  });

  it('extracts deterministic text/archive/metadata without inflating or executing content', async () => {
    const text = ResourceInfo.parse(assertOk(await call('resource_inspect', { path: 'note.txt' })));
    expect(ResourceExtract.parse(assertOk(await call('resource_extract', { resourceId: text.resourceId }))).text).toContain('DODO resource');
    const archive = ResourceInfo.parse(assertOk(await call('resource_inspect', { path: 'empty.zip', expectedMimeType: 'application/zip' })));
    const extracted = ResourceExtract.parse(assertOk(await call('resource_extract', { resourceId: archive.resourceId, kind: 'archive_entries' })));
    expect(extracted).toMatchObject({ kind: 'archive_entries', entries: [], metadata: { totalEntries: 0 }, truncated: false });
    const pdf = ResourceInfo.parse(assertOk(await call('resource_inspect', { path: 'document.pdf' })));
    expect(pdf).toMatchObject({ mimeType: 'application/pdf', metadata: { format: 'pdf-1.4' } });
  });

  it('dispatches the same contracts through dodo_media in compact mode', async () => {
    const compact = await launch({ toolSurface: 'compact', trust: 'trusted', fixtureDir: ctx.fixtureDir });
    try {
      const compactToken = await obtainToken(compact);
      const gateway = (operation: string, args: Record<string, unknown>) => tool(compact, compactToken.accessToken, 'dodo_media', { operation, args });
      const resource = ResourceInfo.parse(assertOk(await gateway('resource_inspect', { path: 'note.txt' })));
      const read = ResourceChunk.parse(assertOk(await gateway('resource_read', { resourceId: resource.resourceId })));
      expect(read.data).toContain('DODO resource');
      const image = ResourceInfo.parse(assertOk(await gateway('resource_inspect', { path: 'picture.png' })));
      const preview = await gateway('resource_preview', { resourceId: image.resourceId, maxEdge: 160 });
      expect(ResourcePreview.parse(assertOk(preview)).previewKind).toBe('image');
      expect(blocks(preview).some((block) => block.type === 'image')).toBe(true);
      const detail = z.object({ operation: z.string(), gateway: z.string(), inputSchema: z.record(z.string(), z.unknown()) }).parse(assertOk(await tool(compact, compactToken.accessToken, 'dodo_discover', { operation: 'resource_read_range' })));
      expect(detail).toMatchObject({ operation: 'resource_read_range', gateway: 'dodo_media' });
    } finally { await compact.cleanup(); }
  });

  it('deduplicates concurrent ingest and keeps live references across a server restart', async () => {
    const resources = await Promise.all(Array.from({ length: 6 }, () => call('resource_inspect', { path: 'picture.png' }).then((result) => ResourceInfo.parse(assertOk(result)))));
    expect(new Set(resources.map((resource) => resource.sha256)).size).toBe(1);
    const hash = resources[0]!.sha256;
    const objectCount = ctx.server.services.store.db.prepare('SELECT COUNT(*) AS count FROM resource_objects WHERE hash=?').get(hash) as { count: number };
    expect(objectCount.count).toBe(1);

    const previousEpoch = ctx.server.epoch;
    const restart = { fixtureDir: ctx.fixtureDir, configDir: ctx.configDir, port: ctx.port };
    await ctx.cleanup();
    ctx = await launch({ ...restart, locked: true, toolSurface: 'full', trust: 'trusted' });
    expect(ctx.server.epoch).not.toBe(previousEpoch);
    const read = ResourceChunk.parse(assertOk(await retryReset(() => call('resource_read', { resourceId: resources[0]!.resourceId, expectedSha256: hash }))));
    expect(read.resource.sha256).toBe(hash);
    expect(fs.existsSync(ctx.server.services.resources!.cas.objectPath(hash))).toBe(true);
    expect(ctx.server.services.resources!.providers.list().map((provider) => provider.name)).toEqual([
      'builtin-utf8', 'sharp-raster', 'bounded-audio-block', 'zip-central-directory', 'metadata-only',
    ]);
  });
});
