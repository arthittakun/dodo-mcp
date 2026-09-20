import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DodoError } from '../../errors.js';
import { newId } from '../../util/hash.js';
import { resolveTrustedExecutable } from '../../platform/execResolve.js';
import { findSpeechEngine } from '../../platform/speech.js';
import { MediaStorage, actorKey, type Actor } from './storage.js';
import { WorkerSpec, WorkerResult, Transcript, type WorkerSpecData, type WorkerResultData, type AssetMetadata, type TranscriptSegment } from './contracts.js';

interface Source { id: string; owner: string; directory: string; path: string; sourcePath: string; hash: string; size: number; expiresAt: number }
interface MediaJob { inputDirectory?: string; owner: string; mediaId: string | null; directory: string; operation: WorkerSpecData['operation']; sandboxed: string | null; assets?: AssetMetadata[]; metadata?: WorkerResultData['metadata']; notes: string[]; expiresAt: number }
export function parseSubtitles(text: string): TranscriptSegment[] {
  const lines = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n'); const result: TranscriptSegment[] = [];
  const seconds = (value: string): number => { const numbers = value.replace(',', '.').split(':').map(Number); return numbers.reduce((a, v) => a * 60 + v, 0); };
  const timestamp = /((?:\d{1,3}:)?\d{2}:\d{2}[.,]\d{3})\s+-->\s+((?:\d{1,3}:)?\d{2}:\d{2}[.,]\d{3})/;
  for (let i = 0; i < lines.length; i++) {
    const match = timestamp.exec(lines[i]!); if (!match) continue;
    const startSec = seconds(match[1]!), endSec = seconds(match[2]!); const content: string[] = [];
    while (++i < lines.length && lines[i]!.trim() !== '') content.push(lines[i]!);
    if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || startSec < 0 || endSec < startSec || endSec > 86400) throw new DodoError('INVALID_INPUT', 'invalid subtitle timestamps');
    result.push({ startSec, endSec, text: content.join('\n').replace(/<[^>]*>/g, '').slice(0, 4000) });
    if (result.length > 10000) throw new DodoError('RESOURCE_LIMIT', 'subtitle cue limit exceeded');
  }
  if (!result.length) throw new DodoError('INVALID_INPUT', 'no valid SRT/WebVTT cues found');
  return result.sort((a, b) => a.startSec - b.startSec);
}
export class MediaService {
  readonly sources = new Map<string, Source>();
  readonly jobs = new Map<string, MediaJob>();
  private pendingOpens = 0;
  constructor(private readonly storage: MediaStorage) {}
  program(name: string): string | null { try { return resolveTrustedExecutable(name, this.storage.services.wfs.root, { allowBatch: false }); } catch { return null; } }
  capabilities() {
    const defaultModel = path.join(this.storage.configDir, 'models', 'ggml-tiny.bin');
    return { ffmpeg: this.program('ffmpeg') !== null, ffprobe: this.program('ffprobe') !== null, whisper: this.program('whisper-cli') !== null || this.program('whisper-cpp') !== null,
      defaultModelPresent: this.modelExists(defaultModel), modelLocation: 'DODO config directory/models/ggml-tiny.bin, or a guarded workspace modelFile', speechSynthesis: findSpeechEngine(this.storage.services.wfs.root) !== undefined,
      limits: { sourceBytes: 512 * 1024 * 1024, cachedSourceBytes: 1024 * 1024 * 1024, framesPerCall: 8, audioSeconds: 120, transcriptionSeconds: 600 },
      notes: ['No automatic model download or microphone/system audio capture.', 'Tools operate on local workspace media and synthesized speech. Cloud analysis depends on the connected client.'] };
  }
  private modelExists(file: string): boolean { try { const st = fs.lstatSync(file); return st.isFile() && !st.isSymbolicLink() && st.nlink === 1 && st.size > 1000000 && st.size <= 512 * 1024 * 1024; } catch { return false; } }
  private requireProgram(name: string): string { const result = this.program(name); if (!result) throw new DodoError('NOT_SUPPORTED', `${name} is not on the trusted PATH; install the local media dependency first`); return result; }
  private source(actor: Actor, id: string): Source {
    this.storage.check(); const result = this.sources.get(id);
    if (!result || result.owner !== actorKey(actor) || result.expiresAt < Date.now()) throw new DodoError('NOT_FOUND', 'unknown/expired media source for this client');
    this.storage.services.wfs.resolve(result.sourcePath, { allowMissing: true }); return result;
  }
  private async launch(actor: Actor, operation: WorkerSpecData['operation'], mediaId: string | null, input: string, extras: Partial<WorkerSpecData> = {}): Promise<string> {
    this.storage.check(); if (this.jobs.size >= 32) throw new DodoError('RESOURCE_LIMIT', 'media job limit reached; close completed media handles');
    const ffmpeg = this.requireProgram('ffmpeg'), ffprobe = this.requireProgram('ffprobe');
    const workerUrls = [new URL('./mediaWorker.js', import.meta.url), new URL('../../../dist/services/multimodal/mediaWorker.js', import.meta.url)];
    const worker = workerUrls.map(url => fileURLToPath(url)).find(p => fs.existsSync(p)); if (!worker) throw new DodoError('NOT_SUPPORTED', 'media worker is not built; run npm run build');
    const directory = this.storage.directory();
    try {
      const spec = WorkerSpec.parse({ operation, input, directory, ffmpeg, ffprobe, startSec: 0, durationSec: 30, times: [], maxEdge: 1280, language: 'auto', ...extras });
      const specFile = path.join(directory, 'spec.json'); fs.writeFileSync(specFile, JSON.stringify(spec), { mode: 0o600, flag: 'wx' });
      const s = this.storage.services;
      const job = await s.jobs.startProtected({ workspaceId: s.workspaceId, epoch: s.epoch, principal: actor.grantId, kind: 'exec', program: 'node', args: [worker, specFile], cwdRel: '.', timeoutMs: operation === 'transcribe' ? 600000 : 180000, stdin: false, network: false });
      this.jobs.set(job.jobId, { owner: actorKey(actor), mediaId, directory, operation, sandboxed: job.sandboxed, notes: [], expiresAt: Date.now() + 1800000 }); return job.jobId;
    } catch (err) { this.storage.removeDirectory(directory); throw err; }
  }
  async open(actor: Actor, file: string, waitMs: number) {
    this.storage.check(); this.requireProgram('ffprobe'); this.requireProgram('ffmpeg');
    if (this.sources.size + this.pendingOpens >= 8) throw new DodoError('RESOURCE_LIMIT', 'at most eight open media sources');
    this.pendingOpens++; const directory = this.storage.directory(); let source: Source | undefined;
    try {
      const copied = await this.storage.copySource(file, directory);
      source = { id: newId('media'), owner: actorKey(actor), directory, ...copied, expiresAt: Date.now() + 1800000 }; this.sources.set(source.id, source);
      const jobId = await this.launch(actor, 'probe', source.id, source.path); await this.storage.services.jobs.waitForExit(jobId, waitMs);
      return { mediaId: source.id, sourcePath: source.sourcePath, sourceHash: source.hash, bytes: source.size, expiresAt: source.expiresAt, job: this.report(actor, jobId) };
    } catch (err) { if (source) { this.sources.delete(source.id); this.storage.releaseSource(source.size); } this.storage.removeDirectory(directory); throw err; }
    finally { this.pendingOpens--; }
  }
  async extract(actor: Actor, id: string, kind: 'frames' | 'audio', opts: { times: number[]; startSec: number; durationSec: number; maxEdge: number; waitMs: number }) {
    const source = this.source(actor, id);
    if (kind === 'frames' && !opts.times.length) throw new DodoError('INVALID_INPUT', 'frames requires explicit timestamps');
    if (kind === 'audio' && opts.durationSec > 120) throw new DodoError('RESOURCE_LIMIT', 'audio excerpt cap is 120 seconds');
    const jobId = await this.launch(actor, kind, source.id, source.path, { times: opts.times, startSec: opts.startSec, durationSec: opts.durationSec, maxEdge: opts.maxEdge });
    await this.storage.services.jobs.waitForExit(jobId, opts.waitMs); return this.report(actor, jobId);
  }
  async transcribe(actor: Actor, id: string, opts: { startSec: number; durationSec: number; language: string; modelFile?: string | undefined; waitMs: number }) {
    const source = this.source(actor, id); const whisper = this.program('whisper-cli') ?? this.program('whisper-cpp');
    if (!whisper) throw new DodoError('NOT_SUPPORTED', 'install whisper.cpp (whisper-cli/whisper-cpp) on the trusted PATH');
    let model = path.join(this.storage.configDir, 'models', 'ggml-tiny.bin');
    if (opts.modelFile) { const resolved = this.storage.services.wfs.resolve(opts.modelFile); this.storage.services.wfs.assertRegularFileForDirectAccess(resolved); model = resolved.abs; }
    else { const parent = path.dirname(model); try { if (fs.lstatSync(parent).isSymbolicLink()) throw new DodoError('PATH_DENIED', 'model directory must not be a symlink'); } catch (err) { if (err instanceof DodoError) throw err; } }
    if (!this.modelExists(model)) throw new DodoError('NOT_SUPPORTED', 'local GGML Whisper model missing or invalid; supply modelFile or install models/ggml-tiny.bin in the DODO config directory');
    const jobId = await this.launch(actor, 'transcribe', source.id, source.path, { whisper, model, startSec: opts.startSec, durationSec: opts.durationSec, language: opts.language });
    await this.storage.services.jobs.waitForExit(jobId, opts.waitMs); return this.report(actor, jobId);
  }
  async synthesize(actor: Actor, text: string, voice: string | undefined, waitMs: number) {
    const speech = findSpeechEngine(this.storage.services.wfs.root);
    if (!speech) throw new DodoError('NOT_SUPPORTED', 'no working local speech engine or voice; run dodo setup');
    this.requireProgram('ffmpeg'); this.requireProgram('ffprobe');
    const directory = this.storage.directory(), input = path.join(directory, 'speech.txt');
    // Disable embedded speech directives; never put private input text in argv or job logs.
    fs.writeFileSync(input, text.replace(/\[\[/g, '[ ['), { flag: 'wx', mode: 0o600 });
    let jobId: string;
    try { jobId = await this.launch(actor, 'speak', null, input, { speechProgram: speech.program, speechKind: speech.kind, ...(voice ? { voice } : {}) }); }
    catch (err) { this.storage.removeDirectory(directory); throw err; }
    this.jobs.get(jobId)!.inputDirectory = directory;
    await this.storage.services.jobs.waitForExit(jobId, waitMs); return this.report(actor, jobId);
  }
  report(actor: Actor, jobId: string) {
    this.storage.check(); const record = this.jobs.get(jobId);
    if (!record || record.owner !== actorKey(actor) || record.expiresAt < Date.now()) throw new DodoError('NOT_FOUND', 'unknown media job for this client');
    if (record.mediaId) this.source(actor, record.mediaId);
    const job = this.storage.services.jobs.getJobChecked(jobId, this.storage.services.workspaceId); let error: string | null = null;
    if (job.status === 'exited' && job.exitCode === 0 && record.assets === undefined) {
      try {
        const result = WorkerResult.parse(JSON.parse(this.storage.resultFile(record.directory, 'result.json', 65536).toString('utf8')));
        if (result.operation !== record.operation) throw new Error('operation mismatch');
        const assets: AssetMetadata[] = [];
        for (const output of result.files) {
          let bytes = this.storage.resultFile(record.directory, output.name);
          if (output.kind === 'transcript') bytes = Buffer.from(JSON.stringify(Transcript.parse({ ...JSON.parse(bytes.toString('utf8')), mediaId: record.mediaId })));
          const guard = record.mediaId ? () => { this.source(actor, record.mediaId!); } : undefined;
          assets.push(this.storage.put(actor, output.kind, output.mimeType, bytes, { ...(output.timeSec !== undefined ? { timeSec: output.timeSec } : {}), ...(output.endSec !== undefined ? { endSec: output.endSec } : {}), ...(guard ? { guard } : {}) }));
        }
        record.assets = assets; record.metadata = result.metadata; record.notes = result.notes;
        this.storage.removeDirectory(record.directory);
        if (record.inputDirectory) this.storage.removeDirectory(record.inputDirectory);
      } catch (err) { error = `Output unavailable/invalid: ${err instanceof DodoError ? err.code : 'INVALID_OUTPUT'}. Inspect the original job log; do not assume the media was read.`; }
    } else if (job.status !== 'running' && !(job.status === 'exited' && job.exitCode === 0)) error = 'Media processor did not complete successfully; inspect job_output. No automatic retry or sandbox downgrade.';
    return { jobId, mediaId: record.mediaId, operation: record.operation, status: error ? 'failed' : job.status, exitCode: job.exitCode, sandboxed: record.sandboxed, assets: record.assets ?? [], ...(record.metadata ? { metadata: record.metadata } : {}), notes: record.notes, error };
  }
  subtitles(actor: Actor, id: string, file: string, language: string): AssetMetadata {
    this.source(actor, id); const input = this.storage.services.wfs.readTextFile(file, Math.min(this.storage.services.limits.readFileBytes, 2 * 1024 * 1024));
    const segments = parseSubtitles(input.text), transcript = Transcript.parse({ source: 'sidecar_subtitles', language, mediaId: id, startSec: segments[0]!.startSec, endSec: Math.max(...segments.map(s => s.endSec)), segments, truncated: false });
    return this.storage.put(actor, 'transcript', 'application/json', Buffer.from(JSON.stringify(transcript)), { guard: () => { this.source(actor, id); this.storage.services.wfs.resolve(file, { allowMissing: true }); } });
  }
  search(actor: Actor, assetId: string, query: string, limit: number) {
    const asset = this.storage.get(actor, assetId); if (asset.meta.kind !== 'transcript') throw new DodoError('INVALID_INPUT', 'search needs a transcript asset');
    const transcript = Transcript.parse(JSON.parse(asset.bytes.toString('utf8'))), terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    const matches = transcript.segments.filter(s => terms.every(t => s.text.toLowerCase().includes(t)));
    return { mediaId: transcript.mediaId, source: transcript.source, matches: matches.slice(0, limit), totalMatches: matches.length, truncated: matches.length > limit, note: 'Literal transcript search only. No visual scene understanding is claimed for unsampled frames.' };
  }
  async closeSource(actor: Actor, id: string) {
    const source = this.source(actor, id), jobs = [...this.jobs].filter(([, j]) => j.mediaId === id);
    for (const [jobId] of jobs) { this.storage.services.jobs.cancel(jobId, this.storage.services.workspaceId, 100); await this.storage.services.jobs.waitForExit(jobId, 1000); }
    for (const [jobId, job] of jobs) { this.storage.removeDirectory(job.directory); this.jobs.delete(jobId); }
    this.sources.delete(id); this.storage.releaseSource(source.size); this.storage.removeDirectory(source.directory); return { closed: true, mediaId: id };
  }
  async sweep(): Promise<void> {
    const expiredSources = [...this.sources.values()].filter(s => s.expiresAt <= Date.now());
    const expiredIds = new Set(expiredSources.map(s => s.id));
    for (const [id, job] of this.jobs) if (job.expiresAt <= Date.now() || (job.mediaId !== null && expiredIds.has(job.mediaId))) {
      this.storage.services.jobs.cancel(id, this.storage.services.workspaceId, 100);
      await this.storage.services.jobs.waitForExit(id, 2000);
      this.storage.removeDirectory(job.directory); if (job.inputDirectory) this.storage.removeDirectory(job.inputDirectory); this.jobs.delete(id);
    }
    for (const source of expiredSources) { this.sources.delete(source.id); this.storage.releaseSource(source.size); this.storage.removeDirectory(source.directory); }
  }
  async close() {
    for (const [jobId] of this.jobs) { try { this.storage.services.jobs.cancel(jobId, this.storage.services.workspaceId, 100); } catch { /* already finished */ } }
    await Promise.all([...this.jobs.keys()].map(id => this.storage.services.jobs.waitForExit(id, 2000).catch(() => undefined)));
    this.jobs.clear(); this.sources.clear();
  }
}
