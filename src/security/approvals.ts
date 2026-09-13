import { DodoError } from '../errors.js';
import { digestOf } from '../util/hash.js';
import type { Store } from '../store/store.js';

/**
 * Per-action local approvals (spec §9): bound to principal, workspace, epoch,
 * exact action digest, and expiry. Changing arguments or local policy yields
 * a different digest, so stale approvals can never authorize a different
 * action (CHG-15). Approving happens ONLY over the private IPC socket
 * (`dodo approve ID`) — no tool and no public endpoint can approve.
 */
export interface ApprovalRequest {
  workspaceId: string;
  epoch: string;
  principal: string;
  tool: string;
  /** Canonicalized action payload (already policy-relevant fields only). */
  action: Record<string, unknown>;
  /** One-line human summary shown on the owner's terminal. */
  summary: string;
  ttlMs: number;
}

export function actionDigest(req: Pick<ApprovalRequest, 'tool' | 'action'>, policyVersion: number): string {
  return digestOf({ tool: req.tool, action: req.action, policyVersion });
}

function policyVersionOf(store: Store, workspaceId: string): number {
  const row = store.db.prepare('SELECT COUNT(*) AS c FROM policy_versions WHERE workspace_id = ?').get(workspaceId) as { c: number };
  return row.c;
}

/**
 * Gate an action behind a local approval. Either returns (approval found and
 * consumed — proceed) or throws APPROVAL_REQUIRED carrying an opaque request
 * reference the model can surface to the user.
 */
export function requireLocalApproval(store: Store, req: ApprovalRequest): { approvalId: string } {
  const digest = actionDigest(req, policyVersionOf(store, req.workspaceId));
  const existing = store.findPendingActionApproval(req.workspaceId, digest, req.principal);
  if (existing) {
    if (existing.epoch !== req.epoch) {
      // approvals do not survive server restarts (spec §12.3)
      store.setApprovalStatus(existing.id, 'denied');
    } else if (existing.status === 'approved') {
      const consumed = store.setApprovalStatus(existing.id, 'consumed');
      if (consumed) return { approvalId: existing.id };
      throw new DodoError('APPROVAL_EXPIRED', 'approval expired before use; request again', {
        retryable: true,
        detail: { approvalId: existing.id },
      });
    } else if (existing.status === 'pending') {
      throw new DodoError('APPROVAL_REQUIRED', `local approval pending: run \`dodo approve ${existing.id}\` on the server terminal`, {
        retryable: true,
        recovery: `ask the machine owner to run: dodo approve ${existing.id}`,
        detail: { approvalId: existing.id, summary: req.summary },
      });
    }
  }
  const created = store.createApproval({
    kind: 'action',
    workspaceId: req.workspaceId,
    epoch: req.epoch,
    principal: req.principal,
    tool: req.tool,
    digest,
    summary: req.summary,
    ttlMs: req.ttlMs,
  });
  throw new DodoError('APPROVAL_REQUIRED', `local approval required: run \`dodo approve ${created.id}\` on the server terminal, then retry this call with the same arguments`, {
    retryable: true,
    recovery: `ask the machine owner to run: dodo approve ${created.id}`,
    detail: { approvalId: created.id, summary: req.summary },
  });
}
