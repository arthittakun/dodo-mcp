import { z } from 'zod';

/** Typed, additive contracts. No new privileges, config, or model/API dependency. */
export const HashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const Count = z.number().int().nonnegative();
export const CitationSchema = z.object({
  path: z.string(), hash: HashSchema, line: z.number().int().positive(),
  endLine: z.number().int().positive(),
});
export const OutlineSchema = z.object({
  name: z.string(), qualifiedName: z.string(), kind: z.string(),
  line: z.number().int().positive(), endLine: z.number().int().positive(),
  signature: z.string(),
});
export const CoverageSchema = z.object({
  scannedFiles: Count, skippedFiles: Count, scannedBytes: Count,
  truncated: z.boolean(), unresolvedImports: Count, dynamicImports: Count,
  scope: z.literal('bounded_workspace_static_analysis'),
});
export const EdgeSchema = z.object({
  from: z.string(), to: z.string(), line: z.number().int().positive(),
  kind: z.enum(['import', 'export', 'import_equals']),
});
export const ContextSchema = z.object({
  goal: z.string(), terms: z.array(z.string()),
  files: z.array(CitationSchema.extend({
    score: z.number(), reasons: z.array(z.string()), content: z.string(),
    category: z.enum(['source', 'test', 'docs', 'config']),
    symbols: z.array(OutlineSchema), excerptTruncated: z.boolean(),
  })),
  relationships: z.array(EdgeSchema), coverage: CoverageSchema,
  computedAt: z.number(), truncated: z.boolean(), notes: z.array(z.string()),
});
export const ImpactSchema = z.object({
  targets: z.array(z.object({ path: z.string(), hash: HashSchema.nullable(), missing: z.boolean() })),
  impacted: z.array(z.object({
    path: z.string(), hash: HashSchema, distance: z.number().int().positive(),
    via: z.string(), evidenceLine: z.number().int().positive(), isTest: z.boolean(),
  })),
  relatedTests: z.array(z.string()), coverage: CoverageSchema,
  requiresBroadVerification: z.boolean(), reasons: z.array(z.string()),
  computedAt: z.number(), truncated: z.boolean(),
});
export const SymbolSchema = CitationSchema.extend({
  symbol: OutlineSchema, content: z.string(), truncated: z.boolean(),
  editableBody: z.boolean(), provider: z.literal('typescript-ast'),
});
export const RefactorSchema = z.object({
  path: z.string(), beforeHash: HashSchema, content: z.string(),
  symbol: OutlineSchema, operation: z.literal('replace_body'),
});
export type ContextResult = z.infer<typeof ContextSchema>;
export type ImpactResult = z.infer<typeof ImpactSchema>;
export type SymbolResult = z.infer<typeof SymbolSchema>;
export type RefactorResult = z.infer<typeof RefactorSchema>;
export type Outline = z.infer<typeof OutlineSchema>;
export type Coverage = z.infer<typeof CoverageSchema>;
export type Edge = z.infer<typeof EdgeSchema>;
export type AssistanceRequest =
  | { op: 'assist_context'; goal: string; terms: string[]; files: string[]; maxFiles: number; maxBytes: number }
  | { op: 'assist_impact'; files: string[]; maxResults: number; maxDepth: number }
  | { op: 'assist_symbol'; file: string; symbol: string; line?: number; maxBytes: number }
  | { op: 'assist_refactor'; file: string; symbol: string; line?: number; expectedHash: string; body: string };

export const RecipeSchema = z.object({
  taskId: z.string(), recipeDigest: z.string(), title: z.string(),
});
