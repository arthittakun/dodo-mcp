import { z } from 'zod';

export const AGENT_SCHEMA_VERSION = 1;
export const AgentRunId = z.string().regex(/^arun_[0-9a-hjkmnp-tv-z]{8,64}$/);
export const AgentHypothesisId = z.string().regex(/^ahyp_[0-9a-hjkmnp-tv-z]{8,64}$/);
export const AgentIntentId = z.string().regex(/^aintent_[0-9a-hjkmnp-tv-z]{8,64}$/);
export const AgentSnapshotId = z.string().regex(/^asnap_[0-9a-hjkmnp-tv-z]{8,64}$/);
export const AgentSkillId = z.string().regex(/^askill_[0-9a-hjkmnp-tv-z]{8,64}$/);
export const AgentSkillProposalId = z.string().regex(/^askillprop_[0-9a-hjkmnp-tv-z]{8,64}$/);

export const AgentCapabilities = z.object({
  allowedProjectIds: z.array(z.string().regex(/^prj_[0-9a-hjkmnp-tv-z]{8,64}$/)).max(8),
  writablePaths: z.array(z.string().min(1).max(1024)).max(32),
  allowedPrograms: z.array(z.string().min(1).max(512)).max(32),
  allowNetwork: z.boolean(),
  allowBrowser: z.boolean(),
  allowDesktop: z.boolean(),
  allowMedia: z.boolean(),
  allowWorkflow: z.boolean(),
  secretAccess: z.literal(false),
  maxHypotheses: z.number().int().min(1).max(8),
  maxActions: z.number().int().min(1).max(500),
  maxRunningJobs: z.number().int().min(1).max(16),
  maxWallMinutes: z.number().int().min(1).max(24 * 60),
}).strict();

export const AgentRun = z.object({
  schemaVersion: z.literal(AGENT_SCHEMA_VERSION),
  runId: AgentRunId,
  goal: z.string(),
  completionCriteria: z.array(z.string()),
  capabilities: AgentCapabilities,
  status: z.enum(['ACTIVE', 'PAUSED', 'RECOVERY_REQUIRED', 'COMPLETED', 'CANCELED', 'EXPIRED']),
  revision: z.number().int().positive(),
  actionCount: z.number().int().nonnegative(),
  workspaceId: z.string(),
  openedEpoch: z.string(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
  completedAt: z.number().int().nonnegative().nullable(),
  authority: z.literal('coordination_only'),
}).strict();

export const AgentPlanStep = z.object({
  id: z.string().min(1).max(80),
  phase: z.enum(['context', 'plan', 'act', 'observe', 'verify', 'diagnose', 'repair']),
  operation: z.string().min(1).max(128),
  description: z.string().min(1).max(500),
  completionCriterion: z.string().min(1).max(500).nullable(),
  dependsOn: z.array(z.string().min(1).max(80)).max(16),
}).strict();

export const AgentPlan = z.object({
  runId: AgentRunId,
  revision: z.number().int().positive(),
  steps: z.array(AgentPlanStep),
  contentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  createdAt: z.number().int().nonnegative(),
  immutable: z.literal(true),
}).strict();

export const AgentHypothesis = z.object({
  hypothesisId: AgentHypothesisId,
  runId: AgentRunId,
  title: z.string(),
  probableCause: z.string(),
  expectedEvidence: z.array(z.string()),
  status: z.enum(['ACTIVE', 'PASSED', 'FAILED', 'INCONCLUSIVE', 'CANCELED']),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
}).strict();

export const AgentIntent = z.object({
  intentId: AgentIntentId,
  runId: AgentRunId,
  hypothesisId: AgentHypothesisId,
  kind: z.enum(['path', 'symbol', 'resource']),
  resourceKey: z.string(),
  status: z.enum(['ACTIVE', 'RELEASED', 'EXPIRED']),
  createdAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
  releasedAt: z.number().int().nonnegative().nullable(),
}).strict();

export const AgentSnapshot = z.object({
  snapshotId: AgentSnapshotId,
  runId: AgentRunId,
  hypothesisId: AgentHypothesisId,
  manifestHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  fileCount: z.number().int().nonnegative(),
  truncated: z.boolean(),
  createdAt: z.number().int().nonnegative(),
  storesFileContents: z.literal(false),
}).strict();

export const AgentSkillSummary = z.object({
  skillId: AgentSkillId,
  key: z.string(),
  title: z.string(),
  summary: z.string(),
  version: z.number().int().positive(),
  requiredCapabilities: z.array(z.string()),
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  authority: z.literal('untrusted_guidance'),
}).strict();

export const AgentSkillDetail = AgentSkillSummary.extend({
  steps: z.array(z.string()),
  approvedAt: z.number().int().nonnegative(),
}).strict();

export type AgentCapabilitiesData = z.infer<typeof AgentCapabilities>;
export type AgentRunData = z.infer<typeof AgentRun>;
export type AgentHypothesisData = z.infer<typeof AgentHypothesis>;
export type AgentIntentData = z.infer<typeof AgentIntent>;
export type AgentSnapshotData = z.infer<typeof AgentSnapshot>;
