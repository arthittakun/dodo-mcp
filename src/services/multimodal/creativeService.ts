import { DodoError } from '../../errors.js';
import { digestOf, newId } from '../../util/hash.js';
import type { ToolCtx } from '../../tools/context.js';
import type { ResourceInfoData } from '../resources/contracts.js';
import { CreativeProvider, type CreativeImageInput, type CreativeVideoInput } from './creativeProvider.js';
import { cropCreativeImage, normalizeCreativeImage, gridCreativeRegions, type CreativeGrid } from './creativeImages.js';
import { CreativeModelId, creativeModelHint, isCreativeConnection, supportsCreativeVideoConnection, resolveAutoImageModel } from './creativeSettings.js';
import { loadSharpBackend } from './sharpBackend.js';
import { MediaStorage, actorKey, liveAccess } from './storage.js';
import type { CropRect } from './contracts.js';

const TTL = 24 * 60 * 60 * 1000;
const activeGlobal = new Set<string>();
const pollingGlobal = new Set<string>();
type Status = 'queued' | 'running' | 'completed' | 'failed' | 'uncertain' | 'interrupted';
export interface CreativeJobData {
  jobId: string; kind: 'image' | 'background_removal' | 'video'; status: Status;
  model: string; progress: number; resource: ResourceInfoData | null; error: string | null;
  createdAt: number; expiresAt: number; note: string;
}
interface RecordData extends CreativeJobData { epoch: string; connectionId: string; configuration: string; remoteId?: string }
export interface ImageSource { path?: string | undefined; assetId?: string | undefined; resourceId?: string | undefined }
interface ModelSelection { model?: string | undefined }
type ImageRequest = Omit<CreativeImageInput, 'model'> & ModelSelection;
type VideoRequest = Omit<CreativeVideoInput, 'model' | 'reference'> & ModelSelection & { reference?: ImageSource | undefined };
interface VideoTransform { sourceJobId: string; operation: 'edit' | 'extend'; prompt: string; seconds?: number | undefined }

/** Paid work is submitted once. Status requests only retrieve an existing remote job. */
export class CreativeService {
  private readonly active = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private readonly polling = new Map<string, Promise<CreativeJobData>>();
  private readonly pollControllers = new Map<string, AbortController>();
  private readonly unsaved = new Map<string, RecordData>();
  constructor(private readonly storage: MediaStorage) {
    // A previous image POST has no remote retrieval handle. Never silently send it again.
    if (!storage.services.installationScoped) storage.services.store.db.prepare(`UPDATE creative_jobs SET payload=json_set(payload,'$.status','interrupted','$.error','SERVER_RESTARTED')
      WHERE workspace_id=? AND json_extract(payload,'$.epoch')<>? AND json_extract(payload,'$.remoteId') IS NULL
      AND json_extract(payload,'$.status') IN ('queued','running')`).run(storage.services.workspaceId, storage.services.epoch);
  }
  private check(ctx: ToolCtx, scope: 'dodo:read' | 'dodo:exec' = 'dodo:exec'): void {
    this.storage.check(); liveAccess(ctx, scope); ctx.revalidate?.();
    if (ctx.principal.expiresAt !== undefined && ctx.principal.expiresAt * 1000 <= Date.now()) throw new DodoError('AUTH_REQUIRED', 'client authorization expired');
  }
  private configuration(ctx: ToolCtx, scope: 'dodo:read' | 'dodo:exec' = 'dodo:exec') {
    this.check(ctx, scope);
    const installation = this.storage.services.installation;
    if (!installation) throw new DodoError('NOT_SUPPORTED', 'creative media needs the installation provider settings');
    const settings = installation.ai.settings, config = settings.media();
    if (!config.connectionId) throw new DodoError('AUTH_REQUIRED', 'configure an image provider URL and API key in Local Config > Providers > Creative Media');
    const connection = settings.connection(config.connectionId);
    if (!isCreativeConnection(connection)) throw new DodoError('NOT_SUPPORTED', 'Creative Media needs an enabled OpenAI-compatible Images or Gemini image connection');
    return { settings, config, connection, digest: digestOf({ connection, imageModel: config.imageModel, videoModel: config.videoModel }) };
  }
  private videoConfiguration(ctx: ToolCtx) {
    const cfg = this.configuration(ctx);
    if (!cfg.config.videoEnabled || !cfg.config.videoModel) throw new DodoError('NOT_SUPPORTED', 'video compatibility is not configured; select a supported connection and model in Creative Media');
    if (!supportsCreativeVideoConnection(cfg.connection)) throw new DodoError('NOT_SUPPORTED', 'OpenAI Videos API is retired; use an explicitly configured compatible video connection');
    return cfg;
  }
  /** Metadata-only discovery for the calling AI; does not submit a paid render. */
  async models(ctx: ToolCtx, options: { query?: string | undefined; limit: number; cursor?: number | undefined }) {
    const { query, limit, cursor = 0 } = options;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(cursor) || cursor < 0 || cursor > 200 || (query !== undefined && (typeof query !== 'string' || query.length > 200))) throw new DodoError('INVALID_INPUT', 'invalid model discovery query or pagination');
    const cfg = this.configuration(ctx, 'dodo:read');
    const validate = () => {
      const current = this.configuration(ctx, 'dodo:read');
      if (current.digest !== cfg.digest) throw new DodoError('FORBIDDEN', 'media configuration changed during model discovery');
      return current;
    };
    const release = cfg.settings.lease(cfg.connection.id);
    try {
      const advertised = await cfg.settings.models(cfg.connection.id, { beforeSend: validate });
      const current = validate();
      const needle = query?.trim().toLowerCase() ?? '';
      const ids = [...new Set(advertised.map(item => item.id).filter(id => CreativeModelId.safeParse(id).success))]
        .filter(id => !needle || id.toLowerCase().includes(needle)).sort();
      return {
        protocol: cfg.connection.protocol,
        imageModel: cfg.config.imageModel,
        videoModel: cfg.config.videoModel,
        videoEnabled: current.config.videoEnabled && supportsCreativeVideoConnection(current.connection),
        models: ids.slice(cursor, cursor + limit).map(id => ({ id, mediaHint: creativeModelHint(id), hintSource: 'name' as const })),
        nextCursor: cursor + limit < ids.length ? cursor + limit : null,
        note: 'Provider-advertised model IDs. mediaHint is inferred only from the name, not proof of API capabilities or quality. Choose a suitable model for this task and pass its exact ID to image_generate, image_remove_background or video_generate; discovery does not create media.',
      };
    } finally { release(); }
  }
  status(ctx: ToolCtx) {
    liveAccess(ctx, 'dodo:read'); this.storage.check();
    const settings = this.storage.services.installation?.ai.settings;
    const config = settings?.media();
    let available = false, videoAvailable = false;
    try { this.configuration(ctx); available = true; } catch { /* Read status never requests credentials or a model. */ }
    try { this.videoConfiguration(ctx); videoAvailable = true; } catch { /* Availability only, no inference. */ }
    return { enabled: Boolean(config?.connectionId), available, imageModel: config?.imageModel ?? 'auto', videoModel: config?.videoModel ?? '', videoAvailable,
      videoNote: 'OpenAI Videos API retired on 2026-09-24. Video tools require explicit compatible-provider configuration; no video model is selected by default.',
      localCrop: true, imageUploadEnabled: true, modelCalls: false as const,
      note: 'Cloud creation is explicit and may cost money. Crop runs locally. Background removal is a generative edit and can alter details. No 3D tools.' };
  }
  private resources() {
    const resources = this.storage.services.resources;
    if (!resources) throw new DodoError('NOT_SUPPORTED', 'immutable media resource store is unavailable');
    return resources;
  }
  async imageSource(ctx: ToolCtx, input: ImageSource): Promise<{ bytes: Buffer; guard: () => void }> {
    this.check(ctx);
    if ([input.path, input.assetId, input.resourceId].filter(v => v !== undefined).length !== 1) throw new DodoError('INVALID_INPUT', 'provide exactly one path, assetId or resourceId');
    if (input.path !== undefined) {
      const source = this.storage.services.wfs.readFileBytes(input.path, Math.min(16 * 1024 * 1024, this.storage.services.limits.readFileBytes));
      const guard = () => { this.check(ctx); const p = this.storage.services.wfs.resolve(source.rel); this.storage.services.wfs.assertRegularFileForDirectAccess(p); };
      return { bytes: source.bytes, guard };
    }
    if (input.assetId !== undefined) {
      const asset = this.storage.get(ctx.principal, input.assetId);
      if (asset.meta.kind !== 'image') throw new DodoError('INVALID_INPUT', 'source asset is not an image');
      return { bytes: asset.bytes, guard: () => { this.check(ctx); this.storage.get(ctx.principal, input.assetId!); } };
    }
    const resources = this.resources(), info = await resources.inspect(ctx, input.resourceId!);
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(info.mimeType) || info.bytes > 16 * 1024 * 1024) throw new DodoError('INVALID_INPUT', 'source resource must be a bounded raster image');
    const bytes = await resources.cas.readRange(info.sha256, info.bytes, 0, info.bytes);
    return { bytes, guard: () => { this.check(ctx); if (info.expiresAt <= Date.now()) throw new DodoError('NOT_FOUND', 'source image resource expired before use'); } };
  }
  async crop(ctx: ToolCtx, input: ImageSource, regions?: CropRect[], grid?: CreativeGrid) {
    if ((regions === undefined) === (grid === undefined)) throw new DodoError('INVALID_INPUT', 'provide exactly one regions or grid');
    const source = await this.imageSource(ctx, input);
    let selected = regions;
    if (grid) { const image = await normalizeCreativeImage(source.bytes); selected = gridCreativeRegions(image.width, image.height, grid); }
    const images = await cropCreativeImage(source.bytes, selected!);
    source.guard();
    const resources: ResourceInfoData[] = [];
    for (const image of images) { source.guard(); resources.push(await this.resources().ingestGenerated(ctx, image.bytes, 'image/png', newId('crop'), { width: image.width, height: image.height, format: 'png' })); }
    return { resources, note: 'Lossless PNG crops preserve transparency. Coordinates use encoded source pixels before EXIF rotation. No network or model calls.' };
  }
  private save(ctx: ToolCtx, record: RecordData): void {
    this.storage.services.store.db.prepare('INSERT INTO creative_jobs(id,workspace_id,owner,payload,updated_at,expires_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at')
      .run(record.jobId, this.storage.services.workspaceId, actorKey(ctx.principal), JSON.stringify(record), Date.now(), record.expiresAt);
  }
  private get(ctx: ToolCtx, id: string): RecordData {
    this.check(ctx);
    const row = this.storage.services.store.db.prepare('SELECT payload FROM creative_jobs WHERE id=? AND workspace_id=? AND owner=? AND expires_at>?').get(id, this.storage.services.workspaceId, actorKey(ctx.principal), Date.now()) as { payload: string } | undefined;
    if (!row) throw new DodoError('NOT_FOUND', 'unknown or expired creative job for this client/workspace');
    const pendingSave = this.unsaved.get(id);
    const record = pendingSave ?? JSON.parse(row.payload) as RecordData;
    if (pendingSave) {
      // Retry bookkeeping only. A failed receipt write must never repeat a paid POST.
      try { this.save(ctx, record); this.unsaved.delete(id); } catch { /* retain the truthful volatile receipt */ }
    }
    if (record.epoch !== this.storage.services.epoch && !record.remoteId && ['queued', 'running'].includes(record.status)) {
      if (this.storage.services.installationScoped) return { ...record, status: 'uncertain', error: 'SERVER_INSTANCE_CHANGED', note: 'This job was submitted by another server instance. Its outcome may be uncertain; inspect this job again rather than resubmitting a paid request.' };
      record.status = 'interrupted'; record.error = 'SERVER_RESTARTED'; record.note = 'Work was interrupted; its outcome may be uncertain. It was not automatically resubmitted.'; this.save(ctx, record);
    }
    return record;
  }
  private view(record: RecordData): CreativeJobData {
    const { jobId, kind, status, model, progress, resource, error, createdAt, expiresAt, note } = record;
    return { jobId, kind, status, model, progress, resource, error, createdAt, expiresAt, note };
  }
  private rememberUnsaved(record: RecordData): void {
    record.status = 'uncertain'; record.error = 'RECEIPT_PERSISTENCE_FAILED';
    record.note = 'Final job state could not be saved. Inspect existing output; no paid request was repeated.';
    if (this.unsaved.size >= 128) this.unsaved.delete(this.unsaved.keys().next().value!);
    this.unsaved.set(record.jobId, record);
  }
  async start(ctx: ToolCtx, kind: RecordData['kind'], input: ImageRequest | VideoRequest | VideoTransform | (ImageSource & ModelSelection)): Promise<CreativeJobData> {
    const video = kind === 'video' && !('sourceJobId' in input) ? input as VideoRequest : undefined;
    const transform = kind === 'video' && 'sourceJobId' in input ? input : undefined;
    const configForRequest = () => kind === 'video' ? this.videoConfiguration(ctx) : this.configuration(ctx);
    const cfg = configForRequest(); this.resources();
    if (kind !== 'video') await loadSharpBackend(); // Fail before spending if the output decoder is unavailable.
    let source: Awaited<ReturnType<CreativeService['imageSource']>> | undefined;
    let image: Buffer | undefined;
    if (kind === 'background_removal') { source = await this.imageSource(ctx, input as ImageSource); image = (await normalizeCreativeImage(source.bytes)).bytes; source.guard(); }
    if (video?.reference) {
      source = await this.imageSource(ctx, video.reference);
      const normalized = await normalizeCreativeImage(source.bytes);
      if (`${normalized.width}x${normalized.height}` !== video.size) throw new DodoError('INVALID_INPUT', 'video reference dimensions must exactly match size; crop/resize the source first');
      image = normalized.bytes; source.guard();
    }
    let parent: RecordData | undefined;
    const checkParent = () => {
      if (!transform) return;
      const value = this.get(ctx, transform.sourceJobId);
      if (value.kind !== 'video' || value.status !== 'completed' || !value.remoteId) throw new DodoError('INVALID_INPUT', 'video editing/extension requires a completed owned video job');
      if (value.configuration !== cfg.digest || value.connectionId !== cfg.connection.id) throw new DodoError('FORBIDDEN', 'source video belongs to another media connection/configuration');
      parent = value;
    };
    checkParent();
    const release = cfg.settings.lease(cfg.connection.id);
    let key: string;
    try { key = await cfg.settings.credential(cfg.connection); } catch (error) { release(); throw error; }
    let provider: CreativeProvider;
    const requested = !transform && 'model' in input && input.model !== undefined ? CreativeModelId.safeParse(input.model) : undefined;
    if (requested && !requested.success) { release(); throw new DodoError('INVALID_INPUT', 'invalid creative model ID'); }
    const selected = requested?.success && requested.data.toLowerCase() !== 'auto' ? requested.data : undefined;
    let model = parent?.model ?? selected ?? (kind === 'video' ? cfg.config.videoModel : cfg.config.imageModel);
    if (cfg.connection.protocol === 'gemini') model = model.replace(/^models\//, '');
    if (!CreativeModelId.safeParse(model).success) { release(); throw new DodoError('INVALID_INPUT', 'invalid creative model ID'); }
    try {
      provider = new CreativeProvider(cfg.connection, key, cfg.settings.ports); configForRequest(); source?.guard(); checkParent();
      if (kind !== 'video' && model.toLowerCase() === 'auto') {
        const models = await cfg.settings.models(cfg.connection.id, { beforeSend: () => {
          if (configForRequest().digest !== cfg.digest) throw new DodoError('FORBIDDEN', 'media configuration changed during model discovery');
          source?.guard(); checkParent();
        } }).catch((error: unknown) => {
          // Discovery is metadata-only and precedes every paid submission. A
          // transport/parse failure here is safe to retry with the same key.
          if (error instanceof DodoError && error.code !== 'CONFLICT') throw error;
          throw new DodoError('NOT_SUPPORTED', 'image model discovery is unavailable; retry discovery or choose a Model ID manually');
        });
        if (configForRequest().digest !== cfg.digest) throw new DodoError('FORBIDDEN', 'media configuration changed during model discovery');
        model = resolveAutoImageModel(cfg.connection.protocol, models.map(item => item.id));
        source?.guard();
      }
    }
    catch (error) { release(); throw error; }
    try {
      this.sweep();
      const count = this.storage.services.store.db.prepare('SELECT count(*) AS n FROM creative_jobs WHERE workspace_id=? AND owner=? AND expires_at>?').get(this.storage.services.workspaceId, actorKey(ctx.principal), Date.now()) as { n: number };
      const pending = this.storage.services.store.db.prepare(`SELECT id,workspace_id,json_extract(payload,'$.remoteId') AS remote_id FROM creative_jobs WHERE expires_at>? AND json_extract(payload,'$.status') IN ('queued','running')`).all(Date.now()) as Array<{ id: string; workspace_id: string; remote_id: string | null }>;
      // A stale image row in an unopened project is not a live render. Known remote
      // video handles still count after restart; local submissions count while active.
      const remote = pending.filter(r => r.remote_id !== null || activeGlobal.has(r.id));
      if (this.active.size >= 2 || activeGlobal.size >= 4 || count.n >= 32 || remote.filter(r => r.workspace_id === this.storage.services.workspaceId).length >= 2 || remote.length >= 4) throw new DodoError('RESOURCE_LIMIT', 'creative media job budget reached; collect current jobs or wait for history expiry');
    } catch (error) { release(); throw error; }
    const jobId = newId('creative'), record: RecordData = { jobId, kind, status: 'queued', model,
      progress: 0, resource: null, error: null, createdAt: Date.now(), expiresAt: Date.now() + TTL, note: 'Submitted once. Poll creative_job with this jobId; never repeat a paid request to check progress.',
      epoch: this.storage.services.epoch, connectionId: cfg.connection.id, configuration: cfg.digest };
    try { this.save(ctx, record); } catch (error) { release(); throw error; }
    const controller = new AbortController(); let dispatched = false;
    const beforeSend = () => { cfg.settings.assertCredential(cfg.connection, key); const current = configForRequest(); if (current.digest !== record.configuration) throw new DodoError('FORBIDDEN', 'media configuration changed'); source?.guard(); checkParent(); record.status = 'running'; this.save(ctx, record); dispatched = true; };
    activeGlobal.add(jobId);
    const promise = Promise.resolve().then(async () => {
      if (kind === 'video') {
        const job = transform ? transform.operation === 'edit'
          ? await provider.editVideo({ id: parent!.remoteId!, prompt: transform.prompt }, controller.signal, beforeSend)
          : await provider.extendVideo({ id: parent!.remoteId!, prompt: transform.prompt, seconds: transform.seconds! }, controller.signal, beforeSend)
          : await provider.createVideo({ model: record.model, prompt: video!.prompt, size: video!.size, seconds: video!.seconds, ...(image ? { reference: image } : {}) }, controller.signal, beforeSend);
        record.remoteId = job.id; record.progress = job.progress; record.status = job.status === 'failed' ? 'failed' : 'running';
        if (job.status === 'failed') record.error = 'PROVIDER_RENDER_FAILED';
        record.note = 'Remote render submitted. Call creative_job to retrieve its status and completed MP4; no render is resubmitted.';
      } else {
        const result = kind === 'background_removal' ? await provider.removeBackground({ model: record.model, image: image! }, controller.signal, beforeSend)
          : await provider.generateImage({ ...input as Omit<CreativeImageInput, 'model'>, model: record.model }, controller.signal, beforeSend);
        this.configuration(ctx); source?.guard();
        const transparent = kind === 'background_removal' || (input as Partial<CreativeImageInput>).background === 'transparent';
        const normalized = await normalizeCreativeImage(result.bytes, transparent);
        record.resource = await this.resources().ingestGenerated(ctx, normalized.bytes, 'image/png', jobId, { width: normalized.width, height: normalized.height, format: 'png' });
        record.status = 'completed'; record.progress = 100;
      }
    }).catch((error: unknown) => {
      const rejected = error instanceof DodoError && [400, 401, 403, 404, 405, 413, 422].includes(Number(error.detail?.['httpStatus']));
      record.status = dispatched && !rejected ? 'uncertain' : 'failed'; record.error = error instanceof DodoError ? error.code : 'PROCESS_ERROR';
      record.note = 'Request was not retried. An uncertain result may already have consumed provider credits; inspect this job before starting another.';
    }).finally(() => {
      try { this.save(ctx, record); } finally { release(); this.active.delete(jobId); activeGlobal.delete(jobId); }
    });
    // A rejected persistence write must never escape as an unhandled rejection or trigger another paid call.
    const guarded = promise.catch(() => { this.rememberUnsaved(record); });
    this.active.set(jobId, { controller, promise: guarded });
    return this.view(record);
  }
  async report(ctx: ToolCtx, id: string): Promise<CreativeJobData> {
    const record = this.get(ctx, id);
    if (!record.remoteId || record.resource || record.status === 'failed' || record.status === 'completed' || this.active.has(id)) return this.view(record);
    const pending = this.polling.get(id); if (pending) return pending;
    if (this.polling.size >= 2 || pollingGlobal.size >= 4) throw new DodoError('RESOURCE_LIMIT', 'creative media collection limit reached; wait for current downloads');
    pollingGlobal.add(id);
    const promise = this.pollVideo(ctx, record).finally(() => { this.polling.delete(id); pollingGlobal.delete(id); });
    this.polling.set(id, promise); return promise;
  }
  private async pollVideo(ctx: ToolCtx, record: RecordData): Promise<CreativeJobData> {
    const cfg = this.videoConfiguration(ctx);
    if (cfg.digest !== record.configuration || cfg.connection.id !== record.connectionId) throw new DodoError('FORBIDDEN', 'creative job connection changed; restore its reviewed connection before polling');
    const release = cfg.settings.lease(cfg.connection.id);
    const controller = new AbortController();
    this.pollControllers.set(record.jobId, controller);
    let key: string;
    const check = () => { cfg.settings.assertCredential(cfg.connection, key); this.check(ctx); if (this.videoConfiguration(ctx).digest !== record.configuration) throw new DodoError('FORBIDDEN', 'media configuration changed'); };
    try {
      key = await cfg.settings.credential(cfg.connection);
      const provider = new CreativeProvider(cfg.connection, key, cfg.settings.ports);
      const job = await provider.videoStatus(record.remoteId!, controller.signal, check);
      check(); record.progress = job.progress;
      if (job.status === 'failed') { record.status = 'failed'; record.error = 'PROVIDER_RENDER_FAILED'; }
      else if (job.status === 'completed') {
        const bytes = await provider.videoContent(record.remoteId!, controller.signal, check); check();
        record.resource = await this.resources().ingestGenerated(ctx, bytes, 'video/mp4', record.jobId, { format: 'mp4' }); record.status = 'completed'; record.progress = 100;
      } else record.status = 'running';
      try { this.save(ctx, record); } catch { this.rememberUnsaved(record); }
      return this.view(record);
    } finally { this.pollControllers.delete(record.jobId); release(); }
  }
  sweep(): void {
    this.storage.services.store.db.prepare('DELETE FROM creative_jobs WHERE expires_at<=?').run(Date.now());
    for (const [id, record] of this.unsaved) if (record.expiresAt <= Date.now()) this.unsaved.delete(id);
  }
  async close(): Promise<void> {
    for (const job of this.active.values()) job.controller.abort();
    for (const controller of this.pollControllers.values()) controller.abort();
    await Promise.allSettled([...this.active.values()].map(job => job.promise));
    await Promise.allSettled(this.polling.values());
  }
}
