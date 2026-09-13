import { z } from 'zod';
import { HashSchema } from '../assistance/contracts.js';

export const BRAIN_SCHEMA_VERSION = 1;
export const BRAIN_FILE_MAX_BYTES = 512 * 1024;
export const BRAIN_QUERY_MAX = 200;

export const BrainRunStatus = z.enum(['idle', 'running', 'paused', 'completed', 'canceled', 'failed', 'interrupted']);
export const BrainNodeType = z.enum(['file', 'symbol', 'route', 'test', 'dependency']);
export const BrainEdgeType = z.enum(['contains', 'imports', 'exports', 'dynamic_import', 'references', 'depends_on']);
export const BrainFreshness = z.enum(['current', 'stale', 'missing']);

export const ParsedSymbol = z.object({
  name: z.string().min(1).max(256),
  qualifiedName: z.string().min(1).max(1024),
  kind: z.string().min(1).max(80),
  ordinal: z.number().int().nonnegative(),
  line: z.number().int().positive(),
  column: z.number().int().positive(),
  endLine: z.number().int().positive(),
  endColumn: z.number().int().positive(),
  signatureHash: HashSchema,
  exported: z.boolean(),
}).strict();

export const ParsedImport = z.object({
  specifier: z.string().min(1).max(1024),
  kind: z.enum(['imports', 'exports', 'dynamic_import']),
  line: z.number().int().positive(),
}).strict();

export const ParsedReference = z.object({
  name: z.string().min(1).max(256),
  line: z.number().int().positive(),
  column: z.number().int().positive(),
  call: z.boolean(),
}).strict();

export const ParsedRoute = z.object({
  method: z.string().min(1).max(20),
  route: z.string().min(1).max(1024),
  ordinal: z.number().int().nonnegative(),
  line: z.number().int().positive(),
  column: z.number().int().positive(),
}).strict();

export const ParsedTest = z.object({
  kind: z.enum(['describe', 'it', 'test']),
  name: z.string().min(1).max(1024),
  ordinal: z.number().int().nonnegative(),
  line: z.number().int().positive(),
  column: z.number().int().positive(),
}).strict();

export const ParsedDependency = z.object({
  name: z.string().min(1).max(256),
  scope: z.enum(['runtime', 'development', 'peer', 'optional']),
  version: z.string().max(512),
}).strict();

export const ParsedDiagnostic = z.object({
  category: z.enum(['error', 'warning']),
  message: z.string().min(1).max(1024),
  line: z.number().int().positive(),
  column: z.number().int().positive(),
}).strict();

export const ParsedBrainFile = z.object({
  provider: z.enum(['typescript-ast', 'package-json']),
  language: z.enum(['typescript', 'javascript', 'json']),
  symbols: z.array(ParsedSymbol).max(5000),
  imports: z.array(ParsedImport).max(5000),
  references: z.array(ParsedReference).max(10000),
  routes: z.array(ParsedRoute).max(2000),
  tests: z.array(ParsedTest).max(2000),
  dependencies: z.array(ParsedDependency).max(5000),
  diagnostics: z.array(ParsedDiagnostic).max(200),
  truncated: z.boolean(),
}).strict();

export type ParsedBrainFileData = z.infer<typeof ParsedBrainFile>;

const Count = z.number().int().nonnegative();
export const BrainRunMetrics = z.object({
  scannedFiles: Count,
  parsedFiles: Count,
  reusedFiles: Count,
  movedFiles: Count,
  removedFiles: Count,
  skippedFiles: Count,
  affectedFiles: Count,
  nodes: Count,
  edges: Count,
  syntaxErrors: Count,
}).strict();

export const BrainStatus = z.object({
  schemaVersion: z.literal(BRAIN_SCHEMA_VERSION),
  parserVersion: z.string(),
  namespace: z.string(),
  status: BrainRunStatus,
  paused: z.boolean(),
  activeRunId: z.string().nullable(),
  lastRunId: z.string().nullable(),
  lastStartedAt: z.number().int().nonnegative().nullable(),
  lastCompletedAt: z.number().int().nonnegative().nullable(),
  lastError: z.string().nullable(),
  sourceHash: HashSchema.nullable(),
  files: Count,
  nodes: Count,
  edges: Count,
  staleFiles: Count,
  metrics: BrainRunMetrics,
  automaticRefresh: z.boolean(),
  note: z.string(),
}).strict();

export const BrainNode = z.object({
  id: z.string(),
  uri: z.string(),
  type: BrainNodeType,
  name: z.string(),
  qualifiedName: z.string().nullable(),
  path: z.string(),
  line: z.number().int().positive(),
  column: z.number().int().positive(),
  endLine: z.number().int().positive(),
  endColumn: z.number().int().positive(),
  sourceHash: HashSchema,
  parserVersion: z.string(),
  schemaVersion: z.literal(BRAIN_SCHEMA_VERSION),
  freshness: BrainFreshness,
  details: z.record(z.string(), z.unknown()),
}).strict();

export const BrainEdge = z.object({
  id: z.string(),
  type: BrainEdgeType,
  from: z.string(),
  to: z.string().nullable(),
  targetKey: z.string().nullable(),
  sourcePath: z.string(),
  targetPath: z.string().nullable(),
  line: z.number().int().positive(),
  sourceHash: HashSchema,
  parserVersion: z.string(),
  schemaVersion: z.literal(BRAIN_SCHEMA_VERSION),
  freshness: BrainFreshness,
  details: z.record(z.string(), z.unknown()),
}).strict();

export const BrainQueryResult = z.object({
  status: BrainStatus,
  nodes: z.array(BrainNode).max(BRAIN_QUERY_MAX),
  edges: z.array(BrainEdge).max(BRAIN_QUERY_MAX),
  staleOmitted: Count,
  inaccessibleOmitted: Count,
  truncated: z.boolean(),
  nextCursor: z.string().nullable(),
  evidence: z.object({
    sourceVerified: z.boolean(),
    checkedAt: z.number().int().nonnegative(),
    note: z.string(),
  }).strict(),
}).strict();

export const BrainControlResult = z.object({
  runId: z.string().nullable(),
  changed: z.boolean(),
  status: BrainStatus,
}).strict();
