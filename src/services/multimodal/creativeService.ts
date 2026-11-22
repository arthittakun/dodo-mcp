import { DodoError } from '../../errors.js';
import { digestOf, newId } from '../../util/hash.js';
import type { ToolCtx, Principal } from '../../tools/context.js';
import { projectAuthority, isOwner } from '../../security/projectAuthority.js';
import type { ResourceInfoData } from '../resources/contracts.js';
import { CreativeProvider, assertCreativeEditInputBudget, type CreativeImageInput, type CreativeVideoInput } from './creativeProvider.js';
import { cropCreativeImage, normalizeCreativeImage, normalizeCreativeMask, gridCreativeRegions, type CreativeGrid } from './creativeImages.js';
import { CreativeModelId, creativeModelHint, isCreativeConnection, supportsCreativeVideoConnection, resolveAutoImageModel } from './creativeSettings.js';
import { loadSharpBackend } from './sharpBackend.js';
import { MediaStorage, actorKey, liveAccess } from './storage.js';
import type { CropRect } from './contracts.js';
import type { ResourceMetadataData } from '../resources/contracts.js';
import { CreativeArtifacts } from './creativeArtifacts.js';
import { creativeDiagnostics, type CreativeDiagnostics } from './creativeDiagnostics.js';
import { creativeSubmission } from './operations.js';

const TTL = 24 * 60 * 60 * 1000;
const activeGlobal = new Set<string>();
const pollingGlobal = new Set<string>();
type Status = 'queued' | 'running' | 'completed' | 'failed' | 'uncertain' | 'interrupted' | 'stopped';
export interface CreativeJobData {
  jobId: string; kind: 'image' | 'image_edit' | 'background_removal' | 'video'; status: Status;
  model: string; progress: number; resource: ResourceInfoData | null; error: string | null;
  createdAt: number; expiresAt: number; note: string;
  diagnostics?: CreativeDiagnostics;
}
interface RecordData extends CreativeJobData { epoch: string; connectionId: string; configuration: string; remoteId?: string; remoteComplete?: boolean; transport?: string; authority?: Principal; completedAt?: number; submissionKey?: string; submissionTool?: string; submissionHash?: string; controlRevision?: number }
export interface ImageSource { path?: string | undefined; assetId?: string | undefined; resourceId?: string | undefined }
interface ModelSelection { model?: string | undefined }
type ImageRequest = Omit<CreativeImageInput, 'model'> & ModelSelection;
/** Reference-conditioned drawing: 1-4 owned images, the first being the canvas an optional mask applies to. */
export type EditRequest = ImageRequest & { images: ImageSource[]; mask?: ImageSource | undefined };
type VideoRequest = Omit<CreativeVideoInput, 'model' | 'reference'> & ModelSelection & { reference?: ImageSource | undefined };
interface VideoTransform { sourceJobId: string; operation: 'edit' | 'extend'; prompt: string; seconds?: number | undefined }

/** Paid work is submitted once. Status requests only retrieve an existing remote job. */
export class CreativeService {
  private readonly active = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private readonly polling = new Map<string, Promise<CreativeJobData>>();
  private readonly pollControllers = new Map<string, AbortController>();
  private readonly unsaved = new Map<string, RecordData>();
  private readonly artifacts: CreativeArtifacts;
  private readonly volatileOutputs = new Map<string, { bytes: Buffer; mimeType: 'image/png' | 'video/mp4'; metadata: ResourceMetadataData }>();
  constructor(private readonly storage: MediaStorage) {
    this.artifacts = new CreativeArtifacts(storage.configDir);
    // A previous image POST has no remote retrieval handle. Never silently send it again.
    // A get() can reconcile a durable output before classifying old work. Do not
    // overwrite receipts belonging to another live installation process here.
  }
  private detached(ctx: ToolCtx): ToolCtx {
    const { expiresAt: _expiresAt, ...principal } = ctx.principal;
    const authority = ctx.principal.projectRestriction ? ctx.principal : principal;
    const next: ToolCtx = { services: ctx.services, principal: authority, trustMode: ctx.trustMode };
    next.revalidate = () => {
      const live = projectAuthority(next.services.store, authority, next.services.workspaceId);
      if (!live.scopes.includes('dodo:exec')) throw new DodoError('FORBIDDEN', 'job authorization was revoked');
    };
    next.revalidate(); return next;
  }
  private transport(connection: ReturnType<CreativeService['configuration']>['connection']): string {
    const settings = this.storage.services.installation!.ai.settings;
    const binding = settings.get<{ fingerprint: string }>('credential-binding', connection.id);
    return digestOf({ id: connection.id, baseUrl: connection.baseUrl, protocol: connection.protocol, credentialStorage: connection.credentialStorage, envVar: connection.credentialEnvVar ?? null, credential: binding?.fingerprint ?? null });
  }
  private audit(record: RecordData, event: string): void {
    try { this.storage.services.store.audit({ ...(record.authority ? { principal: record.authority.grantId } : {}), workspaceId: this.storage.services.workspaceId, tool: `creative.${event}`, refId: record.jobId, ...(record.diagnostics?.requestId ? { requestId: record.diagnostics.requestId } : {}), result: record.error ?? record.status }); } catch { this.storage.services.logEvent?.('creative.audit.failed', { jobId: record.jobId, code: 'STORAGE_UNAVAILABLE' }); }
    this.storage.services.logEvent?.(`creative.${event}`, { jobId: record.jobId, ...(record.error ? { code: record.error } : {}), ...(record.diagnostics?.httpStatus ? { httpStatus: record.diagnostics.httpStatus } : {}), ...(record.diagnostics?.requestId ? { requestId: record.diagnostics.requestId } : {}) });
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
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(cursor) || cursor < 0 || cursor > 2000 || (query !== undefined && (typeof query !== 'string' || query.length > 200))) throw new DodoError('INVALID_INPUT', 'invalid model discovery query or pagination');
    const cfg = this.configuration(ctx, 'dodo:read');
    const validate = () => {
      const current = this.configuration(ctx, 'dodo:read');
      if (current.digest !== cfg.digest) throw new DodoError('FORBIDDEN', 'media configuration changed during model discovery');
      return current;
    };
    const release = cfg.settings.lease(cfg.connection.id);
    try {
      const page = await cfg.settings.modelsPage(cfg.connection.id, { beforeSend: validate });
      const advertised = page.models;
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
        truncated: page.truncated,
        providerPages: page.pages,
        note: 'Provider-advertised model IDs. mediaHint is inferred only from the name, not proof of API capabilities or quality. Choose a suitable model for this task and pass its exact ID to image_generate, image_remove_background or video_generate; discovery does not create media.',
      };
    } finally { release(); }
  }
  status(ctx: ToolCtx) {
    liveAccess(ctx, 'dodo:read'); this.storage.check();
    const settings = this.storage.services.installation?.ai.settings;
    const config = settings?.media();
    const blockers: string[] = [], videoBlockers: string[] = [];
    if (!ctx.principal.scopes.includes('dodo:exec')) blockers.push('scope_missing');
    if (!settings || !config?.connectionId) blockers.push('connection_missing');
    if (settings && config?.connectionId) {
      const connection = settings.get<ReturnType<typeof settings.connection>>('connection', config.connectionId);
      if (!connection || !connection.enabled) blockers.push('connection_disabled');
      else if (!isCreativeConnection(connection)) blockers.push('protocol_unsupported');
      const key = settings.credentialState(config.connectionId);
      if (key.needsReentry) blockers.push('credential_reentry_required');
      else if (!key.present) blockers.push('credential_missing');
      if (connection && !supportsCreativeVideoConnection(connection)) videoBlockers.push('video_protocol_unsupported');
    }
    if (!config?.videoEnabled || !config.videoModel) videoBlockers.push('video_not_configured');
    const available = blockers.length === 0, videoAvailable = available && videoBlockers.length === 0;
    return { enabled: Boolean(config?.connectionId), available, imageModel: config?.imageModel ?? 'auto', videoModel: config?.videoModel ?? '', videoAvailable,
      videoNote: 'OpenAI Videos API retired on 2026-09-24. Video tools require explicit compatible-provider configuration; no video model is selected by default.',
      localCrop: true, imageUploadEnabled: true, modelCalls: false as const,
      blockers, videoBlockers: [...blockers, ...videoBlockers], readiness: available ? 'ready' as const : 'blocked' as const,
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
  private save(ctx: ToolCtx, record: RecordData, resume = false): void {
    const db = this.storage.services.store.db;
    db.transaction(() => {
      const row = db.prepare('SELECT payload FROM creative_jobs WHERE id=? AND workspace_id=?').get(record.jobId, this.storage.services.workspaceId) as { payload: string } | undefined;
      const stored = row ? JSON.parse(row.payload) as RecordData : undefined;
      if (stored?.status === 'stopped' && record.status !== 'stopped' && (!resume || (stored.controlRevision ?? 0) !== (record.controlRevision ?? 0))) {
        const resource = stored.resource ?? record.resource;
        Object.assign(record, stored, { resource });
      }
      db.prepare('INSERT INTO creative_jobs(id,workspace_id,owner,payload,updated_at,expires_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at,expires_at=excluded.expires_at')
        .run(record.jobId, this.storage.services.workspaceId, actorKey(ctx.principal), JSON.stringify(record), Date.now(), record.expiresAt);
    }).immediate();
  }
  private finish(record: RecordData): void { record.completedAt = Date.now(); record.expiresAt = record.completedAt + TTL; }
  private get(ctx: ToolCtx, id: string): RecordData {
    this.check(ctx);
    const row = this.storage.services.store.db.prepare(`SELECT payload FROM creative_jobs WHERE id=? AND workspace_id=? AND owner=? AND (expires_at>? OR json_extract(payload,'$.status') IN ('queued','running') OR EXISTS(SELECT 1 FROM creative_output_reservations r WHERE r.job_id=creative_jobs.id AND r.workspace_id=creative_jobs.workspace_id AND r.owner=creative_jobs.owner))`).get(id, this.storage.services.workspaceId, actorKey(ctx.principal), Date.now()) as { payload: string } | undefined;
    if (!row) throw new DodoError('NOT_FOUND', 'unknown or expired creative job for this client/workspace');
    const stored = JSON.parse(row.payload) as RecordData;
    const pendingSave = stored.status === 'stopped' ? undefined : this.unsaved.get(id);
    const record = pendingSave ?? stored;
    if (pendingSave) {
      // Retry bookkeeping only. A failed receipt write must never repeat a paid POST.
      try { this.save(ctx, record); this.unsaved.delete(id); } catch { /* retain the truthful volatile receipt */ }
    }
    return record;
  }
  private view(record: RecordData): CreativeJobData {
    const { jobId, kind, status, model, progress, resource, error, createdAt, expiresAt, note, diagnostics } = record;
    return { jobId, kind, status, model, progress, resource, error, createdAt, expiresAt, note, ...(diagnostics ? { diagnostics } : {}) };
  }
  private rememberUnsaved(record: RecordData): void {
    record.status = 'uncertain'; record.error = 'RECEIPT_PERSISTENCE_FAILED';
    record.note = 'Final job state could not be saved. Inspect existing output; no paid request was repeated.';
    if (this.unsaved.size >= 128) this.unsaved.delete(this.unsaved.keys().next().value!);
    this.unsaved.set(record.jobId, record);
  }
  private async persistOutput(ctx: ToolCtx, record: RecordData, output: { bytes: Buffer; mimeType: 'image/png' | 'video/mp4'; metadata: ResourceMetadataData }): Promise<void> {
    this.check(ctx);
    this.volatileOutputs.set(record.jobId, output);
    this.artifacts.write(this.storage.services.workspaceId, actorKey(ctx.principal), record.jobId, output.bytes, output.mimeType, output.metadata);
    record.resource = await this.resources().ingestGenerated(ctx, output.bytes, output.mimeType, record.jobId, output.metadata);
    record.status = 'completed'; record.progress = 100; record.error = null; delete record.diagnostics;
    this.finish(record);
    this.volatileOutputs.delete(record.jobId);
  }
  private async reconcileOutput(ctx: ToolCtx, record: RecordData, resume = false): Promise<boolean> {
    const existing = await this.resources().generatedForJob(ctx, record.jobId) ?? (record.resource ? await this.resources().inspect(ctx, record.resource.resourceId, record.resource.sha256) : undefined);
    if (existing) { record.resource = existing; record.status = 'completed'; record.progress = 100; record.error = null; delete record.diagnostics; this.finish(record); }
    else {
      const output = this.volatileOutputs.get(record.jobId) ?? this.artifacts.read(this.storage.services.workspaceId, actorKey(ctx.principal), record.jobId, record.kind === 'video' ? 'video/mp4' : 'image/png');
      if (!output) return false;
      this.resources().reserveGeneratedOutput(ctx, record.jobId);
      await this.persistOutput(ctx, record, output);
    }
    record.note = 'Recovered existing provider output without submitting another render.';
    this.save(ctx, record, resume); this.unsaved.delete(record.jobId); this.resources().releaseGeneratedOutput(record.jobId);
    try { this.artifacts.remove(record.jobId); } catch { /* safe private outbox remains recoverable */ }
    this.audit(record, 'recovered'); return true;
  }
  async list(ctx: ToolCtx, input: { limit: number; cursor?: number | undefined; status?: string | undefined; idempotencyKey?: string | undefined }) {
    this.check(ctx, 'dodo:read');
    const offset = input.cursor ?? 0;
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100 || !Number.isInteger(offset) || offset < 0) throw new DodoError('INVALID_INPUT', 'invalid creative history pagination');
    let jobId: string | undefined;
    if (input.idempotencyKey) {
      const rows = this.storage.services.store.db.prepare('SELECT result FROM idempotency_keys WHERE key=? AND principal=? AND workspace_id=?').all(input.idempotencyKey, ctx.principal.grantId, this.storage.services.workspaceId) as Array<{ result: string | null }>;
      for (const row of rows) { try { const value = JSON.parse(row.result ?? '{}') as { jobId?: string }; if (value.jobId) { jobId = value.jobId; break; } } catch { /* partial reservation has no receipt yet */ } }
      if (!jobId) {
        const row = this.storage.services.store.db.prepare(`SELECT id FROM creative_jobs WHERE workspace_id=? AND owner=? AND json_extract(payload,'$.submissionKey')=? LIMIT 1`).get(this.storage.services.workspaceId, actorKey(ctx.principal), input.idempotencyKey) as { id: string } | undefined;
        jobId = row?.id;
      }
      if (!jobId) return { jobs: [], nextCursor: null };
    }
    const params: unknown[] = [this.storage.services.workspaceId, actorKey(ctx.principal), Date.now()];
    let where = `workspace_id=? AND owner=? AND (expires_at>? OR json_extract(payload,'$.status') IN ('queued','running') OR EXISTS(SELECT 1 FROM creative_output_reservations r WHERE r.job_id=creative_jobs.id AND r.workspace_id=creative_jobs.workspace_id AND r.owner=creative_jobs.owner))`;
    if (input.status) { where += ` AND json_extract(payload,'$.status')=?`; params.push(input.status); }
    if (jobId) { where += ' AND id=?'; params.push(jobId); }
    const rows = this.storage.services.store.db.prepare(`SELECT payload FROM creative_jobs WHERE ${where} ORDER BY updated_at DESC,id DESC LIMIT ? OFFSET ?`).all(...params, input.limit + 1, offset) as Array<{ payload: string }>;
    return { jobs: rows.slice(0, input.limit).map(row => this.view(JSON.parse(row.payload) as RecordData)), nextCursor: rows.length > input.limit ? offset + input.limit : null };
  }
  async control(ctx: ToolCtx, input: { jobId: string; action: 'retry_save' | 'stop_tracking' }): Promise<CreativeJobData> {
    const record = this.get(ctx, input.jobId);
    if (input.action === 'retry_save') {
      if (this.active.has(record.jobId)) return this.view(record);
      return this.collectOnce(record.jobId, async () => {
        if (await this.reconcileOutput(ctx, record, true)) return this.view(record);
        if (record.remoteId) return this.pollVideo(ctx, record, true, undefined, true);
        record.note = 'No durable provider output is available yet. No new render was submitted.'; return this.view(record);
      });
    }
    if (record.status === 'completed') return this.view(record);
    this.active.get(record.jobId)?.controller.abort(); this.pollControllers.get(record.jobId)?.abort();
    record.controlRevision = (record.controlRevision ?? 0) + 1;
    record.status = 'stopped'; record.error = 'CANCELED'; record.note = 'Stopped local tracking only. Provider cancellation and refunds are not guaranteed; no new render was submitted.';
    this.finish(record); this.save(ctx, record); this.resources().releaseGeneratedOutput(record.jobId); this.audit(record, 'stopped'); return this.view(record);
  }
  adminList(ctx: ToolCtx, input: { limit: number; cursor?: number | undefined; status?: string | undefined }) {
    if (!isOwner(ctx.principal)) throw new DodoError('FORBIDDEN', 'owner media history is private');
    this.check(ctx, 'dodo:read');
    const offset = input.cursor ?? 0;
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100 || !Number.isInteger(offset) || offset < 0) throw new DodoError('INVALID_INPUT', 'invalid media history page');
    const rows = this.storage.services.store.db.prepare(`SELECT payload FROM creative_jobs WHERE workspace_id=? AND (? IS NULL OR json_extract(payload,'$.status')=?) ORDER BY updated_at DESC,id DESC LIMIT ? OFFSET ?`).all(this.storage.services.workspaceId, input.status ?? null, input.status ?? null, input.limit + 1, offset) as Array<{ payload: string }>;
    return { jobs: rows.slice(0, input.limit).map(row => this.view(JSON.parse(row.payload) as RecordData)), nextCursor: rows.length > input.limit ? offset + input.limit : null };
  }
  async adminControl(ctx: ToolCtx, input: { jobId: string; action: 'retry_save' | 'stop_tracking' }): Promise<CreativeJobData> {
    if (!isOwner(ctx.principal)) throw new DodoError('FORBIDDEN', 'owner media history is private');
    this.check(ctx);
    const row = this.storage.services.store.db.prepare('SELECT owner,payload FROM creative_jobs WHERE id=? AND workspace_id=?').get(input.jobId, this.storage.services.workspaceId) as { owner: string; payload: string } | undefined;
    if (!row) throw new DodoError('NOT_FOUND', 'unknown creative job');
    const record = JSON.parse(row.payload) as RecordData;
    if (input.action === 'stop_tracking') {
      if (record.status === 'completed') return this.view(record);
      this.active.get(record.jobId)?.controller.abort(); this.pollControllers.get(record.jobId)?.abort();
      record.controlRevision = (record.controlRevision ?? 0) + 1;
      record.status = 'stopped'; record.error = 'CANCELED'; record.note = 'The local owner stopped tracking. This does not confirm provider cancellation or a refund.';
      this.finish(record); this.save(ctx, record); this.resources().releaseGeneratedOutput(record.jobId); this.audit(record, 'owner_stopped'); return this.view(record);
    }
    if (!record.authority || actorKey(record.authority) !== row.owner) throw new DodoError('NOT_SUPPORTED', 'legacy work must be collected by its original client');
    const original = this.detached({ services: ctx.services, principal: record.authority, trustMode: ctx.trustMode });
    const validate = original.revalidate!;
    original.revalidate = () => { ctx.revalidate?.(); if (ctx.principal.expiresAt !== undefined && ctx.principal.expiresAt <= Date.now() / 1000) throw new DodoError('AUTH_REQUIRED', 'owner session expired'); validate(); };
    const result = await this.control(original, input); ctx.revalidate?.(); return result;
  }
  private async reconcileCapacity(): Promise<void> {
    const rows = this.storage.services.store.db.prepare(`SELECT owner,payload FROM creative_jobs WHERE workspace_id=? AND json_extract(payload,'$.status') IN ('queued','running') AND json_extract(payload,'$.remoteId') IS NOT NULL LIMIT 8`).all(this.storage.services.workspaceId) as Array<{ owner: string; payload: string }>;
    const deadline = Date.now() + 15000;
    for (const row of rows.slice(0, 4)) {
      if (Date.now() >= deadline) break;
      const record = JSON.parse(row.payload) as RecordData;
      if (this.active.has(record.jobId) || this.polling.has(record.jobId) || !record.authority || actorKey(record.authority) !== row.owner) continue;
      try {
        const ctx = this.detached({ services: this.storage.services, principal: record.authority, trustMode: this.storage.services.trustMode() });
        await this.collectOnce(record.jobId, () => this.pollVideo(ctx, record, false, Math.min(5000, deadline - Date.now())));
      } catch (error) {
        if (error instanceof DodoError && ['AUTH_REQUIRED', 'FORBIDDEN'].includes(error.code)) {
          record.status = 'stopped'; record.error = error.code; record.note = 'Tracking stopped because its original grant or connection authority is no longer valid. Provider cancellation is not implied.'; this.finish(record);
          this.save({ services: this.storage.services, principal: record.authority, trustMode: this.storage.services.trustMode() }, record); this.resources().releaseGeneratedOutput(record.jobId); this.audit(record, 'stopped');
        }
      }
    }
  }
  async start(ctx: ToolCtx, kind: RecordData['kind'], input: ImageRequest | EditRequest | VideoRequest | VideoTransform | (ImageSource & ModelSelection)): Promise<CreativeJobData> {
    const video = kind === 'video' && !('sourceJobId' in input) ? input as VideoRequest : undefined;
    const transform = kind === 'video' && 'sourceJobId' in input ? input : undefined;
    const configForRequest = () => kind === 'video' ? this.videoConfiguration(ctx) : this.configuration(ctx);
    const cfg = configForRequest(); this.resources();
    if (kind !== 'video') await loadSharpBackend(); // Fail before spending if the output decoder is unavailable.
    let source: Awaited<ReturnType<CreativeService['imageSource']>> | undefined;
    let image: Buffer | undefined;
    if (kind === 'background_removal') { source = await this.imageSource(ctx, input as ImageSource); image = (await normalizeCreativeImage(source.bytes)).bytes; source.guard(); }
    let references: Buffer[] | undefined, mask: Buffer | undefined;
    if (kind === 'image_edit') {
      const edit = input as EditRequest;
      const sources = [];
      for (const reference of edit.images) sources.push(await this.imageSource(ctx, reference));
      const maskSource = edit.mask ? await this.imageSource(ctx, edit.mask) : undefined;
      const normalized = [];
      for (const item of sources) {
        normalized.push(await normalizeCreativeImage(item.bytes));
        assertCreativeEditInputBudget(normalized.map(image => image.bytes));
      }
      references = normalized.map(item => item.bytes);
      if (maskSource) {
        const shape = await normalizeCreativeMask(maskSource.bytes);
        // The mask applies to the first image, so both must have the same pixel size.
        if (shape.width !== normalized[0]!.width || shape.height !== normalized[0]!.height) throw new DodoError('INVALID_INPUT', 'the mask must have the same pixel size as the first image');
        mask = shape.bytes;
      }
      assertCreativeEditInputBudget(references, mask);
      const all = [...sources, ...(maskSource ? [maskSource] : [])];
      source = { bytes: references[0]!, guard: () => { for (const item of all) item.guard(); } };
      source.guard();
    }
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
      if (value.connectionId !== cfg.connection.id || (value.transport ? value.transport !== this.transport(cfg.connection) : value.configuration !== cfg.digest)) throw new DodoError('FORBIDDEN', 'source video belongs to another provider transport or credential account');
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
    const jobId = newId('creative');
    try {
      this.sweep();
      const staleSlots = this.storage.services.store.db.prepare(`SELECT COUNT(*) AS n FROM creative_jobs WHERE workspace_id=? AND json_extract(payload,'$.status') IN ('queued','running') AND json_extract(payload,'$.remoteId') IS NOT NULL AND COALESCE(json_extract(payload,'$.remoteComplete'),0)=0`).get(this.storage.services.workspaceId) as { n: number };
      if (staleSlots.n >= 2) await this.reconcileCapacity();
      const pending = this.storage.services.store.db.prepare(`SELECT id,workspace_id,json_extract(payload,'$.remoteId') AS remote_id FROM creative_jobs WHERE json_extract(payload,'$.status') IN ('queued','running') AND COALESCE(json_extract(payload,'$.remoteComplete'),0)=0`).all() as Array<{ id: string; workspace_id: string; remote_id: string | null }>;
      // A stale image row in an unopened project is not a live render. Known remote
      // video handles still count after restart; local submissions count while active.
      const remote = pending.filter(r => r.remote_id !== null || activeGlobal.has(r.id));
      if (this.active.size >= 2 || activeGlobal.size >= 4 || remote.filter(r => r.workspace_id === this.storage.services.workspaceId).length >= 2 || remote.length >= 4) throw new DodoError('RESOURCE_LIMIT', 'active creative render slots are full; inspect or stop tracking active jobs with creative_jobs/creative_job_control');
      this.resources().reserveGeneratedOutput(ctx, jobId);
    } catch (error) { release(); throw error; }
    let workCtx: ToolCtx;
    try { workCtx = this.detached(ctx); } catch (error) { this.resources().releaseGeneratedOutput(jobId); release(); throw error; }
    const submission = creativeSubmission.getStore();
    const record: RecordData = { jobId, kind, status: 'queued', model,
      progress: 0, resource: null, error: null, createdAt: Date.now(), expiresAt: Date.now() + TTL, note: 'Submitted once. Poll creative_job with this jobId; never repeat a paid request to check progress.',
      epoch: this.storage.services.epoch, connectionId: cfg.connection.id, configuration: cfg.digest, transport: this.transport(cfg.connection), authority: workCtx.principal, ...(submission ? { submissionKey: submission.key, submissionTool: submission.tool, submissionHash: submission.payloadHash } : {}) };
    try { this.save(ctx, record); this.audit(record, 'accepted'); } catch (error) { this.resources().releaseGeneratedOutput(jobId); release(); throw error; }
    const controller = new AbortController(); let dispatched = false;
    const beforeSend = () => {
      cfg.settings.assertCredential(cfg.connection, key); const current = configForRequest();
      if (current.digest !== record.configuration) throw new DodoError('FORBIDDEN', 'media configuration changed');
      source?.guard(); checkParent(); record.status = 'running'; this.save(ctx, record);
      if ((record.status as Status) === 'stopped') throw new DodoError('CANCELED', 'creative job was stopped before sending', { detail: { phase: 'before_send', outcome: 'not_sent', retryable: false } });
      dispatched = true;
    };
    activeGlobal.add(jobId);
    const promise = Promise.resolve().then(async () => {
      if (kind === 'video') {
        const job = transform ? transform.operation === 'edit'
          ? await provider.editVideo({ id: parent!.remoteId!, prompt: transform.prompt }, controller.signal, beforeSend)
          : await provider.extendVideo({ id: parent!.remoteId!, prompt: transform.prompt, seconds: transform.seconds! }, controller.signal, beforeSend)
          : await provider.createVideo({ model: record.model, prompt: video!.prompt, size: video!.size, seconds: video!.seconds, ...(image ? { reference: image } : {}) }, controller.signal, beforeSend);
        record.remoteId = job.id; record.progress = job.progress; record.status = job.status === 'failed' ? 'failed' : 'running';
        if (job.status === 'failed') { record.error = 'PROVIDER_RENDER_FAILED'; this.finish(record); this.resources().releaseGeneratedOutput(jobId); }
        record.note = 'Remote render submitted. Call creative_job to retrieve its status and completed MP4; no render is resubmitted.';
      } else {
        const edit = input as EditRequest;
        const result = kind === 'background_removal' ? await provider.removeBackground({ model: record.model, image: image! }, controller.signal, beforeSend)
          : kind === 'image_edit' ? await provider.editImage({ model: record.model, prompt: edit.prompt, size: edit.size, quality: edit.quality, background: edit.background, images: references!, mask }, controller.signal, beforeSend)
            : await provider.generateImage({ ...input as Omit<CreativeImageInput, 'model'>, model: record.model }, controller.signal, beforeSend);
        this.check(workCtx);
        const transparent = kind === 'background_removal' || (input as Partial<CreativeImageInput>).background === 'transparent';
        const normalized = await normalizeCreativeImage(result.bytes, transparent);
        await this.persistOutput(workCtx, record, { bytes: normalized.bytes, mimeType: 'image/png', metadata: { width: normalized.width, height: normalized.height, format: 'png' } });
      }
    }).catch((error: unknown) => {
      if (record.status === 'stopped') return;
      record.diagnostics = creativeDiagnostics(error, dispatched);
      if (this.volatileOutputs.has(jobId)) { record.diagnostics = { ...record.diagnostics, phase: 'output_save', outcome: 'unknown', retryable: true }; record.note = 'Provider output exists but could not be finalized. Use creative_job_control retry_save; no new render is required.'; }
      else record.note = record.diagnostics.outcome === 'unknown' ? 'Submission outcome is unknown. No automatic paid retry was made; inspect this job before starting another.' : 'The request was rejected or stopped before sending. No automatic paid retry was made.';
      record.status = record.diagnostics.outcome === 'unknown' ? 'uncertain' : 'failed'; record.error = error instanceof DodoError ? error.code : 'PROCESS_ERROR';
      if (!record.remoteId && !this.volatileOutputs.has(jobId)) this.resources().releaseGeneratedOutput(jobId);
      this.finish(record);
    }).finally(() => {
      try { this.save(workCtx, record); if (record.status === 'completed') { this.resources().releaseGeneratedOutput(jobId); try { this.artifacts.remove(jobId); } catch { /* durable private artifact cleanup can retry */ } } this.audit(record, record.status); } finally { release(); this.active.delete(jobId); activeGlobal.delete(jobId); }
    });
    // A rejected persistence write must never escape as an unhandled rejection or trigger another paid call.
    const guarded = promise.catch(() => { this.rememberUnsaved(record); });
    this.active.set(jobId, { controller, promise: guarded });
    return this.view(record);
  }
  async report(ctx: ToolCtx, id: string): Promise<CreativeJobData> {
    const record = this.get(ctx, id);
    if (this.active.has(id)) return this.view(record);
    if (record.status === 'stopped' || (record.status === 'completed' && record.resource)) return this.view(record);
    return this.collectOnce(id, () => this.collectRecord(ctx, record));
  }
  private collectOnce(id: string, work: () => Promise<CreativeJobData>): Promise<CreativeJobData> {
    const pending = this.polling.get(id); if (pending) return pending;
    if (this.polling.size >= 2 || pollingGlobal.size >= 4) throw new DodoError('RESOURCE_LIMIT', 'creative media collection limit reached; wait for current downloads');
    pollingGlobal.add(id);
    const promise = Promise.resolve().then(work).finally(() => { this.polling.delete(id); pollingGlobal.delete(id); });
    this.polling.set(id, promise); return promise;
  }
  private async collectRecord(ctx: ToolCtx, record: RecordData): Promise<CreativeJobData> {
    if (record.status !== 'stopped' && (record.status !== 'completed' || !record.resource)) {
      try { if (await this.reconcileOutput(ctx, record)) return this.view(record); }
      catch (error) { this.check(ctx); record.status = 'uncertain'; record.error = record.resource ? 'RECEIPT_PERSISTENCE_FAILED' : error instanceof DodoError ? error.code : 'STORAGE_UNAVAILABLE'; record.diagnostics = { ...creativeDiagnostics(error, true), phase: 'output_save', retryable: true }; record.note = 'Existing provider output could not be finalized. Use retry_save after repairing storage; do not submit a new render.'; try { this.save(ctx, record); } catch { this.rememberUnsaved(record); } return this.view(record); }
    }
    if (record.resource || record.status === 'failed' || record.status === 'completed' || record.status === 'stopped') return this.view(record);
    if (!record.remoteId) {
      if (record.epoch !== this.storage.services.epoch && ['queued', 'running'].includes(record.status)) return this.view({ ...record, status: 'uncertain', error: 'SERVER_INSTANCE_CHANGED', note: 'Another server instance submitted this work. No output has been recovered yet and no render was repeated.' });
      return this.view(record);
    }
    return this.pollVideo(ctx, record);
  }
  private async pollVideo(ctx: ToolCtx, record: RecordData, collect = true, timeoutMs?: number, resume = false): Promise<CreativeJobData> {
    this.check(ctx);
    const settings = this.storage.services.installation!.ai.settings;
    const connection = settings.connection(record.connectionId);
    const validate = () => {
      this.check(ctx);
      const current = settings.connection(record.connectionId);
      if (!supportsCreativeVideoConnection(current) || (record.transport ? record.transport !== this.transport(current) : record.configuration !== this.configuration(ctx).digest)) throw new DodoError('FORBIDDEN', 'video provider transport or credential account changed; its original connection is required');
      return current;
    };
    validate();
    const release = settings.lease(connection.id);
    const controller = new AbortController();
    const timeout = timeoutMs === undefined ? undefined : setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
    timeout?.unref();
    this.pollControllers.set(record.jobId, controller);
    let key: string;
    const check = () => { settings.assertCredential(connection, key); validate(); };
    try {
      key = await settings.credential(connection);
      const provider = new CreativeProvider(connection, key, settings.ports);
      const job = record.remoteComplete ? { id: record.remoteId!, status: 'completed' as const, progress: 100 } : await provider.videoStatus(record.remoteId!, controller.signal, check);
      check(); record.progress = job.progress;
      if (job.status === 'failed') { record.status = 'failed'; record.error = 'PROVIDER_RENDER_FAILED'; this.finish(record); this.resources().releaseGeneratedOutput(record.jobId); }
      else if (job.status === 'completed') {
        record.remoteComplete = true;
        record.note = 'Provider render completed. Collect this existing job to download its output; no render is resubmitted.';
        if (collect) {
          this.resources().reserveGeneratedOutput(ctx, record.jobId);
          const bytes = await provider.videoContent(record.remoteId!, controller.signal, check); check();
          await this.persistOutput(ctx, record, { bytes, mimeType: 'video/mp4', metadata: { format: 'mp4' } });
        }
      } else record.status = 'running';
      try { this.save(ctx, record, resume); if (record.status === 'completed') { this.resources().releaseGeneratedOutput(record.jobId); try { this.artifacts.remove(record.jobId); } catch { /* safe private artifact retained */ } } } catch { this.rememberUnsaved(record); }
      this.audit(record, record.status);
      return this.view(record);
    } catch (error) {
      this.check(ctx);
      record.error = error instanceof DodoError ? error.code : 'PROCESS_ERROR'; record.diagnostics = creativeDiagnostics(error, true);
      record.note = this.volatileOutputs.has(record.jobId) ? 'Provider output is recoverable; retry_save finalizes it without another render.' : 'Could not collect provider status/output. The existing remote render was not resubmitted.';
      if (this.volatileOutputs.has(record.jobId)) record.status = 'uncertain';
      try { this.save(ctx, record); } catch { this.rememberUnsaved(record); }
      this.audit(record, 'collection_failed'); return this.view(record);
    } finally { if (timeout) clearTimeout(timeout); this.pollControllers.delete(record.jobId); release(); }
  }
  sweep(): void {
    const db = this.storage.services.store.db, now = Date.now();
    db.prepare(`UPDATE creative_jobs SET expires_at=?,payload=json_set(payload,'$.expiresAt',?) WHERE expires_at<=? AND json_extract(payload,'$.status') IN ('queued','running')`).run(now + TTL, now + TTL, now);
    const expired = db.prepare(`SELECT id FROM creative_jobs WHERE workspace_id=? AND expires_at<=? AND json_extract(payload,'$.status') NOT IN ('queued','running') AND NOT EXISTS(SELECT 1 FROM creative_output_reservations WHERE job_id=creative_jobs.id) LIMIT 128`).all(this.storage.services.workspaceId, now) as Array<{ id: string }>;
    for (const row of expired) {
      // Keep the job row until its private output is removed; a locked file can
      // be retried next sweep without abandoning unaccounted provider bytes.
      try {
        this.artifacts.remove(row.id);
        db.prepare(`DELETE FROM creative_jobs WHERE id=? AND workspace_id=? AND expires_at<=? AND json_extract(payload,'$.status') NOT IN ('queued','running') AND NOT EXISTS(SELECT 1 FROM creative_output_reservations WHERE job_id=creative_jobs.id)`).run(row.id, this.storage.services.workspaceId, now);
      } catch { try { this.storage.services.logEvent?.('creative.cleanup.failed', { jobId: row.id, code: 'STORAGE_UNAVAILABLE' }); } catch { /* timer cleanup must remain retryable */ } }
    }
    for (const [id, record] of this.unsaved) if (record.expiresAt <= Date.now()) this.unsaved.delete(id);
  }
  async close(): Promise<void> {
    for (const job of this.active.values()) job.controller.abort();
    for (const controller of this.pollControllers.values()) controller.abort();
    await Promise.allSettled([...this.active.values()].map(job => job.promise));
    await Promise.allSettled(this.polling.values());
  }
}
