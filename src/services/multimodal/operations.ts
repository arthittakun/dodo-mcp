import { DodoError } from '../../errors.js';
import { digestOf } from '../../util/hash.js';
import { policyGate, type ToolCtx } from '../../tools/context.js';
import { liveAccess } from './storage.js';
import { actorKey } from './storage.js';
import { AsyncLocalStorage } from 'node:async_hooks';

const PAID_MEDIA = new Set(['image_generate', 'image_edit', 'image_remove_background', 'video_generate', 'video_edit', 'video_extend']);
export const creativeSubmission = new AsyncLocalStorage<{ key: string; tool: string; payloadHash: string }>();

/** Preserve reservations on uncertain execution OR receipt-persistence failure. Never replay an action just because its response was lost.
 * preflightCodes is backend-only and may be supplied only when fn guarantees that those errors precede every effect.
 */
export async function multimediaEffect<T>(ctx: ToolCtx, tool: string, key: string, payload: Record<string, unknown>, fn: () => Promise<T>, standardGate = true, preflightCodes: readonly string[] = []): Promise<T & { replayed: boolean }> {
  liveAccess(ctx, 'dodo:exec');
  const store = ctx.services.store, ids = { key, principal: ctx.principal.grantId, workspaceId: ctx.services.workspaceId, tool };
  const durable = PAID_MEDIA.has(tool), payloadHash = digestOf(durable ? payload : { ...payload, epoch: ctx.services.epoch });
  if (durable) {
    const prior = store.db.prepare('SELECT payload_hash,result,state FROM idempotency_keys WHERE key=? AND principal=? AND workspace_id=? AND tool=?').get(key, ids.principal, ids.workspaceId, tool) as { payload_hash: string; result: string | null; state: string } | undefined;
    if (prior) {
      let jobId: string | undefined;
      try { jobId = (JSON.parse(prior.result ?? '{}') as { jobId?: string }).jobId; } catch { /* lost receipt can be reconciled by submission key below */ }
      const row = jobId ? store.db.prepare('SELECT payload FROM creative_jobs WHERE id=? AND workspace_id=? AND owner=?').get(jobId, ids.workspaceId, actorKey(ctx.principal)) : store.db.prepare(`SELECT payload FROM creative_jobs WHERE workspace_id=? AND owner=? AND json_extract(payload,'$.submissionKey')=? AND json_extract(payload,'$.submissionTool')=? LIMIT 1`).get(ids.workspaceId, actorKey(ctx.principal), key, tool);
      const job = row ? JSON.parse((row as { payload: string }).payload) as Record<string, unknown> : undefined;
      if (job && prior.payload_hash !== payloadHash && prior.payload_hash === digestOf({ ...payload, epoch: job['epoch'] })) store.db.prepare('UPDATE idempotency_keys SET payload_hash=? WHERE key=? AND principal=? AND workspace_id=? AND tool=? AND payload_hash=?').run(payloadHash, key, ids.principal, ids.workspaceId, tool, prior.payload_hash);
      if (job && prior.state === 'reserved' && (job['submissionHash'] === payloadHash || prior.payload_hash === payloadHash)) {
        const receipt = Object.fromEntries(['jobId', 'kind', 'status', 'model', 'progress', 'resource', 'error', 'createdAt', 'expiresAt', 'note', 'diagnostics'].filter(field => field in job).map(field => [field, job[field]]));
        store.completeIdempotency(ids, JSON.stringify(receipt));
      }
    }
  }
  const reservation = store.reserveIdempotency({ ...ids, payloadHash });
  if (reservation.outcome === 'conflict') throw new DodoError('IDEMPOTENCY_CONFLICT', 'idempotency key belongs to different multimedia arguments');
  if (reservation.outcome === 'duplicate') {
    if (reservation.state === 'completed' && reservation.result !== null) return { ...JSON.parse(reservation.result) as T, replayed: true };
    throw new DodoError('RECOVERY_REQUIRED', 'multimedia operation is in progress or uncertain; inspect existing jobs/window before retrying');
  }
  let result: T;
  try {
    if (standardGate) policyGate(ctx, { tool, action: 'exec', approvalAction: payload, summary: `${tool}: explicit bounded multimedia/browser operation` });
    result = durable ? await creativeSubmission.run({ key, tool, payloadHash }, fn) : await fn();
  } catch (err) {
    const safeCodes = ['APPROVAL_REQUIRED', 'FORBIDDEN', 'INVALID_INPUT', 'NOT_SUPPORTED', 'NOT_FOUND', 'PATH_DENIED', 'SECRET_PATH_DENIED', 'FILE_CHANGED', 'FILE_TOO_LARGE', 'RESOURCE_LIMIT', 'STALE_WORKSPACE', 'AMBIGUOUS_EDIT'];
    if (err instanceof DodoError && (safeCodes.includes(err.code) || preflightCodes.includes(err.code))) { store.releaseIdempotency(ids); throw err; }
    throw new DodoError('RECOVERY_REQUIRED', `operation outcome requires inspection; it was not automatically repeated (${err instanceof DodoError ? err.code : 'PROCESS_ERROR'})`);
  }
  try { store.completeIdempotency(ids, JSON.stringify(result)); }
  catch { throw new DodoError('RECOVERY_REQUIRED', 'operation finished but its receipt could not be persisted; inspect results, never auto-repeat with a new key'); }
  liveAccess(ctx, 'dodo:exec');
  return { ...result, replayed: false };
}
