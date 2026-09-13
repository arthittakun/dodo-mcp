import { z } from 'zod';
import { defineTool, policyGate, type AnyToolDef, type ToolCtx } from './context.js';
import { DodoError } from '../errors.js';
import { Hash, Id, Path } from '../services/multimodal/contracts.js';
import { ResourceChunk, ResourceExtract, ResourceInfo, ResourcePreview } from '../services/resources/contracts.js';
import { RESOURCE_RANGE_MAX_BYTES } from '../services/resources/casStore.js';

const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const execute = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const ExpectedMime = z.string().regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i).max(150).optional();

function use(ctx: ToolCtx) {
  const service = ctx.services.resources;
  if (!service) throw new DodoError('NOT_SUPPORTED', 'resource service is unavailable in this running build');
  return service;
}

const inspectTool = defineTool({
  name: 'resource_inspect', title: 'Ingest or inspect one immutable resource',
  description: 'Create a workspace/principal-scoped reference to one guarded workspace path or owned media asset, or inspect an existing resourceId. Bytes enter the private content-addressed store only after path/link/file-identity checks and SHA-256 verification. A resourceId/URI is never authority and cannot cross clients or workspaces.',
  input: { resourceId: Id.optional(), path: Path.optional(), assetId: Id.optional(), expectedSha256: Hash.optional(), expectedMimeType: ExpectedMime },
  output: ResourceInfo, requiredScope: 'dodo:read', action: 'read', annotations: read,
  handler: async (args, ctx) => {
    const selected = [args.resourceId, args.path, args.assetId].filter((value) => value !== undefined);
    if (selected.length !== 1) throw new DodoError('INVALID_INPUT', 'provide exactly one of resourceId, path or assetId');
    const service = use(ctx);
    if (args.path) return { data: await service.ingestWorkspace(ctx, args.path, args.expectedSha256, args.expectedMimeType) };
    if (args.assetId) return { data: await service.ingestAsset(ctx, args.assetId, args.expectedSha256, args.expectedMimeType) };
    return { data: await service.inspect(ctx, args.resourceId!, args.expectedSha256, args.expectedMimeType) };
  },
});

const resourceReadTool = defineTool({
  name: 'resource_read', title: 'Read one bounded resource chunk',
  description: 'Read at most 256 KiB from the beginning of an owned resource. Complete UTF-8 text is returned as text; binary or partial data is bounded Base64 with a signed resumeToken. Access, ACL and object hash are rechecked on every call.',
  input: { resourceId: Id, maxBytes: z.number().int().min(1).max(RESOURCE_RANGE_MAX_BYTES).default(64 * 1024), expectedSha256: Hash.optional() },
  output: ResourceChunk, requiredScope: 'dodo:read', action: 'read', annotations: read,
  handler: async (args, ctx) => {
    const result = await use(ctx).read(ctx, args.resourceId, args.maxBytes, args.expectedSha256);
    return { data: { resource: result.info, encoding: result.encoding, data: result.data, range: { start: result.start, endExclusive: result.endExclusive, total: result.info.bytes }, chunkSha256: result.chunkHash, eof: result.eof, nextOffset: result.nextOffset, resumeToken: result.resumeToken }, truncated: !result.eof, nextCursor: result.resumeToken };
  },
});

const resourceRangeTool = defineTool({
  name: 'resource_read_range', title: 'Read or resume a bounded byte range',
  description: 'Read one Base64-encoded byte range (maximum 256 KiB) from an owned immutable resource. Continue with resumeToken alone; the signed token is bound to resource hash, workspace and principal but never replaces authorization. Multi-range and unbounded reads are refused.',
  input: { resourceId: Id.optional(), cursor: z.string().max(2048).optional(), offset: z.number().int().min(0).max(RESOURCE_RANGE_MAX_BYTES * 2048).optional(), length: z.number().int().min(1).max(RESOURCE_RANGE_MAX_BYTES).default(64 * 1024), expectedSha256: Hash.optional() },
  output: ResourceChunk, requiredScope: 'dodo:read', action: 'read', annotations: read,
  handler: async (args, ctx) => {
    const result = await use(ctx).readRange(ctx, { ...(args.resourceId ? { resourceId: args.resourceId } : {}), ...(args.cursor ? { cursor: args.cursor } : {}), ...(args.offset !== undefined ? { offset: args.offset } : {}), length: args.length, ...(args.expectedSha256 ? { expectedHash: args.expectedSha256 } : {}) });
    return { data: { resource: result.info, encoding: 'base64', data: result.data, range: { start: result.start, endExclusive: result.endExclusive, total: result.info.bytes }, chunkSha256: result.chunkHash, eof: result.eof, nextOffset: result.nextOffset, resumeToken: result.resumeToken }, truncated: !result.eof, nextCursor: result.resumeToken };
  },
});

const previewTool = defineTool({
  name: 'resource_preview', title: 'Preview a resource safely',
  description: 'Return bounded UTF-8 text, a raster thumbnail MCP image block, a <=6 MiB MCP audio block, or metadata-only evidence. SVG stays untrusted text; unsupported formats are never executed or sent to a shell.',
  input: { resourceId: Id, maxEdge: z.number().int().min(64).max(1600).default(1024), expectedSha256: Hash.optional() },
  output: ResourcePreview, requiredScope: 'dodo:read', action: 'read', annotations: read,
  handler: async (args, ctx) => {
    const result = await use(ctx).preview(ctx, args.resourceId, args.maxEdge, args.expectedSha256);
    return { data: result.data, ...(result.block ? { contentBlocks: [result.block] } : {}) };
  },
});

const extractTool = defineTool({
  name: 'resource_extract', title: 'Extract bounded deterministic resource data',
  description: 'Extract validated UTF-8 text, safe ZIP central-directory names/sizes, or metadata from an owned resource. Archive entries are never inflated, files are never executed, and OCR/PDF claims are not fabricated when no provider exists.',
  input: { resourceId: Id, kind: z.enum(['auto', 'text', 'metadata', 'archive_entries']).default('auto'), expectedSha256: Hash.optional() },
  output: ResourceExtract, requiredScope: 'dodo:read', action: 'read', annotations: read,
  handler: async (args, ctx) => ({ data: await use(ctx).extract(ctx, args.resourceId, args.kind, args.expectedSha256) }),
});

const transformTool = defineTool({
  name: 'resource_transform', title: 'Create a bounded immutable resource transform',
  description: 'Create a JPEG thumbnail from an owned raster image and store it as a new immutable CAS resource. Decoder input is untrusted, dimensions/output are bounded, source hash is rechecked and inspect-mode owner approval still applies. No external command or network access.',
  input: { resourceId: Id, operation: z.literal('thumbnail').default('thumbnail'), maxEdge: z.number().int().min(64).max(1600).default(1024), expectedSha256: Hash.optional() },
  output: ResourceInfo, requiredScope: 'dodo:exec', action: 'exec', annotations: execute,
  handler: async (args, ctx) => {
    policyGate(ctx, { tool: 'resource_transform', action: 'exec', approvalAction: { resourceId: args.resourceId, operation: args.operation, maxEdge: args.maxEdge, expectedSha256: args.expectedSha256 ?? null }, summary: 'create one bounded image thumbnail resource' });
    return { data: await use(ctx).transformImage(ctx, args.resourceId, args.maxEdge, args.expectedSha256) };
  },
});

export const RESOURCE_TOOLS: AnyToolDef[] = [inspectTool, resourceReadTool, resourceRangeTool, previewTool, extractTool, transformTool];
