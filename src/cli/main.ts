#!/usr/bin/env node
/**
 * DODO CLI entrypoint. The FIRST statement evaluated in this module captures
 * process.cwd() (spec §4.2) — ES module imports above it are hoisted but none
 * of them changes the working directory at load time (enforced by test).
 */
const invokedCwd = process.cwd();

import fs from 'node:fs';
import { Command } from 'commander';
import { startServer, DODO_VERSION } from '../server/appServer.js';
import { startStdioServer } from '../server/stdioServer.js';
import { resolveConfigDir, ensureConfigDir, statePaths, ipcSocketPath } from '../config/paths.js';
import { loadGlobalConfig, saveGlobalConfig, validatePublicUrl, GlobalConfigSchema } from '../config/globalConfig.js';
import { resolveWorkspaceRoot } from '../workspace/root.js';
import { mintWorkspaceId } from '../workspace/identity.js';
import { openDatabase, openDatabaseReadonly } from '../store/db.js';
import { Store, type TrustMode } from '../store/store.js';
import { ipcCall, IpcError } from '../ipc/client.js';
import { installationIpcCall } from '../ipc/installationClient.js';
import { formatTerminalLine } from './terminal.js';
import { TRUST_MODE_DESCRIPTIONS } from '../security/policy.js';
import { DodoError } from '../errors.js';
import type { StatusData } from '../ipc/protocol.js';
import { sandboxAvailability } from '../services/jobs/sandbox.js';
import { DesktopPolicyInputSchema, saveDesktopPolicy } from '../services/desktop/desktopPolicy.js';
import { INPUT_LIMIT_PROFILES } from '../config/limits.js';
import { ProjectRegistry, type RegisteredProject } from '../projects/registry.js';
import { runCliMenu } from './menu.js';
import { TunnelRuntime } from '../tunnel/runtime.js';
import { INSTALLATION_AUTHORITY_ID } from '../auth/constants.js';

const program = new Command();
program.name('dodo').description('DODO — local-first, single-owner, project-scoped coding MCP server').version(DODO_VERSION);

function fail(message: string, code = 1): never {
  console.error(`dodo: ${message}`);
  process.exit(code);
}

function workspaceIpcPath(root?: string): { ipcPath: string; root: string } {
  const { dir } = resolveConfigDir(process.env);
  ensureConfigDir(dir);
  const paths = statePaths(dir);
  const rootInfo = resolveWorkspaceRoot(root ?? invokedCwd, { allowUnsafe: true });
  // Read-only, no migration: never contend with a running server's write lock.
  const db = openDatabaseReadonly(paths.dbFile);
  if (!db) {
    throw new IpcError('no running DODO server for this workspace (start it with `dodo start`)');
  }
  try {
    const store = new Store(db);
    const secret = store.readInstallSecret();
    if (!secret) {
      throw new IpcError('no running DODO server for this workspace (start it with `dodo start`)');
    }
    const wsId = mintWorkspaceId(secret, rootInfo.root);
    return { ipcPath: ipcSocketPath(dir, wsId), root: rootInfo.root };
  } finally {
    db.close();
  }
}

async function ipcForCwd(cmd: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const { ipcPath } = workspaceIpcPath();
  return ipcCall(ipcPath, cmd, args);
}

/** OAuth identity belongs to the installation, not the shell's CWD. */
async function ipcForInstallation(cmd: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const { dir } = resolveConfigDir(process.env);
  return installationIpcCall(dir, cmd, args);
}

function printJsonOrLines(json: boolean, data: unknown, lines: () => string[]): void {
  if (json) console.log(JSON.stringify(data, null, 2));
  else for (const l of lines()) console.log(l);
}

function withProjectRegistry<T>(fn: (registry: ProjectRegistry, store: Store) => T): T {
  const { dir } = resolveConfigDir(process.env);
  ensureConfigDir(dir);
  const db = openDatabase(statePaths(dir).dbFile);
  try {
    const store = new Store(db);
    return fn(new ProjectRegistry(store), store);
  } finally {
    db.close();
  }
}

function projectLines(project: RegisteredProject): string[] {
  return [
    `${project.displayName}  ${project.projectId}`,
    `  Path: ${project.root}`,
    `  Workspace: ${project.workspaceId}`,
    `  Status: ${project.availability} — ${project.statusText}`,
    `  Updated: ${new Date(project.updatedAt).toISOString()}`,
    ...(project.removedAt === null ? [] : [`  Removed: ${new Date(project.removedAt).toISOString()}`]),
  ];
}

function startupProject(): RegisteredProject | undefined {
  try {
    return withProjectRegistry((registry) => {
      const configFile = statePaths(resolveConfigDir(process.env).dir).configFile;
      const projectId = loadGlobalConfig(configFile).startupProjectId;
      return projectId ? registry.get(projectId) : undefined;
    });
  } catch {
    return undefined;
  }
}

function selectStartupProject(projectId: string): RegisteredProject {
  return withProjectRegistry((registry) => {
    const project = registry.get(projectId);
    if (!project.available) throw new DodoError('CONFLICT', project.statusText);
    const configFile = statePaths(resolveConfigDir(process.env).dir).configFile;
    const config = loadGlobalConfig(configFile);
    saveGlobalConfig(configFile, GlobalConfigSchema.parse({ ...config, startupProjectId: project.projectId }));
    return project;
  });
}

function addAndSelectProject(projectPath: string, displayName?: string): RegisteredProject {
  return withProjectRegistry((registry) => {
    const project = registry.add(projectPath, displayName).project;
    const configFile = statePaths(resolveConfigDir(process.env).dir).configFile;
    const config = loadGlobalConfig(configFile);
    saveGlobalConfig(configFile, GlobalConfigSchema.parse({ ...config, startupProjectId: project.projectId }));
    return project;
  });
}

interface HttpLaunchOptions {
  root?: string;
  port?: number;
  allowUnsafeRoot?: boolean;
  quiet?: boolean;
  allow?: boolean;
  all?: boolean;
  bypass?: boolean;
  tools?: string;
  /** Open a one-hour Remote Config lease on the public MCP listener. */
  web?: boolean;
}

async function launchHttp(opts: HttpLaunchOptions): Promise<void> {
  if (Boolean(opts.allow) !== Boolean(opts.all)) fail('use --allow and --all together');
  if (opts.tools !== undefined && !['compact', 'full', 'hybrid'].includes(opts.tools)) fail('--tools must be compact, full or hybrid');

  let root = opts.root;
  if (root !== undefined && !opts.allowUnsafeRoot) root = addAndSelectProject(root).root;
  if (root === undefined) {
    const remembered = startupProject();
    if (remembered?.available) root = remembered.root;
  }

  const configDir = resolveConfigDir(process.env).dir;
  const configFile = statePaths(configDir).configFile;
  const config = loadGlobalConfig(configFile);
  const connectionMode = config.tunnel.connectionMode;
  const publicUrl = config.publicUrl;
  const selectedPort = opts.port ?? config.port;
  if (connectionMode === 'tunnel') {
    if (!publicUrl) fail('Tunnel mode requires a public HTTPS origin; run dodo tunnel configure --tunnel --os-credential --public-url https://your-host');
    validatePublicUrl(publicUrl, false);
    if (!config.tunnel.credentialRef) fail('Tunnel mode requires a saved credential; run dodo tunnel configure --tunnel --os-credential --public-url https://your-host');
  } else {
    if (opts.web) fail('Remote Config requires Tunnel mode; configure Tunnel, restart DODO, then run dodo --web');
    if (selectedPort === 0) fail('local connection mode requires a concrete MCP port');
  }
  const endpointOrigin = connectionMode === 'tunnel' ? publicUrl! : `http://127.0.0.1:${selectedPort}`;
  const startOpts: Parameters<typeof startServer>[0] = {
    configPort: config.configPort,
    ...(opts.bypass ? { runMode: 'bypass' as const } : opts.allow ? { runMode: 'allow-all' as const } : {}),
    invokedCwd,
    ...(root === undefined ? { deferWorkspace: true } : { rootOverride: root }),
    allowUnsafeRoot: opts.allowUnsafeRoot ?? false,
    quiet: opts.quiet ?? false,
    onLog: (line) => console.log(formatTerminalLine(line)),
    connectionMode,
    publicUrlOverride: endpointOrigin,
  };
  if (opts.port !== undefined && !Number.isNaN(opts.port)) startOpts.portOverride = opts.port;
  if (opts.tools !== undefined) startOpts.toolSurface = opts.tools as 'compact' | 'full' | 'hybrid';
  const tunnelRuntime = new TunnelRuntime(configDir, line => console.log(`[dodo:tunnel] ${line}`));
  let shutdownPromise: Promise<void> | undefined;
  let suppressOnStopped = false;
  const server = await startServer({
    ...startOpts,
    tunnelRuntime,
    onStopped: () => {
      if (!shutdownPromise && !suppressOnStopped) void stop('server stop');
    },
  });

  if (connectionMode === 'tunnel') {
    try {
      const selectedConfig = GlobalConfigSchema.parse({
        ...config,
        ...(publicUrl ? { publicUrl } : {}),
        tunnel: { ...config.tunnel, connectionMode: 'tunnel' },
      });
      const status = await tunnelRuntime.start(selectedConfig);
      console.log(`[dodo] DODO Tunnel started: ${status.publicOrigin}/mcp`);
      if (opts.web) printRemoteConfig(await ipcForInstallation('remoteConfig.open') as RemoteConfigCliResult);
    } catch (error) {
      suppressOnStopped = true;
      await server.close();
      throw error;
    }
  } else if (!opts.quiet) {
    console.log(`[dodo] Local connection selected: ${endpointOrigin}/mcp`);
  }

  async function stop(signal: string): Promise<void> {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
    console.log(`\n[dodo] ${signal} received — shutting down (finishing journal safe point, closing jobs)…`);
    await Promise.allSettled([server.close(), tunnelRuntime.close()]);
    process.exit(0);
    })();
    return shutdownPromise;
  }
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));
}

async function setupFromMenu(check: boolean): Promise<void> {
  const { runSetup, parseComponents } = await import('../setup/setup.js');
  const configResolution = resolveConfigDir(process.env);
  const report = await runSetup({
    cwd: invokedCwd,
    configDir: configResolution.dir,
    check,
    yes: !check,
    components: parseComponents('all'),
    detectExistingState: configResolution.source === 'platform',
  }, line => console.log(line));
  console.log(`DODO setup: ${report.platform}/${report.arch} (${report.mode})`);
  for (const item of report.components) console.log(`[${item.state}] ${item.component}: ${item.detail}${item.action ? ` — ${item.action}` : ''}`);
  console.log(report.complete ? 'ทุก component พร้อมใช้งาน' : 'บาง component ยังต้องติดตั้ง อนุญาต หรือเตรียม backend เพิ่ม');
}

// Local-owner dependency setup. Never exposed as an MCP permission-changing tool.
program.command('setup')
  .description('check and install missing local dependencies for this OS; existing security permissions remain in force')
  .option('--check', 'read-only readiness report; no installation or configuration writes', false)
  .option('--plan', 'read-only installation/readiness plan', false)
  .option('--import-state', 'import only reviewed non-authority preferences from detected Dodo state; preserves the source', false)
  .option('--yes', 'acknowledge reviewed package installations; never bypasses OS elevation or desktop consent', false)
  .option('--components <list>', 'all, or comma-separated component names', 'all')
  .option('--enable-web', 'explicitly permit SSRF-guarded outbound web access in owner config', false)
  .option('--json', 'machine-readable report; progress goes to stderr', false)
  .action(async (opts: { check: boolean; plan: boolean; importState: boolean; yes: boolean; components: string; enableWeb: boolean; json: boolean }) => {
    const { runSetup, parseComponents } = await import('../setup/setup.js');
    try {
      const configResolution = resolveConfigDir(process.env);
      const report = await runSetup({ cwd: invokedCwd, configDir: configResolution.dir, check: opts.check, plan: opts.plan, yes: opts.yes, enableWeb: opts.enableWeb, components: parseComponents(opts.components), detectExistingState: configResolution.source === 'platform', importState: opts.importState }, line => opts.json ? console.error(line) : console.log(line));
      if (opts.json) console.log(JSON.stringify(report, null, 2));
      else {
        console.log(`DODO setup: ${report.platform}/${report.arch} (${report.mode})`);
        for (const item of report.components) console.log(`[${item.state}] ${item.component}: ${item.detail}${item.action ? ` — ${item.action}` : ''}`);
        if (report.stateImport?.result) {
          console.log(`Imported reviewed Dodo preferences: ${report.stateImport.result.importedConfigFields.join(', ') || 'none'} (source preserved)\nSecurity state reset: ${report.stateImport.result.resetSecurity.join('; ')}\nReceipt: ${report.stateImport.result.receipt}`);
        } else if (report.stateImport?.plan.state === 'available') {
          console.log(`Existing Dodo config detected at ${report.stateImport.plan.sourceDir}. Importable preferences: ${report.stateImport.plan.importedConfigFields.join(', ') || 'none'}. OAuth, ACL, trust and permission state will not be copied. Re-run with --import-state to continue.`);
        } else if (report.stateImport?.plan.state === 'blocked') {
          console.log(`Dodo state import requires local review: ${report.stateImport.plan.reason}`);
        }
        console.log(report.complete ? 'All selected components passed their readiness checks.' : 'Not all selected components are ready. Missing permissions/backends are not installation successes.');
        if (report.receipt) console.log(`Receipt: ${report.receipt}\nRestart existing DODO processes to load installed paths/LSP/config. OAuth grants and workspace access were not reset.`);
      }
      process.exitCode = report.exitCode;
    } catch (error) {
      if (opts.json) console.log(JSON.stringify({ error: error instanceof DodoError ? error.code : 'SETUP_FAILED', message: (error as Error).message }));
      else console.error(`dodo setup: ${(error as Error).message}`);
      process.exitCode = 1;
    }
  });

// --------------------------------------------------------------- project --
// Installation-level owner registry. It exposes no MCP tool and grants no
// trust/client access; those remain keyed by the referenced workspace ID.
const project = program.command('project').description('manage the local owner-only project registry');

project.command('add <path>')
  .description('register an absolute project directory without changing trust or client access')
  .option('--name <display-name>', 'local display name (defaults to the directory name)')
  .option('--json', 'machine-readable result', false)
  .action((projectPath: string, opts: { name?: string; json: boolean }) => {
    try {
      const result = withProjectRegistry((registry) => registry.add(projectPath, opts.name));
      printJsonOrLines(opts.json, result, () => [
        result.relocated ? 'Updated the location of an existing project identity.' : result.changed ? 'Project registered.' : 'Project was already registered; nothing changed.',
        ...projectLines(result.project),
        'Trust, OAuth grants and workspace client access were not changed.',
      ]);
    } catch (error) {
      if (error instanceof DodoError) fail(`${error.code}: ${error.message}${error.recovery ? `\n  → ${error.recovery}` : ''}`);
      throw error;
    }
  });

project.command('list')
  .description('list registered projects and current path readiness')
  .option('--all', 'include reviewed removals', false)
  .option('--json', 'machine-readable output', false)
  .action((opts: { all: boolean; json: boolean }) => {
    try {
      const projects = withProjectRegistry((registry) => registry.list({ includeRemoved: opts.all }));
      printJsonOrLines(opts.json, projects, () => projects.length === 0
        ? ['no projects registered (add one with: dodo project add /absolute/path)']
        : projects.flatMap((entry, index) => [...(index ? [''] : []), ...projectLines(entry)]));
    } catch (error) {
      if (error instanceof DodoError) fail(`${error.code}: ${error.message}`);
      throw error;
    }
  });

project.command('info <projectId>')
  .description('show one project registry entry without displaying credentials')
  .option('--json', 'machine-readable output', false)
  .action((projectId: string, opts: { json: boolean }) => {
    try {
      const entry = withProjectRegistry((registry) => registry.get(projectId, { includeRemoved: true }));
      printJsonOrLines(opts.json, entry, () => projectLines(entry));
    } catch (error) {
      if (error instanceof DodoError) fail(`${error.code}: ${error.message}`);
      throw error;
    }
  });

project.command('remove <projectId>')
  .description('remove one registry entry; never deletes project files, history, trust or ACL state')
  .option('--yes', 'confirm the reviewed registry removal', false)
  .option('--json', 'machine-readable output', false)
  .action((projectId: string, opts: { yes: boolean; json: boolean }) => {
    try {
      const result = withProjectRegistry((registry) => {
        const current = registry.get(projectId);
        if (!opts.yes) {
          throw new DodoError('APPROVAL_REQUIRED', `removing ${current.displayName} (${current.projectId}) requires --yes`, {
            recovery: `review ${current.root}, then run: dodo project remove ${current.projectId} --yes`,
          });
        }
        return registry.remove(projectId);
      });
      printJsonOrLines(opts.json, { removed: true, project: result, filesDeleted: false, authorityDeleted: false }, () => [
        `Removed ${result.displayName} (${result.projectId}) from the project registry.`,
        'Project files, workspace history, trust and client ACL state were preserved.',
      ]);
    } catch (error) {
      if (error instanceof DodoError) fail(`${error.code}: ${error.message}${error.recovery ? `\n  → ${error.recovery}` : ''}`);
      throw error;
    }
  });

// --------------------------------------------------------------- tunnel ----
const tunnel = program.command('tunnel').description('manage or inspect a Cloudflare remotely-managed Tunnel without managing DNS or the Cloudflare account');

tunnel.command('configure')
  .description('select persistent local or DODO-owned Tunnel mode; tokens are never written to config')
  .option('--tunnel', 'select the DODO-owned Tunnel for every dodo start', false)
  .option('--local', 'select local-only MCP for every dodo start', false)
  .option('--managed', 'deprecated alias for --tunnel', false)
  .option('--external', 'deprecated alias for --local', false)
  .option('--public-url <url>', 'public HTTPS origin used by the selected DODO Tunnel')
  .option('--os-credential', 'prompt through the reviewed OS credential provider', false)
  .option('--token-env <name>', 'reference an uppercase environment variable that already contains the token')
  .option('--token-file <absolute-path>', 'reference an owner-private absolute token file')
  .option('--cloudflared <absolute-path>', 'owner-selected cloudflared executable outside any workspace')
  .option('--metrics-port <n>', 'loopback cloudflared readiness port', (v: string) => Number(v))
  .option('--max-restarts <n>', 'bounded supervisor restarts, 0..5', (v: string) => Number(v))
  .option('--remove-credential', 'delete an OS-stored credential and clear the reference (requires --yes)', false)
  .option('--yes', 'confirm credential deletion; does not start cloudflared', false)
  .option('--json', 'machine-readable non-secret result', false)
  .action(async (opts: { tunnel: boolean; local: boolean; managed: boolean; external: boolean; publicUrl?: string; osCredential: boolean; tokenEnv?: string; tokenFile?: string; cloudflared?: string; metricsPort?: number; maxRestarts?: number; removeCredential: boolean; yes: boolean; json: boolean }) => {
    try {
      const chooseTunnel = opts.tunnel || opts.managed;
      const chooseLocal = opts.local || opts.external;
      if (chooseTunnel && chooseLocal) fail('choose --tunnel or --local');
      const methods = [opts.osCredential, opts.tokenEnv !== undefined, opts.tokenFile !== undefined].filter(Boolean).length;
      if (methods > 1) fail('choose only one of --os-credential, --token-env or --token-file');
      if (opts.removeCredential && methods > 0) fail('--remove-credential cannot be combined with a credential source');
      if (opts.removeCredential && !opts.yes) fail('credential deletion requires --yes');
      const { dir } = resolveConfigDir(process.env); ensureConfigDir(dir);
      const paths = statePaths(dir), current = loadGlobalConfig(paths.configFile);
      const connectionMode = chooseTunnel ? 'tunnel' : chooseLocal ? 'local' : methods > 0 ? 'tunnel' : current.tunnel.connectionMode;
      const publicUrl = opts.publicUrl !== undefined
        ? validatePublicUrl(opts.publicUrl, false).origin
        : current.publicUrl;
      if (connectionMode === 'tunnel' && !publicUrl) fail('Tunnel mode requires --public-url https://your-host (or a previously saved public origin)');
      if (connectionMode === 'tunnel' && publicUrl) validatePublicUrl(publicUrl, false);
      if (connectionMode === 'local' && opts.publicUrl !== undefined) fail('--public-url is used only with --tunnel');
      const credentials = await import('../tunnel/credentials.js');
      const { resolveCloudflared } = await import('../tunnel/supervisor.js');
      const previousCredentialRef = current.tunnel.credentialRef;
      let credentialRef = current.tunnel.credentialRef;
      if (opts.removeCredential) credentialRef = undefined;
      const baseTunnelInput: Record<string, unknown> = {
        ...current.tunnel,
        connectionMode,
        ...(credentialRef ? { credentialRef } : {}),
        ...(opts.metricsPort !== undefined ? { metricsPort: opts.metricsPort } : {}),
        ...(opts.maxRestarts !== undefined ? { maxRestarts: opts.maxRestarts } : {}),
        ...(opts.cloudflared !== undefined ? { executable: opts.cloudflared } : {}),
      };
      if (!credentialRef) delete baseTunnelInput['credentialRef'];
      let next = GlobalConfigSchema.parse({ ...current, ...(publicUrl ? { publicUrl } : {}), tunnel: baseTunnelInput });
      if (opts.cloudflared !== undefined) {
        const canonical = resolveCloudflared(next);
        next = GlobalConfigSchema.parse({ ...next, tunnel: { ...next.tunnel, executable: canonical } });
      }
      if (opts.osCredential) {
        const ref = credentials.osTunnelCredentialRef(dir);
        await credentials.storeOsTunnelCredentialInteractive(ref);
        credentialRef = ref;
      } else if (opts.tokenEnv !== undefined) credentialRef = credentials.envTunnelCredentialRef(opts.tokenEnv);
      else if (opts.tokenFile !== undefined) credentialRef = credentials.fileTunnelCredentialRef(opts.tokenFile);
      const withCredential: Record<string, unknown> = { ...next.tunnel, ...(credentialRef ? { credentialRef } : {}) };
      if (!credentialRef) delete withCredential['credentialRef'];
      next = GlobalConfigSchema.parse({ ...next, tunnel: withCredential });
      if (next.tunnel.connectionMode === 'tunnel' && !next.tunnel.credentialRef) fail('Tunnel mode requires --os-credential, --token-env or --token-file');
      saveGlobalConfig(paths.configFile, next);
      if (opts.removeCredential && previousCredentialRef) credentials.deleteOsTunnelCredential(previousCredentialRef);
      const result = { connectionMode: next.tunnel.connectionMode, publicOrigin: next.tunnel.connectionMode === 'tunnel' ? next.publicUrl : null, credential: next.tunnel.credentialRef ? 'configured' : 'not-configured', metricsPort: next.tunnel.metricsPort, maxRestarts: next.tunnel.maxRestarts, cloudflared: next.tunnel.executable ? 'owner-selected' : 'trusted-PATH', started: false };
      if (opts.json) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`Connection mode: ${result.connectionMode}`);
        console.log(`Credential: ${result.credential} (value is not stored in config or displayed)`);
        console.log(`Readiness: 127.0.0.1:${result.metricsPort}   Restarts: ${result.maxRestarts}`);
        console.log(result.connectionMode === 'tunnel' ? 'Saved. Every dodo start now owns this Tunnel and fails closed if it cannot start.' : 'Saved. Every dodo start now uses only the local MCP endpoint.');
      }
    } catch (error) {
      if (error instanceof DodoError) fail(`${error.code}: ${error.message}${error.recovery ? `\n  → ${error.recovery}` : ''}`);
      throw error;
    }
  });

async function runTunnelForeground(restart: boolean, json: boolean): Promise<void> {
  const { dir } = resolveConfigDir(process.env); ensureConfigDir(dir);
  const config = loadGlobalConfig(statePaths(dir).configFile);
  const control = await import('../tunnel/control.js');
  if (restart) {
    try { await control.stopTunnel(dir); } catch (error) { if (!(error instanceof IpcError)) throw error; }
    const deadline = Date.now() + 10_000;
    while ((await control.tunnelStatus(dir, config)).supervisor && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    if ((await control.tunnelStatus(dir, config)).supervisor) throw new DodoError('TIMEOUT', 'existing tunnel supervisor did not stop within 10 seconds');
  }
  const { startManagedTunnel } = await import('../tunnel/supervisor.js');
  const supervisor = await startManagedTunnel({ configDir: dir, config, onLog: line => { if (!json) console.log(`[dodo:tunnel] ${line}`); } });
  if (json) console.log(JSON.stringify({ started: true, status: supervisor.status() }));
  else console.log(`Tunnel supervisor is running in the foreground for ${supervisor.status().publicOrigin}. Press Ctrl-C to stop.`);
  const stop = () => supervisor.stop();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  if (process.platform !== 'win32') process.once('SIGHUP', stop);
  const exitCode = await supervisor.wait();
  process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  if (process.platform !== 'win32') process.removeListener('SIGHUP', stop);
  if (exitCode !== 0) process.exitCode = exitCode;
}

for (const name of ['start', 'restart'] as const) {
  tunnel.command(name)
    .description(name === 'start' ? 'start the configured managed tunnel in the foreground' : 'stop the current managed supervisor and start it again in the foreground')
    .option('--yes', 'confirm starting a process that connects this machine to the configured Cloudflare Tunnel', false)
    .option('--json', 'machine-readable startup/status line; diagnostics remain private', false)
    .action(async (opts: { yes: boolean; json: boolean }) => {
      if (!opts.yes) fail(`dodo tunnel ${name} requires --yes; no process was started`);
      try { await runTunnelForeground(name === 'restart', opts.json); }
      catch (error) {
        if (error instanceof DodoError || error instanceof IpcError) fail(`${error instanceof DodoError ? `${error.code}: ` : ''}${error.message}`);
        throw error;
      }
    });
}

tunnel.command('stop').description('ask the authenticated local managed supervisor to stop its owned cloudflared process')
  .option('--json', 'machine-readable result', false)
  .action(async (opts: { json: boolean }) => {
    try {
      const { stopTunnel } = await import('../tunnel/control.js');
      const result = await stopTunnel(resolveConfigDir(process.env).dir);
      if (opts.json) console.log(JSON.stringify(result)); else console.log('Stop requested. DODO will not signal any saved PID or unrelated process.');
    } catch (error) { if (error instanceof IpcError) fail('no authenticated managed tunnel supervisor is running', 2); throw error; }
  });

tunnel.command('status').description('show configured mode and authenticated supervisor evidence without reading the credential')
  .option('--json', 'machine-readable report', false)
  .action(async (opts: { json: boolean }) => {
    const { dir } = resolveConfigDir(process.env), config = loadGlobalConfig(statePaths(dir).configFile);
    const { tunnelStatus } = await import('../tunnel/control.js');
    const report = await tunnelStatus(dir, config);
    if (opts.json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`Configured mode: ${report.configuredMode}`);
      if (report.supervisor) console.log(`Supervisor: ${report.supervisor.phase}; connected=${report.supervisor.connected}; restarts=${report.supervisor.restarts}/${report.supervisor.maxRestarts}`);
      else console.log(`Supervisor: not running${report.lastKnown ? `; last phase=${report.lastKnown.phase} at ${report.lastKnown.updatedAt}` : ''}`);
    }
  });

tunnel.command('doctor').description('explicitly probe cloudflared, credential availability, local MCP health and configured public health')
  .option('--json', 'machine-readable non-secret report', false)
  .action(async (opts: { json: boolean }) => {
    const { dir } = resolveConfigDir(process.env), config = loadGlobalConfig(statePaths(dir).configFile);
    const { tunnelDoctor } = await import('../tunnel/control.js');
    const report = await tunnelDoctor(dir, config);
    console.log(opts.json ? JSON.stringify(report, null, 2) : JSON.stringify(report, null, 2));
  });

tunnel.command('logs').description('show bounded redacted managed-tunnel diagnostics')
  .option('--lines <n>', 'last 1..500 lines', (v: string) => Number(v), 200)
  .option('--json', 'machine-readable result', false)
  .action(async (opts: { lines: number; json: boolean }) => {
    if (!Number.isSafeInteger(opts.lines) || opts.lines < 1 || opts.lines > 500) fail('--lines must be an integer from 1 to 500');
    const { tunnelLogs } = await import('../tunnel/control.js');
    const result = await tunnelLogs(resolveConfigDir(process.env).dir, opts.lines);
    if (opts.json) console.log(JSON.stringify(result, null, 2)); else for (const line of result.lines) console.log(line);
  });

// --------------------------------------------------------------- menu -----
program.command('cli')
  .description('open the interactive local owner menu')
  .action(async () => {
    try {
      await runCliMenu({
        listProjects: () => withProjectRegistry((registry) => registry.list()),
        startupProject,
        selectProject: selectStartupProject,
        addProject: addAndSelectProject,
        start: async (root) => launchHttp({ ...(root === undefined ? {} : { root }) }),
        openRemoteConfig: openRemoteConfigFromCli,
        setupAll: () => setupFromMenu(false),
        checkSetup: () => setupFromMenu(true),
      }, { input: process.stdin, output: process.stdout });
    } catch (error) {
      if (error instanceof DodoError) fail(`${error.code}: ${error.message}${error.recovery ? `\n  → ${error.recovery}` : ''}`);
      throw error;
    }
  });

// ---------------------------------------------------------------- start ----
type RemoteConfigCliResult = { url: string; pairingCode: string; expiresAt: number };

function printRemoteConfig(result: RemoteConfigCliResult): void {
  console.log(`Remote Config: ${result.url}`);
  console.log(`Pairing code (shown once): ${result.pairingCode}`);
  console.log(`Expires: ${new Date(result.expiresAt).toISOString()} (ไม่เกิน 1 ชั่วโมง)`);
  console.log('เปิด URL แล้วกรอก code นี้ ระบบจะแลกเป็น Secure/HttpOnly cookie; ไม่มี secret อยู่ใน URL');
}

async function openRemoteConfigFromCli(): Promise<void> {
  try {
    printRemoteConfig(await ipcForInstallation('remoteConfig.open') as RemoteConfigCliResult);
  } catch (error) {
    if (!(error instanceof IpcError) || !error.message.includes('no running DODO installation')) throw error;
    await launchHttp({ web: true });
  }
}

const web = program.command('web')
  .description('open or renew the one-hour Remote Config page through the public MCP tunnel')
  .option('--close', 'close the Remote Config lease without stopping MCP or Tunnel', false)
  .option('--status', 'show the current non-secret Remote Config lease status', false)
  .action(async (opts: { close: boolean; status: boolean }) => {
    if (opts.close && opts.status) fail('choose --close or --status');
    try {
      if (opts.close) {
        console.log(JSON.stringify(await ipcForInstallation('remoteConfig.close'), null, 2));
        return;
      }
      if (opts.status) {
        console.log(JSON.stringify(await ipcForInstallation('remoteConfig.status'), null, 2));
        return;
      }
      await openRemoteConfigFromCli();
    } catch (error) {
      if (error instanceof DodoError || error instanceof IpcError) fail(error.message);
      throw error;
    }
  });
void web;

program
  .command('start')
  .description('start the MCP server for the saved project, or wait for a project selection (foreground)')
  .option('--root <path>', 'select and remember an explicit workspace root (local CLI only)')
  .option('--port <n>', 'listen port (default from config, initially 21730)', (v) => Number.parseInt(v, 10))
  .option('--allow-unsafe-root', 'permit filesystem root / home / other unusually broad workspace roots', false)
  .option('--allow', 'allow task execution for this run (requires --all)', false)
  .option('--all', 'all local action classes (requires --allow)', false)
  .option('--bypass', 'trusted actions and no default job sandbox for this run; OAuth and file guards remain', false)
  .option('--tools <surface>', 'tool exposure for this run: compact (HTTP default), full, or hybrid (49 tools: gateways + common direct tools); permissions are unchanged')
  .option('--web', 'open Remote Config through the public tunnel for at most one hour', false)
  .option('--quiet', 'suppress the startup banner', false)
  .action(async (opts: { root?: string; port?: number; allowUnsafeRoot: boolean; quiet: boolean; allow: boolean; all: boolean; bypass: boolean; tools?: string; web: boolean }) => {
    try {
      await launchHttp(opts);
    } catch (err) {
      if (err instanceof DodoError) fail(`${err.message}${err.recovery ? `\n  → ${err.recovery}` : ''}`);
      throw err;
    }
  });

const schedule = program.command('schedule').alias('cron').description('immutable scheduled commands; separate local approval required');
schedule.command('create').requiredOption('--name <name>', 'human-readable task name')
  .requiredOption('--command <command>', 'exact shell command, max 64 KiB')
  .requiredOption('--cron <expression>', 'five-field cron (minute hour day month weekday)')
  .option('--timezone <zone>', 'IANA time zone', 'UTC')
  .requiredOption('--expires <ISO>', 'consent expiry, ISO date-time within 30 days')
  .option('--cwd <path>', 'workspace-relative working directory', '.')
  .option('--timeout <ms>', 'maximum runtime in milliseconds', '300000')
  .option('--no-sandbox', 'explicitly run with OS user privileges without an OS sandbox')
  .option('--network', 'allow network in the requested sandbox', false)
  .action(async (o:{name:string;command:string;cron:string;timezone:string;expires:string;cwd:string;timeout:string;sandbox:boolean;network:boolean}) => {
    console.log(JSON.stringify(await ipcForCwd('schedule.propose',{name:o.name,command:o.command,cron:o.cron,timezone:o.timezone,expiresAt:Date.parse(o.expires),cwd:o.cwd,timeoutMs:Number(o.timeout),sandbox:o.sandbox,network:o.network}),null,2));
    console.log('PENDING: inspect with dodo schedule show ID, then approve the exact digest. Runs current project code; not pinned to a revision.');
  });
schedule.command('list').action(async () => console.log(JSON.stringify(await ipcForCwd('schedule.list'),null,2)));
schedule.command('show <id>').action(async (id:string) => console.log(JSON.stringify(await ipcForCwd('schedule.show',{id}),null,2)));
schedule.command('approve <id>').requiredOption('--digest <sha256>', 'exact digest from the reviewed schedule')
  .action(async (id:string,o:{digest:string}) => console.log(JSON.stringify(await ipcForCwd('schedule.approve',{id,digest:o.digest}),null,2)));
schedule.command('revoke <id>').action(async (id:string) => console.log(JSON.stringify(await ipcForCwd('schedule.revoke',{id}),null,2)));
schedule.command('history <id>').action(async (id:string) => console.log(JSON.stringify(await ipcForCwd('schedule.history',{id}),null,2)));

// --------------------------------------------------------------- memory --
const memory = program.command('memory').description('review evidence-backed project memory and reusable-learning proposals over private owner IPC');
memory.command('pending')
  .description('list pending memory proposals for this active workspace')
  .action(async () => console.log(JSON.stringify(await ipcForCwd('memory.pending'), null, 2)));
memory.command('show <id>')
  .description('inspect one exact memory proposal or approved memory, including its review digest')
  .action(async (id: string) => console.log(JSON.stringify(await ipcForCwd('memory.show', { id }), null, 2)));
memory.command('list')
  .description('list owner-approved memory visible to this active workspace')
  .option('--include-stale', 'include stale/expired/source-changed records', false)
  .action(async (opts: { includeStale: boolean }) => console.log(JSON.stringify(await ipcForCwd('memory.list', { includeStale: opts.includeStale }), null, 2)));
memory.command('approve <id>')
  .description('approve the exact reviewed proposal; never changes source files, permissions or executable policy')
  .requiredOption('--digest <sha256>', 'exact digest shown by dodo memory show')
  .option('--share-with <projectIds...>', 'owner-authorized registered project IDs that may read this memory', [])
  .option('--allow-conflict', 'explicitly retain this proposal alongside listed conflicting current memories', false)
  .action(async (id: string, opts: { digest: string; shareWith: string[]; allowConflict: boolean }) => {
    console.log(JSON.stringify(await ipcForCwd('memory.approve', { id, digest: opts.digest, shareWith: opts.shareWith, allowConflict: opts.allowConflict }), null, 2));
  });
memory.command('reject <id>')
  .description('reject a pending memory proposal')
  .option('--note <text>', 'short non-secret owner review note', '')
  .action(async (id: string, opts: { note: string }) => console.log(JSON.stringify(await ipcForCwd('memory.reject', { id, note: opts.note }), null, 2)));
memory.command('reverify <id>')
  .description('restore a stale memory only when every original evidence hash matches again')
  .requiredOption('--digest <sha256>', 'exact memory contentHash from dodo memory show')
  .action(async (id: string, opts: { digest: string }) => console.log(JSON.stringify(await ipcForCwd('memory.reverify', { id, digest: opts.digest }), null, 2)));
memory.command('prune')
  .description('delete old rejected/expired proposals and stale memories; CURRENT memory is never pruned')
  .requiredOption('--older-than <days>', 'minimum age in days', (value) => Number.parseInt(value, 10))
  .option('--yes', 'confirm reviewed deletion', false)
  .action(async (opts: { olderThan: number; yes: boolean }) => {
    if (!opts.yes) fail('memory prune requires --yes after reviewing dodo memory list --include-stale');
    console.log(JSON.stringify(await ipcForCwd('memory.prune', { olderThanDays: opts.olderThan }), null, 2));
  });

const memoryLearning = memory.command('learning').description('review workflow/skill suggestions; approval never installs or executes them');
memoryLearning.command('pending').action(async () => console.log(JSON.stringify(await ipcForCwd('memory.learning.pending'), null, 2)));
memoryLearning.command('show <id>').action(async (id: string) => console.log(JSON.stringify(await ipcForCwd('memory.learning.show', { id }), null, 2)));
memoryLearning.command('approve <id>')
  .requiredOption('--digest <sha256>', 'exact digest shown by dodo memory learning show')
  .option('--note <text>', 'short non-secret owner review note', '')
  .action(async (id: string, opts: { digest: string; note: string }) => console.log(JSON.stringify(await ipcForCwd('memory.learning.review', { id, digest: opts.digest, note: opts.note, approved: true }), null, 2)));
memoryLearning.command('reject <id>')
  .requiredOption('--digest <sha256>', 'exact digest shown by dodo memory learning show')
  .option('--note <text>', 'short non-secret owner review note', '')
  .action(async (id: string, opts: { digest: string; note: string }) => console.log(JSON.stringify(await ipcForCwd('memory.learning.review', { id, digest: opts.digest, note: opts.note, approved: false }), null, 2)));

// ----------------------------------------------------- advanced agent --
const agent = program.command('agent').description('owner review for reusable Advanced Agent Runtime skills');
const agentSkill = agent.command('skill').description('review versioned skill guidance over private owner IPC');
agentSkill.command('pending')
  .description('list pending skill proposals for this active workspace')
  .action(async () => console.log(JSON.stringify(await ipcForCwd('agent.skill.pending'), null, 2)));
agentSkill.command('show <id>')
  .description('inspect one exact proposal/skill and its digest')
  .action(async (id: string) => console.log(JSON.stringify(await ipcForCwd('agent.skill.show', { id }), null, 2)));
agentSkill.command('approve <id>')
  .description('approve reviewed guidance as the next immutable skill version; never installs or executes it')
  .requiredOption('--digest <sha256>', 'exact digest shown by dodo agent skill show')
  .option('--note <text>', 'short non-secret owner review note', '')
  .action(async (id: string, opts: { digest: string; note: string }) => console.log(JSON.stringify(await ipcForCwd('agent.skill.review', { id, digest: opts.digest, note: opts.note, approved: true }), null, 2)));
agentSkill.command('reject <id>')
  .description('reject a pending untrusted skill proposal')
  .requiredOption('--digest <sha256>', 'exact digest shown by dodo agent skill show')
  .option('--note <text>', 'short non-secret owner review note', '')
  .action(async (id: string, opts: { digest: string; note: string }) => console.log(JSON.stringify(await ipcForCwd('agent.skill.review', { id, digest: opts.digest, note: opts.note, approved: false }), null, 2)));

// ----------------------------------------------------------------- init ----
program
  .command('init')
  .description('set the global public URL profile (does not modify the repository)')
  .requiredOption('--public-url <url>', 'public HTTPS origin of your tunnel, e.g. https://dodo.example.com')
  .option('--port <n>', 'default listen port', (v) => Number.parseInt(v, 10))
  .option('--dangerously-allow-insecure-http', 'allow an http:// public URL (LOCAL TESTS ONLY)', false)
  .action((opts: { publicUrl: string; port?: number; dangerouslyAllowInsecureHttp: boolean }) => {
    try {
      const { dir } = resolveConfigDir(process.env);
      ensureConfigDir(dir);
      const paths = statePaths(dir);
      const config = loadGlobalConfig(paths.configFile);
      const next = { ...config, dangerouslyAllowInsecurePublicUrl: opts.dangerouslyAllowInsecureHttp || config.dangerouslyAllowInsecurePublicUrl };
      const url = validatePublicUrl(opts.publicUrl, next.dangerouslyAllowInsecurePublicUrl);
      next.publicUrl = url.origin;
      if (opts.port !== undefined && !Number.isNaN(opts.port)) next.port = opts.port;
      saveGlobalConfig(paths.configFile, GlobalConfigSchema.parse(next));
      console.log(`Saved global config: ${paths.configFile}`);
      console.log(`Public URL: ${url.origin}   Port: ${next.port}`);
      console.log('');
      console.log('Next steps:');
      console.log(`  1. Point your own tunnel at 127.0.0.1:${next.port} for host ${url.hostname} (see docs/TUNNEL.md — route ALL paths, not just /mcp)`);
      console.log(`  2. Select it persistently: dodo tunnel configure --tunnel --public-url ${url.origin} --os-credential`);
      console.log('  3. Register your client callback: dodo auth add-client --redirect-uri <exact callback URL from your client UI>');
      console.log('  4. dodo start');
    } catch (err) {
      if (err instanceof DodoError) fail(err.message);
      throw err;
    }
  });

// ---------------------------------------------------------------- limits ---
program.command('limits')
  .description('show input budgets or save a local profile (keeps OAuth, trust and output limits)')
  .option('--profile <name>', 'save standard or large input budgets; restart DODO to apply')
  .option('--json', 'machine-readable output', false)
  .action((opts: { profile?: string; json: boolean }) => {
    if (opts.profile !== undefined && opts.profile !== 'standard' && opts.profile !== 'large') fail('profile must be standard or large (unlimited is not supported)');
    const { dir } = resolveConfigDir(process.env);
    const { configFile } = statePaths(dir);
    const config = loadGlobalConfig(configFile);
    if (opts.profile !== undefined) {
      ensureConfigDir(dir);
      config.limits = { ...config.limits, ...INPUT_LIMIT_PROFILES[opts.profile] };
      saveGlobalConfig(configFile, config);
    }
    const result = { configFile, limits: config.limits, restartRequired: opts.profile !== undefined };
    printJsonOrLines(opts.json, result, () => [
      `DODO input limits: ${configFile}`,
      `  Shell command: ${config.limits.commandBytes} UTF-8 bytes`,
      `  Text file:     ${config.limits.readFileBytes} UTF-8 bytes`,
      `  Change plan:   ${config.limits.previewAggregateBytes} bytes of resulting content`,
      `  MCP request:   ${config.limits.requestBodyBytes} bytes including JSON framing/escaping`,
      '  Native argv:   65536 bytes per argument; 131072 bytes combined',
      ...(opts.profile !== undefined ? ['Saved. Restart DODO to apply. OAuth, trust, sandbox and output caps were preserved.'] : ['For larger inputs: dodo limits --profile large (then restart DODO)']),
    ]);
  });

// ---------------------------------------------------------------- doctor ---
program
  .command('doctor')
  .description('check the local environment (prints no secrets)')
  .option('--json', 'machine-readable output', false)
  .action(async (opts: { json: boolean }) => {
    const checks: Array<{ name: string; ok: boolean; note: string }> = [];
    const [nodeMajor = 0, nodeMinor = 0] = process.versions.node.split('.').map(Number);
    const nodeOk = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 12);
    checks.push({ name: 'node', ok: nodeOk, note: `v${process.versions.node} (need >=22.12)` });
    const { dir } = resolveConfigDir(process.env);
    let cfgOk = true;
    let cfgNote = dir;
    try {
      ensureConfigDir(dir);
      const { activateManagedTools } = await import('../setup/managedTools.js');
      activateManagedTools(dir, invokedCwd);
      const st = fs.statSync(dir);
      if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) {
        cfgOk = false;
        cfgNote = `${dir} has group/other permissions (expected 0700)`;
      }
    } catch (err) {
      cfgOk = false;
      cfgNote = (err as Error).message;
    }
    checks.push({ name: 'config-dir', ok: cfgOk, note: cfgNote });
    try {
      const paths = statePaths(dir);
      const db = openDatabase(paths.dbFile);
      try {
        checks.push({ name: 'state-db', ok: true, note: 'opens and migrates' });
        const projects = new ProjectRegistry(new Store(db)).list();
        const invalid = projects.filter((entry) => entry.availability === 'invalid').length;
        const unavailable = projects.filter((entry) => !entry.available && entry.availability !== 'invalid').length;
        checks.push({ name: 'projects', ok: invalid === 0, note: `${projects.length} registered; ${projects.length - invalid - unavailable} ready; ${unavailable} unavailable; ${invalid} invalid` });
      } finally { db.close(); }
    } catch (err) {
      checks.push({ name: 'state-db', ok: false, note: (err as Error).message });
      checks.push({ name: 'projects', ok: false, note: 'registry unavailable because state database did not open' });
    }
    try {
      const config = loadGlobalConfig(statePaths(dir).configFile);
      checks.push({ name: 'public-url', ok: config.publicUrl !== undefined, note: config.publicUrl ?? 'not configured (server will start LOCKED)' });
    } catch (err) {
      checks.push({ name: 'public-url', ok: false, note: (err as Error).message });
    }
    const { spawnSync } = await import('node:child_process');
    const { resolveTrustedExecutable } = await import('../platform/execResolve.js');
    const { buildChildEnv } = await import('../security/env.js');
    const { shellSpec } = await import('../platform/shell.js');
    const env = buildChildEnv({ parentEnv: process.env, workspaceRoot: invokedCwd, extraAllowlist: [] });
    for (const [bin, name] of [['git', 'git'], ['rg', 'ripgrep']] as const) {
      try {
        const executable = resolveTrustedExecutable(bin, invokedCwd, { allowBatch: false });
        const probe = spawnSync(executable, ['--version'], { cwd: invokedCwd, env, shell: false, windowsHide: true, timeout: 3000 });
        checks.push({ name, ok: bin === 'rg' || probe.status === 0, note: probe.status === 0 ? String(probe.stdout).split('\n')[0]!.trim() : 'probe failed; no capability claimed' });
      } catch { checks.push({ name, ok: bin === 'rg', note: bin === 'rg' ? 'not found; bounded JavaScript search is available' : 'not found on trusted PATH (repository executables are not probed)' }); }
    }
    try {
      const shell = shellSpec(invokedCwd);
      checks.push({ name: 'shell', ok: true, note: `${shell.kind}: ${shell.executable}` });
    } catch (error) { checks.push({ name: 'shell', ok: false, note: (error as Error).message }); }
    checks.push({ name: 'platform', ok: true, note: process.platform === 'win32' ? 'Windows native: authenticated named-pipe IPC and owned-tree cancellation; optional desktop, speech and sandbox backends are checked with dodo setup --check' : `${process.platform}/${process.arch}; authenticated Unix-socket IPC` });
    const sb = sandboxAvailability();
    checks.push({ name: 'sandbox', ok: true, note: sb.available ? `available (${sb.kind})` : `unavailable — ${sb.reason ?? 'unsupported platform'} (sandbox-required commands are refused; no automatic downgrade)` });
    try {
      const cfg = loadGlobalConfig(statePaths(dir).configFile);
      const langs = Object.keys(cfg.lsp);
      checks.push({ name: 'lsp', ok: true, note: langs.length === 0 ? 'none registered (TypeScript/JavaScript built in); dodo lsp add <lang> ...' : `registered: ${langs.join(', ')}` });
      checks.push({ name: 'command-sandbox', ok: true, note: `commandSandbox=${cfg.commandSandbox}; allowWebFetch=${cfg.allowWebFetch}` });
    } catch {
      /* config errors already reported above */
    }
    try {
      const require2 = (await import('node:module')).createRequire(import.meta.url);
      require2('better-sqlite3');
      checks.push({ name: 'sqlite-native', ok: true, note: 'prebuilt binding loads' });
    } catch (err) {
      checks.push({ name: 'sqlite-native', ok: false, note: (err as Error).message });
    }
    printJsonOrLines(opts.json, checks, () => checks.map((c) => `${c.ok ? 'ok  ' : 'FAIL'}  ${c.name.padEnd(14)} ${c.note}`));
    if (checks.some((c) => !c.ok)) process.exitCode = 1;
  });

// ---------------------------------------------------------------- status ---
program
  .command('status')
  .description('show the running server for this directory (via private IPC)')
  .option('--json', 'machine-readable output', false)
  .action(async (opts: { json: boolean }) => {
    try {
      const data = (await ipcForCwd('status')) as StatusData;
      printJsonOrLines(opts.json, data, () => [
        `DODO ${data.version}  pid ${data.pid}`,
        `Workspace: ${data.root}`,
        `Workspace ID: ${data.workspaceId}  epoch: ${data.workspaceEpoch}`,
        `Port: ${data.port}  ${data.locked ? 'LOCKED (no public URL)' : `Public: ${data.publicUrl}`}`,
        `Trust mode: ${data.trustMode}`,
        `Running jobs: ${data.runningJobs}`,
        ...(data.recoveryRequired.length > 0 ? [`RECOVERY REQUIRED: ${data.recoveryRequired.join(', ')} (run: dodo recover)`] : []),
      ]);
    } catch (err) {
      if (err instanceof IpcError) fail(err.message, 2);
      throw err;
    }
  });

// ------------------------------------------------------------------ stop ---
program
  .command('stop')
  .description('gracefully stop the running server for this directory')
  .action(async () => {
    try {
      await ipcForCwd('stop');
      console.log('stopping');
    } catch (err) {
      if (err instanceof IpcError) fail(err.message, 2);
      throw err;
    }
  });

// ------------------------------------------------------------------ kill ---
program
  .command('kill')
  .description('stop all DODO servers and their jobs for this user/config, from any folder; preserve OAuth login')
  .option('--timeout <seconds>', 'shutdown wait per server (1..120 seconds)', Number, 30)
  .option('--json', 'machine-readable shutdown report', false)
  .action(async (opts: { timeout: number; json: boolean }) => {
    if (!Number.isInteger(opts.timeout) || opts.timeout < 1 || opts.timeout > 120) fail('--timeout must be an integer from 1 to 120 seconds');
    const { killServers } = await import('./kill.js');
    const { dir } = resolveConfigDir(process.env);
    if (!opts.json) console.log('Stopping DODO servers and their jobs; keeping OAuth login and configuration…');
    const result = await killServers(dir, opts.timeout * 1000);
    printJsonOrLines(opts.json, result, () => [
      ...result.stopped.map(s => `Stopped DODO ${s.pid} (${s.transport}): ${s.root}`),
      ...result.failed.map(s => `Could not stop ${s.root}: ${s.reason}`),
      ...(result.stopped.length === 0 && result.failed.length === 0 ? ['No running DODO servers found.'] : []),
      `State: ${dir}`,
      'OAuth clients, keys, tokens and saved permissions are kept. Start dodo again with the same public URL to use existing valid login credentials.',
    ]);
    if (result.failed.length) process.exitCode = 1;
  });

// ----------------------------------------------------------------- trust ---
program
  .command('trust')
  .description('set the local trust mode for THIS workspace directory')
  .requiredOption('--mode <mode>', 'inspect | edit | trusted')
  .option('--yes', 'confirm trusted mode non-interactively', false)
  .action((opts: { mode: string; yes: boolean }) => {
    const mode = opts.mode as TrustMode;
    if (!['inspect', 'edit', 'trusted'].includes(mode)) fail('mode must be inspect, edit, or trusted');
    if (mode === 'trusted' && !opts.yes) {
      fail(
        'trusted mode lets the remote AI run commands with YOUR user privileges (no OS sandbox; scripts can read/write outside this folder).\n' +
          'If you understand that, repeat with:  dodo trust --mode trusted --yes',
      );
    }
    try {
      const { dir } = resolveConfigDir(process.env);
      ensureConfigDir(dir);
      const paths = statePaths(dir);
      const rootInfo = resolveWorkspaceRoot(invokedCwd, {});
      const db = openDatabase(paths.dbFile);
      try {
        const store = new Store(db);
        const wsId = mintWorkspaceId(store.installSecret(), rootInfo.root);
        store.upsertWorkspace({ id: wsId, root: rootInfo.root, dev: rootInfo.dev, ino: rootInfo.ino, epoch: 'cli' });
        store.setTrustMode(wsId, mode);
      } finally {
        db.close();
      }
      console.log(`Trust mode for ${rootInfo.root}: ${mode}`);
      console.log(`  ${TRUST_MODE_DESCRIPTIONS[mode]}`);
      console.log('A running server picks this up immediately.');
    } catch (err) {
      if (err instanceof DodoError) fail(err.message);
      throw err;
    }
  });

// --------------------------------------------------------------- approve ---
program
  .command('approve <requestId>')
  .description('approve a pending action request shown by an APPROVAL_REQUIRED error')
  .action(async (requestId: string) => {
    try {
      const res = (await ipcForCwd('approvals.approve', { id: requestId })) as { summary: string };
      console.log(`approved: ${requestId}`);
      console.log(`  ${res.summary}`);
      console.log('The remote client can now retry the SAME call (same arguments).');
    } catch (err) {
      if (err instanceof IpcError) fail(err.message, 2);
      throw err;
    }
  });

program
  .command('deny <requestId>')
  .description('deny a pending action request')
  .action(async (requestId: string) => {
    try {
      await ipcForCwd('approvals.deny', { id: requestId });
      console.log(`denied: ${requestId}`);
    } catch (err) {
      if (err instanceof IpcError) fail(err.message, 2);
      throw err;
    }
  });

program
  .command('pending')
  .description('list pending action approvals for this workspace')
  .option('--json', 'machine-readable output', false)
  .action(async (opts: { json: boolean }) => {
    try {
      const rows = (await ipcForCwd('approvals.pending')) as Array<{ id: string; tool: string; summary: string; expiresAt: number }>;
      printJsonOrLines(opts.json, rows, () =>
        rows.length === 0
          ? ['no pending approvals']
          : rows.map((r) => `${r.id}  [${r.tool}]  ${r.summary}  (expires ${new Date(r.expiresAt).toLocaleTimeString()})`),
      );
    } catch (err) {
      if (err instanceof IpcError) fail(err.message, 2);
      throw err;
    }
  });

// ------------------------------------------------------------------ auth ---
const auth = program.command('auth').description('OAuth client registration, consent and grants');

auth
  .command('add-client')
  .description('register a static OAuth client (copy the EXACT redirect URI from your client UI)')
  .requiredOption('--redirect-uri <uri...>', 'exact redirect/callback URI(s)')
  .option('--name <name>', 'display name', 'dodo remote client')
  .option('--public', 'public client (PKCE only, no secret)', false)
  .option('--json', 'machine-readable output', false)
  .action((opts: { redirectUri: string[]; name: string; public: boolean; json: boolean }) => {
    try {
      const { dir } = resolveConfigDir(process.env);
      ensureConfigDir(dir);
      const paths = statePaths(dir);
      const db = openDatabase(paths.dbFile);
      try {
        const store = new Store(db);
        const info = (function register() {
          const req: Parameters<typeof addStaticClientLocal>[1] = { redirectUris: opts.redirectUri, name: opts.name };
          if (opts.public) req.public = true;
          return addStaticClientLocal(store, req);
        })();
        if (opts.json) {
          console.log(JSON.stringify(info, null, 2));
        } else {
          console.log('Registered OAuth client (shown ONCE — store it in your client config now):');
          console.log(`  client_id:     ${info.clientId}`);
          if (info.clientSecret) console.log(`  client_secret: ${info.clientSecret}`);
          console.log(`  redirect URIs: ${info.redirectUris.join(', ')}`);
          console.log(`  auth method:   ${info.tokenEndpointAuthMethod}`);
        }
      } finally {
        db.close();
      }
    } catch (err) {
      if (err instanceof DodoError) fail(err.message);
      throw err;
    }
  });

auth
  .command('clients')
  .description('list registered OAuth clients')
  .option('--json', 'machine-readable output', false)
  .action((opts: { json: boolean }) => {
    const { dir } = resolveConfigDir(process.env);
    ensureConfigDir(dir);
    const db = openDatabase(statePaths(dir).dbFile);
    try {
      const store = new Store(db);
      const rows = listStaticClientsLocal(store);
      printJsonOrLines(opts.json, rows, () =>
        rows.length === 0 ? ['no clients registered'] : rows.map((c) => `${c.clientId}  ${c.name}  → ${c.redirectUris.join(', ')}`),
      );
    } finally {
      db.close();
    }
  });

auth
  .command('pending')
  .description('list pending OAuth authorization requests (verify id + phrase against the browser page)')
  .option('--json', 'machine-readable output', false)
  .action(async (opts: { json: boolean }) => {
    try {
      const rows = (await ipcForInstallation('auth.pending')) as Array<{
        id: string;
        phrase: string;
        clientId: string;
        redirectUri: string;
        scopes: string;
        authorizationTarget: 'installation';
        accessMode: 'personal' | 'managed';
        workspaceRoot: null;
      }>;
      printJsonOrLines(opts.json, rows, () =>
        rows.length === 0
          ? ['no pending authorization requests']
          : rows.flatMap((r) => [
              `id:       ${r.id}`,
              `phrase:   ${r.phrase}   ← must match the browser page`,
              `client:   ${r.clientId}`,
              `callback: ${r.redirectUri}`,
              `scopes:   ${r.scopes}`,
              r.accessMode === 'personal'
                ? 'access:   registered projects, bounded by these OAuth scopes (personal mode)'
                : 'access:   installation login only; assign project scopes later in Local Config (managed mode)',
              `approve:  dodo auth approve -- ${r.id}`,
              '',
            ]),
      );
    } catch (err) {
      if (err instanceof IpcError) fail(err.message, 2);
      throw err;
    }
  });

auth
  .command('approve <id>')
  .description('approve a pending OAuth authorization request')
  .action(async (id: string) => {
    try {
      await ipcForInstallation('auth.approve', { id });
      console.log(`approved: ${id}`);
      console.log('The browser page will now finish the sign-in automatically.');
    } catch (err) {
      if (err instanceof IpcError) fail(err.message, 2);
      throw err;
    }
  });

auth
  .command('deny <id>')
  .description('deny a pending OAuth authorization request')
  .action(async (id: string) => {
    try {
      await ipcForInstallation('auth.deny', { id });
      console.log(`denied: ${id}`);
    } catch (err) {
      if (err instanceof IpcError) fail(err.message, 2);
      throw err;
    }
  });

auth
  .command('list')
  .description('list grants (no tokens are shown)')
  .option('--json', 'machine-readable output', false)
  .action(async (opts: { json: boolean }) => {
    try {
      const rows = (await ipcForInstallation('auth.grants')) as Array<{
        grantId: string;
        clientId: string;
        scopes: string[];
        thisWorkspace: boolean;
        installationIdentity: boolean;
        revokedAt: number | null;
      }>;
      printJsonOrLines(opts.json, rows, () =>
        rows.length === 0
          ? ['no grants']
          : rows.map(
              (g) =>
                `${g.grantId}  client=${g.clientId}  scopes=${g.scopes.join(',')}  ${g.installationIdentity ? '(installation identity)' : g.thisWorkspace ? '(this workspace)' : '(legacy workspace identity)'}${g.revokedAt ? '  REVOKED' : ''}`,
            ),
      );
    } catch (err) {
      if (err instanceof IpcError) fail(err.message, 2);
      throw err;
    }
  });

auth
  .command('revoke <grantId>')
  .description('revoke a grant immediately (access + refresh tokens die with it)')
  .action(async (grantId: string) => {
    try {
      await ipcForInstallation('auth.revoke', { grantId });
      console.log(`revoked: ${grantId}`);
    } catch (err) {
      if (err instanceof IpcError) fail(err.message, 2);
      throw err;
    }
  });

// --------------------------------------------------------------- recover ---
program
  .command('recover')
  .description('list changesets needing manual recovery; resolve with --resolve <id> after fixing files')
  .option('--resolve <changesetId>', 'mark a changeset resolved after manual fixes')
  .option('--json', 'machine-readable output', false)
  .action(async (opts: { resolve?: string; json: boolean }) => {
    try {
      if (opts.resolve !== undefined) {
        await ipcForCwd('recover.resolve', { changesetId: opts.resolve, action: 'mark-resolved' });
        console.log(`marked resolved: ${opts.resolve}`);
        return;
      }
      const rows = (await ipcForCwd('recover.list')) as Array<{ changesetId: string; summary: string | null; error: string | null }>;
      printJsonOrLines(opts.json, rows, () =>
        rows.length === 0
          ? ['nothing needs recovery']
          : rows.flatMap((r) => [`${r.changesetId}  ${r.summary ?? ''}`, `  problem: ${r.error ?? 'unknown'}`, `  backups: <config-dir>/backups/${r.changesetId}/`, '']),
      );
    } catch (err) {
      if (err instanceof IpcError) fail(err.message, 2);
      throw err;
    }
  });

// ----------------------------------------------------------------- stdio ---
program
  .command('stdio')
  .description('serve MCP over stdin/stdout for a LOCAL client (Claude Code, Cursor, Codex CLI, Claude Desktop) — no tunnel or OAuth')
  .option('--root <path>', 'workspace root (defaults to the current directory)')
  .option('--allow-unsafe-root', 'permit filesystem root / home / other unusually broad workspace roots', false)
  .option('--tools <surface>', 'tool exposure for this run: full (STDIO default), compact, or hybrid; permissions are unchanged')
  .action(async (opts: { root?: string; allowUnsafeRoot: boolean; tools?: string }) => {
    try {
      if (opts.tools !== undefined && !['compact', 'full', 'hybrid'].includes(opts.tools)) fail('--tools must be compact, full or hybrid');
      const startOpts: Parameters<typeof startStdioServer>[0] = { invokedCwd, allowUnsafeRoot: opts.allowUnsafeRoot, onStopped: () => process.exit(0) };
      if (opts.root !== undefined) startOpts.rootOverride = opts.root;
      if (opts.tools !== undefined) startOpts.toolSurface = opts.tools as 'compact' | 'full' | 'hybrid';
      const server = await startStdioServer(startOpts);
      const stop = async () => {
        await server.close();
        process.exit(0);
      };
      process.stdin.on('end', () => void stop());
      process.stdin.on('close', () => void stop());
      process.on('SIGINT', () => void stop());
      process.on('SIGTERM', () => void stop());
    } catch (err) {
      if (err instanceof DodoError) fail(`${err.message}${err.recovery ? `\n  → ${err.recovery}` : ''}`);
      throw err;
    }
  });

// ----------------------------------------------------------------- audit ---
program
  .command('audit')
  .description('show what the AI did in this workspace (recent tool calls; no file contents or secrets)')
  .option('--limit <n>', 'number of entries', (v) => Number.parseInt(v, 10), 50)
  .option('--json', 'machine-readable output', false)
  .action((opts: { limit: number; json: boolean }) => {
    const { dir } = resolveConfigDir(process.env);
    const paths = statePaths(dir);
    const db = openDatabaseReadonly(paths.dbFile);
    if (!db) fail('no DODO state yet for this machine (nothing has run)', 2);
    try {
      const store = new Store(db);
      const secret = store.readInstallSecret();
      const rootInfo = resolveWorkspaceRoot(invokedCwd, { allowUnsafe: true });
      const wsId = secret ? mintWorkspaceId(secret, rootInfo.root) : undefined;
      const rows = store.recentAudit(wsId, Number.isNaN(opts.limit) ? 50 : opts.limit);
      printJsonOrLines(opts.json, rows, () =>
        rows.length === 0
          ? ['no audit entries for this workspace']
          : rows.map((r) => `${new Date(r.ts).toISOString()}  ${(r.tool ?? '-').padEnd(18)} ${r.result.padEnd(22)} ${r.durationMs ?? 0}ms  ${r.principal ?? ''}`),
      );
    } finally {
      db.close();
    }
  });

// ------------------------------------------------------------------- lsp ---
const lsp = program.command('lsp').description('owner-installed language servers for symbols/references/rename in non-TS languages');

lsp
  .command('add <language>')
  .description('register a language server, e.g. dodo lsp add python --command pyright-langserver --args --stdio --ext .py --ext .pyi')
  .requiredOption('--command <cmd>', 'server executable (bare name on your PATH, or absolute path outside the workspace)')
  .option('--args <args...>', 'arguments', [])
  .requiredOption('--ext <ext...>', 'file extensions handled, e.g. .py')
  .action((language: string, opts: { command: string; args: string[]; ext: string[] }) => {
    try {
      const { dir } = resolveConfigDir(process.env);
      ensureConfigDir(dir);
      const paths = statePaths(dir);
      const config = loadGlobalConfig(paths.configFile);
      const next = GlobalConfigSchema.parse({ ...config, lsp: { ...config.lsp, [language]: { command: opts.command, args: opts.args, extensions: opts.ext } } });
      saveGlobalConfig(paths.configFile, next);
      console.log(`Registered LSP for ${language}: ${opts.command} ${opts.args.join(' ')}  (${opts.ext.join(', ')})`);
      console.log('The server is started on first use and runs with YOUR user privileges. Restart dodo to pick this up.');
    } catch (err) {
      if (err instanceof DodoError) fail(err.message);
      throw err;
    }
  });

lsp
  .command('list')
  .description('list registered language servers')
  .option('--json', 'machine-readable output', false)
  .action((opts: { json: boolean }) => {
    const { dir } = resolveConfigDir(process.env);
    const config = loadGlobalConfig(statePaths(dir).configFile);
    const rows = Object.entries(config.lsp).map(([language, c]) => ({ language, ...c }));
    printJsonOrLines(opts.json, rows, () => (rows.length === 0 ? ['no language servers registered (TypeScript/JavaScript are built in)'] : rows.map((r) => `${r.language.padEnd(10)} ${r.command} ${r.args.join(' ')}  [${r.extensions.join(', ')}]`)));
  });

lsp
  .command('remove <language>')
  .description('unregister a language server')
  .action((language: string) => {
    const { dir } = resolveConfigDir(process.env);
    const paths = statePaths(dir);
    const config = loadGlobalConfig(paths.configFile);
    const rest = { ...config.lsp };
    delete rest[language];
    saveGlobalConfig(paths.configFile, GlobalConfigSchema.parse({ ...config, lsp: rest }));
    console.log(`removed ${language}`);
  });

// Only local owner commands can save desktop consent. No running server is
// needed for persistent grants or revocation. Persistent native-app consent is
// installation-wide; active services still bind snapshots/receipts to their
// workspace and re-check OAuth, trust and current policy before every call.
function saveInstallationDesktopPolicy(input: unknown) {
  const args = DesktopPolicyInputSchema.parse(input);
  const { dir } = resolveConfigDir(process.env);
  ensureConfigDir(dir);
  const db = openDatabase(statePaths(dir).dbFile);
  try {
    const store = new Store(db);
    // A CWD-independent owner command may be the first command used with a
    // fresh state directory. Initialize the installation identity just as a
    // normal server bootstrap would, without creating a workspace identity.
    store.installSecret();
    return db.transaction(() => saveDesktopPolicy(store, INSTALLATION_AUTHORITY_ID, 'local-cli', args, Date.now()))();
  } finally {
    db.close();
  }
}

const desktop = program.command('desktop').description('native window capture/control setup and local app permission');
desktop.command('apps').description('local owner only: list Windows/Linux executable identities to choose exact app grants')
  .action(async () => {
    if (!['win32', 'linux'].includes(process.platform)) fail('On macOS use application bundle IDs; this command lists Windows/Linux executable identities.');
    const { NativeDesktopBackend } = await import('../services/desktop/nativeBackend.js');
    console.log(JSON.stringify(await new NativeDesktopBackend(resolveConfigDir(process.env).dir).run({ op: 'apps' }), null, 2));
  });
desktop.command('setup')
  .description('prepare the platform helper (macOS Swift, Windows .NET, Linux X11/AT-SPI)')
  .option('--request-permissions', 'request/check platform desktop permission where the OS exposes an owner prompt', false)
  .action(async (opts: { requestPermissions: boolean }) => {
    const { setupNativeDesktop } = await import('../services/desktop/nativeBackend.js');
    const { dir } = resolveConfigDir(process.env); ensureConfigDir(dir);
    const result = await setupNativeDesktop(dir, opts.requestPermissions);
    console.log(JSON.stringify(result, null, 2));
    console.log('OS setup does not change DODO access. To allow a named app once for this installation: dodo desktop allow --app <app-id> --mode control --persist --yes');
    console.log(process.platform === 'win32'
      ? 'Windows: use dodo desktop apps for exact IDs. An unlocked interactive session is required; no UAC/secure desktop bypass.'
      : process.platform === 'linux'
        ? 'Linux: use dodo desktop apps for exact IDs. X11/XWayland with DISPLAY, XTEST/X-Resource and AT-SPI is required; pure Wayland portal-only sessions are not claimed.'
        : 'macOS permissions: System Settings > Privacy & Security > Screen & System Audio Recording / Accessibility. Restart DODO after changing OS permissions if needed.');
  });
desktop.command('status').description('show desktop permission and helper status for this running workspace')
  .action(async () => console.log(JSON.stringify(await ipcForCwd('desktop.status'), null, 2)));
desktop.command('allow')
  .description('permit named apps; --persist remembers consent once for this DODO installation')
  .requiredOption('--app <bundleIds...>', 'exact macOS bundle IDs or win.<hash>/linux.<hash> IDs from dodo desktop apps')
  .option('--mode <mode>', 'view | control', 'view')
  .option('--minutes <n>', 'temporary permission lifetime 1..480 minutes (default 60); excludes --persist', (v: string) => Number(v))
  .option('--persist', 'remember this app grant for the DODO installation until disabled', false)
  .option('--yes', 'acknowledge that screen/UI access can expose data and affect apps outside the workspace', false)
  .action(async (opts: { app: string[]; mode: string; minutes?: number; persist: boolean; yes: boolean }) => {
    if (!['view', 'control'].includes(opts.mode)) fail('desktop mode must be view or control');
    if (!opts.yes) fail('Desktop access can expose private screen/UI data outside this workspace; control can change apps with your OS-user rights. Repeat with --yes to authorize the named apps.');
    if (opts.persist && opts.minutes !== undefined) fail('use --persist or --minutes, not both');
    if (process.platform === 'win32' || process.platform === 'linux') {
      const { NativeDesktopBackend } = await import('../services/desktop/nativeBackend.js');
      const backend = new NativeDesktopBackend(resolveConfigDir(process.env).dir);
      if (!backend.available()) fail('NOT_SUPPORTED: run dodo setup --components desktop locally first; no desktop permission was saved.');
      const pattern = process.platform === 'win32' ? /^win\.[a-f0-9]{40}$/ : /^linux\.[a-f0-9]{40}$/;
      if (opts.app.some(app => !pattern.test(app))) fail('Use exact platform app IDs from dodo desktop apps, not executable basenames.');
    }
    const input = { mode: opts.mode, allowedApps: opts.app, persistent: opts.persist, ...(opts.minutes !== undefined ? { minutes: opts.minutes } : {}) };
    if (opts.persist) {
      const saved = saveInstallationDesktopPolicy(input);
      console.log(JSON.stringify(saved, null, 2));
      console.log('Remembered until disabled for this DODO installation. Every project reuses this native-app consent.');
    } else {
      console.log(JSON.stringify(await ipcForCwd('desktop.policy', input), null, 2));
      console.log('Temporary grant: resets on restart/workspace switch. Use --persist instead of --minutes to remember it.');
    }
    console.log('Revoke and forget: dodo desktop disable (or the private Local Config stop button).');
  });
desktop.command('disable').description('revoke and forget installation-wide desktop consent, even while the server is stopped')
  .action(() => {
    const saved = saveInstallationDesktopPolicy({ mode: 'off' });
    console.log(JSON.stringify(saved, null, 2));
    console.log('Desktop access disabled and forgotten for this DODO installation.');
  });

// Static-client helpers are imported lazily to keep CLI startup light.
import { addStaticClient as addStaticClientLocal, listStaticClients as listStaticClientsLocal } from '../auth/clients.js';

program.addHelpText(
  'after',
  `
Local HTTP + private config:
  dodo                               start the saved project; config on 127.0.0.1:21731
  dodo kill                          stop DODO across folders, keep OAuth login
  dodo limits --profile large        larger command/file budgets; restart to apply
  dodo start --allow --all            trusted tasks for this run
  dodo --bypass                       trusted tasks, default command sandbox off
MCP subprocess clients:
  dodo stdio --root /path/to/project  explicit local STDIO transport
Desktop (platform helper and explicit app permission required):
  dodo desktop setup                 prepare the platform desktop backend
  dodo desktop disable               revoke desktop access
Remote setup:
  dodo init --public-url https://...   configure public origin once
  dodo tunnel configure --tunnel --os-credential --public-url https://...
                                       select the persistent DODO Tunnel
  dodo tunnel configure --local        select local-only MCP
  dodo start                            use exactly the saved connection mode
  dodo --web                           start/renew Remote Config through that tunnel for 1 hour
  dodo web --close                     close Remote Config; keep MCP/Tunnel running`,
);

function effectiveArgv(): string[] {
  if (process.argv.length <= 2) return [...process.argv, 'start'];
  if (process.argv.length === 3 && process.argv[2] === '--cli') return [...process.argv.slice(0, 2), 'cli'];
  if (process.argv.length === 3 && process.argv[2] === '--web') return [...process.argv.slice(0, 2), 'web'];
  if (process.argv[2] === '--bypass') return [...process.argv.slice(0, 2), 'start', ...process.argv.slice(2)];
  return process.argv;
}

program.parseAsync(effectiveArgv()).catch((err: unknown) => {
  fail(err instanceof Error ? err.message : String(err));
});
