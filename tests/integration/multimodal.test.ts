import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import sharp from 'sharp';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { launch, obtainToken, mkTmpDir, type TestContext, type TokenSet } from '../helpers/testServer.js';
import { tool, assertOk, blocks, BROWSER_FIXTURE } from '../helpers/multimodal.js';
import { MediaJobResult, AssetInfo, BrowserObservation, WorkflowRecord, Transcript } from '../../src/services/multimodal/contracts.js';
import { TOOL_CATALOG } from '../../src/tools/catalog.js';
import { surfaceCatalog } from '../../src/tools/surface.js';

const nativeAvailable = spawnSync('ffmpeg', ['-version'], { timeout: 10000, stdio: 'pipe' }).status === 0;
const browserAvailable = fs.existsSync(chromium.executablePath());
const model = path.resolve('models/ggml-tiny.bin');
const asrAvailable = nativeAvailable && fs.existsSync(model) && spawnSync('whisper-cli', ['--help'], { timeout: 10000, stdio: 'pipe' }).status === 0;
const Session = z.object({ sessionId: z.string(), observation: BrowserObservation });
const Run = z.object({ runId: z.string(), status: z.string(), stepIndex: z.number(), observation: BrowserObservation.nullable() });

function generateMedia(root: string) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=600:sample_rate=16000', '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path.join(root, 'sample.mp4')], { timeout: 30000, stdio: 'pipe' });
}
describe('real multimodal MCP media', () => {
  let ctx: TestContext, token: TokenSet, mediaId: string;
  beforeAll(async () => {
    ctx = await launch({ toolSurface: 'full',  trust: 'trusted', fixtureFiles: {
      'clip.srt': '1\n00:00:00,000 --> 00:00:01,500\nสวัสดี setting up\n\n2\n00:00:01,500 --> 00:00:03,000\nSave the project\n\n',
      'bad.mp4': 'not a valid video',
    } });
    if (nativeAvailable) generateMedia(ctx.fixtureDir);
    token = await obtainToken(ctx);
  });
  afterAll(async () => ctx?.cleanup());
  const call = (name: string, args: Record<string, unknown>) => tool(ctx, token.accessToken, name, args);
  async function completed(result: unknown) {
    let parsed = MediaJobResult.parse(result);
    for (let i = 0; i < 30 && parsed.status === 'running'; i++) parsed = MediaJobResult.parse(assertOk(await call('media_job', { jobId: parsed.jobId, waitMs: 10000 })));
    if (parsed.error) { const log = ctx.server.services.jobs.inlineOutput(parsed.jobId, ctx.server.workspaceId, 'stderr', 10000); throw new Error(`${parsed.error}: ${log.content}`); }
    expect(parsed.exitCode).toBe(0); return parsed;
  }
  it('status is read-only and advertises real capabilities without opening media or browser', async () => {
    const mm = ctx.server.services.multimodal!;
    const data = assertOk(await call('multimodal_status', {})) as { media: { ffmpeg: boolean }; modelCalls: boolean };
    expect(data.media.ffmpeg).toBe(nativeAvailable); expect(data.modelCalls).toBe(false);
    expect(mm.storage.directories.size).toBe(0); expect(mm.media.jobs.size).toBe(0);
  });
  it.skipIf(!nativeAvailable)('opens an immutable source and probes actual video/audio streams', async () => {
    const opened = z.object({ mediaId: z.string(), sourceHash: z.string(), job: MediaJobResult }).parse(assertOk(await call('media_open', { path: 'sample.mp4', idempotencyKey: 'mm-open-sample-001', waitMs: 10000 })));
    mediaId = opened.mediaId; const job = await completed(opened.job);
    expect(opened.sourceHash).toMatch(/^sha256:/); expect(job.metadata?.durationSec).toBeGreaterThanOrEqual(3);
    expect(job.metadata?.streams.map(s => s.type)).toEqual(expect.arrayContaining(['video', 'audio']));
    const repeat = assertOk(await call('media_open', { path: 'sample.mp4', idempotencyKey: 'mm-open-sample-001' })) as { mediaId: string; replayed: boolean };
    expect(repeat.mediaId).toBe(mediaId); expect(repeat.replayed).toBe(true);
  });
  it.skipIf(!nativeAvailable)('returns actual requested JPEG frames and original timestamps through image content blocks', async () => {
    const output = await completed(assertOk(await call('media_extract', { mediaId, kind: 'frames', times: [0.2, 1.5, 2.5], maxEdge: 640, waitMs: 10000, idempotencyKey: 'mm-frames-sample-001' })));
    expect(output.assets).toHaveLength(3); expect(output.assets.map(a => a.timeSec)).toEqual([0.2, 1.5, 2.5]);
    const read = await call('media_read', { assetId: output.assets[0]!.assetId }); assertOk(read);
    const image = blocks(read).find(b => b.type === 'image')!;
    expect(image.mimeType).toBe('image/jpeg'); expect((await sharp(Buffer.from(image.data!, 'base64')).metadata()).width).toBe(640);
  });
  it.skipIf(!nativeAvailable)('extracts actual playable WAV bytes as an MCP audio block', async () => {
    const output = await completed(assertOk(await call('media_extract', { mediaId, kind: 'audio', startSec: 0, durationSec: 2, waitMs: 10000, idempotencyKey: 'mm-audio-sample-001' })));
    const read = await call('media_read', { assetId: output.assets[0]!.assetId }); assertOk(read);
    const audio = blocks(read).find(b => b.type === 'audio')!;
    const bytes = Buffer.from(audio.data!, 'base64'); expect(bytes.subarray(0, 4).toString()).toBe('RIFF'); expect(bytes.subarray(8, 12).toString()).toBe('WAVE'); expect(bytes.length).toBeGreaterThan(50000);
  });
  it.skipIf(!nativeAvailable)('searches Thai subtitles with honest provenance and paged timestamps', async () => {
    const attached = z.object({ asset: AssetInfo }).parse(assertOk(await call('media_subtitles', { mediaId, path: 'clip.srt', language: 'th' })));
    const result = assertOk(await call('media_search', { assetId: attached.asset.assetId, query: 'สวัสดี' })) as { source: string; matches: Array<{ startSec: number }> };
    expect(result.source).toBe('sidecar_subtitles'); expect(result.matches[0]?.startSec).toBe(0);
    const read = assertOk(await call('media_read', { assetId: attached.asset.assetId, limit: 1 })) as { nextOffset: number; transcript: unknown };
    expect(read.nextOffset).toBe(1); expect(Transcript.parse(read.transcript).segments).toHaveLength(1);
  });
  it.skipIf(!nativeAvailable)('reports decoder failures and out-of-range frames without invented assets', async () => {
    const output = z.object({ job: MediaJobResult }).parse(assertOk(await call('media_open', { path: 'bad.mp4', waitMs: 10000, idempotencyKey: 'mm-bad-video-001' })));
    expect(output.job.status).toBe('failed'); expect(output.job.assets).toHaveLength(0);
    const outside = MediaJobResult.parse(assertOk(await call('media_extract', { mediaId, kind: 'frames', times: [100], waitMs: 10000, idempotencyKey: 'mm-outside-video-001' })));
    expect(outside.status).toBe('failed'); expect(outside.assets).toHaveLength(0);
  });
  it.skipIf(!nativeAvailable || process.platform !== 'darwin')('synthesizes speech locally without playing it on the machine', async () => {
    const output = await completed(assertOk(await call('speech_synthesize', { text: 'Hello world. This is a local test.', voice: 'Samantha', waitMs: 10000, idempotencyKey: 'mm-speech-001' })));
    expect(output.assets[0]?.kind).toBe('audio');
    const bytes = ctx.server.services.multimodal!.storage.get(token, output.assets[0]!.assetId).bytes;
    expect(bytes.subarray(0, 4).toString()).toBe('RIFF');
  });
  it.skipIf(!asrAvailable || process.platform !== 'darwin')('transcribes actual synthesized speech with the local multilingual Whisper model', async () => {
    fs.mkdirSync(path.join(ctx.configDir, 'models'), { recursive: true });
    fs.copyFileSync(model, path.join(ctx.configDir, 'models', 'ggml-tiny.bin'));
    execFileSync('/usr/bin/say', ['-v', 'Samantha', '-o', path.join(ctx.fixtureDir, 'spoken.aiff'), 'Hello world. Please save the project. This is a local speech test.'], { timeout: 20000, stdio: 'pipe' });
    const input = z.object({ mediaId: z.string() }).parse(assertOk(await call('media_open', { path: 'spoken.aiff', waitMs: 10000, idempotencyKey: 'mm-asr-source-001' })));
    const output = await completed(assertOk(await call('media_transcribe', { mediaId: input.mediaId, durationSec: 10, language: 'en', waitMs: 10000, idempotencyKey: 'mm-asr-001' })));
    const read = assertOk(await call('media_read', { assetId: output.assets[0]!.assetId })) as { transcript: unknown };
    const text = Transcript.parse(read.transcript); expect(text.source).toBe('whisper.cpp'); expect(text.segments.map(s => s.text).join(' ').toLowerCase()).toContain('project');
    expect(text.segments.every(s => s.startSec >= 0 && s.endSec >= s.startSec)).toBe(true);
  }, 180000);
  it.skipIf(!nativeAvailable)('closing a source removes private copies and invalidates access without changing source bytes', async () => {
    const mm = ctx.server.services.multimodal!, source = mm.media.sources.get(mediaId)!;
    const original = fs.readFileSync(path.join(ctx.fixtureDir, 'sample.mp4'));
    assertOk(await call('media_close', { mediaId })); expect(fs.existsSync(source.directory)).toBe(false);
    expect(fs.readFileSync(path.join(ctx.fixtureDir, 'sample.mp4')).equals(original)).toBe(true);
    expect((await call('media_extract', { mediaId, kind: 'frames', times: [0], idempotencyKey: 'mm-after-close-001' })).isError).toBe(true);
  });
});

describe.skipIf(!browserAvailable)('real isolated browser, game and demonstrated workflow', () => {
  let ctx: TestContext, token: TokenSet;
  beforeAll(async () => { ctx = await launch({ toolSurface: 'full',  trust: 'trusted', fixtureFiles: { 'index.html': BROWSER_FIXTURE, '.env': 'NEVER_LEAK_ENV=true' } }); if (nativeAvailable) generateMedia(ctx.fixtureDir); token = await obtainToken(ctx); });
  afterAll(async () => ctx?.cleanup());
  const call = (name: string, args: Record<string, unknown>) => tool(ctx, token.accessToken, name, args);
  let seq = 0;
  const open = async () => Session.parse(assertOk(await call('browser_session', { source: 'workspace', path: 'index.html', idempotencyKey: `mm-browser-open-${++seq}` })));
  const close = async (id: string) => assertOk(await call('browser_session', { mode: 'close', sessionId: id, idempotencyKey: `mm-browser-close-${++seq}` }));
  it('opens offline HTML and returns actual screenshot/selectors without input/password values', async () => {
    const session = await open();
    try {
      expect(session.observation.title).toBe('DODO test world'); expect(session.observation.elements.some(e => e.selector === '#save')).toBe(true);
      expect(JSON.stringify(session.observation)).not.toContain('NEVER_READ_PASSWORD');
      const read = await call('browser_observe', { sessionId: session.sessionId }); assertOk(read);
      const image = blocks(read).find(b => b.type === 'image')!; expect((await sharp(Buffer.from(image.data!, 'base64')).metadata()).width).toBe(1280);
    } finally { await close(session.sessionId); }
  });
  it('fills a form, clicks its real button and reports the changed page without replaying the click', async () => {
    const s = await open();
    try {
      const filled = z.object({ observation: BrowserObservation }).parse(assertOk(await call('browser_action', { sessionId: s.sessionId, observationId: s.observation.observationId, action: { kind: 'fill', selector: '#name', text: 'ทดสอบ' }, idempotencyKey: 'mm-browser-fill-001' })));
      const saved = z.object({ observation: BrowserObservation }).parse(assertOk(await call('browser_action', { sessionId: s.sessionId, observationId: filled.observation.observationId, action: { kind: 'click', selector: '#save' }, idempotencyKey: 'mm-browser-save-001' })));
      expect(saved.observation.text).toContain('Saved ทดสอบ');
      const args = { sessionId: s.sessionId, observationId: saved.observation.observationId, action: { kind: 'click', selector: '#count' }, idempotencyKey: 'mm-browser-count-001' };
      assertOk(await call('browser_action', args)); expect((assertOk(await call('browser_action', args)) as { replayed: boolean }).replayed).toBe(true);
      const current = BrowserObservation.parse(assertOk(await call('browser_observe', { sessionId: s.sessionId }))); expect(current.text).toContain('Count 1'); expect(current.text).not.toContain('Count 2');
      expect((await call('browser_action', { ...args, idempotencyKey: 'mm-browser-stale-001' })).envelope.error).toMatchObject({ code: 'STALE_WORKSPACE' });
    } finally { await close(s.sessionId); }
  });
  it('blocks outgoing URLs and secret resources in an offline workspace browser', async () => {
    const s = await open();
    try {
      assertOk(await call('browser_action', { sessionId: s.sessionId, observationId: s.observation.observationId, action: { kind: 'click', selector: '#network' }, idempotencyKey: 'mm-offline-network-001' }));
      const state = BrowserObservation.parse(assertOk(await call('browser_observe', { sessionId: s.sessionId })));
      expect(state.network.some(n => n.includes('BLOCKED') && n.includes('127.0.0.1'))).toBe(true);
      expect(state.network.some(n => n.includes('BLOCKED') && n.includes('/.env'))).toBe(true);
      expect(state.text).not.toContain('NEVER_LEAK_ENV');
    } finally { await close(s.sessionId); }
  });
  it('executes a bounded browser game key combination, releases every held key, and shows after-state', async () => {
    const s = await open();
    try {
      const game = z.object({ gameId: z.string(), observation: BrowserObservation }).parse(assertOk(await call('game_session', { browserId: s.sessionId })));
      const next = z.object({ steps: z.number(), observation: BrowserObservation }).parse(assertOk(await call('game_step', { gameId: game.gameId, observationId: game.observation.observationId, action: { kind: 'keys', keys: ['ArrowRight', 'a'], holdMs: 100 }, idempotencyKey: 'mm-game-move-001' })));
      expect(next.steps).toBe(1); expect(next.observation.text).toContain('Held none'); expect(next.observation.text).toContain('Moves 2');
    } finally { await close(s.sessionId); }
  });
  it('saves/finds a demonstrated workflow, then performs only one checked step per call', async () => {
    const s = await open();
    try {
      const saved = WorkflowRecord.parse(assertOk(await call('workflow_save', { workflow: { name: 'Increment demo', goal: 'Increment twice', tags: ['game', 'demo'], steps: [
        { instruction: 'First increment', expectedBefore: 'Count 0', expectedAfter: 'Count 1', action: { target: 'browser', action: { kind: 'click', selector: '#count' } } },
        { instruction: 'Second increment', expectedBefore: 'Count 1', expectedAfter: 'Count 2', action: { target: 'browser', action: { kind: 'click', selector: '#count' } } },
      ] } })));
      const search = assertOk(await call('workflow_search', { query: 'Increment' })) as { totalMatches: number }; expect(search.totalMatches).toBeGreaterThan(0);
      const start = Run.parse(assertOk(await call('workflow_run', { mode: 'start', workflowId: saved.workflowId, revision: saved.revision, browserId: s.sessionId })));
      expect(start.stepIndex).toBe(0); expect(start.observation?.text).toContain('Count 0');
      const next = Run.parse(assertOk(await call('workflow_run', { mode: 'next', runId: start.runId, stepIndex: 0, observationId: start.observation!.observationId, idempotencyKey: 'mm-workflow-step-001' })));
      expect(next.stepIndex).toBe(1); expect(next.status).toBe('ready'); expect(next.observation?.text).toContain('Count 1');
      const done = Run.parse(assertOk(await call('workflow_run', { mode: 'next', runId: start.runId, stepIndex: 1, observationId: next.observation!.observationId, idempotencyKey: 'mm-workflow-step-002' })));
      expect(done.status).toBe('completed'); expect(done.observation?.text).toContain('Count 2');
    } finally { await close(s.sessionId); }
  });
  it('pauses a workflow before action if the demonstrated precondition is not present', async () => {
    const s = await open();
    try {
      const saved = WorkflowRecord.parse(assertOk(await call('workflow_save', { workflow: { name: 'Wrong context', goal: 'Do not click blindly', steps: [{ instruction: 'Increment', expectedBefore: 'Something not on this page', action: { target: 'browser', action: { kind: 'click', selector: '#count' } } }] } })));
      const start = Run.parse(assertOk(await call('workflow_run', { mode: 'start', workflowId: saved.workflowId, revision: saved.revision, browserId: s.sessionId })));
      const result = assertOk(await call('workflow_run', { mode: 'next', runId: start.runId, stepIndex: 0, observationId: start.observation!.observationId, idempotencyKey: 'mm-workflow-precondition-001' })) as { status: string; dispatched: boolean };
      expect(result.status).toBe('needs_review'); expect(result.dispatched).toBe(false);
      expect(BrowserObservation.parse(assertOk(await call('browser_observe', { sessionId: s.sessionId }))).text).toContain('Count 0');
    } finally { await close(s.sessionId); }
  });
  it.skipIf(!nativeAvailable)('seeks an actual local video element through a fixed bounded media action', async () => {
    const s = await open();
    try {
      const result = z.object({ observation: BrowserObservation }).parse(assertOk(await call('browser_action', { sessionId: s.sessionId, observationId: s.observation.observationId, action: { kind: 'media', selector: '#clip', control: 'seek', timeSec: 1 }, idempotencyKey: 'mm-video-seek-001' })));
      expect(result.observation.media.find(m => m.selector === '#clip')?.currentTime).toBeCloseTo(1, 2);
      expect(result.observation.media.find(m => m.selector === '#clip')?.errorCode).toBeNull();
      const playing = z.object({ observation: BrowserObservation }).parse(assertOk(await call('browser_action', { sessionId: s.sessionId, observationId: result.observation.observationId, action: { kind: 'media', selector: '#clip', control: 'play' }, idempotencyKey: 'mm-video-play-001' })));
      expect(playing.observation.media[0]?.paused).toBe(false);
      await new Promise(resolve => setTimeout(resolve, 180));
      const paused = z.object({ observation: BrowserObservation }).parse(assertOk(await call('browser_action', { sessionId: s.sessionId, observationId: playing.observation.observationId, action: { kind: 'media', selector: '#clip', control: 'pause' }, idempotencyKey: 'mm-video-pause-001' })));
      expect(paused.observation.media[0]?.paused).toBe(true);
      expect(paused.observation.media[0]?.currentTime).toBeGreaterThan(1.05);
      await new Promise(resolve => setTimeout(resolve, 100));
      const stillPaused = BrowserObservation.parse(assertOk(await call('browser_observe', { sessionId: s.sessionId })));
      expect(stillPaused.media[0]?.currentTime).toBeCloseTo(paused.observation.media[0]!.currentTime, 2);
    } finally { await close(s.sessionId); }
  });
});

it('new tools and actual image content work through a modern STDIO client', async () => {
  const root = mkTmpDir('dodo-mm-stdio-'), config = mkTmpDir('dodo-mm-stdio-cfg-');
  fs.writeFileSync(path.join(root, 'test.png'), await sharp({ create: { width: 32, height: 32, channels: 3, background: '#556677' } }).png().toBuffer());
  const client = new Client({ name: 'multimodal-stdio-test', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve('dist/cli/main.js'), 'stdio'], cwd: root, env: { ...process.env, DODO_CONFIG_DIR: config } as Record<string, string>, stderr: 'pipe' }));
  try {
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(surfaceCatalog('full', { subagents: false }).map((tool) => tool.name));
    expect(TOOL_CATALOG).toHaveLength(158);
    const overview = (await client.callTool({ name: 'project_overview', arguments: {} })).structuredContent as { workspaceId: string; workspaceEpoch: string };
    const response = await client.callTool({ name: 'image_view', arguments: { workspaceId: overview.workspaceId, workspaceEpoch: overview.workspaceEpoch, path: 'test.png' } });
    expect(response.isError).not.toBe(true); expect(z.array(z.object({ type: z.string() })).parse(response.content).some(c => c.type === 'image')).toBe(true);
  } finally { await client.close(); fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(config, { recursive: true, force: true }); }
});
