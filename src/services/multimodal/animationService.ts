import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DodoError } from '../../errors.js';
import { resolveTrustedExecutable, trustedExecutable } from '../../platform/execResolve.js';
import type { ToolCtx } from '../../tools/context.js';
import type { ResourceInfoData } from '../resources/contracts.js';
import type { GeneratedMime } from '../resources/resourceService.js';
import { MediaStorage, actorKey, liveAccess } from './storage.js';
import type { CreativeService } from './creativeService.js';
import {
  ANIMATION_FORMATS, CHARACTER_ACTIONS, IMAGE_EFFECTS, RIG_PRESETS, VIDEO_FORMATS, AnimationWorkerSpec, BridgeResult,
  type AnimationJobData, type AnimationKind,
} from './animationContracts.js';

type Source = { path?: string | undefined; assetId?: string | undefined; resourceId?: string | undefined };
interface AnimationRecord { owner: string; kind: AnimationKind; directory: string; createdAt: number; expiresAt: number; result?: AnimationJobData }

const ENGINE = fileURLToPath(new URL('../../../engines/animation/', import.meta.url));
const RENDER_TIMEOUT_MS = 280_000;
const MAX_RUNNING = 2;
const RECORD_TTL_MS = 30 * 60_000;
const OUTPUT_CAP = 64 * 1024 * 1024;

export const PRESET_INFO: Readonly<Record<(typeof RIG_PRESETS)[number], { character: 'orange_cat' | 'fox_girl'; title: string; motion: string }>> = {
  orange_cat: { character: 'orange_cat', title: 'แมวส้มเดินอยู่กับที่และโบกมือ', motion: 'Walk in place and wave; ears, tail and arm follow through with spring physics.' },
  orange_cat_ik: { character: 'orange_cat', title: 'แมวส้มเดินล็อกเท้าด้วย IK และโบกมือ', motion: 'Walk with planted-foot IK (checked for foot slip) and wave.' },
  orange_cat_idle: { character: 'orange_cat', title: 'แมวส้มยืนหายใจ โบกมือช้า ๆ และกะพริบตา', motion: 'Breathe, slow wave, tail in a breeze and a double blink.' },
  orange_cat_jump: { character: 'orange_cat', title: 'แมวส้มกระโดดพร้อมหูและหางสะบัด', motion: 'Hop with anticipation, stretch and landing squash; ears and tail fly behind.' },
  fox_girl_idle: { character: 'fox_girl', title: 'สาวจิ้งจอกยืนหายใจ โบกมือ หางลู่ลม', motion: 'Breathe, wave hello, tail wag in a breeze, ear twitches and a double blink.' },
  fox_girl_bounce: { character: 'fox_girl', title: 'สาวจิ้งจอกเด้งดึ๋งอย่างร่าเริง', motion: 'Happy small hops in place with floppy ears and tail.' },
  fox_girl_jump: { character: 'fox_girl', title: 'สาวจิ้งจอกกระโดดพร้อมหูและหางสะบัด', motion: 'A big hop with anticipation, stretch and landing squash.' },
};
const FORMAT_INFO: Record<(typeof ANIMATION_FORMATS)[number], { mimeType: string; transparent: boolean; note: string }> = {
  gif: { mimeType: 'image/gif', transparent: true, note: '1-bit alpha; use 20, 25 or 50 FPS for even timing and edgeMatte for soft edges on a known page color.' },
  webp: { mimeType: 'image/webp', transparent: true, note: 'Smooth alpha and small files.' },
  apng: { mimeType: 'image/png', transparent: true, note: 'Lossless animated PNG with smooth alpha.' },
  webm: { mimeType: 'video/webm', transparent: true, note: 'VP9 video with alpha; needs FFmpeg.' },
  mp4: { mimeType: 'video/mp4', transparent: false, note: 'H.264 on the background color; needs FFmpeg.' },
  spritesheet: { mimeType: 'image/png', transparent: true, note: 'Sprite sheet PNG plus an Aseprite-style JSON companion for game engines.' },
  line: { mimeType: 'image/png', transparent: true, note: 'LINE Creators Market animated sticker: APNG up to 320x270, 5-20 frames, whole seconds, 4 s total, under 1 MB.' },
  telegram: { mimeType: 'video/webm', transparent: true, note: 'Telegram video sticker: 512 px VP9 WebM, up to 3 s and 30 FPS, under 256 KB; needs FFmpeg.' },
};

let manifestCheck: { verified: boolean; reason?: string } | undefined;
function verifyEngine(): { verified: boolean; reason?: string } {
  if (manifestCheck) return manifestCheck;
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(ENGINE, 'MANIFEST.json'), 'utf8')) as { files?: Record<string, string> };
    const files = Object.entries(manifest.files ?? {});
    if (!files.length || !fs.statSync(path.join(ENGINE, 'dodo_bridge.py')).isFile()) throw new Error('engine bridge or manifest missing');
    for (const [name, digest] of files) {
      if (name.includes('..') || path.isAbsolute(name)) throw new Error('invalid manifest entry');
      if (createHash('sha256').update(fs.readFileSync(path.join(ENGINE, name))).digest('hex') !== digest) throw new Error(`engine file changed: ${name}`);
    }
    manifestCheck = { verified: true };
  } catch (err) { manifestCheck = { verified: false, reason: (err as Error).message }; }
  return manifestCheck;
}

/** Runs the vendored Gift engine as owned jobs, requests network denial from the optional OS sandbox, and publishes owned resources. */
export class AnimationService {
  private readonly jobs = new Map<string, AnimationRecord>();
  private readonly collecting = new Map<string, Promise<AnimationJobData>>();
  private starting = 0;
  constructor(private readonly storage: MediaStorage, private readonly creative: CreativeService) {}

  private root(): string { return this.storage.services.wfs.root; }

  /** Owner-chosen interpreter first, then the private venv created by dodo-media-setup --install-animation. */
  python(): { program: string; source: 'env' | 'venv' } | null {
    const configured = process.env['DODO_ANIMATION_PYTHON'];
    if (configured) return path.isAbsolute(configured) && trustedExecutable(configured, this.root(), false) ? { program: configured, source: 'env' } : null;
    const venv = path.join(this.storage.configDir, 'animation', 'venv', ...(process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python3']));
    // Run the venv entry itself (not its realpath) so Python finds the venv's site-packages.
    return fs.existsSync(venv) && trustedExecutable(venv, this.root(), false) ? { program: venv, source: 'venv' } : null;
  }

  ffmpeg(): string | null { try { return resolveTrustedExecutable('ffmpeg', this.root(), { allowBatch: false }); } catch { return null; } }

  catalog() {
    const python = this.python(), engine = verifyEngine(), ffmpeg = this.ffmpeg() !== null;
    return {
      ready: python !== null && engine.verified,
      python: { available: python !== null, source: python?.source ?? null },
      ffmpeg, engine: { verified: engine.verified, ...(engine.reason ? { problem: engine.reason } : {}) },
      setup: python ? (ffmpeg ? 'Interpreter and engine configured; setup/render checks Python 3.11+ and its required packages.' : 'Interpreter configured for GIF/WebP/APNG/sprite sheets/LINE; setup/render checks Python 3.11+ and its required packages. Install FFmpeg on the trusted PATH for webm, mp4 and telegram.')
        : 'Run dodo-media-setup --install-animation once (creates a private Python 3.11+ venv with Pillow, pydantic and uharfbuzz), or start DODO with DODO_ANIMATION_PYTHON set to an absolute Python that has them.',
      presets: RIG_PRESETS.map(name => ({ name, ...PRESET_INFO[name] })),
      characters: ['orange_cat', 'fox_girl'],
      imageEffects: [...IMAGE_EFFECTS], characterActions: [...CHARACTER_ACTIONS],
      formats: ANIMATION_FORMATS.map(format => ({ format, ...FORMAT_INFO[format] })),
      spriteSheet: 'animation_sprite takes ONE transparent PNG pose sheet: 4 columns by 2 rows (8 poses) or 4 rows (16 poses), row-major, same character size and ground line in every cell, wide transparent gutters, no text, borders or shadows.',
      limits: { imageDurationSec: [1, 5], rigDurationSec: [1, 8], spriteDurationSec: [0.8, 5], fps: [8, 50], sourceBytes: 16 * 1024 * 1024, concurrentRenders: MAX_RUNNING },
      note: 'Local rendering with Gift makes no network or model calls and has no API cost. Readiness checks the configured interpreter path and engine integrity; setup/render checks the Python version and packages. OS-level network denial depends on the configured sandbox. Results are owned resources; use media_save or download_link_create to deliver them.',
    };
  }

  private check(ctx: ToolCtx): void {
    this.storage.check(); liveAccess(ctx, 'dodo:exec'); ctx.revalidate?.();
    if (ctx.principal.expiresAt !== undefined && ctx.principal.expiresAt <= Date.now() / 1000) throw new DodoError('AUTH_REQUIRED', 'authorization expired; authenticate and collect this animation again');
  }

  private record(ctx: ToolCtx, jobId: string): AnimationRecord {
    this.check(ctx); const record = this.jobs.get(jobId);
    if (!record || record.owner !== actorKey(ctx.principal) || record.expiresAt < Date.now()) throw new DodoError('NOT_FOUND', 'unknown or expired animation job for this client');
    return record;
  }

  private running(): number {
    let count = 0;
    for (const [jobId, record] of this.jobs) {
      if (record.result) continue;
      try { if (this.storage.services.jobs.getJobChecked(jobId, this.storage.services.workspaceId).status === 'running') count++; } catch { /* finished elsewhere */ }
    }
    return count;
  }

  /**
   * `extras.reference` is written as reference.bin; `extras.files` are further named inputs (scene
   * layers and background), each an owned image copied into the private job directory.
   */
  async start(ctx: ToolCtx, kind: AnimationKind, source: Source | undefined, params: Record<string, unknown>, waitMs: number,
    extras: { reference?: Source | undefined; files?: Array<{ name: string; source: Source }> } = {}): Promise<AnimationJobData> {
    const referenceSource = extras.reference;
    this.check(ctx); this.sweep();
    if (this.running() + this.starting >= MAX_RUNNING) throw new DodoError('RESOURCE_LIMIT', 'animation render limit reached; collect running jobs with animation_job first');
    const python = this.python();
    if (!python) throw new DodoError('NOT_SUPPORTED', 'the animation engine needs Python 3.11+ with Pillow, pydantic and uharfbuzz; run dodo-media-setup --install-animation or set DODO_ANIMATION_PYTHON');
    const engine = verifyEngine();
    if (!engine.verified) throw new DodoError('NOT_SUPPORTED', `the bundled animation engine is unavailable (${engine.reason ?? 'unverified'}); reinstall DODO`);
    const ffmpeg = this.ffmpeg();
    if (VIDEO_FORMATS.has(String(params['format'])) && !ffmpeg) throw new DodoError('NOT_SUPPORTED', `${String(params['format'])} needs FFmpeg on the trusted PATH; choose gif, webp, apng, line or spritesheet instead`);
    this.starting++;
    let reserved = true;
    try {
      const hasSource = source !== undefined && (source.path !== undefined || source.assetId !== undefined || source.resourceId !== undefined);
      if ([source?.path, source?.assetId, source?.resourceId].filter(v => v !== undefined).length > 1) throw new DodoError('INVALID_INPUT', 'provide one source: path, assetId or resourceId');
      const image = hasSource ? await this.creative.imageSource(ctx, source!) : undefined;
      if (referenceSource && [referenceSource.path, referenceSource.assetId, referenceSource.resourceId].filter(v => v !== undefined).length !== 1) throw new DodoError('INVALID_INPUT', 'reference needs exactly one of path, assetId or resourceId');
      const reference = referenceSource ? await this.creative.imageSource(ctx, referenceSource) : undefined;
      const files: Array<{ name: string; bytes: Buffer; guard: () => void }> = [];
      let totalBytes = 0;
      for (const file of extras.files ?? []) {
        if (!/^(?:layer-[0-9]{1,2}|background)\.bin$/.test(file.name) || [file.source.path, file.source.assetId, file.source.resourceId].filter(v => v !== undefined).length !== 1) throw new DodoError('INVALID_INPUT', 'each scene image needs exactly one of path, assetId or resourceId');
        const loaded = await this.creative.imageSource(ctx, file.source);
        if (loaded.bytes.length > 10 * 1024 * 1024) throw new DodoError('FILE_TOO_LARGE', 'each scene image must be at most 10 MiB');
        totalBytes += loaded.bytes.length;
        if (totalBytes > 64 * 1024 * 1024) throw new DodoError('RESOURCE_LIMIT', 'scene images together must stay under 64 MiB');
        files.push({ name: file.name, ...loaded });
      }
      const workers = [new URL('./animationWorker.js', import.meta.url), new URL('../../../dist/services/multimodal/animationWorker.js', import.meta.url)];
      const worker = workers.map(url => fileURLToPath(url)).find(p => fs.existsSync(p));
      if (!worker) throw new DodoError('NOT_SUPPORTED', 'animation worker is not built; run npm run build');
      const directory = this.storage.directory();
      let started = false;
      try {
        if (image) { image.guard(); fs.writeFileSync(path.join(directory, 'source.bin'), image.bytes, { mode: 0o600, flag: 'wx' }); }
        if (reference) { reference.guard(); fs.writeFileSync(path.join(directory, 'reference.bin'), reference.bytes, { mode: 0o600, flag: 'wx' }); }
        for (const file of files) { file.guard(); fs.writeFileSync(path.join(directory, file.name), file.bytes, { mode: 0o600, flag: 'wx' }); }
        const spec = AnimationWorkerSpec.parse({ version: 1, operation: kind, directory, python: python.program, bridge: path.join(ENGINE, 'dodo_bridge.py'), ffmpeg, params });
        const specFile = path.join(directory, 'spec.json'); fs.writeFileSync(specFile, JSON.stringify(spec), { mode: 0o600, flag: 'wx' });
        const s = this.storage.services;
        const job = await s.jobs.startProtected({
          workspaceId: s.workspaceId, epoch: s.epoch, principal: ctx.principal.grantId, kind: 'exec', program: 'node', args: [worker, specFile], cwdRel: '.',
          timeoutMs: RENDER_TIMEOUT_MS + 15_000, stdin: false, network: false,
          sandboxReadablePaths: [ENGINE, path.dirname(path.dirname(python.program))], sandboxWritablePaths: [directory],
        }, () => { this.check(ctx); image?.guard(); reference?.guard(); for (const file of files) file.guard(); });
        const now = Date.now();
        this.jobs.set(job.jobId, { owner: actorKey(ctx.principal), kind, directory, createdAt: now, expiresAt: now + RECORD_TTL_MS });
        started = true;
        this.starting--; reserved = false;
        try { return await this.report(ctx, job.jobId, waitMs); }
        catch (error) {
          // Preserve an accepted job receipt even if quota/storage prevents its
          // initial collection. The same idempotency key must not render again.
          this.check(ctx);
          const code = error instanceof DodoError ? error.code : 'STORAGE_UNAVAILABLE';
          return this.base(job.jobId, this.record(ctx, job.jobId), 'failed', `The render was accepted but its output could not be collected (${code}). Call animation_job with this jobId to retry collection; no new render is required.`);
        }
      } catch (err) { if (!started) this.storage.removeDirectory(directory); throw err; }
    } finally { if (reserved) this.starting--; }
  }

  private base(jobId: string, record: AnimationRecord, status: AnimationJobData['status'], error: string | null = null): AnimationJobData {
    return { jobId, kind: record.kind, status, animation: null, companions: [], preview: null, details: null, checks: [], passed: null, notes: [], error, createdAt: record.createdAt, expiresAt: record.expiresAt, plan: null };
  }

  private failure(jobId: string): string {
    try {
      const text = this.storage.services.jobs.inlineOutput(jobId, this.storage.services.workspaceId, 'stderr', 8192);
      const message = /Animation rendering failed: ([^\r\n]+)/.exec(`${text.content}\n${text.tail ?? ''}`)?.[1];
      if (message) return message.slice(0, 1500);
    } catch { /* fall through to the generic message */ }
    return 'The animation renderer did not complete; inspect job_output for this jobId. No automatic retry.';
  }

  private async ingest(ctx: ToolCtx, jobId: string, directory: string, file: string, mimeType: string, metadata: { width?: number; height?: number; format: string }): Promise<ResourceInfoData> {
    this.check(ctx);
    const label = `anim_${createHash('sha256').update(`${jobId}:${file}`).digest('hex')}`;
    const existing = await this.storage.services.resources!.generatedForJob(ctx, label);
    if (existing) return existing;
    const bytes = this.storage.resultFile(directory, file, OUTPUT_CAP);
    return this.storage.services.resources!.ingestGenerated(ctx, bytes, mimeType as GeneratedMime, label, { provider: 'gift', ...metadata });
  }

  async report(ctx: ToolCtx, jobId: string, waitMs = 0): Promise<AnimationJobData> {
    let record = this.record(ctx, jobId);
    if (record.result) return record.result;
    if (waitMs > 0) await this.storage.services.jobs.waitForExit(jobId, waitMs);
    record = this.record(ctx, jobId);
    if (record.result) return record.result;
    const job = this.storage.services.jobs.getJobChecked(jobId, this.storage.services.workspaceId);
    if (job.status === 'running') return this.base(jobId, record, 'running');
    const pending = this.collecting.get(jobId);
    if (pending) { const result = await pending; this.record(ctx, jobId); return result; }
    const collection = this.collect(ctx, jobId, record, job.status === 'exited' && job.exitCode === 0)
      .finally(() => { this.collecting.delete(jobId); });
    this.collecting.set(jobId, collection);
    return collection;
  }

  private async collect(ctx: ToolCtx, jobId: string, record: AnimationRecord, succeeded: boolean): Promise<AnimationJobData> {
    let result: AnimationJobData;
    if (succeeded) {
      const output = BridgeResult.parse(JSON.parse(this.storage.resultFile(record.directory, 'result.json', 256 * 1024).toString('utf8')));
      if (output.operation !== record.kind) throw new DodoError('INTERNAL_ERROR', 'animation output does not match its job');
      if (output.error === null && record.kind === 'plan' && output.plan) {
        const { guide: guideFile, mask: maskFile, layout, ...rest } = output.plan;
        const [width, height] = layout.sheet;
        const guide = await this.ingest(ctx, jobId, record.directory, guideFile.file, 'image/png', { width, height, format: 'pose-guide' });
        const mask = await this.ingest(ctx, jobId, record.directory, maskFile.file, 'image/png', { width, height, format: 'edit-mask' });
        const preview = output.preview ? await this.ingest(ctx, jobId, record.directory, output.preview.file, 'image/png', { format: 'plan-preview' }) : null;
        result = { ...this.base(jobId, record, 'completed'), preview, notes: output.notes, plan: { ...rest, layout, guide, mask } };
      } else if (output.error !== null || !output.animation) result = this.base(jobId, record, 'failed', output.error ?? 'the engine produced no animation');
      else {
        const { file, mimeType, ...details } = output.animation;
        const animation = await this.ingest(ctx, jobId, record.directory, file, mimeType, { width: details.width, height: details.height, format: details.format });
        const companions: ResourceInfoData[] = [];
        for (const companion of output.companions) companions.push(await this.ingest(ctx, jobId, record.directory, companion.file, companion.mimeType, { format: 'json' }));
        const preview = output.preview ? await this.ingest(ctx, jobId, record.directory, output.preview.file, 'image/png', { format: 'contact-sheet' }) : null;
        result = { ...this.base(jobId, record, 'completed'), animation, companions, preview, details, checks: output.checks, passed: output.passed, notes: output.notes };
      }
    } else {
      const status = this.storage.services.jobs.getJobChecked(jobId, this.storage.services.workspaceId).status;
      const error = status === 'timed_out' ? 'Animation render timed out. Shorten the loop or lower the frame rate; no automatic retry was made.'
        : status === 'canceled' ? 'Animation rendering was canceled; no automatic retry was made.' : this.failure(jobId);
      result = this.base(jobId, record, 'failed', error);
    }
    this.check(ctx); record.result = result;
    this.storage.removeDirectory(record.directory);
    return result;
  }

  sweep(): void {
    for (const [jobId, record] of this.jobs) {
      if (record.expiresAt > Date.now()) continue;
      try { this.storage.services.jobs.cancel(jobId, this.storage.services.workspaceId, 100); } catch { /* already finished */ }
      this.storage.removeDirectory(record.directory); this.jobs.delete(jobId);
    }
  }

  async close(): Promise<void> {
    const ids = [...this.jobs.keys()];
    for (const jobId of ids) { try { this.storage.services.jobs.cancel(jobId, this.storage.services.workspaceId, 100); } catch { /* already finished */ } }
    await Promise.all(ids.map(id => this.storage.services.jobs.waitForExit(id, 2000).catch(() => undefined)));
    this.jobs.clear();
  }
}
