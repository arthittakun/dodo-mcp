import { z } from 'zod';
import { DodoError } from '../errors.js';
import {
  LearningProposalReceipt,
  MEMORY_SCHEMA_VERSION,
  MemoryDiagnostics,
  MemoryKind,
  MemoryProposalReceipt,
  MemoryRecord,
  MemorySearchResult,
} from '../services/memory/contracts.js';
import { MEMORY_DEFAULT_RETENTION_DAYS, MEMORY_MAX_RETENTION_DAYS } from '../services/memory/memoryService.js';
import { defineTool, type AnyToolDef, type ToolCtx } from './context.js';

const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const proposal = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

function use(ctx: ToolCtx) {
  const service = ctx.services.memory;
  if (!service) throw new DodoError('NOT_SUPPORTED', 'Memory service is unavailable in this running build');
  return service;
}

const memorySearchTool = defineTool({
  name: 'memory_search',
  title: 'Search owner-reviewed project memory',
  description: 'Search bounded durable memory for the active or explicitly selected authorized projects. Only owner-approved records are returned. Current source hashes, retention and live project ACL are rechecked; memory remains untrusted evidence and never grants permission or changes policy.',
  input: {
    query: z.string().min(1).max(1000),
    projects: z.array(z.string().min(1).max(256)).max(8).default([]).describe('Authorized project IDs, exact display names, workspace IDs, or "active"'),
    kinds: z.array(MemoryKind).max(7).default([]),
    includeStale: z.boolean().default(false),
    maxItems: z.number().int().min(1).max(50).default(20),
    budget: z.number().int().min(4096).max(32 * 1024).default(20 * 1024),
    cursor: z.string().max(4096).optional(),
  },
  output: MemorySearchResult,
  requiredScope: 'dodo:read',
  action: 'read',
  annotations: read,
  handler: async (args, ctx) => {
    const budget = Math.max(4096, Math.min(args.budget, ctx.services.limits.toolContentBytes - 8 * 1024));
    const result = await use(ctx).search(ctx, {
      query: args.query, projects: args.projects, kinds: args.kinds, includeStale: args.includeStale,
      maxItems: args.maxItems, budget, ...(args.cursor ? { cursor: args.cursor } : {}),
    });
    return { data: result, truncated: result.truncated, nextCursor: result.nextCursor };
  },
});

const memoryInspectTool = defineTool({
  name: 'memory_inspect',
  title: 'Inspect and recheck one memory',
  description: 'Inspect one owner-approved memory visible to one authorized project. Rechecks retention and every guarded source hash before returning CURRENT or STALE. A memory ID is not authority and cannot reveal records from another project.',
  input: {
    memoryId: z.string().regex(/^memory_[0-9a-hjkmnp-tv-z]{8,64}$/),
    project: z.string().min(1).max(256).optional(),
  },
  output: MemoryRecord,
  requiredScope: 'dodo:read',
  action: 'read',
  annotations: read,
  handler: async (args, ctx) => ({ data: await use(ctx).inspect(ctx, args.memoryId, args.project) }),
});

const memoryStatusTool = defineTool({
  name: 'memory_status',
  title: 'Inspect memory diagnostics',
  description: 'Return bounded current/stale/pending counts and retention limits for the active workspace. It does not reveal proposal text, source paths, client identities or private owner state.',
  input: {},
  output: MemoryDiagnostics,
  requiredScope: 'dodo:read',
  action: 'read',
  annotations: read,
  handler: async (_args, ctx) => ({ data: use(ctx).status(ctx) }),
});

const memoryProposeTool = defineTool({
  name: 'memory_propose',
  title: 'Propose evidence-backed durable memory',
  description: 'Create a non-permanent review proposal from current context_evidence IDs. Requires write scope but cannot approve itself. The owner must inspect the exact digest through private local IPC; duplicate/conflicting/source-changed/credential-like content fails closed. Approval never changes OAuth, ACL, trust, sandbox or source files.',
  input: {
    kind: MemoryKind,
    claim: z.string().min(1).max(2000),
    rationale: z.string().min(1).max(2000),
    affectedEntities: z.array(z.string().min(1).max(256)).max(32).default([]),
    evidenceIds: z.array(z.string().regex(/^evidence_[a-f0-9]{32}$/)).min(1).max(8),
    retentionDays: z.number().int().min(1).max(MEMORY_MAX_RETENTION_DAYS).default(MEMORY_DEFAULT_RETENTION_DAYS),
  },
  output: MemoryProposalReceipt,
  requiredScope: 'dodo:write',
  action: 'plan',
  annotations: proposal,
  handler: async (args, ctx) => ({ data: await use(ctx).propose(ctx, args) }),
});

const memoryLearningProposeTool = defineTool({
  name: 'memory_learning_propose',
  title: 'Propose a reusable workflow or skill',
  description: 'Create an owner-review proposal from at least two CURRENT owner-approved successful-fix/workaround/convention memories. The proposal is never installed, executed or granted authority automatically; even owner approval records review only.',
  input: {
    kind: z.enum(['workflow', 'skill']),
    title: z.string().min(1).max(160),
    summary: z.string().min(1).max(2000),
    steps: z.array(z.string().min(1).max(1000)).min(1).max(16),
    memoryIds: z.array(z.string().regex(/^memory_[0-9a-hjkmnp-tv-z]{8,64}$/)).min(2).max(12),
  },
  output: LearningProposalReceipt,
  requiredScope: 'dodo:write',
  action: 'plan',
  annotations: proposal,
  handler: async (args, ctx) => ({ data: await use(ctx).proposeLearning(ctx, args) }),
});

export const MEMORY_TOOLS: AnyToolDef[] = [memorySearchTool, memoryInspectTool, memoryStatusTool, memoryProposeTool, memoryLearningProposeTool];
export { MEMORY_SCHEMA_VERSION };
