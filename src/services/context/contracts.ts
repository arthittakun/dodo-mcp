import { z } from 'zod';
import { HashSchema } from '../assistance/contracts.js';

export const CONTEXT_SCHEMA_VERSION = 1;
export const CONTEXT_CACHE_LEVELS = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6'] as const;

export const EvidenceKind = z.enum(['FACT', 'OBSERVATION', 'MEMORY', 'INFERENCE', 'HYPOTHESIS']);
export const EvidenceFreshness = z.enum(['current', 'stale', 'unavailable']);
export const EvidenceSourceKind = z.enum(['source', 'test', 'documentation', 'configuration', 'graph', 'git', 'memory', 'runtime']);

export const ContextProject = z.object({
  projectId: z.string().nullable(),
  displayName: z.string(),
  workspaceId: z.string(),
  active: z.boolean(),
  available: z.boolean(),
}).strict();

export const EvidenceRecord = z.object({
  evidenceId: z.string().regex(/^evidence_[a-f0-9]{32}$/),
  kind: EvidenceKind,
  claim: z.string(),
  confidence: z.object({
    score: z.number().min(0).max(1),
    level: z.enum(['low', 'medium', 'high']),
    reasons: z.array(z.string()),
  }).strict(),
  freshness: EvidenceFreshness,
  project: ContextProject,
  source: z.object({
    kind: EvidenceSourceKind,
    resource: z.string(),
    path: z.string().nullable(),
    hash: HashSchema,
    line: z.number().int().positive().nullable(),
    endLine: z.number().int().positive().nullable(),
    commit: z.string().nullable(),
  }).strict(),
  generatedAt: z.number().int().nonnegative(),
  lastVerifiedAt: z.number().int().nonnegative(),
  ranking: z.object({ score: z.number(), reasons: z.array(z.string()) }).strict(),
  limitations: z.array(z.string()),
  trust: z.literal('untrusted_content'),
}).strict();

export const EvidenceGroups = z.object({
  FACT: z.array(EvidenceRecord),
  OBSERVATION: z.array(EvidenceRecord),
  MEMORY: z.array(EvidenceRecord),
  INFERENCE: z.array(EvidenceRecord),
  HYPOTHESIS: z.array(EvidenceRecord),
}).strict();

export const RetrievalSourceStatus = z.object({
  source: z.enum(['lexical', 'semantic_graph', 'git', 'memory', 'runtime']),
  status: z.enum(['available', 'partial', 'unavailable']),
  note: z.string(),
}).strict();

export const ContextQueryResult = z.object({
  schemaVersion: z.literal(CONTEXT_SCHEMA_VERSION),
  queryId: z.string().regex(/^context_[a-f0-9]{32}$/),
  goal: z.string(),
  normalizedTerms: z.array(z.string()),
  projects: z.array(ContextProject),
  evidence: EvidenceGroups,
  order: z.array(z.string()),
  sourceStatus: z.array(RetrievalSourceStatus),
  freshnessTransitions: z.array(z.object({ evidenceId: z.string(), from: z.literal('current'), to: z.literal('stale'), reason: z.string() }).strict()),
  limitations: z.array(z.string()),
  budget: z.object({ requestedBytes: z.number().int(), usedBytes: z.number().int(), candidateCount: z.number().int(), returnedCount: z.number().int() }).strict(),
  cache: z.object({ hit: z.boolean(), hitLevel: z.enum(CONTEXT_CACHE_LEVELS).nullable(), levels: z.array(z.object({ level: z.enum(CONTEXT_CACHE_LEVELS), hit: z.boolean(), invalidated: z.boolean() }).strict()) }).strict(),
  metrics: z.object({
    latencyMs: z.number().int().nonnegative(), candidateCount: z.number().int(), returnedCount: z.number().int(), cacheHit: z.boolean(),
    quality: z.object({ matchedTerms: z.number().int().nonnegative(), totalTerms: z.number().int().nonnegative(), termCoverage: z.number().min(0).max(1), sourceKinds: z.number().int().nonnegative() }).strict(),
  }).strict(),
  generatedAt: z.number().int().nonnegative(),
  lastVerifiedAt: z.number().int().nonnegative(),
  indexVersion: HashSchema,
  partial: z.boolean(),
  truncated: z.boolean(),
  nextCursor: z.string().nullable(),
}).strict();

export const ContextStatus = z.object({
  schemaVersion: z.literal(CONTEXT_SCHEMA_VERSION),
  cache: z.object({
    entries: z.number().int().nonnegative(),
    levels: z.array(z.object({ level: z.enum(CONTEXT_CACHE_LEVELS), entries: z.number().int().nonnegative(), hits: z.number().int().nonnegative() }).strict()),
  }).strict(),
  evidence: z.object({ current: z.number().int().nonnegative(), stale: z.number().int().nonnegative(), unavailable: z.number().int().nonnegative() }).strict(),
  metrics: z.object({ queries: z.number().int().nonnegative(), cacheHits: z.number().int().nonnegative(), cacheHitRate: z.number().min(0).max(1), averageLatencyMs: z.number().nonnegative(), candidates: z.number().int().nonnegative(), returned: z.number().int().nonnegative(), staleTransitions: z.number().int().nonnegative(), lastTermCoverage: z.number().min(0).max(1), lastQueryAt: z.number().int().nonnegative().nullable() }).strict(),
  sources: z.array(RetrievalSourceStatus),
  note: z.string(),
}).strict();

export type EvidenceRecordData = z.infer<typeof EvidenceRecord>;
export type ContextProjectData = z.infer<typeof ContextProject>;
export type ContextQueryResultData = z.infer<typeof ContextQueryResult>;
