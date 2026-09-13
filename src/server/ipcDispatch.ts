import type { IpcHandler } from '../ipc/server.js';
import type { StatusData } from '../ipc/protocol.js';
import type { BootstrappedWorkspace } from './bootstrap.js';
import type { TrustMode } from '../store/store.js';
import { phraseFor } from '../util/hash.js';
import { TRUST_MODE_DESCRIPTIONS } from '../security/policy.js';
import { addStaticClient, listStaticClients } from '../auth/clients.js';
import { DODO_VERSION } from './version.js';

/**
 * Private-IPC owner commands (spec §8.4), shared by the HTTP and stdio
 * entries. Everything here runs only for a local process that can open the
 * 0600 socket — never over the public listener.
 */
export interface IpcContext {
  ws: BootstrappedWorkspace;
  transport: { kind: 'http' | 'stdio'; port: number; locked: boolean; publicUrl: string | null };
  requestStop: () => void;
}

export function createIpcDispatcher(ctx: IpcContext): IpcHandler {
  const { store, services, rootInfo, workspaceId, epoch } = ctx.ws;
  return async (cmd, args) => {
    switch (cmd) {
      case 'status': {
        const data: StatusData = {
          version: DODO_VERSION,
          pid: process.pid,
          root: rootInfo.root,
          workspaceId,
          workspaceEpoch: epoch,
          port: ctx.transport.port,
          locked: ctx.transport.locked,
          publicUrl: ctx.transport.publicUrl,
          trustMode: services.trustMode(),
          runningJobs: services.jobs.runningCount(),
          recoveryRequired: store.listChangesetsByStatus('recovery_required').filter(c => c.workspaceId === workspaceId).map((c) => c.id),
          transport: ctx.transport.kind,
        };
        return data;
      }
      case 'stop': {
        if ((args['expectedPid'] !== undefined && args['expectedPid'] !== process.pid)
          || (args['expectedEpoch'] !== undefined && args['expectedEpoch'] !== epoch)) {
          throw new Error('server identity changed; retry dodo kill');
        }
        setTimeout(() => ctx.requestStop(), 50);
        return { stopping: true };
      }
      case 'schedule.list': return services.schedules.list();
      case 'schedule.propose': return services.schedules.propose(args);
      case 'schedule.show': return services.schedules.inspect(String(args['id']));
      case 'schedule.history': return services.schedules.history(String(args['id']));
      case 'schedule.approve': return services.schedules.approve(String(args['id']), String(args['digest']));
      case 'schedule.revoke': return services.schedules.revoke(String(args['id']));
      case 'memory.pending': return services.memory?.ownerPending() ?? [];
      case 'memory.show': {
        if (!services.memory) throw new Error('memory service is unavailable');
        return services.memory.ownerShow(String(args['id']));
      }
      case 'memory.list': {
        if (!services.memory) throw new Error('memory service is unavailable');
        return await services.memory.ownerList(args['includeStale'] === true);
      }
      case 'memory.approve': {
        if (!services.memory) throw new Error('memory service is unavailable');
        const shareWith = Array.isArray(args['shareWith']) && args['shareWith'].every((item) => typeof item === 'string') ? args['shareWith'] as string[] : [];
        return await services.memory.ownerApprove(String(args['id']), String(args['digest']), shareWith, args['allowConflict'] === true);
      }
      case 'memory.reject': {
        if (!services.memory) throw new Error('memory service is unavailable');
        return services.memory.ownerReject(String(args['id']), typeof args['note'] === 'string' ? args['note'] : '');
      }
      case 'memory.reverify': {
        if (!services.memory) throw new Error('memory service is unavailable');
        return await services.memory.ownerReverify(String(args['id']), String(args['digest']));
      }
      case 'memory.prune': {
        if (!services.memory) throw new Error('memory service is unavailable');
        const days = Number(args['olderThanDays']);
        if (!Number.isInteger(days) || days < 0 || days > 3650) throw new Error('olderThanDays must be an integer from 0 to 3650');
        return services.memory.ownerPrune(days);
      }
      case 'memory.learning.pending': return services.memory?.ownerLearningPending() ?? [];
      case 'memory.learning.show': {
        if (!services.memory) throw new Error('memory service is unavailable');
        return services.memory.ownerLearningShow(String(args['id']));
      }
      case 'memory.learning.review': {
        if (!services.memory) throw new Error('memory service is unavailable');
        return await services.memory.ownerLearningReview(String(args['id']), String(args['digest']), args['approved'] === true, typeof args['note'] === 'string' ? args['note'] : '');
      }
      case 'desktop.status': return services.desktop.status();
      case 'desktop.policy': return services.desktop.setPolicy(args);
      case 'trust.set': {
        const mode = String(args['mode']) as TrustMode;
        if (!['inspect', 'edit', 'trusted'].includes(mode)) throw new Error('invalid mode');
        store.setTrustMode(workspaceId, mode);
        return { mode, description: TRUST_MODE_DESCRIPTIONS[mode] };
      }
      case 'approvals.pending': {
        return store
          .listPendingApprovals('action')
          .filter((a) => a.workspaceId === workspaceId)
          .map((a) => ({ id: a.id, tool: a.tool, summary: a.summary, createdAt: a.createdAt, expiresAt: a.expiresAt }));
      }
      case 'approvals.approve': {
        const id = String(args['id']);
        const row = store.getApproval(id);
        if (!row || row.kind !== 'action' || row.workspaceId !== workspaceId) throw new Error('unknown approval id');
        if (!store.setApprovalStatus(id, 'approved')) throw new Error(`approval is ${row.status} (only pending, unexpired approvals can be approved)`);
        return { id, status: 'approved', summary: row.summary };
      }
      case 'approvals.deny': {
        const id = String(args['id']);
        if (!store.setApprovalStatus(id, 'denied')) throw new Error('approval not pending');
        return { id, status: 'denied' };
      }
      case 'auth.pending': {
        return store.listPendingApprovals('oauth').filter(a => a.workspaceId === workspaceId && a.epoch === epoch).map((a) => {
          const interaction = store.oauthFind('Interaction', a.id) as { params?: Record<string, unknown> } | undefined;
          const params = interaction?.params ?? {};
          const summary = JSON.parse(a.summary) as { clientId?: string; redirectUri?: string; scopes?: string[] };
          return {
            id: a.id,
            phrase: phraseFor(a.id),
            clientId: String(params['client_id'] ?? summary.clientId ?? 'unknown'),
            redirectUri: String(params['redirect_uri'] ?? summary.redirectUri ?? 'unknown'),
            scopes: String(params['scope'] ?? (summary.scopes ?? []).join(' ')),
            workspaceRoot: rootInfo.root,
            expiresAt: a.expiresAt,
          };
        });
      }
      case 'auth.approve': {
        const id = String(args['id']);
        const row = store.getApproval(id);
        if (!row || row.kind !== 'oauth' || row.workspaceId !== workspaceId || row.epoch !== epoch) throw new Error('unknown authorization request id');
        if (!store.setApprovalStatus(id, 'approved')) throw new Error(`request is ${row.status}`);
        return { id, status: 'approved' };
      }
      case 'auth.deny': {
        const id = String(args['id']);
        if (!store.setApprovalStatus(id, 'denied')) throw new Error('request not pending');
        return { id, status: 'denied' };
      }
      case 'auth.addClient': {
        const redirectUris = (args['redirectUris'] as string[]) ?? [];
        const req: Parameters<typeof addStaticClient>[1] = { redirectUris };
        if (typeof args['name'] === 'string') req.name = args['name'];
        if (args['public'] === true) req.public = true;
        return addStaticClient(store, req);
      }
      case 'auth.listClients':
        return listStaticClients(store);
      case 'auth.grants':
        return store.listGrants().map((g) => ({
          grantId: g.id,
          clientId: g.clientId,
          scopes: g.scopes,
          workspaceId: g.workspaceId,
          thisWorkspace: g.workspaceId === workspaceId,
          createdAt: g.createdAt,
          revokedAt: g.revokedAt,
        }));
      case 'auth.revoke': {
        const grantId = String(args['grantId']);
        const revoked = store.revokeGrant(grantId);
        if (!revoked) throw new Error('unknown or already-revoked grant');
        store.oauthRevokeByGrantId(grantId);
        return { grantId, revoked: true };
      }
      case 'audit.recent': {
        const limit = Math.max(1, Math.min(Number(args['limit'] ?? 50), 500));
        return store.recentAudit(workspaceId, limit);
      }
      case 'recover.list': {
        return store.listChangesetsByStatus('recovery_required').filter(c => c.workspaceId === workspaceId).map((c) => ({
          changesetId: c.id,
          createdAt: c.createdAt,
          summary: c.summary,
          error: c.error,
          steps: store.listJournalSteps(c.id),
        }));
      }
      case 'recover.resolve': {
        const id = String(args['changesetId']);
        const action = String(args['action']);
        const cs = store.getChangeset(id);
        if (!cs || cs.workspaceId !== workspaceId || cs.status !== 'recovery_required') throw new Error('changeset is not in recovery_required state');
        if (action === 'mark-resolved') {
          store.setChangesetStatus(id, 'failed', 'manually resolved by owner');
          return { changesetId: id, resolved: true };
        }
        throw new Error('unknown recovery action (supported: mark-resolved after fixing files manually; backups are in the DODO state directory)');
      }
      default:
        throw new Error(`unknown command ${cmd}`);
    }
  };
}
