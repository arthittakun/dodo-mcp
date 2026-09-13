import { z } from 'zod';
import { Hash, Id } from '../multimodal/contracts.js';

export const ResourceId = Id.refine((value) => value.startsWith('res_'), 'resource id must start with res_');

export const ResourceCapabilities = z.object({
  read: z.literal(true),
  stream: z.literal(true),
  seek: z.literal(true),
  preview: z.boolean(),
  transform: z.boolean(),
  extractText: z.boolean(),
}).strict();

export const ResourceSource = z.object({
  kind: z.enum(['workspace', 'media_asset', 'transform']),
  /** Workspace-relative path, asset id, or parent resource id. Never absolute. */
  label: z.string().max(1024),
}).strict();

export const ResourceMetadata = z.object({
  provider: z.string().max(80).optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  format: z.string().max(40).optional(),
  entries: z.number().int().nonnegative().optional(),
}).strict();

export const ResourceInfo = z.object({
  resourceId: ResourceId,
  uri: z.string().startsWith('dodo-resource://'),
  mimeType: z.string().min(1).max(150),
  bytes: z.number().int().nonnegative(),
  sha256: Hash,
  source: ResourceSource,
  capabilities: ResourceCapabilities,
  metadata: ResourceMetadata,
  createdAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
  deduplicated: z.boolean().optional(),
}).strict();

export type ResourceInfoData = z.infer<typeof ResourceInfo>;
export type ResourceCapabilitiesData = z.infer<typeof ResourceCapabilities>;
export type ResourceMetadataData = z.infer<typeof ResourceMetadata>;

export const ResourceChunk = z.object({
  resource: ResourceInfo,
  encoding: z.enum(['utf8', 'base64']),
  data: z.string(),
  range: z.object({
    start: z.number().int().nonnegative(),
    endExclusive: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }).strict(),
  chunkSha256: Hash,
  eof: z.boolean(),
  nextOffset: z.number().int().nonnegative().nullable(),
  resumeToken: z.string().max(2048).nullable(),
}).strict();

export const ResourcePreview = z.object({
  resource: ResourceInfo,
  previewKind: z.enum(['text', 'image', 'audio', 'metadata']),
  text: z.string().optional(),
  previewMimeType: z.string().optional(),
  previewBytes: z.number().int().nonnegative().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  note: z.string(),
}).strict();

export const ResourceExtract = z.object({
  resource: ResourceInfo,
  kind: z.enum(['text', 'metadata', 'archive_entries']),
  text: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  entries: z.array(z.object({
    name: z.string().max(1024),
    compressedBytes: z.number().int().nonnegative(),
    uncompressedBytes: z.number().int().nonnegative(),
    directory: z.boolean(),
  }).strict()).max(512).optional(),
  truncated: z.boolean(),
  provenance: z.literal('deterministic_local_decoder_untrusted_content'),
}).strict();
