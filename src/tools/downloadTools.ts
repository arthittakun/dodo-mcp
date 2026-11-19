import { z } from 'zod';
import { DodoError } from '../errors.js';
import { Hash, Id } from '../services/multimodal/contracts.js';
import { ResourceId } from '../services/resources/contracts.js';
import { liveAccess } from '../services/multimodal/storage.js';
import { defineTool, policyGate, type AnyToolDef, type ToolCtx } from './context.js';

const Days = z.union([z.literal(1), z.literal(2), z.literal(7), z.literal(14), z.literal(30)]);
const FileName = z.string().trim().min(1).max(180).refine((value) => !/[\p{Cc}/\\]/u.test(value) && value !== '.' && value !== '..', 'fileName must be one safe filename without path separators or control characters');
const Link = z.object({
  linkId: Id,
  resourceId: ResourceId,
  fileName: z.string().min(1).max(180),
  mimeType: z.string().min(1).max(150),
  bytes: z.number().int().nonnegative(),
  sha256: Hash,
  createdAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
  revokedAt: z.number().int().nonnegative().nullable(),
}).strict();

function use(ctx: ToolCtx) {
  const downloads = ctx.services.resources?.downloads;
  if (!downloads) throw new DodoError('NOT_SUPPORTED', 'temporary download links are unavailable in this running build');
  return downloads;
}

const create = defineTool({
  name: 'download_link_create', title: 'Create a temporary token download link',
  description: 'Publish ONE owned immutable resource as a token-protected download URL on this running HTTP server. First use resource_inspect for a guarded workspace file or creative_job for generated media. Requires read/write scopes, the exact expectedSha256 and execution policy approval. Choose 1, 2, 7, 14 or 30 days. Anyone holding the returned URL can download until expiry/revocation; share it only with the intended recipient. The bytes remain pinned after the resource reference expires. No arbitrary URL, filesystem path or public-domain override. A new call creates a new link; after a lost response inspect download_link_list and revoke unwanted links before creating another.',
  input: { resourceId: ResourceId, expectedSha256: Hash, expiresInDays: Days.default(7), fileName: FileName.optional() },
  output: Link.extend({ url: z.string().url().max(4096) }).strict(),
  requiredScope: 'dodo:write', action: 'exec',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  handler: async (args, ctx) => {
    liveAccess(ctx, 'dodo:read'); liveAccess(ctx, 'dodo:write');
    const origin = ctx.services.downloadOrigin;
    if (!origin) throw new DodoError('NOT_SUPPORTED', 'temporary links require a running HTTP server with a configured public origin; STDIO alone cannot serve downloads');
    const service = use(ctx);
    policyGate(ctx, { tool: 'download_link_create', action: 'exec', approvalAction: args, summary: `publish one immutable resource by token for ${args.expiresInDays} days` });
    const { fileName, ...input } = args;
    return { data: await service.create(ctx, { ...input, ...(fileName === undefined ? {} : { fileName }) }, origin) };
  },
});

const list = defineTool({
  name: 'download_link_list', title: 'List owned temporary download links',
  description: 'List this client/workspace\'s temporary link metadata, including expiry/revocation, without returning secret tokens or URLs. Use linkId to revoke a link. Other clients/workspaces remain private. Link download authority is independent of the original resource reference expiry.',
  input: { limit: z.number().int().min(1).max(128).default(50) },
  output: z.object({ links: z.array(Link).max(128) }).strict(), requiredScope: 'dodo:read', action: 'read',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  handler: async (args, ctx) => ({ data: { links: use(ctx).list(ctx, args) } }),
});

const revoke = defineTool({
  name: 'download_link_revoke', title: 'Revoke an owned temporary download link',
  description: 'Stop future downloads through one owned linkId before its expiry. Requires write scope and client/workspace ownership. Repeating revocation is safe; already downloaded bytes cannot be recalled. Unknown or other-client linkIds are unavailable.',
  input: { linkId: Id }, output: z.object({ linkId: Id, revokedAt: z.number().int().nonnegative() }).strict(),
  requiredScope: 'dodo:write', action: 'job-control',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  handler: async (args, ctx) => ({ data: use(ctx).revoke(ctx, args.linkId) }),
});

export const DOWNLOAD_TOOLS: AnyToolDef[] = [create, list, revoke];
