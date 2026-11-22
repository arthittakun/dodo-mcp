import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ProjectRegistry } from '../../src/projects/registry.js';
import { CreativeProvider } from '../../src/services/multimodal/creativeProvider.js';
import type { CreativeJobData } from '../../src/services/multimodal/creativeService.js';
import type { AnimationJobData } from '../../src/services/multimodal/animationContracts.js';
import { ResourceChunk, ResourceInfo } from '../../src/services/resources/contracts.js';
import { assertOk, blocks, tool } from '../helpers/multimodal.js';
import { launch, obtainToken, type TestContext, type TokenSet } from '../helpers/testServer.js';

/** Frame-by-frame drawing: plan locally, draw with a (mocked) image model, check and assemble. */
const PYTHON = process.env['DODO_TEST_ANIMATION_PYTHON'];
const live = PYTHON ? describe : describe.skip;
const HERO = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="420">
  <rect x="78" y="160" width="84" height="150" rx="18" fill="#137e90" stroke="#2a1a10" stroke-width="5"/>
  <circle cx="120" cy="98" r="58" fill="#fbc984" stroke="#2a1a10" stroke-width="5"/>
  <rect x="82" y="300" width="32" height="104" rx="10" fill="#8b3c60" stroke="#2a1a10" stroke-width="5"/>
  <rect x="126" y="300" width="32" height="104" rx="10" fill="#8b3c60" stroke="#2a1a10" stroke-width="5"/></svg>`;

live('animation_frames_plan → image_edit → animation_sprite', () => {
  let ctx: TestContext, token: TokenSet;
  const previous = process.env['DODO_ANIMATION_PYTHON'];
  const call = (name: string, args: Record<string, unknown>) => tool(ctx, token.accessToken, name, args);
  const error = (result: Awaited<ReturnType<typeof call>>, code: string) => { expect(result.isError).toBe(true); expect(result.envelope.error).toMatchObject({ code }); };
  async function read(resource: unknown): Promise<Buffer> {
    const info = ResourceInfo.parse(resource), parts: Buffer[] = [];
    for (let offset: number | null = 0; offset !== null;) {
      const chunk = ResourceChunk.parse(assertOk(await call('resource_read_range', { resourceId: info.resourceId, offset, length: 256 * 1024 })));
      parts.push(Buffer.from(chunk.data, 'base64')); offset = chunk.eof ? null : chunk.nextOffset;
    }
    return Buffer.concat(parts);
  }
  /** What a well-behaved model returns: the guide's cell-1 character repeated with the arm moving. */
  async function drawnSheet(guide: Buffer, layout: { cells: number[][]; sheet: number[] }): Promise<Buffer> {
    const [width, height] = layout.sheet as [number, number];
    const [left, top, right, bottom] = layout.cells[0] as [number, number, number, number];
    const character = await sharp(guide).extract({ left, top, width: right - left, height: bottom - top }).png().toBuffer();
    const layers = await Promise.all(layout.cells.map(async (cell, index) => {
      const angle = [0, 25, 50, 75, 95, 75, 50, 25][index]! * Math.PI / 180;
      const [cx, cy] = [(right - left) / 2 + 20, (bottom - top) * 0.52];
      const arm = `<svg xmlns="http://www.w3.org/2000/svg" width="${right - left}" height="${bottom - top}"><line x1="${cx}" y1="${cy}" x2="${cx + 120 * Math.cos(-angle)}" y2="${cy + 120 * Math.sin(-angle)}" stroke="#137e90" stroke-width="30" stroke-linecap="round"/></svg>`;
      const pose = await sharp(character).composite([{ input: Buffer.from(arm) }]).png().toBuffer();
      return { input: pose, left: cell[0]!, top: cell[1]! };
    }));
    return sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite(layers).png().toBuffer();
  }

  beforeAll(async () => {
    process.env['DODO_ANIMATION_PYTHON'] = PYTHON;
    ctx = await launch({ toolSurface: 'full', trust: 'trusted' });
    fs.writeFileSync(path.join(ctx.fixtureDir, 'hero.png'), await sharp(Buffer.from(HERO)).png().toBuffer());
    new ProjectRegistry(ctx.server.services.store).add(ctx.fixtureDir, 'Frames fixture');
    token = await obtainToken(ctx);
    const installation = ctx.server.services.installation!, settings = installation.ai.settings;
    const projectId = installation.list(installation.owner()).find(p => p.workspaceId === ctx.server.workspaceId)!.projectId;
    const connectionId = (await settings.saveConnection({ name: 'Frames fixture', provider: 'custom', protocol: 'responses', baseUrl: 'https://media-fixture.example/v1' }, 'fixture-media-credential')).id;
    settings.savePermission({ projectId, profileIds: [], allowedClientIds: [token.clientId] });
    settings.saveMedia({ enabled: true, connectionId, projectIds: [projectId], imageModel: 'fixture-image', allowImageUpload: false });
  });
  afterAll(async () => {
    if (previous === undefined) delete process.env['DODO_ANIMATION_PYTHON']; else process.env['DODO_ANIMATION_PYTHON'] = previous;
    await ctx?.cleanup();
  });
  afterEach(() => vi.restoreAllMocks());

  it('plans, draws one conditioned sheet, checks it against the plan and assembles the loop', async () => {
    const planned = assertOk(await call('animation_frames_plan', { path: 'hero.png', motion: 'wave', idempotencyKey: 'frames-plan-wave' })) as AnimationJobData;
    expect(planned.status, planned.error ?? '').toBe('completed');
    const plan = planned.plan!;
    expect(plan.size).toBe('1536x1024');
    expect(plan.prompt).toContain('Cell 8:');
    expect(plan.layout).toMatchObject({ poses: 8, columns: 4, rows: 2, motion: 'wave' });
    const guide = await read(plan.guide), mask = await read(plan.mask);
    expect(await sharp(guide).metadata()).toMatchObject({ width: 1536, height: 1024 });
    expect((await sharp(mask).metadata()).hasAlpha).toBe(true);

    // A mask that does not match the first image is refused before anything is sent.
    error(await call('image_edit', { images: [{ resourceId: plan.guide.resourceId }], mask: { path: 'hero.png' }, prompt: plan.prompt, idempotencyKey: 'frames-edit-bad-mask' }), 'INVALID_INPUT');

    const sheet = await drawnSheet(guide, plan.layout as { cells: number[][]; sheet: number[] });
    const edit = vi.spyOn(CreativeProvider.prototype, 'editImage').mockImplementation(async (_input, _signal, beforeSend) => { beforeSend?.(); return { bytes: sheet, mimeType: 'image/png' }; });
    const args = { images: [{ resourceId: plan.guide.resourceId }, { path: 'hero.png' }], mask: { resourceId: plan.mask.resourceId }, prompt: plan.prompt, size: plan.size, background: 'transparent', idempotencyKey: 'frames-edit-wave' };
    const started = assertOk(await call('image_edit', args)) as CreativeJobData;
    let job = started;
    for (let attempt = 0; attempt < 100 && job.status !== 'completed'; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 20));
      job = assertOk(await call('creative_job', { jobId: started.jobId })) as CreativeJobData;
    }
    expect(job.status).toBe('completed');
    expect(job.kind).toBe('image_edit');
    const sent = edit.mock.calls[0]![0];
    expect(sent.images).toHaveLength(2);
    expect(sent.mask).toBeInstanceOf(Buffer);
    expect(sent).toMatchObject({ model: 'fixture-image', prompt: plan.prompt, size: '1536x1024', background: 'transparent' });
    expect((assertOk(await call('image_edit', args)) as CreativeJobData & { replayed: boolean }).replayed).toBe(true);
    expect(edit).toHaveBeenCalledTimes(1);

    error(await call('animation_sprite', { resourceId: job.resource!.resourceId, motion: 'walk', layout: plan.layout, idempotencyKey: 'frames-sprite-mismatch' }), 'INVALID_INPUT');
    const response = await call('animation_sprite', {
      resourceId: job.resource!.resourceId, motion: 'wave', poses: 8, layout: plan.layout, reference: { path: 'hero.png' },
      format: 'gif', maxSide: 320, idempotencyKey: 'frames-sprite-wave',
    });
    const assembled = assertOk(response) as AnimationJobData;
    expect(assembled.status, assembled.error ?? '').toBe('completed');
    expect(assembled.checks.map(check => check.id)).toEqual(expect.arrayContaining(['one_figure_per_cell', 'consistent_size', 'ground_line', 'same_character', 'distinct_poses']));
    expect(assembled.passed, JSON.stringify(assembled.checks)).toBe(true);
    expect(assembled.details).toMatchObject({ frames: 8 });
    expect(blocks(response).some(block => block.type === 'image')).toBe(true);
  }, 240_000);

  it('flags a drawn sheet that breaks the plan instead of assembling it silently', async () => {
    const planned = assertOk(await call('animation_frames_plan', { path: 'hero.png', motion: 'wave', idempotencyKey: 'frames-plan-wave-2' })) as AnimationJobData;
    const plan = planned.plan!;
    const guide = await read(plan.guide);
    // Every cell redrawn in a different colour scheme: the model lost the character.
    const recoloured = await sharp(await drawnSheet(guide, plan.layout as { cells: number[][]; sheet: number[] })).modulate({ hue: 150 }).png().toBuffer();
    fs.writeFileSync(path.join(ctx.fixtureDir, 'recoloured.png'), recoloured);
    const result = assertOk(await call('animation_sprite', {
      path: 'recoloured.png', motion: 'wave', poses: 8, layout: plan.layout, reference: { path: 'hero.png' }, format: 'gif', maxSide: 200, idempotencyKey: 'frames-sprite-recoloured',
    })) as AnimationJobData;
    expect(result.status).toBe('completed');
    expect(result.passed).toBe(false);
    expect(result.checks.find(check => check.id === 'same_character')?.status).toBe('fail');
    expect(result.notes.join(' ')).toContain('missed some conditions');
  }, 240_000);
});
