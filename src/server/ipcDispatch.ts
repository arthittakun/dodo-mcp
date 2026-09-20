import { performRecovery, RECOVERY_INPUTS, type RecoveryOperation } from '../tools/recoveryTools.js';
import { performDeployment, type DeploymentOperation } from '../tools/deploymentTools.js';
import type { IpcHandler } from '../ipc/server.js';
import type { StatusData } from '../ipc/protocol.js';
import type { BootstrappedWorkspace } from './bootstrap.js';
import type { ConnectionMode } from '../config/tunnelConfig.js';
import type { TrustMode } from '../store/store.js';
import { phraseFor } from '../util/hash.js';
import { TRUST_MODE_DESCRIPTIONS } from '../security/policy.js';
import { addStaticClient, listStaticClients } from '../auth/clients.js';
import { DODO_VERSION } from './version.js';
import { INSTALLATION_AUTHORITY_EPOCH, INSTALLATION_AUTHORITY_ID } from '../auth/constants.js';
import { accessMode } from '../security/accessMode.js';
import { z } from 'zod';
import { DodoError } from '../errors.js';
import { withIdempotency } from '../tools/changeTools.js';

/**
 * Private-IPC owner commands (spec §8.4), shared by the HTTP and stdio
 * entries. Everything here runs only for a local process that can open the
 * 0600 socket — never over the public listener.
 */
export interface IpcContext {
  ws: BootstrappedWorkspace;
  transport: { kind: 'http' | 'stdio'; port: number; locked: boolean; publicUrl: string | null; connectionMode?: ConnectionMode };
  requestStop: () => void;
  revalidateOwner?: () => void;
  remoteConfig?: {
    open(args: Record<string, unknown>): Promise<{ url: string; pairingCode: string; expiresAt: number }>;
    close(): void;
    status(): unknown;
  };
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
      case 'remoteConfig.open': {
        if (!ctx.remoteConfig) throw new Error('Remote Config requires a configured public HTTPS origin');
        const result = await ctx.remoteConfig.open(args);
        try {
          store.audit({ principal: 'local-cli-owner', workspaceId, tool: 'local.remote-config.open', result: 'opened-one-hour-lease' });
        } catch (error) {
          ctx.remoteConfig.close();
          throw error;
        }
        return result;
      }
      case 'remoteConfig.close': {
        if (!ctx.remoteConfig) throw new Error('Remote Config is unavailable');
        ctx.remoteConfig.close();
        store.audit({ principal: 'local-cli-owner', workspaceId, tool: 'local.remote-config.close', result: 'closed' });
        return { closed: true };
      }
      case 'remoteConfig.status': {
        if (!ctx.remoteConfig) return { active: false, paired: false, url: null, expiresAt: null };
        return ctx.remoteConfig.status();
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
      case 'agent.skill.pending': return services.agentRuntime?.ownerPendingSkills() ?? [];
      case 'agent.skill.show': {
        if (!services.agentRuntime) throw new Error('advanced agent runtime is unavailable');
        return services.agentRuntime.ownerShowSkill(String(args['id']));
      }
      case 'agent.skill.review': {
        if (!services.agentRuntime) throw new Error('advanced agent runtime is unavailable');
        return services.agentRuntime.ownerReviewSkill(String(args['id']), String(args['digest']), args['approved'] === true, typeof args['note'] === 'string' ? args['note'] : '');
      }
      case 'desktop.status': return services.desktop.status();
      case 'desktop.policy': return services.desktop.setPolicy(args);
      case 'android.status': return services.android.status();
      case 'android.devices': return services.android.allDevices();
      case 'android.policy': return services.android.setPolicy(args);
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
        return store.listPendingApprovals('oauth').filter(a => a.workspaceId === INSTALLATION_AUTHORITY_ID && a.epoch === INSTALLATION_AUTHORITY_EPOCH).map((a) => {
          const interaction = store.oauthFind('Interaction', a.id) as { params?: Record<string, unknown> } | undefined;
          const params = interaction?.params ?? {};
          const summary = JSON.parse(a.summary) as { clientId?: string; redirectUri?: string; scopes?: string[] };
          return {
            id: a.id,
            phrase: phraseFor(a.id),
            clientId: String(params['client_id'] ?? summary.clientId ?? 'unknown'),
            redirectUri: String(params['redirect_uri'] ?? summary.redirectUri ?? 'unknown'),
            scopes: String(params['scope'] ?? (summary.scopes ?? []).join(' ')),
            authorizationTarget: 'installation',
            accessMode: accessMode(store),
            workspaceRoot: null,
            expiresAt: a.expiresAt,
          };
        });
      }
      case 'auth.approve': {
        const id = String(args['id']);
        const row = store.getApproval(id);
        if (!row || row.kind !== 'oauth' || row.workspaceId !== INSTALLATION_AUTHORITY_ID || row.epoch !== INSTALLATION_AUTHORITY_EPOCH) throw new Error('unknown authorization request id');
        if (!store.setApprovalStatus(id, 'approved')) throw new Error(`request is ${row.status}`);
        return { id, status: 'approved' };
      }
      case 'auth.deny': {
        const id = String(args['id']);
        const row = store.getApproval(id);
        if (!row || row.kind !== 'oauth' || row.workspaceId !== INSTALLATION_AUTHORITY_ID || row.epoch !== INSTALLATION_AUTHORITY_EPOCH) throw new Error('unknown authorization request id');
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
          installationIdentity: store.getMeta(`identity-grant:${g.id}`) === '2',
          thisWorkspace: g.workspaceId === workspaceId && store.getMeta(`identity-grant:${g.id}`) !== '2',
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
      case 'recovery.restore_status': case 'recovery.checkpoint_list': case 'recovery.checkpoint_inspect': case 'recovery.checkpoint_create':
      case 'recovery.recovery_session_list': case 'recovery.recovery_session_inspect': case 'recovery.recovery_session_begin': case 'recovery.recovery_session_end':
      case 'recovery.restore_preview': case 'recovery.restore_apply': {
        const operation = cmd.slice('recovery.'.length) as RecoveryOperation;
        const shape = RECOVERY_INPUTS[operation];
        const input = z.object({...shape, ...(operation === 'restore_apply' ? {confirm:z.literal(true),workspaceId:z.literal(workspaceId),workspaceEpoch:z.literal(epoch)} : {})}).strict().parse(args) as Record<string,unknown>;
        const raw = Object.fromEntries(Object.keys(shape).map(k => [k,input[k]]));
        const principal = {grantId:'local-config-owner',clientId:'local-owner',sub:'owner',scopes:['dodo:read','dodo:write','dodo:exec']};
        const execute = async () => {
          ctx.revalidateOwner?.();
          const result = await performRecovery(operation,raw,{services,principal,trustMode:services.trustMode()},true);
          ctx.revalidateOwner?.();
          store.audit({principal:principal.grantId,workspaceId,tool:cmd,result:'ok'});
          return result;
        };
        return services.recovery ? services.recovery.withAuthority(()=>ctx.revalidateOwner?.(),execute) : execute();
      }
      case 'recovery.drift.scan': {
        const page=z.object({cursor:z.number().int().min(0).max(1000000).default(0),limit:z.number().int().min(1).max(100).default(50)}).strict().parse(args);ctx.revalidateOwner?.();
        if(!services.recovery)throw new DodoError('NOT_SUPPORTED','Recovery is unavailable');
        await services.recovery.withAuthority(()=>ctx.revalidateOwner?.(),()=>services.recovery!.scanDrift());ctx.revalidateOwner?.();return services.recovery.drift.status(page.limit,page.cursor);
      }
      case 'recovery.drift.acknowledge': {
        const body=z.object({digest:z.string().regex(/^sha256:[a-f0-9]{64}$/),workspaceId:z.string(),workspaceEpoch:z.string(),confirm:z.literal(true)}).strict().parse(args);
        if(body.workspaceId!==workspaceId||body.workspaceEpoch!==services.epoch)throw new DodoError('STALE_WORKSPACE','review the current project and epoch again');
        ctx.revalidateOwner?.();
        return services.recovery?.acknowledgeDrift(body.digest,()=>ctx.revalidateOwner?.());
      }
      case 'recovery.evidence.list': case 'recovery.evidence.inspect': case 'recovery.mark': case 'recovery.pin': case 'recovery.cleanup.preview': {
        const r=services.recovery;if(!r)throw new DodoError('NOT_SUPPORTED','Recovery is unavailable');
        r.assertProject();ctx.revalidateOwner?.();
        const owner={id:'local-config-owner',owner:true};
        const page={cursor:z.number().int().min(0).max(1000000).default(0),limit:z.number().int().min(1).max(50).default(10)};
        if(cmd==='recovery.evidence.list'){const b=z.object(page).strict().parse(args);return {...r.evidence.list(owner,b.cursor,b.limit),pointers:r.evidence.pointers(),pointerEvents:r.evidence.pointerEvents(b.cursor,b.limit)};}
        if(cmd==='recovery.evidence.inspect'){const b=z.object({verificationId:z.string().min(1).max(128)}).strict().parse(args);const result=await r.evidence.inspect(b.verificationId,owner);ctx.revalidateOwner?.();return result;}
        if(cmd==='recovery.cleanup.preview'){const b=z.object(page).strict().parse(args);return r.storage.cleanupPreview(workspaceId,r.policy(),b.cursor,b.limit);}
        const context={workspaceId:z.string(),workspaceEpoch:z.string(),confirm:z.literal(true)};
        const shape=cmd==='recovery.mark'?z.object({...context,name:z.string().min(1).max(64),snapshotId:z.string().max(128).nullable(),expectedRevision:z.number().int().nonnegative()}):z.object({...context,checkpointId:z.string().min(1).max(128),pinned:z.boolean(),expectedPinned:z.boolean()});
        const b=shape.strict().parse(args);
        if(b.workspaceId!==workspaceId||b.workspaceEpoch!==services.epoch)throw new DodoError('STALE_WORKSPACE','review the current project and epoch again');
        if('name' in b)return r.evidence.mark(b.name,b.snapshotId,b.expectedRevision,()=>ctx.revalidateOwner?.());
        return r.evidence.pin(b.checkpointId,b.pinned,b.expectedPinned,()=>ctx.revalidateOwner?.());
      }
      case 'recovery.status': return services.recovery?.status();
      case 'deployment.targets': case 'deployment.configure': case 'deployment.prepare':
      case 'deployment.list': case 'deployment.inspect': case 'deployment.compare': case 'deployment.build': case 'deployment.apply':
      case 'deployment.observe': case 'deployment.source_preview': case 'deployment.rollback_prepare': case 'deployment.maintenance': {
        const r=services.recovery;if(!r)throw new DodoError('NOT_SUPPORTED','Recovery is unavailable');
        r.assertProject();ctx.revalidateOwner?.();
        const owner={id:'local-config-owner',owner:true},revalidate=()=>ctx.revalidateOwner?.();
        if(cmd==='deployment.targets'){z.object({}).strict().parse(args);return {items:r.deployments.targets(),recipes:services.overview.discoverTasks(services.projectConfig).map(t=>({taskId:t.id,recipeDigest:t.recipeDigest})),daemonAccess:'commands may control resources outside the workspace; existing sandbox and approval policy still applies'};}
        if(cmd==='deployment.list'){const b=z.object({cursor:z.number().int().min(0).max(1000000).default(0),limit:z.number().int().min(1).max(50).default(20)}).strict().parse(args);return r.deployments.list(owner,b.cursor,b.limit);}
        if(cmd==='deployment.inspect'||cmd==='deployment.compare'){
          const b=z.object({deploymentId:z.string().min(1).max(128)}).strict().parse(args);
          const result=cmd==='deployment.inspect'?r.deployments.inspect(b.deploymentId,owner):await r.deployments.compare(b.deploymentId,owner);revalidate();return result;
        }
        const b=z.object({workspaceId:z.literal(workspaceId),workspaceEpoch:z.literal(epoch),confirm:z.literal(true),input:z.unknown()}).strict().parse(args);
        if(['deployment.build','deployment.apply','deployment.observe','deployment.source_preview','deployment.rollback_prepare','deployment.maintenance'].includes(cmd)){
          const principal={grantId:'local-config-owner',clientId:'local-config',sub:'owner',scopes:['dodo:read','dodo:write','dodo:exec']};
          if(cmd==='deployment.maintenance')return r.withAuthority(revalidate,()=>r.deployments.maintenance(b.input,{services,principal,trustMode:services.trustMode(),revalidate}));
          const operation=cmd.replace('deployment.','deployment_') as DeploymentOperation;
          return r.withAuthority(revalidate,()=>performDeployment(operation,z.record(z.string(),z.unknown()).parse(b.input),{services,principal,trustMode:services.trustMode(),revalidate},true));
        }
        return r.withAuthority<unknown>(revalidate,()=>cmd==='deployment.configure'?r.deployments.configure(b.input,revalidate):r.deployments.prepare(b.input,owner,revalidate));
      }
      case 'recovery.configure': {
        const body = z.object({ policy: z.unknown(), confirm: z.literal(true) }).strict().parse(args);
        ctx.revalidateOwner?.();
        if (!services.recovery) throw new DodoError('NOT_SUPPORTED', 'Recovery is unavailable');
        return services.recovery.configure(body.policy, body.confirm, ctx.revalidateOwner);
      }
      case 'recovery.checkpoint': {
        ctx.revalidateOwner?.();
        if (!services.recovery) throw new DodoError('NOT_SUPPORTED', 'Recovery is unavailable');
        await services.recovery.checkpoint('owner-checkpoint', 'local-config-owner');
        return services.recovery.status();
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
      case 'recover.rollback': {
        const input = z.object({
          changesetId: z.string().min(1).max(128),
          idempotencyKey: z.string().min(8).max(128),
          workspaceId: z.string(), workspaceEpoch: z.string(),
        }).strict().parse(args);
        const execute = async () => {
          ctx.revalidateOwner?.();
          if (input.workspaceId !== workspaceId || input.workspaceEpoch !== epoch) throw new DodoError('STALE_WORKSPACE', 'review the current workspace before owner rollback');
          const principal = { grantId: 'local-recovery-owner', clientId: 'local-owner', sub: 'owner', scopes: ['dodo:read', 'dodo:write', 'dodo:exec'] as const };
          const toolCtx = { services, principal: { ...principal, scopes: [...principal.scopes] }, trustMode: services.trustMode() };
          try {
            const result = await withIdempotency(toolCtx, 'owner.rollback', input.idempotencyKey, { changesetId: input.changesetId }, () =>
              services.applier.rollbackAsOwner({ changesetId: input.changesetId, workspaceId, epoch, principal: principal.grantId }));
            store.audit({ principal: principal.grantId, workspaceId, tool: 'owner.rollback', result: 'ok', inputDigest: input.changesetId });
            return { ...result.result, replayed: result.replayed };
          } catch (err) {
            store.audit({ principal: principal.grantId, workspaceId, tool: 'owner.rollback', result: err instanceof DodoError ? err.code : 'error', inputDigest: input.changesetId });
            throw err;
          }
        };
        const authorized = () => services.recovery ? services.recovery.withAuthority(() => ctx.revalidateOwner?.(), execute) : execute();
        return services.mutations ? services.mutations.run(authorized) : authorized();
      }
      default:
        throw new Error(`unknown command ${cmd}`);
    }
  };
}
