import { z } from 'zod';

export const RUNTIME_SCHEMA_VERSION = 1;
export const RuntimeSessionId = z.string().regex(/^runtime_[0-9a-hjkmnp-tv-z]{8,64}$/);
export const RuntimeTaskId = z.string().regex(/^rtask_[0-9a-hjkmnp-tv-z]{8,64}$/);
export const RuntimeEvidenceId = z.string().regex(/^runtimeev_[0-9a-hjkmnp-tv-z]{8,64}$/);
export const RuntimeTaskKind = z.enum(['process', 'test', 'container']);
export const RuntimeEvidenceKind = z.enum(['process', 'test', 'container', 'browser', 'snapshot']);
export const RuntimeEvidenceStatus = z.enum(['CURRENT', 'STALE', 'EXPIRED']);

export const RuntimeSession = z.object({
  schemaVersion: z.literal(RUNTIME_SCHEMA_VERSION),
  sessionId: RuntimeSessionId,
  label: z.string(),
  status: z.enum(['OPEN', 'CLOSED', 'EXPIRED']),
  workspaceId: z.string(),
  openedEpoch: z.string(),
  createdAt: z.number().int().nonnegative(),
  lastSeenAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
  closedAt: z.number().int().nonnegative().nullable(),
}).strict();

export const RuntimeTask = z.object({
  taskId: RuntimeTaskId,
  sessionId: RuntimeSessionId,
  jobId: z.string(),
  kind: RuntimeTaskKind,
  status: z.string(),
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  createdAt: z.number().int().nonnegative(),
  startedAt: z.number().int().nonnegative().nullable(),
  endedAt: z.number().int().nonnegative().nullable(),
  timeoutMs: z.number().int().positive(),
}).strict();

export const RuntimeEvidence = z.object({
  schemaVersion: z.literal(RUNTIME_SCHEMA_VERSION),
  evidenceId: RuntimeEvidenceId,
  sessionId: RuntimeSessionId,
  kind: RuntimeEvidenceKind,
  status: RuntimeEvidenceStatus,
  sourceRef: z.string(),
  sourceHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  contentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  payload: z.record(z.string(), z.unknown()),
  staleReason: z.string().nullable(),
  createdAt: z.number().int().nonnegative(),
  lastVerifiedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
  trust: z.literal('untrusted_runtime_evidence'),
}).strict();

export const RuntimeSessionStatus = z.object({
  session: RuntimeSession,
  tasks: z.array(RuntimeTask),
  evidence: z.object({ current: z.number().int().nonnegative(), stale: z.number().int().nonnegative(), expired: z.number().int().nonnegative() }).strict(),
  reconnectable: z.literal(true),
  note: z.string(),
}).strict();

export const RuntimeDiagnosis = z.object({
  sessionId: RuntimeSessionId,
  facts: z.array(z.string()),
  observations: z.array(z.string()),
  inferences: z.array(z.object({ statement: z.string(), confidence: z.enum(['low', 'medium', 'high']), evidenceIds: z.array(RuntimeEvidenceId) }).strict()),
  limitations: z.array(z.string()),
  trust: z.literal('untrusted_runtime_evidence'),
}).strict();

export type RuntimeSessionData = z.infer<typeof RuntimeSession>;
export type RuntimeTaskData = z.infer<typeof RuntimeTask>;
export type RuntimeEvidenceData = z.infer<typeof RuntimeEvidence>;
