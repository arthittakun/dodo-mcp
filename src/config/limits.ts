import { z } from 'zod';

export const MiB = 1024 * 1024;
export const MAX_COMMAND_BYTES = 8 * MiB;
export const MAX_FILE_BYTES = 16 * MiB;
export const MAX_REQUEST_BYTES = 32 * MiB;

/** Owner-selected input budgets. These do not change scopes, trust or output caps. */
export const INPUT_LIMIT_PROFILES = {
  standard: { commandBytes: MiB, readFileBytes: 8 * MiB, previewAggregateBytes: 8 * MiB, requestBodyBytes: 16 * MiB },
  large: { commandBytes: MAX_COMMAND_BYTES, readFileBytes: MAX_FILE_BYTES, previewAggregateBytes: MAX_REQUEST_BYTES, requestBodyBytes: MAX_REQUEST_BYTES },
} as const;

/**
 * Resource budgets (spec §16). Defaults are the proposed values; only the
 * local global config may adjust them — never repo config, never a tool.
 */
export const LimitsSchema = z
  .object({
    requestBodyBytes: z.number().int().min(64 * 1024).max(MAX_REQUEST_BYTES).default(INPUT_LIMIT_PROFILES.standard.requestBodyBytes),
    commandBytes: z.number().int().min(8192).max(MAX_COMMAND_BYTES).default(INPUT_LIMIT_PROFILES.standard.commandBytes),
    toolContentBytes: z.number().int().min(8 * 1024).max(1024 * 1024).default(64 * 1024),
    readFileBytes: z.number().int().min(16 * 1024).max(MAX_FILE_BYTES).default(INPUT_LIMIT_PROFILES.standard.readFileBytes),
    readBatchMax: z.number().int().min(1).max(50).default(10),
    treeDepthDefault: z.number().int().min(1).max(10).default(2),
    treeEntriesMax: z.number().int().min(10).max(5000).default(200),
    searchResultsMax: z.number().int().min(10).max(1000).default(100),
    previewFilesMax: z.number().int().min(1).max(500).default(50),
    previewAggregateBytes: z.number().int().min(64 * 1024).max(64 * 1024 * 1024).default(INPUT_LIMIT_PROFILES.standard.previewAggregateBytes),
    jobsConcurrentMax: z.number().int().min(1).max(32).default(4),
    jobWallTimeoutDefaultMs: z.number().int().min(1000).default(10 * 60 * 1000),
    jobWallTimeoutMaxMs: z.number().int().min(1000).default(30 * 60 * 1000),
    jobLogBytesPerJob: z.number().int().min(64 * 1024).default(20 * 1024 * 1024),
    jobLogBytesTotal: z.number().int().min(1024 * 1024).default(200 * 1024 * 1024),
    planExpiryMs: z.number().int().min(60 * 1000).default(15 * 60 * 1000),
    approvalExpiryMs: z.number().int().min(30 * 1000).default(5 * 60 * 1000),
    idempotencyRetentionMs: z.number().int().min(60 * 60 * 1000).default(24 * 60 * 60 * 1000),
    semanticFilesMax: z.number().int().min(50).max(20000).default(2000),
    semanticRequestTimeoutMs: z.number().int().min(1000).default(15 * 1000),
    searchTimeoutMs: z.number().int().min(500).default(10 * 1000),
    auditRetentionDays: z.number().int().min(1).default(7),
  })
  .strict();

export type Limits = z.infer<typeof LimitsSchema>;

export const DEFAULT_LIMITS: Limits = LimitsSchema.parse({});
