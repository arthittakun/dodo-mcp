import { z } from 'zod';
import { MAX_FILE_BYTES } from '../config/limits.js';
import { policyGate, defineTool, type ToolCtx } from './context.js';
import { DodoError } from '../errors.js';
import { digestOf } from '../util/hash.js';
import type { PublicPlanOp } from '../services/changes/types.js';

const looseData = z.looseObject({});

const OperationSchema = z.discriminatedUnion('op', [
  z
    .object({
      op: z.literal('create'),
      path: z.string().max(1024),
      content: z.string().max(MAX_FILE_BYTES),
      createParents: z.boolean().default(false),
    })
    .strict(),
  z
    .object({
      op: z.literal('replace_file'),
      path: z.string().max(1024),
      content: z.string().max(MAX_FILE_BYTES),
      expectedHash: z.string().max(128).optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal('replace_exact'),
      path: z.string().max(1024),
      find: z.string().min(1).max(MAX_FILE_BYTES),
      replace: z.string().max(MAX_FILE_BYTES),
      expectedCount: z.number().int().min(1).max(1000).default(1),
      expectedHash: z.string().max(128).optional(),
    })
    .strict(),
  z.object({ op: z.literal('delete'), path: z.string().max(1024), expectedHash: z.string().max(128).optional() }).strict(),
  z
    .object({
      op: z.literal('move'),
      path: z.string().max(1024),
      destPath: z.string().max(1024),
      expectedHash: z.string().max(128).optional(),
    })
    .strict(),
]);

export const previewChangesTool = defineTool({
  name: 'preview_changes',
  title: 'Preview changes',
  description:
    'Validate a batch of file operations (create / replace_file / replace_exact / delete / move) and produce an IMMUTABLE plan with per-file diffs, raw-byte before/after SHA-256 hashes, risk and expiry. The workspace is NOT modified. replace_exact requires the target text to occur exactly expectedCount times (default 1) — mismatches fail with AMBIGUOUS_EDIT instead of fuzzy-editing. Apply with apply_changes(planId, planHash, idempotencyKey).',
  input: {
    operations: z.array(OperationSchema).min(1).max(50),
  },
  output: looseData,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  requiredScope: 'dodo:write',
  action: 'plan',
  handler: async (args, ctx) => {
    const preview = ctx.services.planner.preview({
      ops: args.operations as PublicPlanOp[],
      workspaceId: ctx.services.workspaceId,
      epoch: ctx.services.epoch,
      principal: ctx.principal.grantId,
      trustMode: ctx.trustMode,
      source: 'preview_changes',
    });
    return { data: preview };
  },
});

const IdempotencyKey = z.string().min(8).max(128).describe('Client-generated key; reuse the SAME key when retrying this exact call');

/**
 * Durable idempotency wrapper (spec §12.3): reserve → side effect → receipt.
 * Same key + same payload replays the stored receipt; same key + different
 * payload is IDEMPOTENCY_CONFLICT; a reservation without a receipt reports an
 * uncertain in-progress/interrupted state and is never blindly re-run.
 */
export async function withIdempotency<T>(
  ctx: ToolCtx,
  tool: string,
  key: string,
  payload: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<{ result: T; replayed: boolean }> {
  const store = ctx.services.store;
  const ids = { key, principal: ctx.principal.grantId, workspaceId: ctx.services.workspaceId, tool };
  const payloadHash = digestOf(payload);
  const reservation = store.reserveIdempotency({ ...ids, payloadHash });
  if (reservation.outcome === 'conflict') {
    throw new DodoError('IDEMPOTENCY_CONFLICT', 'this idempotencyKey was already used with different arguments', {
      recovery: 'use a fresh idempotencyKey for a new operation',
    });
  }
  if (reservation.outcome === 'duplicate') {
    if (reservation.state === 'completed' && reservation.result !== null) {
      return { result: JSON.parse(reservation.result) as T, replayed: true };
    }
    throw new DodoError('RECOVERY_REQUIRED', 'an operation with this key is in progress or was interrupted; its outcome is uncertain', {
      retryable: true,
      recovery: 'wait and retry with the same key to check again; use a NEW key only if you intend to run the operation again',
    });
  }
  try {
    const result = await fn();
    store.completeIdempotency(ids, JSON.stringify(result));
    return { result, replayed: false };
  } catch (err) {
    const je = err instanceof DodoError ? err : undefined;
    if (je?.code !== 'PARTIAL_RECOVERY_REQUIRED' && je?.code !== 'RECOVERY_REQUIRED') {
      store.releaseIdempotency(ids);
    }
    throw err;
  }
}

export const applyChangesTool = defineTool({
  name: 'apply_changes',
  title: 'Apply changes',
  description:
    'Apply a previously previewed immutable plan. Requires planId + planHash from preview_changes/preview_rename and a client idempotencyKey (retry-safe: the same key returns the same receipt and never creates a second changeset). Every file hash is re-verified before writing; changed files fail with FILE_CHANGED. In inspect mode this needs a local owner approval first (the error tells you the approval id).',
  input: {
    planId: z.string().max(128),
    planHash: z.string().max(128),
    idempotencyKey: IdempotencyKey,
  },
  output: looseData,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  requiredScope: 'dodo:write',
  action: 'mutate-files',
  handler: async (args, ctx) => {
    policyGate(ctx, {
      tool: 'apply_changes',
      action: 'mutate-files',
      approvalAction: { planId: args.planId, planHash: args.planHash },
      summary: `apply change plan ${args.planId}`,
    });
    const { result, replayed } = await withIdempotency(ctx, 'apply_changes', args.idempotencyKey, { planId: args.planId, planHash: args.planHash }, () =>
      ctx.services.applier.apply({
        planId: args.planId,
        planHash: args.planHash,
        workspaceId: ctx.services.workspaceId,
        epoch: ctx.services.epoch,
        principal: ctx.principal.grantId,
      }),
    );
    return { data: { ...result, replayed } };
  },
});

export const rollbackChangesTool = defineTool({
  name: 'rollback_changes',
  title: 'Rollback changes',
  description:
    'Restore your own committed changeset to its pre-apply bytes from verified durable backups. Changesets owned by another caller require private owner recovery. Refused if any affected file or backup changed. Takes the changesetId from apply_changes and a fresh idempotencyKey.',
  input: {
    changesetId: z.string().max(128),
    idempotencyKey: IdempotencyKey,
  },
  output: looseData,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  requiredScope: 'dodo:write',
  action: 'mutate-files',
  handler: async (args, ctx) => {
    policyGate(ctx, {
      tool: 'rollback_changes',
      action: 'mutate-files',
      approvalAction: { changesetId: args.changesetId },
      summary: `rollback changeset ${args.changesetId}`,
    });
    const { result, replayed } = await withIdempotency(ctx, 'rollback_changes', args.idempotencyKey, { changesetId: args.changesetId }, () =>
      ctx.services.applier.rollback({
        changesetId: args.changesetId,
        workspaceId: ctx.services.workspaceId,
        epoch: ctx.services.epoch,
        principal: ctx.principal.grantId,
      }),
    );
    return { data: { ...result, replayed } };
  },
});

export const changeHistoryTool = defineTool({
  name: 'change_history',
  title: 'Change history',
  description: 'List DODO changesets for this workspace (id, kind, status, summary, timestamps). Only DODO-made changes appear here — external edits are not tracked.',
  input: {
    limit: z.number().int().min(1).max(100).default(20),
  },
  output: looseData,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  requiredScope: 'dodo:read',
  action: 'read',
  handler: async (args, ctx) => {
    const rows = ctx.services.store.listChangesets(ctx.services.workspaceId, args.limit).map((c) => ({
      changesetId: c.id,
      kind: c.kind,
      status: c.status,
      summary: c.summary,
      createdAt: c.createdAt,
      committedAt: c.committedAt,
      planId: c.planId,
    }));
    return { data: { changesets: rows } };
  },
});
