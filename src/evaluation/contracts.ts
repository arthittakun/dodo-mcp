import { z } from 'zod';

export const DODO_BENCH_REPORT_VERSION = 1;

export const DodoBenchDomain = z.enum([
  'code_retrieval',
  'bug_diagnosis_refactor',
  'runtime_browser_visual',
  'resource_multimodal',
  'recovery_memory_cache',
  'security_authorization',
]);

export const DodoBenchCase = z.object({
  id: z.string().min(1).max(128),
  domain: DodoBenchDomain,
  status: z.enum(['PASS', 'FAIL', 'SKIPPED']),
  eligible: z.boolean(),
  latencyMs: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  serializedRequestBytes: z.number().int().nonnegative(),
  serializedResponseBytes: z.number().int().nonnegative(),
  humanInterventions: z.number().int().nonnegative(),
  securityViolations: z.number().int().nonnegative(),
  metrics: z.object({
    relevantRetrieved: z.number().int().nonnegative().optional(),
    retrieved: z.number().int().nonnegative().optional(),
    expectedRelevant: z.number().int().nonnegative().optional(),
    edits: z.number().int().nonnegative().optional(),
    wrongFileEdits: z.number().int().nonnegative().optional(),
    cacheHits: z.number().int().nonnegative().optional(),
    cacheLookups: z.number().int().nonnegative().optional(),
  }).strict(),
  notes: z.array(z.string().max(500)).max(16),
}).strict();

export const DodoBenchThresholds = z.object({
  successRateMin: z.number().min(0).max(1),
  wrongFileEditRateMax: z.number().min(0).max(1),
  contextPrecisionMin: z.number().min(0).max(1),
  contextRecallMin: z.number().min(0).max(1),
  cacheHitRateMin: z.number().min(0).max(1),
  securityViolationsMax: z.number().int().nonnegative(),
  toolCallsMax: z.number().int().positive(),
  p95LatencyMsMax: z.number().int().positive(),
  humanInterventionsMax: z.number().int().nonnegative(),
}).strict();

export const DodoBenchBaseline = z.object({
  schemaVersion: z.literal(DODO_BENCH_REPORT_VERSION),
  dataset: z.object({ name: z.string(), version: z.string() }).strict(),
  requiredCases: z.array(z.string()).min(1),
  optionalCases: z.array(z.string()),
  thresholds: DodoBenchThresholds,
}).strict();

export const DodoBenchAggregate = z.object({
  eligibleCases: z.number().int().nonnegative(),
  passedCases: z.number().int().nonnegative(),
  skippedCases: z.number().int().nonnegative(),
  successRate: z.number().min(0).max(1),
  wrongFileEditRate: z.number().min(0).max(1),
  contextPrecision: z.number().min(0).max(1),
  contextRecall: z.number().min(0).max(1),
  cacheHitRate: z.number().min(0).max(1),
  toolCalls: z.number().int().nonnegative(),
  serializedRequestBytes: z.number().int().nonnegative(),
  serializedResponseBytes: z.number().int().nonnegative(),
  modelTokens: z.null(),
  latencyMs: z.object({ total: z.number().int().nonnegative(), p50: z.number().int().nonnegative(), p95: z.number().int().nonnegative() }).strict(),
  humanInterventions: z.number().int().nonnegative(),
  securityViolations: z.number().int().nonnegative(),
  regressions: z.array(z.string()),
}).strict();

export const DodoBenchReport = z.object({
  schemaVersion: z.literal(DODO_BENCH_REPORT_VERSION),
  status: z.enum(['PASS', 'FAIL']),
  generatedAt: z.string().datetime(),
  source: z.object({ revision: z.string(), dirty: z.boolean() }).strict(),
  dataset: z.object({ name: z.string(), version: z.string(), digest: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).strict(),
  environment: z.object({
    platform: z.string(), arch: z.string(), release: z.string(), node: z.string(),
    dependencyLockSha256: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    configurationSha256: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  }).strict(),
  client: z.object({ name: z.string(), version: z.string() }).strict(),
  model: z.object({ name: z.null(), version: z.null(), note: z.string() }).strict(),
  cases: z.array(DodoBenchCase),
  aggregate: DodoBenchAggregate,
  limitations: z.array(z.string()),
}).strict();

export type DodoBenchCaseData = z.infer<typeof DodoBenchCase>;
export type DodoBenchBaselineData = z.infer<typeof DodoBenchBaseline>;
export type DodoBenchAggregateData = z.infer<typeof DodoBenchAggregate>;
export type DodoBenchReportData = z.infer<typeof DodoBenchReport>;
