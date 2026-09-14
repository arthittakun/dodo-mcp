import { registerAIAdmin } from './aiAdmin.js';
import http from 'node:http';
import { reviewClientDeletion, deleteReviewedClients, DeleteClientsInput } from '../auth/clientDeletion.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import express, { type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import type { BootstrappedWorkspace } from './bootstrap.js';
import type { WorkspaceHost, SwitchResult } from './workspaceHost.js';
import { loadGlobalConfig, saveGlobalConfig, validatePublicUrl, GlobalConfigSchema } from '../config/globalConfig.js';
import { ALL_SCOPES } from '../security/policy.js';
import { DodoError } from '../errors.js';
import { ProjectRegistry } from '../projects/registry.js';
import type { TunnelRuntime } from '../tunnel/runtime.js';
import { accessMode } from '../security/accessMode.js';

/**
 * Owner-only control plane (ADR-017, ADR-019), deliberately NOT mounted on the
 * MCP listener:
 * - loopback bind, per-process 256-bit bearer capability with an 8 h expiry,
 *   passed once in the URL fragment (never a query string), then kept in
 *   sessionStorage by the page;
 * - Host/Origin/Sec-Fetch-Site checks and proxy-header rejection so a tunnel
 *   or a foreign page can never reach it, even with the token;
 * - static UI assets shipped with the package; strict CSP, no inline code,
 *   no external assets;
 * - the ACTIVE workspace is resolved per request through the host, so every
 *   read and write targets whatever `dodo start` currently serves.
 */
export interface LocalConfigInfo {
  version?: string;
  /** What the MCP listener of this process looks like (absent for entries without one). */
  transport?: { port: number; locked: boolean; publicUrl: string | null };
  runMode?: 'allow-all' | 'bypass' | null;
  /** Dynamic because the launcher can activate its first real workspace. */
  workspaceSelected?: () => boolean;
  /** Process-owned runtime; accepts only run-scoped credentials. */
  tunnelRuntime?: Pick<TunnelRuntime, 'status' | 'start' | 'stop'>;
  log?: (line: string) => void;
}

export interface LocalConfigServer {
  /** Private URL including the capability in the fragment — print it, never log it elsewhere. */
  url: string;
  /** Origin without the capability (safe to display). */
  origin: string;
  close(): Promise<void>;
}

const TOKEN_TTL_MS = 8 * 60 * 60 * 1000;
const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'configUi');
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

type Target = WorkspaceHost | BootstrappedWorkspace;

function isHost(t: Target): t is WorkspaceHost {
  return typeof (t as WorkspaceHost).current === 'function' && typeof (t as WorkspaceHost).switchTo === 'function';
}

/** Entries without runtime switching (stdio, tests) get a fixed single-workspace host. */
function staticHost(ws: BootstrappedWorkspace): WorkspaceHost {
  return {
    current: () => ws,
    state: () => 'ready',
    inflight: { enter: () => () => undefined, count: () => 0 },
    switchTo: async () => {
      throw new DodoError('NOT_SUPPORTED', 'workspace switching is only available for a server started with `dodo start`', {
        recovery: 'for stdio entries the workspace is the directory the client launched; restart the client with another --root',
      });
    },
    onSwitch: () => () => undefined,
    close: async () => undefined,
  };
}

function loadAsset(name: string): Buffer {
  const file = path.join(UI_DIR, name);
  try {
    return fs.readFileSync(file);
  } catch {
    throw new DodoError('INTERNAL_ERROR', `Local Config UI asset missing: ${file}`, { recovery: 'reinstall the package (npm install -g dodo-mcp) — the UI ships inside dist/server/configUi' });
  }
}

function localClients(ws: BootstrappedWorkspace) {
  const personal = accessMode(ws.store) === 'personal';
  return ws.store.listOAuthClients().map((c) => ({
    id: c.clientId,
    name: typeof c.payload['client_name'] === 'string' ? c.payload['client_name'] : null,
    public: c.payload['token_endpoint_auth_method'] === 'none',
    scopes: personal
      ? [...new Set(ws.store.listGrants().filter(g => g.clientId === c.clientId && g.revokedAt === null).flatMap(g => g.scopes))]
      : ws.store.clientAccess(ws.workspaceId, c.clientId),
  }));
}

export async function startLocalConfig(target: Target, port = 21731, info: LocalConfigInfo = {}): Promise<LocalConfigServer> {
  const host: WorkspaceHost = isHost(target) ? target : staticHost(target);
  const switchSupported = isHost(target);
  const hasWorkspace = () => info.workspaceSelected?.() ?? true;
  const token = randomBytes(32).toString('hex');
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  const assets = { html: loadAsset('index.html'), css: loadAsset('app.css'), js: loadAsset('app.js') };
  // Fail fast at startup when the shipped UI is incomplete (broken install).
  for (const critical of ['workbench.js', 'workbench.css', 'ui/dom.js', 'ui/tooltips.js', 'ui/alerts.js', 'vendor/sweetalert2.min.js', 'vendor/sweetalert2.min.css']) loadAsset(critical);

  const app = express();
  app.disable('x-powered-by');
  let actualPort = port;

  // ---- loopback + same-origin boundary (applies to EVERY route) ----
  app.use((req, res, next) => {
    const hostHeader = req.headers.host;
    const origin = req.headers.origin;
    const localHosts = [`127.0.0.1:${actualPort}`, `localhost:${actualPort}`];
    const forwarded = Object.keys(req.headers).some((k) => k === 'forwarded' || k.startsWith('x-forwarded-') || k.startsWith('cf-'));
    if (
      !['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '') ||
      !localHosts.includes(hostHeader ?? '') ||
      forwarded ||
      (origin && origin !== `http://${hostHeader}`) ||
      req.headers['sec-fetch-site'] === 'cross-site'
    ) {
      res.status(403).end();
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', CSP);
    next();
  });

  // ---- static UI (no inline code; CSP 'self'; SweetAlert2 vendored, no CDN) ----
  // Assets live only in dist/server/configUi (flat files plus the ui/ and
  // vendor/ subdirectories). The route is fail-closed: decoded path must match
  // a strict shape (at most one directory segment, allowlisted extension), and
  // the resolved file must stay inside UI_DIR. Anything else is 404.
  const ASSET_TYPES: Record<string, string> = {
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.svg': 'image/svg+xml',
  };
  const ASSET_SHAPE = /^(?:[A-Za-z0-9_-]+\/)?[A-Za-z0-9_-][A-Za-z0-9_.-]*(\.css|\.js|\.svg)$/;
  app.get('/', (_req, res) => res.type('html').send(assets.html));
  app.use('/assets', (req, res) => {
    if (req.method !== 'GET') { res.status(404).end(); return; }
    let relative = '';
    try { relative = decodeURIComponent(req.path.replace(/^\/+/, '')); } catch { res.status(404).end(); return; }
    const match = ASSET_SHAPE.exec(relative);
    if (!match || relative.includes('..') || relative.includes('\\') || relative.includes('\0')) { res.status(404).end(); return; }
    const file = path.resolve(UI_DIR, relative);
    if (!file.startsWith(UI_DIR + path.sep)) { res.status(404).end(); return; }
    let body: Buffer;
    try { body = fs.readFileSync(file); } catch { res.status(404).end(); return; }
    res.setHeader('Content-Type', ASSET_TYPES[match[1] as string] ?? 'application/octet-stream');
    res.send(body);
  });

  // ---- capability check + flood bound for the API ----
  let attempts = 0;
  let windowStart = Date.now();
  app.use('/api', (req, res, next) => {
    if (Date.now() - windowStart > 60_000) {
      windowStart = Date.now();
      attempts = 0;
    }
    if (++attempts > 120) {
      res.status(429).json({ error: 'Too many requests; wait a minute' });
      return;
    }
    const supplied = Buffer.from(req.headers.authorization?.replace(/^Bearer /, '') ?? '');
    const expected = Buffer.from(token);
    if (Date.now() > expiresAt || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      res.status(401).json({ error: 'Open the private Config URL printed in the DODO terminal. It expires after 8 hours; restart DODO to renew.' });
      return;
    }
    next();
  });
  app.use('/api', express.json({ limit: 32 * 1024 }));

  registerAIAdmin(app, host, info, expiresAt);

  // Bind every mutation to the workspace the owner actually reviewed.
  app.use('/api', (req, res, next) => {
    if (req.method !== 'POST') { next(); return; }
    const ws = host.current();
    if (host.state() !== 'ready' || req.headers['x-dodo-workspace'] !== ws.workspaceId || req.headers['x-dodo-epoch'] !== ws.epoch) {
      res.status(409).json({error:'Workspace changed or is switching. Refresh this page before saving.',code:'STALE_WORKSPACE'}); return;
    }
    next();
  });

  // ---- state ----
  app.get('/api/state', (_req, res) => {
    const ws = host.current();
    const cfg = loadGlobalConfig(ws.paths.configFile);
    const transport = info.transport;
    const selected = hasWorkspace();
    res.json({
      version: info.version ?? ws.services.version,
      state: host.state(),
      generatedAt: Date.now(),
      controlContext: { workspaceId: ws.workspaceId, epoch: ws.epoch },
      workspaceSwitchSupported: switchSupported,
      workspace: selected ? {
        root: ws.rootInfo.root,
        name: path.basename(ws.rootInfo.root),
        workspaceId: ws.workspaceId,
        epoch: ws.epoch,
        runningJobs: ws.services.jobs.runningCount(),
        recoveryRequired: ws.store.listChangesetsByStatus('recovery_required').filter((c) => c.workspaceId === ws.workspaceId).length,
        switchSupported,
      } : null,
      schedules: selected ? ws.services.schedules.list() : [],
      desktop: selected ? { policy: ws.services.desktop.policy() } : null,
      permissions: selected ? {
        accessMode: accessMode(ws.store),
        savedMode: ws.store.trustMode(ws.workspaceId),
        effectiveMode: ws.services.trustMode(),
        override: info.runMode ?? null,
        commandSandbox: ws.config.commandSandbox,
        allowWebFetch: ws.config.allowWebFetch,
      } : null,
      connection: {
        workspaceSelected: selected,
        mcpLocalUrl: transport ? `http://127.0.0.1:${transport.port}/mcp` : null,
        publicUrl: cfg.publicUrl ?? '',
        mcpPublicUrl: transport?.publicUrl ? `${transport.publicUrl}/mcp` : null,
        oauthConfigured: transport ? !transport.locked : null,
        activePublicUrl: transport?.publicUrl ?? null,
        restartRequired: transport !== undefined && (cfg.publicUrl ?? null) !== (transport.publicUrl ?? null),
        localConfigOrigin: `http://127.0.0.1:${actualPort}`,
        expiresAt,
      },
      tunnel: {
        mode: cfg.tunnel.mode,
        startWithDodo: cfg.tunnel.startWithDodo,
        tokenStorage: 'none',
        legacyCredentialConfigured: Boolean(cfg.tunnel.credentialRef),
        cloudflared: cfg.tunnel.executable ? 'owner-selected' : 'trusted-PATH',
        metricsPort: cfg.tunnel.metricsPort,
        maxRestarts: cfg.tunnel.maxRestarts,
        runtime: info.tunnelRuntime?.status() ?? { available: false, running: false, current: null, lastKnown: null },
      },
      clients: selected ? localClients(ws).filter((c) => c.scopes.length > 0) : [],
    });
  });

  // Registration is installation-wide; only list unassigned clients when the
  // owner explicitly opens the add-client picker for the reviewed workspace.
  app.get('/api/access/available', (req, res) => {
    const ws = host.current();
    if (!hasWorkspace()) { res.status(409).json({ error: 'Select a workspace before granting client access.', code: 'WORKSPACE_REQUIRED' }); return; }
    if (host.state() !== 'ready' || req.headers['x-dodo-workspace'] !== ws.workspaceId || req.headers['x-dodo-epoch'] !== ws.epoch) {
      res.status(409).json({ error: 'Workspace changed. Refresh before adding a client.', code: 'STALE_WORKSPACE' }); return;
    }
    res.json({
      workspaceId: ws.workspaceId,
      workspaceEpoch: ws.epoch,
      clients: localClients(ws).filter((c) => c.scopes.length === 0).map(({ id, name, public: isPublic }) => ({ id, name, public: isPublic })),
    });
  });

  app.get('/api/clients/manage', (req, res) => {
    const ws = host.current();
    if (host.state() !== 'ready' || req.headers['x-dodo-workspace'] !== ws.workspaceId || req.headers['x-dodo-epoch'] !== ws.epoch) {
      res.status(409).json({error:'Workspace changed. Refresh before reviewing clients.',code:'STALE_WORKSPACE'}); return;
    }
    const registered = ws.store.listOAuthClients();
    res.json({workspaceId:ws.workspaceId,workspaceEpoch:ws.epoch,
      clients:registered.slice(0,100).map(c => reviewClientDeletion(ws.store,c.clientId)),
      truncated:registered.length > 100});
  });

  // ---- installation project registry (owner only; never mounted on MCP) ----
  app.get('/api/projects', (req, res) => {
    const ws = host.current();
    if (host.state() !== 'ready' || req.headers['x-dodo-workspace'] !== ws.workspaceId || req.headers['x-dodo-epoch'] !== ws.epoch) {
      res.status(409).json({ error: 'Workspace changed. Refresh before reviewing projects.', code: 'STALE_WORKSPACE' }); return;
    }
    const projects = new ProjectRegistry(ws.store).list();
    res.json({
      workspaceId: ws.workspaceId,
      workspaceEpoch: ws.epoch,
      activeWorkspaceId: hasWorkspace() ? ws.workspaceId : null,
      projects,
    });
  });

  app.post('/api/projects/add', (req, res) => {
    const input = z.object({ path: z.string().min(1).max(4096), displayName: z.string().min(1).max(120).optional() }).strict().safeParse(req.body);
    if (!input.success) { res.status(400).json({ error: 'Project path and display name are invalid.', code: 'INVALID_INPUT' }); return; }
    try {
      const result = new ProjectRegistry(host.current().store).add(input.data.path, input.data.displayName);
      res.json({ ok: true, ...result, authorityChanged: false });
    } catch (error) {
      const { status, body } = ownerStateError(error);
      res.status(status).json(body);
    }
  });

  app.post('/api/projects/remove', async (req, res) => {
    const input = z.object({ projectId: z.string().min(1).max(96), confirmProjectId: z.string().min(1).max(96) }).strict().safeParse(req.body);
    if (!input.success || input.data.projectId !== input.data.confirmProjectId) {
      res.status(400).json({ error: 'Project removal requires the exact reviewed project ID.', code: 'INVALID_INPUT' }); return;
    }
    try {
      const ws = host.current();
      await ws.services.installation?.closeProject(input.data.projectId);
      const registered = new ProjectRegistry(ws.store).list().find(p => p.projectId === input.data.projectId);
      if (registered?.workspaceId === ws.workspaceId && (ws.services.jobs.runningCount() || ws.services.installation?.busy(ws.workspaceId))) throw new DodoError('CONFLICT', 'project has active jobs or agents');
      const project = new ProjectRegistry(ws.store).remove(input.data.projectId);
      const cfg = loadGlobalConfig(ws.paths.configFile);
      if (cfg.startupProjectId === project.projectId) {
        const next = { ...cfg };
        delete next.startupProjectId;
        saveGlobalConfig(ws.paths.configFile, GlobalConfigSchema.parse(next));
      }
      res.json({ ok: true, removed: true, project, filesDeleted: false, authorityDeleted: false });
    } catch (error) {
      const { status, body } = ownerStateError(error);
      res.status(status).json(body);
    }
  });
  app.post('/api/clients/delete', (req, res) => {
    const ws = host.current();
    res.json(deleteReviewedClients(ws.store,DeleteClientsInput.parse(req.body),ws.workspaceId));
  });

  app.post('/api/schedule/approve', (req, res) => {
    if (!hasWorkspace()) { res.status(409).json({ error: 'Select a workspace first.', code: 'WORKSPACE_REQUIRED' }); return; }
    const p = z.object({id:z.string().max(100),digest:z.string().max(100)}).strict().parse(req.body);
    res.json(host.current().services.schedules.approve(p.id,p.digest));
  });
  app.post('/api/schedule/revoke', (req, res) => {
    if (!hasWorkspace()) { res.status(409).json({ error: 'Select a workspace first.', code: 'WORKSPACE_REQUIRED' }); return; }
    const p = z.object({id:z.string().max(100)}).strict().parse(req.body);
    res.json(host.current().services.schedules.revoke(p.id));
  });

  // ---- Cloudflare Tunnel settings --------------------------------------
  // This route accepts only non-secret process preferences. The separate
  // authenticated session/start route accepts a run-scoped token and passes
  // it directly to the process-owned supervisor without persisting it.
  app.post('/api/tunnel/config', (req, res) => {
    const input = z.object({
      startWithDodo: z.boolean().optional(),
      metricsPort: z.number().int().min(1024).max(65535).optional(),
      maxRestarts: z.number().int().min(0).max(5).optional(),
    }).strict().safeParse(req.body);
    if (!input.success) {
      res.status(400).json({ error: 'Invalid tunnel configuration.', code: 'INVALID_INPUT' }); return;
    }
    const ws = host.current();
    try {
      const current = loadGlobalConfig(ws.paths.configFile);
      const tunnelInput: Record<string, unknown> = {
        ...current.tunnel,
        ...(input.data.startWithDodo !== undefined ? { startWithDodo: input.data.startWithDodo } : {}),
        ...(input.data.metricsPort !== undefined ? { metricsPort: input.data.metricsPort } : {}),
        ...(input.data.maxRestarts !== undefined ? { maxRestarts: input.data.maxRestarts } : {}),
      };
      const next = GlobalConfigSchema.parse({ ...current, tunnel: tunnelInput });
      saveGlobalConfig(ws.paths.configFile, next);
      ws.store.audit({ principal: 'local-config-owner', workspaceId: ws.workspaceId, tool: 'local.tunnel.config', result: 'saved-non-secret-settings' });
      res.json({
        ok: true,
        startWithDodo: next.tunnel.startWithDodo,
        tokenStorage: 'none',
        metricsPort: next.tunnel.metricsPort,
        maxRestarts: next.tunnel.maxRestarts,
        restartRequired: true,
      });
    } catch (error) {
      const { status, body } = switchError(error);
      res.status(status).json(body);
    }
  });

  app.post('/api/tunnel/session/start', async (req, res) => {
    const input = z.object({ token: z.string().min(20).max(8192) }).strict().safeParse(req.body);
    if (!input.success) {
      if (req.body && typeof req.body === 'object' && 'token' in req.body) req.body.token = '';
      res.status(400).json({ error: 'A valid temporary Tunnel token is required.', code: 'INVALID_INPUT' }); return;
    }
    const ws = host.current();
    try {
      if (!info.tunnelRuntime) throw new DodoError('NOT_SUPPORTED', 'This DODO entry cannot own a Cloudflare Tunnel process.');
      const current = loadGlobalConfig(ws.paths.configFile);
      if (!info.transport || info.transport.locked || !info.transport.publicUrl || current.publicUrl !== info.transport.publicUrl) {
        throw new DodoError('CONFLICT', 'Restart DODO after configuring the public HTTPS origin before starting Tunnel.');
      }
      const transient = GlobalConfigSchema.parse({ ...current, tunnel: { ...current.tunnel, mode: 'managed' } });
      const status = await info.tunnelRuntime.start(transient, input.data.token);
      req.body.token = '';
      try {
        ws.store.audit({ principal: 'local-config-owner', workspaceId: ws.workspaceId, tool: 'local.tunnel.session.start', result: 'started-with-temporary-token' });
      } catch (error) {
        await info.tunnelRuntime.stop();
        throw error;
      }
      res.json({ ok: true, tokenStored: false, status });
    } catch (error) {
      req.body.token = '';
      const { status, body } = switchError(error);
      res.status(status).json(body);
    }
  });

  app.post('/api/tunnel/session/stop', async (_req, res) => {
    const ws = host.current();
    try {
      if (!info.tunnelRuntime) throw new DodoError('NOT_SUPPORTED', 'This DODO entry cannot own a Cloudflare Tunnel process.');
      const status = await info.tunnelRuntime.stop();
      ws.store.audit({ principal: 'local-config-owner', workspaceId: ws.workspaceId, tool: 'local.tunnel.session.stop', result: 'stopped-owned-process' });
      res.json({ ok: true, status });
    } catch (error) {
      const { status, body } = switchError(error);
      res.status(status).json(body);
    }
  });

  // ---- saved trust / public origin ----
  app.post('/api/config', (req, res) => {
    const ws = host.current();
    const input = z.object({ mode: z.enum(['inspect', 'edit', 'trusted']).optional(), publicUrl: z.string().max(2048).optional() }).strict().safeParse(req.body);
    if (!input.success) {
      res.status(400).json({ error: 'Invalid configuration' });
      return;
    }
    try {
      let restartRequired = false;
      if (input.data.publicUrl !== undefined) {
        const config = loadGlobalConfig(ws.paths.configFile);
        const url = validatePublicUrl(input.data.publicUrl, false);
        saveGlobalConfig(ws.paths.configFile, GlobalConfigSchema.parse({ ...config, publicUrl: url.origin }));
        restartRequired = (info.transport?.publicUrl ?? null) !== url.origin;
      }
      if (input.data.mode && !hasWorkspace()) throw new DodoError('CONFLICT', 'Select a workspace before changing its trust mode.');
      if (input.data.mode) ws.store.setTrustMode(ws.workspaceId, input.data.mode);
      ws.store.audit({ principal: 'local-config-owner', workspaceId: ws.workspaceId, tool: 'local.config', result: 'saved' });
      res.json({ ok: true, restartRequired, savedMode: ws.store.trustMode(ws.workspaceId), effectiveMode: ws.services.trustMode() });
    } catch {
      res.status(400).json({ error: 'Invalid public HTTPS origin' });
    }
  });

  // Owner-only emergency stop; enabling is explicit through local IPC/CLI.
  app.post('/api/desktop/disable', (_req, res) => {
    if (!hasWorkspace()) { res.status(409).json({ error: 'Select a workspace first.', code: 'WORKSPACE_REQUIRED' }); return; }
    const policy = host.current().services.desktop.setPolicy({ mode: 'off' });
    res.json({ ok: true, policy });
  });

  // ---- per-workspace client ACL ----
  app.post('/api/access', (req, res) => {
    const ws = host.current();
    if (!hasWorkspace()) { res.status(409).json({ error: 'Select a workspace before granting client access.', code: 'WORKSPACE_REQUIRED' }); return; }
    const input = z.object({ clientId: z.string().min(1).max(128), scopes: z.array(z.enum(ALL_SCOPES)).max(3), addOnly: z.boolean().optional() }).strict().safeParse(req.body);
    if (!input.success || !ws.store.listOAuthClients().some((c) => c.clientId === input.data.clientId)) {
      res.status(400).json({ error: 'Invalid client or scopes' });
      return;
    }
    if (input.data.addOnly && ws.store.clientAccess(ws.workspaceId, input.data.clientId).length > 0) {
      res.status(409).json({ error: 'This client already has access. Refresh to review its current permissions.', code: 'CLIENT_ALREADY_ALLOWED' }); return;
    }
    ws.store.setClientAccess(ws.workspaceId, input.data.clientId, input.data.scopes);
    ws.store.audit({ principal: 'local-config-owner', workspaceId: ws.workspaceId, tool: 'local.access', refId: input.data.clientId, result: input.data.scopes.length ? 'allowed' : 'revoked' });
    res.json({ ok: true, scopes: ws.store.clientAccess(ws.workspaceId, input.data.clientId) });
  });

  // ---- runtime workspace switch (owner only; never an MCP tool) ----
  app.post('/api/workspace/switch', async (req, res) => {
    const input = z.object({ path: z.string().min(1).max(4096) }).strict().safeParse(req.body);
    if (!input.success) {
      res.status(400).json({ error: 'path must be a non-empty absolute path', code: 'INVALID_INPUT' });
      return;
    }
    const before = host.current();
    try {
      const result: SwitchResult = await host.switchTo({ path: input.data.path });
      let startupRemembered = true;
      if (result.changed || hasWorkspace()) {
        try {
          const ws = host.current();
          const registered = new ProjectRegistry(ws.store).add(ws.rootInfo.root).project;
          const cfg = loadGlobalConfig(ws.paths.configFile);
          saveGlobalConfig(ws.paths.configFile, GlobalConfigSchema.parse({ ...cfg, startupProjectId: registered.projectId }));
        } catch (error) {
          startupRemembered = false;
          info.log?.(`[dodo] workspace selected but startup preference could not be saved: ${(error as Error).message}`);
        }
      }
      res.json({ ok: true, ...result, needsProjectOverview: result.changed, startupRemembered });
    } catch (err) {
      const { status, body } = switchError(err);
      try {
        before.store.audit({ principal: 'local-config-owner', workspaceId: before.workspaceId, tool: 'local.workspace.switch', paths: [input.data.path], result: `refused:${body.code}` });
      } catch {
        /* old store may be closed if the failure happened late; audit is best effort */
      }
      res.status(status).json(body);
    }
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof z.ZodError) { res.status(400).json({error:'Invalid owner request',code:'INVALID_INPUT'}); return; }
    if (err instanceof DodoError) { res.status(err.code === 'FORBIDDEN' ? 403 : 409).json({error:err.message,code:err.code}); return; }
    res.status(500).json({error:'Owner request failed',code:'INTERNAL_ERROR'});
  });
  app.use((_req, res) => res.status(404).end());

  const server = http.createServer(app);
  server.requestTimeout = 60_000; // a switch can legitimately take a few seconds
  server.headersTimeout = 5000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  actualPort = (server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${actualPort}`;
  return {
    url: `${origin}/#${token}`,
    origin,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

function switchError(err: unknown): { status: number; body: { error: string; code: string; recovery?: string } } {
  if (err instanceof DodoError) {
    const status =
      err.code === 'CONFLICT' ? 409 :
      err.code === 'NOT_SUPPORTED' ? 501 :
      err.code === 'INVALID_INPUT' || err.code === 'NOT_FOUND' || err.code === 'PATH_DENIED' ? 400 :
      500;
    return { status, body: { error: err.message, code: err.code, ...(err.recovery ? { recovery: err.recovery } : {}) } };
  }
  return { status: 500, body: { error: 'workspace switch failed; the previous workspace is still active', code: 'INTERNAL_ERROR' } };
}

function ownerStateError(err: unknown): { status: number; body: { error: string; code: string; recovery?: string } } {
  if (err instanceof DodoError) {
    const status =
      err.code === 'INVALID_INPUT' || err.code === 'PATH_DENIED' ? 400 :
      err.code === 'NOT_FOUND' ? 404 :
      err.code === 'CONFLICT' || err.code === 'MIGRATION_REVIEW_REQUIRED' || err.code === 'RESOURCE_LIMIT' ? 409 :
      500;
    return { status, body: { error: err.message, code: err.code, ...(err.recovery ? { recovery: err.recovery } : {}) } };
  }
  return { status: 500, body: { error: 'Project registry request failed.', code: 'INTERNAL_ERROR' } };
}

export type { Request, Response };
