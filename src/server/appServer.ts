import { InstallationRuntime } from './installationRuntime.js';
import { instructionsFor } from './instructions.js';
import http from 'node:http';
import { ipcEndpointPresent } from '../ipc/authentication.js';
import express, { type Request, type Response, type NextFunction } from 'express';
import { hostHeaderValidation, originValidation, requireBearerAuth, mcpAuthMetadataRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/express';
import { createMcpHandler, McpServer, type McpServerFactory } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type net from 'node:net';

import { DodoError } from '../errors.js';
import { ensureConfigDir, ipcSocketPath, resolveConfigDir, statePaths } from '../config/paths.js';
import { validatePublicUrl } from '../config/globalConfig.js';
import { loadOrCreateJwks, loadOrCreateCookieKeys } from '../auth/keys.js';
import { buildProvider } from '../auth/provider.js';
import { buildTokenVerifier } from '../auth/verifier.js';
import { interactionRouter } from '../auth/interactions.js';
import { ALL_SCOPES } from '../security/policy.js';
import { registerSurface, surfaceStats, type ToolSurface } from '../tools/surface.js';
import type { AppServices } from '../tools/context.js';
import { startOwnerControl } from '../ipc/ownerControl.js';
import { ipcCall, IpcError } from '../ipc/client.js';
import { openDatabase } from '../store/db.js';
import { Store } from '../store/store.js';
import { bootstrapWorkspace, type BootstrappedWorkspace } from './bootstrap.js';
import { createIpcDispatcher } from './ipcDispatch.js';
import { attachOptionalServices } from './optionalServices.js';
import { createWorkspaceHost, type WorkspaceHost, type WorkspaceResources, type SwitchInput, type SwitchResult } from './workspaceHost.js';
import { startLocalConfig, type LocalConfigServer } from './localConfig.js';
import { DODO_VERSION } from './version.js';
import type { TunnelRuntime } from '../tunnel/runtime.js';
import { osCredentialAvailability, osTunnelCredentialRef, storeOsTunnelCredentialValue } from '../tunnel/credentials.js';
import { RemoteConfigGateway, type RemoteConfigLease, type RemoteConfigStatus } from './remoteConfig.js';

export { DODO_VERSION };

export interface StartOptions {
  /** process.cwd() captured at the CLI entrypoint, before anything else. */
  invokedCwd: string;
  rootOverride?: string;
  /** Start the owner control plane without exposing a workspace until one is selected. */
  deferWorkspace?: boolean;
  portOverride?: number;
  publicUrlOverride?: string;
  /** One active endpoint family for this process. CLI always supplies this. */
  connectionMode?: 'local' | 'tunnel';
  allowUnsafeRoot?: boolean;
  quiet?: boolean;
  configPort?: number;
  runMode?: 'allow-all' | 'bypass';
  /** Tool exposure for this run; overrides config.toolSurface. HTTP default: 'compact'. */
  toolSurface?: ToolSurface;
  /** Test hook: how long a workspace switch waits for in-flight MCP requests. */
  drainTimeoutMs?: number;
  onLog?: (line: string) => void;
  /** CLI process exit notification, after graceful shutdown has completed. */
  onStopped?: () => void;
  /** Process-owned persistent Cloudflare Tunnel lifecycle. */
  tunnelRuntime?: TunnelRuntime;
  /** Open the owner-only Remote Config bridge for at most one hour. */
  remoteConfig?: boolean;
  /** Test-only shorter lease; production callers omit this and receive one hour. */
  remoteConfigLeaseMs?: number;
}

export interface RunningServer {
  version: string;
  /** Live values: they follow the ACTIVE workspace after an owner-triggered switch (ADR-019). */
  root: string;
  workspaceId: string;
  epoch: string;
  port: number;
  locked: boolean;
  publicUrl: string | null;
  connectionMode: 'local' | 'tunnel';
  ipcPath: string;
  configDir: string;
  services: AppServices;
  /** Private Local Config URL (contains the capability in the fragment) or null when not started. */
  configUrl: string | null;
  /** Initial Remote Config lease; pairing code is returned once and never persisted. */
  remoteConfig: RemoteConfigLease | null;
  remoteConfigStatus(): RemoteConfigStatus | null;
  host: WorkspaceHost;
  /** False only for the owner launcher before a real project is selected. */
  readonly workspaceSelected: boolean;
  bannerLines: string[];
  switchWorkspace(input: SwitchInput): Promise<SwitchResult>;
  close(): Promise<void>;
}

/**
 * The HTTP entry (`dodo start`): OAuth AS + MCP resource server on
 * 127.0.0.1, locked until a public URL is configured (spec §4, §7, §8).
 *
 * One process, one ACTIVE workspace at a time. Every long-lived closure
 * (MCP server factory, token verifier, consent router, IPC, Local Config)
 * resolves the active workspace per request through the WorkspaceHost, so
 * the owner can switch roots from the Local Config page without a restart.
 */
export async function startServer(opts: StartOptions): Promise<RunningServer> {
  const log = opts.onLog ?? (() => undefined);
  const runMode = opts.runMode;
  let closing = false;
  let shutdownPromise: Promise<void> | undefined;

  if (opts.deferWorkspace && opts.rootOverride !== undefined) {
    throw new DodoError('INVALID_INPUT', 'deferWorkspace cannot be combined with an explicit root');
  }
  const launcherConfig = opts.deferWorkspace ? resolveConfigDir(process.env) : undefined;
  if (launcherConfig) ensureConfigDir(launcherConfig.dir);
  const launcherRoot = launcherConfig ? statePaths(launcherConfig.dir).launcherWorkspaceDir : undefined;

  // ---- workspace bootstrap (initial root, and later roots for a switch) ----
  // The launcher root is private and inert. It may expose the authenticated
  // catalog, but every operation remains denied until a project ACL is set or
  // the caller explicitly targets an authorized registered project.
  const launcherBootstrap = launcherRoot !== undefined && launcherConfig !== undefined
    ? { rootOverride: launcherRoot, configDir: launcherConfig }
    : opts.rootOverride !== undefined
      ? { rootOverride: opts.rootOverride }
      : {};
  const ws0 = bootstrapWorkspace({
    invokedCwd: opts.invokedCwd,
    ...launcherBootstrap,
    allowUnsafeRoot: opts.allowUnsafeRoot ?? false,
    log,
    ...(runMode ? { runMode } : {}),
  });
  attachOptionalServices(ws0, log);
  const { config, paths, configDir, configDirSource, configDirEnvVar } = ws0;
  const limits = config.limits;
  // Tool exposure only — never permissions (ADR-029). HTTP defaults to the
  // compact gateway surface so remote clients ingest a small catalog.
  const surface: ToolSurface = opts.toolSurface ?? config.toolSurface ?? 'compact';
  const surfaceFeatures = { subagents: config.exposeSubagentsToMcp };
  const bootstrapFor = (root: string): BootstrappedWorkspace => {
    const ws = bootstrapWorkspace({
      invokedCwd: opts.invokedCwd,
      rootOverride: root,
      // --allow-unsafe-root is a boot-time CLI decision; a switch over the
      // config plane always goes through the strict root policy.
      allowUnsafeRoot: false,
      // Same state directory as the boot workspace, never re-resolved from the
      // environment of whoever triggers the switch.
      configDir: { dir: configDir, source: configDirSource },
      log,
      ...(runMode ? { runMode } : {}),
    });
    attachOptionalServices(ws, log);
    return ws;
  };

  // Installation-scoped store for OAuth/consent state: it outlives any single
  // workspace (a workspace's own connection is closed when it is switched out).
  const installDb = openDatabase(paths.dbFile);
  const installStore = new Store(installDb);
  let workspaceSelected = !opts.deferWorkspace;

  // Assigned once the IPC resources exist; closures below read it per request.
  const hostRef: { host: WorkspaceHost | undefined } = { host: undefined };
  const active = (): BootstrappedWorkspace => (hostRef.host ? hostRef.host.current() : ws0);

  // ---- selected endpoint / auth mode ------------------------------------
  const port = opts.portOverride ?? config.port;
  const connectionMode: 'local' | 'tunnel' = opts.connectionMode ?? config.tunnel.connectionMode;
  const publicUrlRaw = connectionMode === 'local'
    // A dynamic port is useful for internal fixtures but cannot be a stable
    // OAuth issuer before listen completes, so that low-level mode stays locked.
    // The product CLI rejects port 0 for Local mode before reaching this layer.
    ? port === 0 ? undefined : `http://127.0.0.1:${port}`
    : opts.publicUrlOverride ?? config.publicUrl;
  let locked = true;
  let issuer: string | null = null;
  let resourceUrl: string | null = null;
  if (publicUrlRaw !== undefined) {
    const url = validatePublicUrl(publicUrlRaw, config.dangerouslyAllowInsecurePublicUrl || connectionMode === 'local');
    issuer = url.origin;
    resourceUrl = `${issuer}/mcp`;
    locked = false;
  }
  if (opts.remoteConfig && connectionMode !== 'tunnel') {
    await ws0.shutdownServices();
    installDb.close();
    throw new DodoError('CONFLICT', 'Remote Config is available only while DODO connection mode is tunnel', {
      recovery: 'run dodo tunnel configure --tunnel --os-credential --public-url https://your-host, restart DODO, then run dodo --web',
    });
  }
  if (opts.remoteConfig && !issuer) {
    await ws0.shutdownServices();
    installDb.close();
    throw new DodoError('CONFLICT', 'dodo --web requires a configured public HTTPS origin', {
      recovery: 'run dodo init --public-url https://your-host, then run dodo --web again',
    });
  }

  // ---- express app -------------------------------------------------------
  const app = express();
  app.disable('x-powered-by');
  // The only hop is the owner's local tunnel daemon (bind is loopback-only);
  // its X-Forwarded-* headers are trusted for protocol/IP, never for issuer.
  app.set('trust proxy', 'loopback');

  const hostAllowlist = ['127.0.0.1', 'localhost', '[::1]', ...config.allowedHosts];
  if (issuer) hostAllowlist.push(new URL(issuer).hostname);
  app.use(hostHeaderValidation(hostAllowlist));
  const originAllowlist = ['127.0.0.1', 'localhost', '[::1]', ...config.allowedOrigins];
  if (issuer) originAllowlist.push(new URL(issuer).hostname);
  app.use(originValidation(originAllowlist));

  // This router is inert (404) until the local owner explicitly opens a
  // bounded lease. It is mounted before OAuth's provider callback so the
  // temporary /config namespace can be reached through the same tunnel.
  const remoteConfigGateway = issuer && connectionMode === 'tunnel'
    ? new RemoteConfigGateway(issuer, opts.remoteConfigLeaseMs)
    : undefined;
  remoteConfigGateway?.mount(app);

  app.get('/healthz', (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store').json({ status: 'ok', name: 'dodo', version: DODO_VERSION, authConfigured: !locked, workspaceSelected });
  });

  let mcpHandlerClose: (() => Promise<void>) | undefined;

  if (locked) {
    app.all(['/mcp', '/mcp/*splat'], (_req: Request, res: Response) => {
      res
        .status(401)
        .setHeader('Cache-Control', 'no-store')
        .setHeader('WWW-Authenticate', 'Bearer error="invalid_token", error_description="server setup incomplete"')
        .json({
          error: 'setup_required',
          error_description: 'This DODO server has no public URL / OAuth configuration yet. On the server machine run: dodo init --public-url https://your-host',
        });
    });
  } else {
    const jwks = loadOrCreateJwks(paths.jwksFile);
    const cookieKeys = loadOrCreateCookieKeys(paths.cookieKeysFile);
    const provider = buildProvider({
      issuer: issuer as string,
      resourceUrl: resourceUrl as string,
      store: installStore,
      jwks,
      cookieKeys,
      workspaceId: () => active().workspaceId,
    });
    const verifier = buildTokenVerifier({
      targetRouting: true,
      issuer: issuer as string,
      resourceUrl: resourceUrl as string,
      jwks,
      active: () => ({ workspaceId: active().workspaceId, store: installStore }),
    });

    const oauthMetadata = {
      issuer: issuer as string,
      authorization_endpoint: `${issuer}/auth`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
      revocation_endpoint: `${issuer}/token/revocation`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
      scopes_supported: [...ALL_SCOPES, 'offline_access'],
      // RFC 9207: oidc-provider puts `iss` on every authorization response
      // (success and error). Advertising it lets clients such as ChatGPT use
      // their stable OAuth callback instead of a per-connection one.
      authorization_response_iss_parameter_supported: true,
    };
    app.use(
      mcpAuthMetadataRouter({
        oauthMetadata,
        resourceServerUrl: new URL(resourceUrl as string),
        scopesSupported: [...ALL_SCOPES],
        resourceName: 'DODO workspace MCP',
        dangerouslyAllowInsecureIssuerUrl: config.dangerouslyAllowInsecurePublicUrl,
      }),
    );

    // Light global rate limit for auth-sensitive routes (flood protection —
    // everything arrives from the local tunnel, so IP buckets are useless).
    app.use(['/auth', '/token', '/interaction'], rateLimiter(120, 10_000));

    app.use(
      interactionRouter({
        provider,
        store: installStore,
        resourceUrl: resourceUrl as string,
        active: () => ({ workspaceId: active().workspaceId, epoch: active().epoch }),
      }),
    );

    // Per-request server instances: the catalog binds to whatever workspace
    // is active when the request arrives.
    const factory: McpServerFactory = () => {
      const server = new McpServer({ name: 'dodo', version: DODO_VERSION, title: 'DODO workspace server' }, { instructions: instructionsFor(surface, surfaceFeatures) });
      const workspace = active();
      registerSurface(server, { ...workspace.services, beginTool: () => {
        const host = hostRef.host;
        if (closing || (host && (host.state() !== 'ready' || host.current() !== workspace))) throw new DodoError('STALE_WORKSPACE', 'workspace changed; call project_overview again');
        return host ? host.inflight.enter() : () => undefined;
      } }, surface, surfaceFeatures);
      return server;
    };
    const mcpHandler = createMcpHandler(factory, {
      legacy: 'stateless',
      onerror: (err) => log(`[dodo] mcp: ${err.message}`),
    });
    mcpHandlerClose = mcpHandler.close;
    const nodeHandler = toNodeHandler(mcpHandler, { onerror: (err) => log(`[dodo] mcp-adapter: ${err.message}`) });

    const pendingBodies = new WeakMap<Request, () => void>();
    // Switch gate + in-flight accounting: while the owner switches workspace,
    // new calls are told to retry; calls already running are drained first.
    const switchGate = (req: Request, res: Response, next: NextFunction) => {
      pendingBodies.get(req)?.();
      const host = hostRef.host;
      const targeted = typeof (req.body as {params?:{arguments?:{targetProjectId?:unknown}}} | undefined)?.params?.arguments?.targetProjectId === 'string';
      if (closing || (!targeted && host && host.state() !== 'ready')) {
        res
          .status(503)
          .setHeader('Retry-After', '2')
          .setHeader('Cache-Control', 'no-store')
          .json({ error: 'workspace_switching', error_description: 'the owner is switching the active workspace; retry in a moment and call project_overview again' });
        return;
      }
      const done = host && !targeted ? host.inflight.enter() : () => undefined;
      res.once('close', done);
      res.once('finish', done);
      next();
    };

    app.all(
      '/mcp',
      (req: Request, res: Response, next: NextFunction) => {
        const done = hostRef.host ? hostRef.host.inflight.enter() : () => undefined;
        pendingBodies.set(req,done); res.once('close',done); res.once('finish',done); next();
      },
      requireBearerAuth({
        verifier,
        resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(new URL(resourceUrl as string)),
      }),
      express.json({ limit: limits.requestBodyBytes }),
      switchGate,
      (req: Request, res: Response) => {
        res.setHeader('Cache-Control', 'no-store');
        void nodeHandler(req, res, req.body);
      },
    );

    // Body-size errors from express.json → clean 413 (AUTH-16).
    app.use('/mcp', (err: Error & { type?: string; status?: number }, _req: Request, res: Response, next: NextFunction) => {
      if (res.headersSent) {
        next(err);
        return;
      }
      const status = err.status ?? 400;
      res.status(status).setHeader('Cache-Control', 'no-store').json({ error: status === 413 ? 'payload_too_large' : 'bad_request' });
    });

    app.use(provider.callback());
  }

  // Anything else (locked mode reaches here): plain 404, no admin surface.
  app.use((_req: Request, res: Response) => {
    res.status(404).setHeader('Cache-Control', 'no-store').json({ error: 'not_found' });
  });

  // ---- listen ------------------------------------------------------------
  const httpServer = http.createServer(app);
  httpServer.requestTimeout = 120_000;
  httpServer.headersTimeout = 30_000;
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(
          new DodoError('RESOURCE_LIMIT', `port ${port} is already in use`, {
            recovery: 'if it is another DODO server, run dodo kill from any folder (OAuth login is kept); otherwise stop that program yourself or choose --port <other-port>',
          }),
        );
      } else {
        reject(new DodoError('INTERNAL_ERROR', `listen failed: ${err.message}`));
      }
    });
    httpServer.listen(port, '127.0.0.1', () => resolve());
  }).catch(async error => { await mcpHandlerClose?.(); await ws0.shutdownServices(); installDb.close(); throw error; });
  const actualPort = (httpServer.address() as net.AddressInfo).port;
  {
    const stats = surfaceStats(surface, surfaceFeatures);
    log(`[dodo] mcp tool surface | transport=http | surface=${surface} | tools=${stats.toolCount} | schemaBytes=${stats.schemaBytes} | subagents=${surfaceFeatures.subagents ? 'on' : 'off'}`);
  }

  function closeHttp(): Promise<void> {
    return new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
      httpServer.closeAllConnections();
    });
  }

  // ---- private IPC (per workspace) ---------------------------------------
  const transportInfo = () => ({ kind: 'http' as const, port: actualPort, locked, publicUrl: issuer, connectionMode });
  let remoteConfigReady = false;
  const remoteConfigControl = remoteConfigGateway ? {
    open: async (args: Record<string, unknown>) => {
      if (!remoteConfigReady) throw new DodoError('NOT_SUPPORTED', 'Remote Config requires the loopback Local Config server');
      const keys = Object.keys(args);
      if (keys.length > 0) {
        throw new DodoError('INVALID_INPUT', 'Remote Config open request contains an unsupported field');
      }
      if (!opts.tunnelRuntime?.status().running) {
        throw new DodoError('CONFLICT', 'the configured DODO Tunnel is not running', {
          recovery: 'restart DODO in tunnel mode and inspect dodo tunnel doctor if startup fails',
        });
      }
      return remoteConfigGateway.open();
    },
    close: () => remoteConfigGateway.close(),
    status: () => ({
      ...remoteConfigGateway.status(),
      tunnel: opts.tunnelRuntime?.status() ?? { available: false, running: false, current: null, lastKnown: null },
    }),
  } : undefined;
  const resourcesFor = async (ws: BootstrappedWorkspace): Promise<WorkspaceResources> => {
    return startOwnerControl(ws, createIpcDispatcher({
      ws,
      transport: transportInfo(),
      requestStop: () => void shutdown(),
      ...(remoteConfigControl ? { remoteConfig: remoteConfigControl } : {}),
    }));
  };
  // A live process for the target root would be clobbered by our IPC bind
  // (startIpcServer removes an existing socket file): probe it first.
  const isRootServedElsewhere = async (workspaceId: string): Promise<boolean> => {
    const p = ipcSocketPath(configDir, workspaceId);
    if (!ipcEndpointPresent(p)) return false;
    try {
      await ipcCall(p, 'status', {}, 1500);
      return true;
    } catch (err) {
      // Stale socket file (nothing listening) is the only safe "no".
      return !(err instanceof IpcError && err.message.startsWith('no running DODO server'));
    }
  };

  let initialResources: WorkspaceResources;
  try {
    initialResources = await resourcesFor(ws0);
  } catch (err) {
    await closeHttp();
    await mcpHandlerClose?.();
    await ws0.shutdownServices();
    try {
      installDb.close();
    } catch {
      /* ignore */
    }
    throw err;
  }
  const installation = new InstallationRuntime(ws0, active, resourcesFor, log, [21730, 21731, actualPort, opts.configPort ?? config.configPort]);
  hostRef.host = createWorkspaceHost({
    initial: ws0,
    initialResources,
    bootstrap: bootstrapFor,
    resources: resourcesFor,
    isRootServedElsewhere,
    busy: () => installation.busy(active().workspaceId),
    log,
    ...(opts.drainTimeoutMs !== undefined ? { drainTimeoutMs: opts.drainTimeoutMs } : {}),
  });
  const theHost = hostRef.host;
  const startSchedules = (ws: BootstrappedWorkspace) => ws.services.schedules.start(() => !closing && workspaceSelected && theHost.state() === 'ready' && theHost.current() === ws);
  if (workspaceSelected) startSchedules(ws0);
  theHost.onSwitch(next => {
    workspaceSelected = true;
    installation.attach(next);
    startSchedules(next);
  });

  installation.defaultReady = () => theHost.state() === 'ready';

  // ---- owner-only Local Config plane ------------------------------------
  let localConfig: LocalConfigServer | undefined;
  let initialRemoteConfig: RemoteConfigLease | null = null;
  try {
    if (opts.configPort !== undefined) {
      localConfig = await startLocalConfig(theHost, opts.configPort, {
        version: DODO_VERSION,
        transport: transportInfo(),
        runMode: runMode ?? null,
        workspaceSelected: () => workspaceSelected,
        ...(opts.tunnelRuntime ? { tunnelRuntime: opts.tunnelRuntime } : {}),
        tunnelCredentialStore: {
          ...osCredentialAvailability(),
          store: async (token: string) => {
            const ref = osTunnelCredentialRef(configDir);
            await storeOsTunnelCredentialValue(ref, token);
            return ref;
          },
        },
        log,
      });
      installation.ai.settings.ports.push(Number(new URL(localConfig.url).port));
      remoteConfigGateway?.attachLocal(localConfig.url);
      remoteConfigReady = Boolean(remoteConfigGateway);
      if (opts.remoteConfig) initialRemoteConfig = remoteConfigGateway?.open(opts.remoteConfigLeaseMs) ?? null;
    }
    if (opts.remoteConfig && !initialRemoteConfig) {
      throw new DodoError('NOT_SUPPORTED', 'Remote Config requires the loopback Local Config server');
    }
  } catch (err) {
    await closeHttp();
    await mcpHandlerClose?.();
    await installation.close();
    await theHost.close();
    try {
      installDb.close();
    } catch {
      /* ignore */
    }
    throw err;
  }

  // ---- shutdown ----------------------------------------------------------
  function shutdown(): Promise<void> {
    if (!shutdownPromise) {
      closing = true;
      // Cancel owned jobs before draining handlers that may be awaiting them.
      const jobsClosed = active().services.jobs.shutdown(3000);
      shutdownPromise = (async () => {
        try {
          await localConfig?.close();
          remoteConfigGateway?.close();
          await closeHttp();
          await jobsClosed;
          await mcpHandlerClose?.();
          await installation.close();
          await theHost.close(); // current IPC socket + current workspace services
          try { installDb.close(); } catch { /* already closed */ }
        } catch { /* shutdown is best effort */ }
        opts.onStopped?.();
      })();
    }
    return shutdownPromise;
  }

  const { rootInfo, workspaceId, epoch, services } = ws0;
  const banner = [
    `DODO ${DODO_VERSION}  |  foreground`,
    workspaceSelected ? `Workspace: ${rootInfo.root}` : 'Workspace: (ยังไม่ได้เลือก — เพิ่มหรือเลือกใน Local Config / dodo --cli)',
    workspaceSelected ? `Workspace ID: ${workspaceId}  |  epoch: ${epoch}` : 'Workspace ID: (ยังไม่สร้าง context สำหรับ AI)',
    `MCP: ${issuer}/mcp (${connectionMode})`,
    connectionMode === 'tunnel' ? `Local upstream: http://127.0.0.1:${actualPort}/mcp` : 'Tunnel: disabled by owner selection',
    !workspaceSelected ? 'Auth: OAuth installation login available; project access remains denied until owner ACL assignment' : locked ? 'Auth: LOCKED / setup required — all tool access refused' : `Auth: OAuth enabled  |  Policy: ${services.trustMode()}`,
    workspaceSelected ? `Exec: ${services.trustMode() === 'trusted' ? 'allowed by trusted mode (OS-user privileges!)' : 'local approval required'}  |  OS sandbox: ${config.commandSandbox === 'off' ? 'NOT enabled' : `${config.commandSandbox} (adapter: ${services.jobs ? 'configured' : 'n/a'})`}` : 'Exec: disabled until a workspace is selected',
    connectionMode === 'tunnel' ? 'Tunnel: DODO-owned; starts and stops with this process' : 'Connection: local only',
    `State: ${configDir}${configDirEnvVar ? ` (from ${configDirEnvVar})` : configDirSource === 'env' ? ' (from explicit environment override)' : ''}`,
  ];
  if (localConfig) log(`[dodo] Private config (expires in 8h): ${localConfig.url}`);
  if (initialRemoteConfig) {
    log(`[dodo] Remote Config (expires in 1h): ${initialRemoteConfig.url}`);
    log(`[dodo] Remote Config pairing code (shown once): ${initialRemoteConfig.pairingCode}`);
  }
  if (runMode) log(`[dodo] ${runMode}: trusted OS-user execution for this run; OAuth, client/path access and file guards remain required.`);
  if (!opts.quiet) banner.forEach((l) => log(l));

  return {
    version: DODO_VERSION,
    get root() {
      return theHost.current().rootInfo.root;
    },
    get workspaceId() {
      return theHost.current().workspaceId;
    },
    get epoch() {
      return theHost.current().epoch;
    },
    port: actualPort,
    locked,
    publicUrl: issuer,
    connectionMode,
    get ipcPath() {
      return ipcSocketPath(configDir, theHost.current().workspaceId);
    },
    configDir,
    get services() {
      return theHost.current().services;
    },
    configUrl: localConfig?.url ?? null,
    remoteConfig: initialRemoteConfig,
    remoteConfigStatus: () => remoteConfigGateway?.status() ?? null,
    host: theHost,
    get workspaceSelected() {
      return workspaceSelected;
    },
    bannerLines: banner,
    switchWorkspace: (input) => theHost.switchTo(input),
    close: () => shutdown(),
  };
}

/** Simple global token-bucket limiter (auth flood bounds, AUTH-16). */
function rateLimiter(maxPerWindow: number, windowMs: number) {
  let count = 0;
  let windowStart = Date.now();
  return (_req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    if (now - windowStart > windowMs) {
      windowStart = now;
      count = 0;
    }
    count += 1;
    if (count > maxPerWindow) {
      res.status(429).setHeader('Cache-Control', 'no-store').json({ error: 'rate_limited' });
      return;
    }
    next();
  };
}
