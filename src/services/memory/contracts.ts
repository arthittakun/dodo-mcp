import { z } from 'zod';
import { HashSchema } from '../assistance/contracts.js';

export const MEMORY_SCHEMA_VERSION = 1;
export const MemoryKind = z.enum(['fact', 'decision', 'failure', 'successful-fix', 'workaround', 'convention', 'preference']);
export const MemoryStatus = z.enum(['CURRENT', 'STALE']);
export const MemoryProposalStatus = z.enum(['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'STALE']);

export const MemoryEvidence = z.object({
  evidenceId: z.string().regex(/^evidence_[a-f0-9]{32}$/),
  projectId: z.string().nullable(),
  workspaceId: z.string(),
  sourceKind: z.string(),
  resource: z.string(),
  path: z.string().nullable(),
  hash: HashSchema,
  line: z.number().int().positive().nullable(),
  endLine: z.number().int().positive().nullable(),
  commit: z.string().nullable(),
  freshness: z.literal('current'),
}).strict();

export const MemoryVisibility = z.object({
  projectId: z.string().nullable(),
  workspaceId: z.string(),
  displayName: z.string(),
}).strict();

export const MemoryRecord = z.object({
  schemaVersion: z.literal(MEMORY_SCHEMA_VERSION),
  memoryId: z.string().regex(/^memory_[0-9a-hjkmnp-tv-z]{8,64}$/),
  kind: MemoryKind,
  claim: z.string(),
  rationale: z.string(),
  affectedEntities: z.array(z.string()),
  sourceProjectId: z.string().nullable(),
  sourceWorkspaceId: z.string(),
  evidence: z.array(MemoryEvidence),
  confidence: z.object({ score: z.number().min(0).max(1), reasons: z.array(z.string()) }).strict(),
  status: MemoryStatus,
  staleReason: z.string().nullable(),
  visibleTo: z.array(MemoryVisibility),
  conflicts: z.array(z.string()),
  contentHash: HashSchema,
  revision: z.number().int().positive(),
  createdAt: z.number().int().nonnegative(),
  approvedAt: z.number().int().nonnegative(),
  lastVerifiedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative().nullable(),
  ownerReviewed: z.literal(true),
  authority: z.literal('evidence_only'),
  trust: z.literal('untrusted_content'),
}).strict();

export const MemorySearchResult = z.object({
  schemaVersion: z.literal(MEMORY_SCHEMA_VERSION),
  query: z.string(),
  normalizedTerms: z.array(z.string()),
  projects: z.array(MemoryVisibility),
  memories: z.array(MemoryRecord),
  returnedCount: z.number().int().nonnegative(),
  staleCount: z.number().int().nonnegative(),
  partial: z.boolean(),
  truncated: z.boolean(),
  nextCursor: z.string().nullable(),
  generatedAt: z.number().int().nonnegative(),
  note: z.string(),
}).strict();

export const MemoryProposalReceipt = z.object({
  schemaVersion: z.literal(MEMORY_SCHEMA_VERSION),
  proposalId: z.string().regex(/^memprop_[0-9a-hjkmnp-tv-z]{8,64}$/),
  digest: HashSchema,
  status: z.literal('PENDING'),
  evidenceCount: z.number().int().positive(),
  conflicts: z.array(z.string()),
  expiresAt: z.number().int().nonnegative(),
  ownerCommand: z.string(),
  permanent: z.literal(false),
}).strict();

export const LearningProposalReceipt = z.object({
  schemaVersion: z.literal(MEMORY_SCHEMA_VERSION),
  learningId: z.string().regex(/^learning_[0-9a-hjkmnp-tv-z]{8,64}$/),
  digest: HashSchema,
  status: z.literal('PENDING'),
  supportingMemoryCount: z.number().int().min(2),
  expiresAt: z.number().int().nonnegative(),
  ownerCommand: z.string(),
  activated: z.literal(false),
}).strict();

export const MemoryDiagnostics = z.object({
  schemaVersion: z.literal(MEMORY_SCHEMA_VERSION),
  workspaceId: z.string(),
  memories: z.object({ current: z.number().int().nonnegative(), stale: z.number().int().nonnegative() }).strict(),
  proposals: z.object({ pending: z.number().int().nonnegative(), stale: z.number().int().nonnegative(), rejected: z.number().int().nonnegative(), expired: z.number().int().nonnegative() }).strict(),
  learning: z.object({ pending: z.number().int().nonnegative(), approved: z.number().int().nonnegative(), rejected: z.number().int().nonnegative() }).strict(),
  retention: z.object({ proposalDays: z.number().int().positive(), defaultMemoryDays: z.number().int().positive(), maxMemoryDays: z.number().int().positive() }).strict(),
  note: z.string(),
}).strict();

export type MemoryKindData = z.infer<typeof MemoryKind>;
export type MemoryEvidenceData = z.infer<typeof MemoryEvidence>;
export type MemoryVisibilityData = z.infer<typeof MemoryVisibility>;
export type MemoryRecordData = z.infer<typeof MemoryRecord>;
export type MemorySearchResultData = z.infer<typeof MemorySearchResult>;
