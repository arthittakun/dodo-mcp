import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ResourceChunk, ResourceInfo } from '../../src/services/resources/contracts.js';
import type { AnimationJobData } from '../../src/services/multimodal/animationContracts.js';
import { assertOk, blocks, tool } from '../helpers/multimodal.js';
import { launch, obtainToken, type TestContext, type TokenSet } from '../helpers/testServer.js';

/**
 * Real renders need a Python with Pillow and pydantic. Point DODO_TEST_ANIMATION_PYTHON at one
 * (for example the Gift project's .venv) to run them; the readiness checks always run.
 */
const PYTHON = process.env['DODO_TEST_ANIMATION_PYTHON'];
const renders = PYTHON ? describe : describe.skip;

describe('local Gift animation engine through the MCP pipeline', () => {
  let ctx: TestContext, token: TokenSet, other: TokenSet;
  const previous = process.env['DODO_ANIMATION_PYTHON'];
  const call = (name: string, args: Record<string, unknown>, accessToken = token.accessToken) => tool(ctx, accessToken, name, args);
  const job = (result: Awaited<ReturnType<typeof call>>) => assertOk(result) as AnimationJobData & { replayed?: boolean };
  const error = (result: Awaited<ReturnType<typeof call>>, code: string) => { expect(result.isError).toBe(true); expect(result.envelope.error).toMatchObject({ code }); };
  async function bytesOf(resource: unknown): Promise<Buffer> {
    const info = ResourceInfo.parse(resource), parts: Buffer[] = [];
    for (let offset: number | null = 0; offset !== null;) {
      const chunk = ResourceChunk.parse(assertOk(await call('resource_read_range', { resourceId: info.resourceId, offset, length: 256 * 1024 })));
      parts.push(Buffer.from(chunk.data, 'base64')); offset = chunk.eof ? null : chunk.nextOffset;
    }
    return Buffer.concat(parts);
  }

  beforeAll(async () => {
    if (PYTHON) process.env['DODO_ANIMATION_PYTHON'] = PYTHON; else delete process.env['DODO_ANIMATION_PYTHON'];
    ctx = await launch({ toolSurface: 'full', trust: 'trusted' });
    // A soft orange ball with a dark outline on a transparent canvas.
    const ball = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240"><circle cx="120" cy="120" r="80" fill="#f39b3f" stroke="#3a2414" stroke-width="6"/></svg>`;
    fs.writeFileSync(path.join(ctx.fixtureDir, 'ball.png'), await sharp(Buffer.from(ball)).png().toBuffer());
    // Eight distinct poses: a figure whose arm rises across a 4x2 transparent sheet.
    const cells = Array.from({ length: 8 }, (_, i) => {
      const x = (i % 4) * 120, y = Math.floor(i / 4) * 160;
      return `<g transform="translate(${x},${y})"><rect x="40" y="50" width="40" height="70" rx="10" fill="#137e90"/><circle cx="60" cy="38" r="22" fill="#fbc984"/>`
        + `<line x1="78" y1="62" x2="100" y2="${40 + i * 6}" stroke="#eea56e" stroke-width="10"/><rect x="42" y="112" width="15" height="24" fill="#8b3c60"/><rect x="63" y="112" width="15" height="24" fill="#8b3c60"/></g>`;
    }).join('');
    fs.writeFileSync(path.join(ctx.fixtureDir, 'sheet.png'), await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="480" height="320">${cells}</svg>`)).png().toBuffer());
    token = await obtainToken(ctx); other = await obtainToken(ctx);
  });
  afterAll(async () => {
    if (previous === undefined) delete process.env['DODO_ANIMATION_PYTHON']; else process.env['DODO_ANIMATION_PYTHON'] = previous;
    await ctx?.cleanup();
  });

  it('lists bundled presets, effects and sticker formats and reports readiness honestly', async () => {
    const catalog = assertOk(await call('animation_catalog', {})) as { ready: boolean; engine: { verified: boolean }; presets: Array<{ name: string }>; formats: Array<{ format: string }>; python: { available: boolean } };
    expect(catalog.engine.verified).toBe(true);
    expect(catalog.presets.map(p => p.name)).toEqual(['orange_cat', 'orange_cat_ik', 'orange_cat_idle', 'orange_cat_jump', 'fox_girl_idle', 'fox_girl_bounce', 'fox_girl_jump']);
    expect(catalog.formats.map(f => f.format)).toEqual(expect.arrayContaining(['gif', 'webp', 'line', 'telegram', 'spritesheet']));
    expect(catalog.python.available).toBe(Boolean(PYTHON)); expect(catalog.ready).toBe(Boolean(PYTHON));
  });

  it('refuses to render without a configured Python and keeps the idempotency key reusable', async () => {
    const saved = process.env['DODO_ANIMATION_PYTHON'];
    delete process.env['DODO_ANIMATION_PYTHON'];
    try { error(await call('animation_rig', { preset: 'orange_cat_idle', duration: 1, fps: 20, idempotencyKey: 'anim-no-python' }), 'NOT_SUPPORTED'); }
    finally { if (saved !== undefined) process.env['DODO_ANIMATION_PYTHON'] = saved; }
  });

  it('validates inputs before starting a job', async () => {
    error(await call('animation_rig', { duration: 1, idempotencyKey: 'anim-no-rig' }), 'INVALID_INPUT');
    error(await call('animation_image', { actions: ['float'], idempotencyKey: 'anim-no-source' }), 'INVALID_INPUT');
    // Out-of-range values never reach the handler: the strict input schema rejects them.
    expect((await call('animation_image', { path: 'ball.png', actions: ['float'], fps: 90, idempotencyKey: 'anim-bad-fps' })).isError).toBe(true);
  });

  renders('real renders', () => {
    it('renders the fox-girl preset with loop-review checks, a preview, replay and a journaled save', async () => {
      const args = { preset: 'fox_girl_idle', format: 'gif', duration: 1, fps: 20, maxSide: 300, idempotencyKey: 'anim-fox-idle' };
      const response = await call('animation_rig', args), data = job(response);
      expect(data.status, data.error ?? '').toBe('completed');
      expect(data.animation).toMatchObject({ mimeType: 'image/gif', source: { kind: 'generated' }, metadata: { provider: 'gift', format: 'gif' } });
      expect(data.details).toMatchObject({ frames: 20, durationMs: 1000 });
      expect(Math.max(data.details!.width, data.details!.height)).toBeLessThanOrEqual(300);
      expect(data.checks.map(c => c.id)).toEqual(expect.arrayContaining(['loop_seam', 'part_seams']));
      expect(data.passed).toBe(true);
      expect(blocks(response).some(block => block.type === 'image' && Boolean(block.data))).toBe(true);
      const gif = await bytesOf(data.animation);
      expect(gif.subarray(0, 6).toString('ascii')).toBe('GIF89a');
      const replay = job(await call('animation_rig', args));
      expect(replay.jobId).toBe(data.jobId); expect(replay.replayed).toBe(true);
      error(await call('animation_job', { jobId: data.jobId }, other.accessToken), 'NOT_FOUND');
      const info = ResourceInfo.parse(data.animation);
      error(await call('media_save', { resourceId: info.resourceId, expectedSha256: info.sha256, path: 'out/fox.png', idempotencyKey: 'anim-save-wrong-ext' }), 'INVALID_INPUT');
      assertOk(await call('media_save', { resourceId: info.resourceId, expectedSha256: info.sha256, path: 'out/fox.gif', idempotencyKey: 'anim-save-gif' }));
      expect(fs.readFileSync(path.join(ctx.fixtureDir, 'out/fox.gif'))).toEqual(gif);
    }, 240_000);

    it('animates a workspace still with a Thai caption as WebP', async () => {
      const data = job(await call('animation_image', { path: 'ball.png', actions: ['jelly'], format: 'webp', duration: 1, fps: 20, caption: { text: 'น่ารัก' }, idempotencyKey: 'anim-ball-jelly' }));
      expect(data.status, data.error ?? '').toBe('completed');
      expect(data.animation).toMatchObject({ mimeType: 'image/webp' });
      const webp = await bytesOf(data.animation);
      expect(webp.subarray(8, 12).toString('ascii')).toBe('WEBP');
      expect((await sharp(webp, { animated: true }).metadata()).pages).toBe(20);
    }, 240_000);

    it('assembles a pose sheet into a LINE sticker within LINE limits', async () => {
      const data = job(await call('animation_sprite', { path: 'sheet.png', motion: 'wave', format: 'line', idempotencyKey: 'anim-sheet-line' }));
      expect(data.status, data.error ?? '').toBe('completed');
      expect(data.animation).toMatchObject({ mimeType: 'image/png' });
      expect(data.details!.width).toBeLessThanOrEqual(320); expect(data.details!.height).toBeLessThanOrEqual(270);
      expect(data.details!.bytes).toBeLessThan(1_000_000);
    }, 240_000);

    it('makes a Thai neon banner without a browser', async () => {
      const data = job(await call('animation_banner', { text: 'เปิดให้บริการ 24 ชั่วโมง', label: 'ONLINE', motion: 'pulse', width: 400, height: 120, duration: 1, fps: 20, idempotencyKey: 'anim-banner' }));
      expect(data.status, data.error ?? '').toBe('completed');
      expect(data.animation).toMatchObject({ mimeType: 'image/gif', metadata: { width: 400, height: 120 } });
      expect(data.details).toMatchObject({ frames: 20 });
      error(await call('animation_banner', { text: ' ', label: '', idempotencyKey: 'anim-banner-empty' }), 'INVALID_INPUT');
    }, 240_000);

    it('composes scenes: the Solar System preset and an animated layer walking across a background', async () => {
      const solar = job(await call('animation_scene', { preset: 'solar_system', width: 320, height: 180, duration: 1, fps: 20, idempotencyKey: 'anim-solar' }));
      expect(solar.status, solar.error ?? '').toBe('completed');
      expect(solar.details).toMatchObject({ width: 320, height: 180, frames: 20 });
      const walker = job(await call('animation_image', { path: 'ball.png', actions: ['bounce'], format: 'gif', duration: 1, fps: 20, maxSide: 160, idempotencyKey: 'anim-walker' }));
      const sky = await sharp({ create: { width: 320, height: 180, channels: 3, background: '#8fc7ff' } }).png().toBuffer();
      fs.writeFileSync(path.join(ctx.fixtureDir, 'sky.png'), sky);
      const walk = job(await call('animation_scene', {
        background: { path: 'sky.png' }, width: 320, height: 180, duration: 2, fps: 20,
        layers: [{ image: { resourceId: walker.animation!.resourceId }, x: -0.2, y: 0.6, endX: 1.2, width: 0.3, animationLoops: 2 }],
        idempotencyKey: 'anim-walk-scene',
      }));
      expect(walk.status, walk.error ?? '').toBe('completed');
      expect(walk.details).toMatchObject({ width: 320, height: 180, frames: 40 });
      // The layer starts off-canvas and crosses the middle: the middle of the sky changes over the clip.
      const gif = await bytesOf(walk.animation);
      const frames = await sharp(gif, { animated: true }).raw().toBuffer({ resolveWithObject: true });
      const frameBytes = 320 * 180 * frames.info.channels, at = (frame: number) => frames.data.subarray(frame * frameBytes, (frame + 1) * frameBytes);
      expect(Buffer.compare(at(0), at(20))).not.toBe(0);
      error(await call('animation_scene', { preset: 'solar_system', layers: [{ image: { path: 'ball.png' } }], idempotencyKey: 'anim-scene-both' }), 'INVALID_INPUT');
    }, 240_000);

    it('relays the engine’s own rig validation as a failed job, not a crash', async () => {
      const part = { name: 'arm', polygon: [[0.1, 0.1], [0.5, 0.1], [0.5, 0.5]], root: [0.3, 0.3], tip: [0.3, 0.3], motion: 'wave' };
      const data = job(await call('animation_rig', { rig: { parts: [part] }, path: 'ball.png', duration: 1, fps: 20, idempotencyKey: 'anim-bad-rig' }));
      expect(data.status).toBe('failed'); expect(data.error).toMatch(/different root and tip/);
      expect(data.animation).toBeNull();
    }, 240_000);
  });
});
