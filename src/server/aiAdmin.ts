import type { Express, Request, Response } from 'express';
import { z } from 'zod';
import type { WorkspaceHost } from './workspaceHost.js';
import type { LocalConfigInfo } from './localConfig.js';
import type { ConfigSession } from './configSession.js';
import { DodoError, toDodoError } from '../errors.js';
import { createIpcDispatcher } from './ipcDispatch.js';
import { GlobalConfigSchema, loadGlobalConfig, saveGlobalConfig } from '../config/globalConfig.js';
import { inspectSetup, runSetup, COMPONENTS } from '../setup/setup.js';
import { ProjectRegistry } from '../projects/registry.js';
import { invokeToolDefinition } from '../tools/context.js';
import { CORE_TOOL_CATALOG } from '../tools/coreCatalog.js';
import { AGENT_RUNTIME_TOOLS } from '../tools/agentRuntimeTools.js';
import { accessMode, setAccessMode } from '../security/accessMode.js';
import { discoverExposure, normalizeDisabledDiscoverOperations } from '../tools/surface.js';

const ACTIONS = ['status','trust.set','schedule.list','schedule.propose','schedule.show','schedule.history','schedule.approve','schedule.revoke','memory.pending','memory.show','memory.list','memory.approve','memory.reject','memory.reverify','memory.prune','memory.learning.pending','memory.learning.show','memory.learning.review','agent.skill.pending','agent.skill.show','agent.skill.review','desktop.status','desktop.policy','approvals.pending','approvals.approve','approvals.deny','auth.pending','auth.approve','auth.deny','auth.addClient','auth.listClients','auth.grants','auth.revoke','audit.recent','recover.list','recover.resolve','recover.rollback','deployment.targets','deployment.configure','deployment.prepare','deployment.list','deployment.inspect','deployment.compare','deployment.build','deployment.apply','deployment.observe','deployment.source_preview','deployment.rollback_prepare','deployment.maintenance','recovery.status','recovery.config.list','recovery.config.configure','recovery.config.backup','recovery.config.preview','recovery.config.apply','recovery.config.rotate','recovery.database.list','recovery.database.configure','recovery.database.inspect','recovery.database.bind','recovery.database.unbind','recovery.evidence.list','recovery.evidence.inspect','recovery.mark','recovery.pin','recovery.cleanup.preview','recovery.drift.scan','recovery.drift.acknowledge','recovery.configure','recovery.checkpoint','recovery.recovery_storage_status','recovery.recovery_cleanup_preview','recovery.recovery_settings_preview','recovery.recovery_maintenance_apply','recovery.restore_status','recovery.checkpoint_list','recovery.checkpoint_inspect','recovery.checkpoint_create','recovery.recovery_session_list','recovery.recovery_session_inspect','recovery.recovery_session_begin','recovery.recovery_session_end','recovery.restore_preview','recovery.restore_apply'] as const;
/**
 * Local Config is an owner-only surface, so naming the invalid form fields is
 * both safe and much more useful than returning the old generic
 * "invalid request fields" response. Values are deliberately omitted: a
 * validation error must never echo an API key, task text, or other payload.
 */
function invalidOwnerRequest(error: z.ZodError): DodoError {
    const fields = [...new Set(error.issues.slice(0, 8).map((issue) => issue.path.join('.') || 'request'))];
    return new DodoError('INVALID_INPUT', `ข้อมูลไม่ถูกต้อง: ตรวจสอบ ${fields.join(', ')}`, {
        detail: { fields },
        recovery: 'แก้ช่องที่ระบุแล้วบันทึกอีกครั้ง',
    });
}
/** Mounted only after Local Config's owner auth + origin checks, never on public MCP. */
export function registerAIAdmin(app: Express, host: WorkspaceHost, info: LocalConfigInfo, ownerSession: (req: Request) => ConfigSession): void {
  const manager = () => { const m = host.current().services.installation; if (!m) throw new DodoError('NOT_SUPPORTED', 'installation runtime is unavailable'); return m; };
  const owner = (req: Request) => ({ ...manager().owner(), expiresAt: ownerSession(req).expiresAt / 1000 });
  const route = (method: 'get' | 'post', url: string, fn: (req: Request, res: Response) => Promise<unknown> | unknown) => app[method](url, async (req, res) => {
    try { const data = await fn(req, res); if (!res.headersSent) res.json({ ok: true, data }); }
    catch (error) { const e = error instanceof z.ZodError ? invalidOwnerRequest(error) : toDodoError(error); if (!res.headersSent) res.status(e.code === 'FORBIDDEN' ? 403 : e.code === 'AUTH_REQUIRED' ? 401 : e.code === 'CONFLICT' || e.code === 'STALE_WORKSPACE' ? 409 : 400).json({ ok: false, error: e.message, code: e.code, ...(e.detail ? { detail: e.detail } : {}), ...(e.recovery ? { recovery: e.recovery } : {}) }); }
  });
  const reviewed = (req: Request, workspaceId = host.current().workspaceId, epoch = host.current().epoch) => {
    ownerSession(req).assertActive();
    if (req.headers['x-dodo-workspace'] !== workspaceId || req.headers['x-dodo-epoch'] !== epoch) throw new DodoError('STALE_WORKSPACE', 'refresh the selected project before making changes');
  };
  route('get', '/api/ai/state', req => ({ ...manager().ai.settings.state(), accessMode: accessMode(manager().store), projects: new ProjectRegistry(manager().store).list(), runtimes: manager().status(), runs: manager().ai.list(owner(req)), controlContext: { workspaceId: host.current().workspaceId, workspaceEpoch: host.current().epoch }, ownerActions: ACTIONS }));
  route('post','/api/ai/knowledge',async req=>{
    const b=z.object({projectId:z.string(),operation:z.enum(['brain_status','context_status','memory_status','memory_search','agent_skill_search']),query:z.string().min(1).max(1000).optional()}).strict().parse(req.body);
    const lease=await manager().acquire(b.projectId,owner(req));
    try {
      reviewed(req,lease.services.workspaceId,lease.services.epoch);
      const def=[...CORE_TOOL_CATALOG,...AGENT_RUNTIME_TOOLS].find(t=>t.name===b.operation)!;
      const result=await invokeToolDefinition({def,services:lease.services,principal:()=>owner(req),args:{workspaceId:lease.services.workspaceId,workspaceEpoch:lease.services.epoch,...(b.query?{query:b.query}:{})}});
      return result.envelope;
    } finally {lease.release();}
  });
  route('post', '/api/ai/limits', req => { reviewed(req); return manager().ai.settings.saveLimits(req.body); });
  route('post', '/api/ai/access-mode', req => {
    reviewed(req);
    const { mode } = z.object({ mode: z.enum(['personal', 'managed']) }).strict().parse(req.body);
    const current = host.current();
    const config = loadGlobalConfig(current.paths.configFile);
    saveGlobalConfig(current.paths.configFile, GlobalConfigSchema.parse({ ...config, accessMode: mode }));
    setAccessMode(manager().store, mode);
    manager().store.audit({ principal: 'local-config-owner', workspaceId: current.workspaceId, tool: 'web.access-mode', result: mode });
    return { mode, effectiveImmediately: true };
  });
  route('post', '/api/ai/prune', req => { reviewed(req); return {removed:manager().ai.pruneHistory()}; });
  route('post', '/api/ai/connection', async req => {
    reviewed(req); const body = z.object({ connection: z.unknown(), apiKey: z.string().max(4096).optional() }).strict().parse(req.body);
    return manager().ai.settings.saveConnection(body.connection, body.apiKey);
  });
  route('post', '/api/ai/profile', req => { reviewed(req); return manager().ai.settings.saveProfile(req.body); });
  route('post', '/api/ai/permission', req => {
    reviewed(req); const b = z.object({ projectId: z.string(), profileIds: z.array(z.string()), allowSourceEgress: z.boolean(), allowedClientIds: z.array(z.string()) }).strict().parse(req.body);
    if (!new ProjectRegistry(manager().store).list().some(p => p.projectId === b.projectId && p.available)) throw new DodoError('PATH_DENIED', 'project is not ready');
    return manager().ai.settings.savePermission(b);
  });
  route('post', '/api/ai/remove', async req => { reviewed(req); const b = z.object({ kind: z.enum(['connection','profile']), id: z.string(), confirmId: z.string() }).strict().parse(req.body); if (b.id !== b.confirmId) throw new DodoError('INVALID_INPUT', 'confirmation does not match'); await manager().ai.settings.remove(b.kind,b.id); return { removed: true }; });
  route('post', '/api/ai/models', req => { reviewed(req); return manager().ai.settings.models(z.object({ connectionId: z.string() }).strict().parse(req.body).connectionId); });
  route('post', '/api/ai/metadata', req => { reviewed(req); return manager().ai.settings.inspectModel(z.object({profileId:z.string()}).strict().parse(req.body).profileId); });
  route('post', '/api/ai/probe', req => { reviewed(req); const b = z.object({ profileId: z.string(), mode: z.enum(['inference','tools']), confirmUsage: z.literal(true) }).strict().parse(req.body); return manager().ai.settings.probe(b.profileId,b.mode); });
  route('post', '/api/ai/project', async req => {
    reviewed(req); const b = z.object({ projectId: z.string(), action: z.enum(['open','close']).default('open') }).strict().parse(req.body);
    if (b.action === 'close') return { closed: await manager().closeProject(b.projectId) };
    const lease = await manager().acquire(b.projectId, owner(req));
    try { return { projectId: b.projectId, workspaceId: lease.services.workspaceId, workspaceEpoch: lease.services.epoch, root: lease.services.wfs.root, savedTrust: lease.services.store.trustMode(lease.services.workspaceId), effectiveTrust: lease.services.trustMode(), jobs: lease.services.jobs.list(lease.services.workspaceId, 50) }; }
    finally { lease.release(); }
  });
  route('post', '/api/ai/project/access', async req => {
    const b = z.object({projectId:z.string(),clientId:z.string().min(1).max(128),scopes:z.array(z.enum(['dodo:read','dodo:write','dodo:exec'])).max(3),confirmRevoke:z.boolean().default(false)}).strict().parse(req.body);
    const lease = await manager().acquire(b.projectId,owner(req));
    try {
      reviewed(req,lease.services.workspaceId,lease.services.epoch);
      const store = manager().store;
      if (!store.getOAuthClient(b.clientId)) throw new DodoError('NOT_FOUND','unknown client');
      if (!b.scopes.length && !b.confirmRevoke) throw new DodoError('FORBIDDEN','confirm revoking this client first');
      store.setClientAccess(lease.services.workspaceId,b.clientId,b.scopes);
      store.audit({principal:'local-config-owner',workspaceId:lease.services.workspaceId,tool:'local.access',refId:b.clientId,result:b.scopes.length?'allowed':'revoked'});
      return {scopes:store.clientAccess(lease.services.workspaceId,b.clientId)};
    } finally {lease.release();}
  });
  route('post', '/api/ai/project/clients', async req => {
    reviewed(req);const b=z.object({projectId:z.string()}).strict().parse(req.body),lease=await manager().acquire(b.projectId,owner(req));
    try {return manager().store.listOAuthClients().slice(0,100).map(c=>({clientId:c.clientId,name:typeof c.payload.client_name === 'string' ? c.payload.client_name : c.clientId,scopes:manager().store.clientAccess(lease.services.workspaceId,c.clientId)}));} finally {lease.release();}
  });
  route('post', '/api/ai/runs', async req => {
    const b = z.object({ projectId: z.string(), profileId: z.string(), task: z.string(), idempotencyKey: z.string(), parentRunId:z.string().optional(), images: z.array(z.object({ path: z.string() }).strict()).max(4).optional() }).strict().parse(req.body);
    const lease = await manager().acquire(b.projectId, owner(req));
    try { reviewed(req,lease.services.workspaceId,lease.services.epoch); return await manager().ai.spawn(b, owner(req), lease.services); }
    finally { lease.release(); }
  });
  route('get', '/api/ai/runs', req => manager().ai.list(owner(req), String(req.query.search ?? '').slice(0, 100)));
  route('get', '/api/ai/runs/:id', req => manager().ai.status(String(req.params.id), owner(req)));
  route('post', '/api/ai/runs/:id/control', req => { reviewed(req); const b = z.object({ action: z.enum(['pause','resume','cancel','delete']) }).strict().parse(req.body); return manager().ai.control(String(req.params.id), b.action, owner(req)); });
  route('get', '/api/ai/runs/:id/events', (req,res) => {
    const id = String(req.params.id); let cursor = Number(req.query.after ?? 0);
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new DodoError('INVALID_INPUT', 'invalid event cursor');
    manager().ai.status(id, owner(req));
    res.setHeader('content-type','text/event-stream'); res.setHeader('connection','keep-alive'); res.flushHeaders();
    const send = () => {
      try {
        const events = manager().ai.events(id, owner(req), cursor);
        for (const event of events) { cursor = event.seq; if (!res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`)) { res.end(); return; } }
        res.write(': keepalive\n\n');
      } catch { res.end(); }
    };
    send(); const timer = setInterval(send,1000); res.on('close', () => clearInterval(timer));
  });
  route('post', '/api/admin/action', async req => {
    const b = z.object({ projectId: z.string(), operation: z.enum(ACTIONS), args: z.record(z.string(),z.unknown()).default({}) }).strict().parse(req.body);
    const lease = await manager().acquire(b.projectId, owner(req));
    try {
      reviewed(req,lease.services.workspaceId,lease.services.epoch);
      const dispatch = createIpcDispatcher({ ws: lease.workspace, transport: { kind: 'http', port: info.transport?.port ?? 0, locked: info.transport?.locked ?? true, publicUrl: info.transport?.publicUrl ?? null }, requestStop: () => undefined, revalidateOwner: () => { ownerSession(req).assertActive(); reviewed(req, lease.services.workspaceId, lease.services.epoch); } });
      const result = await dispatch(b.operation,b.args);
      manager().store.audit({ principal: 'local-config-owner', workspaceId: lease.services.workspaceId, tool: `web.${b.operation}`, result: 'ok' });
      return result;
    } finally { lease.release(); }
  });
    route('get', '/api/admin/config', () => {
        const c = loadGlobalConfig(host.current().paths.configFile);
        return { recovery: c.recovery, limits: c.limits, accessMode: c.accessMode, commandSandbox: c.commandSandbox, sandboxWritablePaths: c.sandboxWritablePaths, allowWebFetch: c.allowWebFetch, lsp: c.lsp, logRetentionDays: c.logRetentionDays, toolSurface: c.toolSurface, exposeSubagentsToMcp: c.exposeSubagentsToMcp, disabledDiscoverOperations: c.disabledDiscoverOperations, envAllowlist: c.envAllowlist, secretDeny: c.secretDeny, secretAllow: c.secretAllow };
    });
    route('get', '/api/admin/discover-exposure', () => {
        const c = loadGlobalConfig(host.current().paths.configFile);
        return discoverExposure({
            subagents: c.exposeSubagentsToMcp,
            disabledDiscoverOperations: c.disabledDiscoverOperations,
        });
    });
    route('post', '/api/admin/config', req => {
        reviewed(req);
        const patch = GlobalConfigSchema.pick({ recovery: true, limits: true, accessMode: true, commandSandbox: true, sandboxWritablePaths: true, allowWebFetch: true, lsp: true, logRetentionDays: true, toolSurface: true, exposeSubagentsToMcp: true, disabledDiscoverOperations: true, envAllowlist: true, secretDeny: true, secretAllow: true }).partial().strict().parse(req.body);
        const normalizedPatch = patch.disabledDiscoverOperations === undefined
            ? patch
            : { ...patch, disabledDiscoverOperations: normalizeDisabledDiscoverOperations(patch.disabledDiscoverOperations) };
        const file = host.current().paths.configFile;
        saveGlobalConfig(file, GlobalConfigSchema.parse({ ...loadGlobalConfig(file), ...normalizedPatch }));
        if (normalizedPatch.accessMode)
            setAccessMode(manager().store, normalizedPatch.accessMode);
        return { saved: true, restartRequired: Object.keys(normalizedPatch).some(key => key !== 'accessMode') };
    });
  route('post', '/api/admin/setup', async req => {
    reviewed(req); const b = z.object({ mode: z.enum(['check','plan','install']), components: z.array(z.enum(COMPONENTS)).min(1), confirmInstall: z.boolean().default(false) }).strict().parse(req.body);
    const options = { cwd: host.current().rootInfo.root, configDir: host.current().configDir, components: b.components };
    if (b.mode === 'install' && !b.confirmInstall) throw new DodoError('FORBIDDEN', 'review and confirm the installation plan');
    return b.mode === 'check' ? inspectSetup({ ...options, check:true }) : runSetup({ ...options, plan:b.mode === 'plan', yes:b.confirmInstall }, () => undefined);
  });
}
