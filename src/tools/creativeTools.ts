import path from 'node:path';
import { z } from 'zod';
import { DodoError } from '../errors.js';
import { projectAuthority } from '../security/projectAuthority.js';
import { digestOf, newId, sha256Bytes } from '../util/hash.js';
import { defineTool, policyGate, type AnyToolDef, type ToolCtx } from './context.js';
import { Crop, Hash, Id, Key, Path } from '../services/multimodal/contracts.js';
import { ResourceInfo } from '../services/resources/contracts.js';
import { liveAccess } from '../services/multimodal/storage.js';
import { multimediaEffect } from '../services/multimodal/operations.js';
import type { StoredPlan } from '../services/changes/types.js';

const execute = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const source = { path: Path.optional(), assetId: Id.optional(), resourceId: Id.optional() };
const Seconds = z.union([z.literal(4), z.literal(8), z.literal(12), z.literal(16), z.literal(20)]);
const Prompt = z.string().trim().min(1).max(16000);
const Job = z.object({ jobId: Id, kind: z.enum(['image', 'background_removal', 'video']), status: z.enum(['queued', 'running', 'completed', 'failed', 'uncertain', 'interrupted']),
  model: z.string(), progress: z.number().min(0).max(100), resource: ResourceInfo.nullable(), error: z.string().nullable(), createdAt: z.number(), expiresAt: z.number(), note: z.string(), replayed: z.boolean().optional() });
function use(ctx: ToolCtx) {
  liveAccess(ctx, 'dodo:exec'); const mm = ctx.services.multimodal;
  if (!mm) throw new DodoError('NOT_SUPPORTED', 'creative media service is unavailable'); mm.storage.check(); return mm;
}
const generate = defineTool({
  name: 'image_generate', title: 'Generate an image',
  description: 'Generate an image directly from chat using the configured provider URL, API key and model. No project, project_overview or workspace context is needed. Supports OpenAI-compatible Images and native Gemini. Returns jobId; creative_job collects its PNG preview/resource. Submits one paid request; reuse the same idempotencyKey after a lost response.',
  input: { prompt: z.string().trim().min(1).max(16000), size: z.enum(['auto', '1024x1024', '1536x1024', '1024x1536']).default('1024x1024'), quality: z.enum(['auto', 'low', 'medium', 'high']).default('auto'), background: z.enum(['auto', 'opaque', 'transparent']).default('auto'), idempotencyKey: Key },
  output: Job, requiredScope: 'dodo:exec', action: 'exec', annotations: execute,
  handler: async (args, ctx) => { const mm = use(ctx), { idempotencyKey, ...input } = args; return { data: await multimediaEffect(ctx, 'image_generate', idempotencyKey, input, () => mm.creative.start(ctx, 'image', input), true, ['AUTH_REQUIRED']) }; },
});
const crop = defineTool({
  name: 'image_crop', title: 'Crop images locally without losing transparency',
  description: 'Crop 1-16 exact pixel rectangles from ONE guarded workspace path, owned image assetId or resourceId. Runs locally with no API call. Returns lossless PNG resources preserving transparency, first-frame pixels and encoded source orientation. Coordinates are left/top/width/height before EXIF rotation. Use resource_preview/read_range or media_save for the results.',
  input: { ...source, regions: z.array(Crop).min(1).max(16).optional(), grid: z.object({ rows: z.number().int().min(1).max(16), columns: z.number().int().min(1).max(16), gap: z.number().int().min(0).max(20000).default(0), margin: z.number().int().min(0).max(20000).default(0) }).strict().optional(), idempotencyKey: Key },
  output: z.object({ resources: z.array(ResourceInfo).min(1).max(16), note: z.string(), replayed: z.boolean() }), requiredScope: 'dodo:exec', action: 'exec', annotations: { ...execute, openWorldHint: false },
  handler: async (args, ctx) => {
    const mm = use(ctx), { idempotencyKey, regions, grid, ...input } = args;
    const data = await multimediaEffect(ctx, 'image_crop', idempotencyKey, { ...input, regions: regions ?? null, grid: grid ?? null }, () => mm.creative.crop(ctx, input, regions, grid));
    const preview = await ctx.services.resources!.preview(ctx, data.resources[0]!.resourceId, 1024);
    return { data, ...(preview.block ? { contentBlocks: [preview.block] } : {}) };
  },
});
const removeBackground = defineTool({
  name: 'image_remove_background', title: 'Remove an image background',
  description: 'Remove the background from one owned image resource directly from chat, without a project or upload-enablement setting. Accepts resourceId/assetId; a workspace path uses optional explicit project context. Submits one paid generative edit and may alter image details; success requires actual transparent pixels. Collect the existing job with creative_job.',
  input: { ...source, idempotencyKey: Key }, output: Job, requiredScope: 'dodo:exec', action: 'exec', annotations: execute,
  handler: async (args, ctx) => { const mm = use(ctx), { idempotencyKey, ...input } = args; return { data: await multimediaEffect(ctx, 'image_remove_background', idempotencyKey, input, () => mm.creative.start(ctx, 'background_removal', input), true, ['AUTH_REQUIRED']) }; },
});
const video = defineTool({
  name: 'video_generate', title: 'Generate a video',
  description: 'Create a video directly from chat without a project using configured compatible video settings. Official OpenAI Videos API is retired; configure a compatible provider and video model first. An optional owned image reference must match size. Returns jobId; creative_job collects that render as MP4. No automatic paid retries or 3D.',
  input: { prompt: Prompt, size: z.enum(['1280x720', '720x1280']).default('1280x720'), seconds: Seconds.default(4), reference: z.object(source).strict().optional(), idempotencyKey: Key },
  output: Job, requiredScope: 'dodo:exec', action: 'exec', annotations: execute,
  handler: async (args, ctx) => { const mm = use(ctx), { idempotencyKey, ...input } = args; return { data: await multimediaEffect(ctx, 'video_generate', idempotencyKey, input, () => mm.creative.start(ctx, 'video', input), true, ['AUTH_REQUIRED']) }; },
});
const videoEdit = defineTool({
  name: 'video_edit', title: 'Edit a completed generated video',
  description: 'Submit one paid video edit using a completed video jobId owned by this caller/workspace. The backend selects its stored remote ID; raw IDs/URLs are never accepted. Requires the same explicitly enabled compatible connection and configuration. Returns a NEW jobId for creative_job; the original remains immutable. Official OpenAI Videos API is retired; compatible-provider support must be configured.',
  input: { jobId: Id, prompt: Prompt, idempotencyKey: Key }, output: Job, requiredScope: 'dodo:exec', action: 'exec', annotations: execute,
  handler: async (args, ctx) => { const mm = use(ctx), { idempotencyKey, ...payload } = args; return { data: await multimediaEffect(ctx, 'video_edit', idempotencyKey, payload, () => mm.creative.start(ctx, 'video', { sourceJobId: args.jobId, operation: 'edit', prompt: args.prompt }), true, ['AUTH_REQUIRED']) }; },
});
const videoExtend = defineTool({
  name: 'video_extend', title: 'Continue a completed generated video',
  description: 'Submit one paid continuation of a completed owned video job, preserving its provider-side source reference. No source URL or remote ID argument. Requires the original compatible connection/configuration and owner video enablement; returns a new jobId without replacing the source. Provider support/duration limits vary. No automatic resubmission. Official OpenAI Videos API is retired.',
  input: { jobId: Id, prompt: Prompt, seconds: Seconds.default(4), idempotencyKey: Key }, output: Job, requiredScope: 'dodo:exec', action: 'exec', annotations: execute,
  handler: async (args, ctx) => { const mm = use(ctx), { idempotencyKey, ...payload } = args; return { data: await multimediaEffect(ctx, 'video_extend', idempotencyKey, payload, () => mm.creative.start(ctx, 'video', { sourceJobId: args.jobId, operation: 'extend', prompt: args.prompt, seconds: args.seconds }), true, ['AUTH_REQUIRED']) }; },
});
const job = defineTool({
  name: 'creative_job', title: 'Collect generated image or video output',
  description: 'Read one owned creative job. For a remote video, retrieves status/content only; NEVER starts another render. Completed images return a real bounded MCP preview and full PNG resource, videos return an MP4 resource. Reports interrupted/uncertain work truthfully after failures/restarts. Rechecks project/client authority and connection configuration before any provider request.',
  input: { jobId: Id }, output: Job, requiredScope: 'dodo:exec', action: 'read', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  handler: async (args, ctx) => {
    const mm = use(ctx), data = await mm.creative.report(ctx, args.jobId);
    if (data.resource?.mimeType === 'image/png') { const result = await ctx.services.resources!.preview(ctx, data.resource.resourceId, 1024); return { data, ...(result.block ? { contentBlocks: [result.block] } : {}) }; }
    return { data };
  },
});
const save = defineTool({
  name: 'media_save', title: 'Save generated media into the project',
  description: 'Save an owned generated PNG/MP4 resource to a guarded workspace-relative path. Requires write AND exec scopes, expectedSha256, and an explicit expectedHash before replacing an existing file. Uses the existing hash-verified journal/backup/rollback path. Owner-configured plan byte budgets apply; no arbitrary download or API call. Retry the same idempotencyKey after a lost response.',
  input: { resourceId: Id, expectedSha256: Hash, path: Path, expectedHash: Hash.optional(), createParents: z.boolean().default(true), idempotencyKey: Key },
  output: z.object({ path: z.string(), hash: Hash, bytes: z.number(), changesetId: z.string(), replayed: z.boolean() }), requiredScope: 'dodo:write', action: 'mutate-files', annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  handler: async (args, ctx) => {
    use(ctx); liveAccess(ctx, 'dodo:write'); const { idempotencyKey, ...payload } = args;
    const data = await multimediaEffect(ctx, 'media_save', idempotencyKey, payload, async () => {
      const s = ctx.services, cap = Math.min(s.limits.readFileBytes, s.limits.previewAggregateBytes);
      const resource = await s.resources!.exportBytes(ctx, args.resourceId, args.expectedSha256, cap).catch(async (error: unknown) => {
        if (!(error instanceof DodoError) || error.code !== 'NOT_FOUND' || !s.installation) throw error;
        const lease = s.installation.acquireGlobal();
        try {
          const principal = projectAuthority(lease.services.store, ctx.principal, lease.services.workspaceId);
          const globalCtx: ToolCtx = { ...ctx, services: lease.services, principal };
          return await lease.services.resources!.exportBytes(globalCtx, args.resourceId, args.expectedSha256, cap);
        } finally { lease.release(); }
      });
      const extension = resource.info.mimeType === 'image/png' ? '.png' : '.mp4';
      if (path.extname(args.path).toLowerCase() !== extension) throw new DodoError('INVALID_INPUT', `save this resource with a ${extension} extension`);
      const target = s.wfs.resolve(args.path, { allowMissing: true });
      let beforeHash: string | null = null, beforeMode: number | undefined, beforeSize = 0;
      if (target.stat) {
        if (!args.expectedHash) throw new DodoError('INVALID_INPUT', 'replacing media requires expectedHash of the existing file');
        const current = s.wfs.readFileBytes(target.rel, cap); beforeHash = sha256Bytes(current.bytes); beforeSize = current.bytes.length; beforeMode = s.wfs.assertRegularFileForDirectAccess(target).mode;
        if (beforeHash !== args.expectedHash) throw new DodoError('FILE_CHANGED', 'target media changed; read it again before overwriting');
      } else if (args.expectedHash) throw new DodoError('FILE_CHANGED', 'target media no longer exists');
      const created = target.stat ? undefined : s.wfs.resolveForCreate(target.rel, args.createParents);
      liveAccess(ctx, 'dodo:write'); ctx.revalidate?.();
      policyGate(ctx, { tool: 'media_save', action: 'mutate-files', approvalAction: payload, summary: `save generated media to ${target.rel} (${resource.bytes.length} bytes)` });
      const plan: StoredPlan = { version: 1, workspaceId: s.workspaceId, epoch: s.epoch, principal: ctx.principal.grantId, source: 'direct', summary: `save generated ${extension} to ${target.rel}`,
        files: [{ path: target.rel, action: beforeHash ? 'modify' : 'create', beforeHash, afterHash: resource.info.sha256, afterContentB64: resource.bytes.toString('base64'), mode: beforeMode ?? 0o644,
          ...(created?.missingParents.length ? { createParents: created.missingParents } : {}), diff: `binary media: ${resource.info.mimeType}`, diffTruncated: false, bytesBefore: beforeSize, bytesAfter: resource.bytes.length }] };
      const planId = newId('plan'), encoded = JSON.stringify(plan), planHash = digestOf({ planId, payload: encoded });
      s.store.putPlan({ id: planId, workspaceId: s.workspaceId, epoch: s.epoch, principal: ctx.principal.grantId, planHash, payload: encoded, ttlMs: s.limits.planExpiryMs });
      const result = await s.applier.apply({ planId, planHash, workspaceId: s.workspaceId, epoch: s.epoch, principal: ctx.principal.grantId });
      return { path: target.rel, hash: resource.info.sha256, bytes: resource.bytes.length, changesetId: result.changesetId };
    }, false);
    return { data };
  },
});
export const CREATIVE_TOOLS: AnyToolDef[] = [...[generate, crop, removeBackground, video, videoEdit, videoExtend, job].map(def => ({ ...def, optionalWorkspaceContext: true })), save];
