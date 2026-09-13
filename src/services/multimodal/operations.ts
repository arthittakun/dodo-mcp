import { DodoError } from '../../errors.js';
import { digestOf } from '../../util/hash.js';
import { policyGate, type ToolCtx } from '../../tools/context.js';
import { liveAccess } from './storage.js';

/** Preserve reservations on uncertain execution OR receipt-persistence failure. Never replay an action just because its response was lost. */
export async function multimediaEffect<T>(ctx: ToolCtx, tool: string, key: string, payload: Record<string, unknown>, fn: () => Promise<T>, standardGate = true): Promise<T & { replayed: boolean }> {
  liveAccess(ctx, 'dodo:exec');
  const store = ctx.services.store, ids = { key, principal: ctx.principal.grantId, workspaceId: ctx.services.workspaceId, tool };
  const reservation = store.reserveIdempotency({ ...ids, payloadHash: digestOf({ ...payload, epoch: ctx.services.epoch }) });
  if (reservation.outcome === 'conflict') throw new DodoError('IDEMPOTENCY_CONFLICT', 'idempotency key belongs to different multimedia arguments');
  if (reservation.outcome === 'duplicate') {
    if (reservation.state === 'completed' && reservation.result !== null) return { ...JSON.parse(reservation.result) as T, replayed: true };
    throw new DodoError('RECOVERY_REQUIRED', 'multimedia operation is in progress or uncertain; inspect existing jobs/window before retrying');
  }
  let result: T;
  try {
    if (standardGate) policyGate(ctx, { tool, action: 'exec', approvalAction: payload, summary: `${tool}: explicit bounded multimedia/browser operation` });
    result = await fn();
  } catch (err) {
    const safeCodes = ['APPROVAL_REQUIRED', 'FORBIDDEN', 'INVALID_INPUT', 'NOT_SUPPORTED', 'NOT_FOUND', 'PATH_DENIED', 'SECRET_PATH_DENIED', 'FILE_CHANGED', 'FILE_TOO_LARGE', 'RESOURCE_LIMIT', 'STALE_WORKSPACE', 'AMBIGUOUS_EDIT'];
    if (err instanceof DodoError && safeCodes.includes(err.code)) { store.releaseIdempotency(ids); throw err; }
    throw new DodoError('RECOVERY_REQUIRED', `operation outcome requires inspection; it was not automatically repeated (${err instanceof DodoError ? err.code : 'PROCESS_ERROR'})`);
  }
  try { store.completeIdempotency(ids, JSON.stringify(result)); }
  catch { throw new DodoError('RECOVERY_REQUIRED', 'operation finished but its receipt could not be persisted; inspect results, never auto-repeat with a new key'); }
  liveAccess(ctx, 'dodo:exec');
  return { ...result, replayed: false };
}
