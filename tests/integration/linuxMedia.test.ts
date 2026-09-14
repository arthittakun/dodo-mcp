import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { beforeAll, describe, expect, it } from 'vitest';
import { launch, obtainToken, callToolLegacy, wsArgs, type TestContext } from '../helpers/testServer.js';
import { blocks, assertOk } from '../helpers/multimodal.js';
import { MediaJobResult } from '../../src/services/multimodal/contracts.js';
import { findSpeechEngine } from '../../src/platform/speech.js';
import { sandboxAvailability } from '../../src/services/jobs/sandbox.js';

const linux = process.platform === 'linux';
const required = process.env['DODO_TEST_REQUIRE_LINUX_MEDIA'] === '1';
const mediaReady = linux && ['ffmpeg', 'ffprobe', 'espeak-ng'].every(program =>
  spawnSync(program, [program === 'espeak-ng' ? '--version' : '-version'], { timeout: 5000, stdio: 'pipe' }).status === 0);

// Own only new directories from this launch, never change the shared harness's
// close-only contract (restart/reuse tests depend on it). Preserve both failures.
async function fixture(surface: 'full' | 'compact', action: (ctx: TestContext) => Promise<void>) {
  const ctx = await launch({ toolSurface: surface, trust: 'trusted' });
  const failures: unknown[] = [];
  try { await action(ctx); } catch (error) { failures.push(error); }
  let closed = false;
  try { await ctx.cleanup(); closed = true; } catch (error) { failures.push(error); }
  if (closed) for (const directory of [ctx.fixtureDir, ctx.configDir]) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
      expect(fs.existsSync(directory)).toBe(false);
    } catch (error) { failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, 'fixture assertion and cleanup failures');
}

describe.skipIf(!linux || (!required && !mediaReady))('Linux real speech through HTTP OAuth (ffmpeg/espeak-ng required in Docker gate)', () => {
  beforeAll(() => {
    expect(mediaReady, 'Linux media gate requires ffmpeg, ffprobe and espeak-ng; missing dependencies must not silently skip').toBe(true);
    if (required) expect(process.getuid?.(), 'release tests must run as an unprivileged user').not.toBe(0);
  });

  it.each(['full', 'compact'] as const)('%s preserves audio bytes, idempotency and read-only denial', async surface => {
    await fixture(surface, async ctx => {
      expect(findSpeechEngine(ctx.fixtureDir)?.kind).toBe('espeak-ng');
      const owner = await obtainToken(ctx);
      const reader = await obtainToken(ctx, { scope: 'dodo:read' });
      const call = (operation: string, args: Record<string, unknown>, token = owner.accessToken) =>
        surface === 'full'
          ? callToolLegacy(ctx, token, operation, { ...wsArgs(ctx), ...args })
          : callToolLegacy(ctx, token, 'dodo_media', { ...wsArgs(ctx), operation, args });
      const jobs = ctx.server.services.multimodal!.media.jobs;
      const before = jobs.size;
      const denied = await call('speech_synthesize', {
        text: 'Must not run.', voice: 'en', waitMs: 1000, idempotencyKey: `linux-${surface}-readonly`,
      }, reader.accessToken);
      expect(denied.isError).toBe(true);
      expect(denied.envelope['error']).toMatchObject({ code: 'FORBIDDEN' });
      expect(jobs.size).toBe(before);

      const request = { text: 'Hello from a private Linux fixture.', voice: 'en', waitMs: 10000, idempotencyKey: `linux-${surface}-speech` };
      let job = MediaJobResult.parse(assertOk(await call('speech_synthesize', request)));
      for (let i = 0; i < 12 && job.status === 'running'; i++) {
        job = MediaJobResult.parse(assertOk(await call('media_job', { jobId: job.jobId, waitMs: 10000 })));
      }
      expect(job.exitCode).toBe(0);
      expect(job.assets[0]?.kind).toBe('audio');
      const result = await call('media_read', { assetId: job.assets[0]!.assetId });
      assertOk(result);
      const audio = blocks(result).find(block => block.type === 'audio');
      expect(audio).toBeDefined();
      const bytes = Buffer.from(audio!.data!, 'base64');
      expect(bytes.subarray(0, 4).toString('ascii')).toBe('RIFF');
      expect(bytes.subarray(8, 12).toString('ascii')).toBe('WAVE');
      expect(bytes.length).toBeGreaterThan(1000);
      const count = jobs.size;
      const replay = MediaJobResult.parse(assertOk(await call('speech_synthesize', request)));
      expect(replay.jobId).toBe(job.jobId);
      expect(replay.assets[0]?.assetId).toBe(job.assets[0]?.assetId);
      expect(jobs.size).toBe(count);
    });
  }, 180000);
});

describe.skipIf(!linux)('Linux required sandbox without a runtime on the selected PATH', () => {
  it('denies before spawning or reserving a running slot, even on hosts with bubblewrap installed', async () => {
    await fixture('compact', async ctx => {
      const owner = await obtainToken(ctx);
      // A real empty trusted directory, outside the workspace, prevents PATH
      // fallback. Do not assume the host lacks bwrap or alter its installation.
      const emptyPath = path.join(ctx.configDir, 'empty-tool-path');
      fs.mkdirSync(emptyPath);
      const oldPath = process.env['PATH'];
      try {
        process.env['PATH'] = emptyPath;
        expect(sandboxAvailability().available).toBe(false);
        const result = await callToolLegacy(ctx, owner.accessToken, 'dodo_exec', {
          ...wsArgs(ctx), operation: 'run_command', args: {
            command: 'printf forbidden > must-not-exist.txt', waitMs: 1000, timeoutMs: 5000, network: false, sandbox: true,
          },
        });
        expect(result.isError).toBe(true);
        expect(result.envelope['error']).toMatchObject({ code: 'NOT_SUPPORTED' });
        expect(fs.existsSync(path.join(ctx.fixtureDir, 'must-not-exist.txt'))).toBe(false);
        expect(ctx.server.services.jobs.runningCount()).toBe(0);
      } finally {
        if (oldPath === undefined) delete process.env['PATH']; else process.env['PATH'] = oldPath;
      }
    });
  });
});
