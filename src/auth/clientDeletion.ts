import { z } from 'zod';
import type { Store } from '../store/store.js';
import { DodoError } from '../errors.js';
import { digestOf } from '../util/hash.js';

export const DeleteClientsInput = z.object({
  clients: z.array(z.object({ id: z.string().min(1).max(128), reviewHash: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).strict()).min(1).max(100),
  confirm: z.literal('delete-selected-clients'),
}).strict();

/** Owner-only review: counts and opaque fingerprint, never credentials or paths. */
export function reviewClientDeletion(store: Store, id: string) {
  const client = store.getOAuthClient(id);
  if (!client) throw new DodoError('NOT_FOUND', 'Client no longer exists; reload the list');
  const access = store.db.prepare('SELECT workspace_id, scopes FROM workspace_clients WHERE client_id=? ORDER BY workspace_id').all(id) as Array<{workspace_id:string;scopes:string}>;
  const grants = store.db.prepare('SELECT id,revoked_at FROM grants WHERE client_id=? ORDER BY id').all(id) as Array<{id:string;revoked_at:number|null}>;
  return {
    id,
    name: typeof client['client_name'] === 'string' ? client['client_name'] : null,
    workspaceCount: access.filter(a => store.clientAccess(a.workspace_id,id).length > 0).length,
    grantCount: grants.filter(g => g.revoked_at === null).length,
    reviewHash: digestOf({id,client,access,grants}),
  };
}

/** One durable transaction for the reviewed selection; no wildcard/global reset. */
export function deleteReviewedClients(store: Store, input: z.infer<typeof DeleteClientsInput>, workspaceId: string) {
  const ids = input.clients.map(c => c.id);
  if (new Set(ids).size !== ids.length) throw new DodoError('INVALID_INPUT', 'Select each client only once');
  return store.db.transaction(() => {
    // Revalidate all before touching any row. A new client is never swept in.
    for (const c of input.clients) {
      if (reviewClientDeletion(store,c.id).reviewHash !== c.reviewHash) throw new DodoError('CONFLICT', 'Client access changed since review; reload and select again');
    }
    for (const id of ids) {
      store.db.prepare("UPDATE pending_approvals SET status='denied' WHERE status IN ('pending','approved') AND (principal IN (SELECT id FROM grants WHERE client_id=?) OR (kind='oauth' AND CASE WHEN json_valid(summary) THEN json_extract(summary,'$.clientId') END=?))").run(id,id);
      store.db.prepare('UPDATE grants SET revoked_at=COALESCE(revoked_at,?) WHERE client_id=?').run(Date.now(),id);
      store.db.prepare("DELETE FROM oauth_models WHERE grant_id IN (SELECT id FROM grants WHERE client_id=?) OR (model='Grant' AND id IN (SELECT id FROM grants WHERE client_id=?)) OR CASE WHEN json_valid(payload) THEN json_extract(payload,'$.clientId') END=? OR CASE WHEN json_valid(payload) THEN json_extract(payload,'$.params.client_id') END=?").run(id,id,id,id);
      store.db.prepare('DELETE FROM workspace_clients WHERE client_id=?').run(id);
      store.db.prepare('DELETE FROM oauth_clients WHERE client_id=?').run(id);
      store.audit({principal:'local-config-owner',workspaceId,tool:'local.client.delete',refId:id,result:'deleted'});
    }
    return {ok:true,deleted:ids};
  }).immediate();
}
