import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { chromium } from 'playwright';
import { z } from 'zod';
import { launch, obtainToken, callToolLegacy, wsArgs, type TestContext, type TokenSet } from '../helpers/testServer.js';
import { blocks, BROWSER_FIXTURE } from '../helpers/multimodal.js';
import { BrowserObservation, MediaJobResult, WorkflowRecord } from '../../src/services/multimodal/contracts.js';
import { ContextSchema, SymbolSchema } from '../../src/services/assistance/contracts.js';
import { VerificationSchema } from '../../src/services/assistance/verification.js';

/**
 * ADR-029: the compact gateways must carry the NEW capability families end to
 * end — assistance, media (image/audio blocks intact), browser, game and
 * workflow — with the same fixtures the direct suites use. This does not
 * duplicate the full multimodal suite; it proves the gateway dispatcher for
 * every result family: text, job, image block, audio-bearing asset, browser
 * state, effect/idempotency.
 */
const browserAvailable = fs.existsSync(chromium.executablePath());
const nativeAvailable = spawnSync('ffmpeg', ['-version'], { timeout: 10000, stdio: 'pipe' }).status === 0;
const report = (passed: number) => JSON.stringify({ numTotalTests: passed, numPassedTests: passed, numFailedTests: 0, numPendingTests: 0, testResults: [] });

describe('compact gateways carry assistance and media capabilities', () => {
  let ctx: TestContext;
  let tokens: TokenSet;
  beforeAll(async () => {
    ctx = await launch({
      trust: 'trusted',
      fixtureFiles: {
        'package.json': JSON.stringify({ name: 'gw-fixture', version: '1', scripts: { test: 'node ok.cjs' } }),
        'ok.cjs': `console.log(${JSON.stringify(report(2))});`,
        'src/math.ts': 'export function add(a: number, b: number) {\n  return a + b;\n}\nexport const untouched = 9;\n',
        'tests/math.test.ts': 'import { add } from "../src/math.js"; export const tested = add(2,3);',
        'index.html': BROWSER_FIXTURE,
      },
    });
    const png = await sharp({ create: { width: 320, height: 200, channels: 3, background: '#3355aa' } }).png().toBuffer();
    fs.writeFileSync(path.join(ctx.fixtureDir, 'shot.png'), png);
    tokens = await obtainToken(ctx);
  }, 120_000);
  afterAll(async () => ctx?.cleanup());

  const gw = (name: string, operation: string, args: Record<string, unknown> = {}) =>
    callToolLegacy(ctx, tokens.accessToken, name, { ...wsArgs(ctx), operation, args });
  const data = (r: Awaited<ReturnType<typeof gw>>) => {
    expect(r.isError, JSON.stringify(r.envelope['error'])).toBe(false);
    return r.envelope['data'] as Record<string, unknown>;
  };

  it('assistance reads and preview-only refactor keep their exact behavior through the gateways', async () => {
    const context = ContextSchema.parse(data(await gw('dodo_assist_read', 'context_for_task', { goal: 'fix add math', terms: ['add'], files: ['src/math.ts'] })));
    expect(context.files[0]?.path).toBe('src/math.ts');
    const sym = SymbolSchema.parse(data(await gw('dodo_assist_read', 'read_symbol', { file: 'src/math.ts', symbol: 'add' })));
    expect(sym.content).toContain('a + b');
    const before = fs.readFileSync(path.join(ctx.fixtureDir, 'src/math.ts'), 'utf8');
    const preview = data(await gw('dodo_assist_change', 'preview_refactor', { file: 'src/math.ts', symbol: 'add', expectedHash: sym.hash, body: '\n  return a - b;\n' })) as { planId: string; planHash: string };
    expect(fs.readFileSync(path.join(ctx.fixtureDir, 'src/math.ts'), 'utf8')).toBe(before); // preview never applies
    const applied = data(await gw('dodo_write', 'apply_changes', { planId: preview.planId, planHash: preview.planHash, idempotencyKey: 'gw-assist-apply-01' })) as { changesetId: string };
    expect(fs.readFileSync(path.join(ctx.fixtureDir, 'src/math.ts'), 'utf8')).toBe(before.replace('a + b', 'a - b'));
    data(await gw('dodo_write', 'rollback_changes', { changesetId: applied.changesetId, idempotencyKey: 'gw-assist-rollback-01' }));
    expect(fs.readFileSync(path.join(ctx.fixtureDir, 'src/math.ts'), 'utf8')).toBe(before);
  });

  it('verify_changes still runs the existing exec policy through the gateway', async () => {
    const plan = VerificationSchema.parse(data(await gw('dodo_assist_change', 'verify_changes', { mode: 'plan', files: ['src/math.ts'] })));
    const task = plan.recommendedTasks[0];
    expect(task).toBeDefined();
    const run = VerificationSchema.parse(
      data(await gw('dodo_assist_change', 'verify_changes', {
        mode: 'run', files: ['src/math.ts'],
        tasks: [{ taskId: task!.taskId, recipeDigest: task!.recipeDigest }],
        sourceDigest: plan.freshness.baselineDigest,
        idempotencyKey: 'gw-verify-01', waitMs: 10000,
      })),
    );
    expect(run.status).toBe('passed');
    expect(run.checks[0]?.tests).toMatchObject({ total: 2, passed: 2, source: 'json' });
  });

  it('multimodal_status (text family) works through dodo_media without opening anything', async () => {
    const status = data(await gw('dodo_media', 'multimodal_status', {})) as { media: { ffmpeg: boolean } };
    expect(typeof status.media.ffmpeg).toBe('boolean');
    expect(ctx.server.services.multimodal!.storage.directories.size).toBe(0);
  });

  it('image content blocks survive the gateway (dodo_media → image_view)', async () => {
    const r = await gw('dodo_media', 'image_view', { path: 'shot.png', maxEdge: 320 });
    data(r);
    const image = blocks(r).find((b) => b.type === 'image');
    expect(image, 'image block missing after gateway dispatch').toBeDefined();
    const meta = await sharp(Buffer.from(image!.data as string, 'base64')).metadata();
    expect(meta.width).toBe(320);
  });

  it.skipIf(!nativeAvailable || process.platform !== 'darwin')('audio-producing jobs run and read back through the gateway (speech → RIFF/WAVE)', async () => {
    let job = MediaJobResult.parse(data(await gw('dodo_media', 'speech_synthesize', { text: 'Compact gateway audio test.', voice: 'Samantha', waitMs: 10000, idempotencyKey: 'gw-speech-01' })));
    for (let i = 0; i < 30 && job.status === 'running'; i += 1) {
      job = MediaJobResult.parse(data(await gw('dodo_media', 'media_job', { jobId: job.jobId, waitMs: 10000 })));
    }
    expect(job.exitCode).toBe(0);
    const assetId = job.assets[0]?.assetId as string;
    const read = await gw('dodo_media', 'media_read', { assetId });
    data(read);
    const audio = blocks(read).find((b) => b.type === 'audio');
    expect(audio).toBeDefined();
    const bytes = Buffer.from(audio!.data as string, 'base64');
    expect(bytes.subarray(0, 4).toString()).toBe('RIFF');
  }, 120_000);
});

describe.skipIf(!browserAvailable)('compact gateways carry browser, game and workflow', () => {
  let ctx: TestContext;
  let tokens: TokenSet;
  let seq = 0;
  const Session = z.object({ sessionId: z.string(), observation: BrowserObservation });
  const Run = z.object({ runId: z.string(), status: z.string(), stepIndex: z.number(), observation: BrowserObservation.nullable() });

  beforeAll(async () => {
    ctx = await launch({ trust: 'trusted', fixtureFiles: { 'index.html': BROWSER_FIXTURE } });
    tokens = await obtainToken(ctx);
  }, 120_000);
  afterAll(async () => ctx?.cleanup());

  const gw = (name: string, operation: string, args: Record<string, unknown> = {}) =>
    callToolLegacy(ctx, tokens.accessToken, name, { ...wsArgs(ctx), operation, args });
  const data = (r: Awaited<ReturnType<typeof gw>>) => {
    expect(r.isError, JSON.stringify(r.envelope['error'])).toBe(false);
    return r.envelope['data'] as Record<string, unknown>;
  };

  it('browser open/observe/act with real screenshots and effect idempotency, all through gateways', async () => {
    const session = Session.parse(data(await gw('dodo_browser', 'browser_session', { source: 'workspace', path: 'index.html', idempotencyKey: `gw-browser-open-${++seq}` })));
    try {
      const observed = await gw('dodo_browser', 'browser_observe', { sessionId: session.sessionId });
      const freshObservation = BrowserObservation.parse(data(observed));
      const image = blocks(observed).find((b) => b.type === 'image');
      expect(image).toBeDefined();
      expect((await sharp(Buffer.from(image!.data as string, 'base64')).metadata()).width).toBe(1280);

      // act on the FRESH observation — the freshness guard refuses older ones by design
      const clickArgs = { sessionId: session.sessionId, observationId: freshObservation.observationId, action: { kind: 'click', selector: '#count' }, idempotencyKey: 'gw-browser-count-01' };
      data(await gw('dodo_browser', 'browser_action', clickArgs));
      const replay = data(await gw('dodo_browser', 'browser_action', clickArgs)) as { replayed?: boolean };
      expect(replay.replayed).toBe(true); // same key + args → no second click
      const now = BrowserObservation.parse(data(await gw('dodo_browser', 'browser_observe', { sessionId: session.sessionId })));
      expect(now.text).toContain('Count 1');
      expect(now.text).not.toContain('Count 2');

      const game = z.object({ gameId: z.string(), observation: BrowserObservation }).parse(data(await gw('dodo_game', 'game_session', { browserId: session.sessionId })));
      const step = z.object({ steps: z.number(), observation: BrowserObservation }).parse(
        data(await gw('dodo_game', 'game_step', { gameId: game.gameId, observationId: game.observation.observationId, action: { kind: 'keys', keys: ['ArrowRight'], holdMs: 80 }, idempotencyKey: 'gw-game-step-01' })),
      );
      expect(step.steps).toBe(1);
      expect(step.observation.text).toContain('Held none');

      const saved = WorkflowRecord.parse(data(await gw('dodo_workflow_write', 'workflow_save', { workflow: { name: 'GW increment', goal: 'Increment once', steps: [
        { instruction: 'Increment', expectedBefore: 'Count 1', expectedAfter: 'Count 2', action: { target: 'browser', action: { kind: 'click', selector: '#count' } } },
      ] } })));
      const search = data(await gw('dodo_workflow_read', 'workflow_search', { query: 'GW increment' })) as { totalMatches: number };
      expect(search.totalMatches).toBeGreaterThan(0);
      const start = Run.parse(data(await gw('dodo_workflow_run', 'workflow_run', { mode: 'start', workflowId: saved.workflowId, revision: saved.revision, browserId: session.sessionId })));
      const done = Run.parse(data(await gw('dodo_workflow_run', 'workflow_run', { mode: 'next', runId: start.runId, stepIndex: 0, observationId: start.observation!.observationId, idempotencyKey: 'gw-workflow-step-01' })));
      expect(done.status).toBe('completed');
      expect(done.observation?.text).toContain('Count 2');
    } finally {
      data(await gw('dodo_browser', 'browser_session', { mode: 'close', sessionId: session.sessionId, idempotencyKey: `gw-browser-close-${++seq}` }));
    }
  }, 180_000);
});
