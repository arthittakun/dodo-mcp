import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import { z } from 'zod';
import { validatePublicUrl, type GlobalConfig } from '../config/globalConfig.js';
import { ipcSocketPath, statePaths } from '../config/paths.js';
import { DodoError } from '../errors.js';
import { startIpcServer } from '../ipc/server.js';
import { resolveTrustedExecutable } from '../platform/execResolve.js';
import { renameWithRetry } from '../platform/fsRetry.js';
import { ensurePrivateDirectory } from '../platform/privateFs.js';
import { signalOwnedProcess } from '../platform/processTree.js';
import { buildChildEnv } from '../security/env.js';
import { readTunnelCredential } from './credentials.js';
import { TunnelLog } from './log.js';

/**
 * Readiness is debounced on purpose. cloudflared re-registers its edge
 * connections on its own schedule, so `/ready` legitimately returns non-200 for
 * a moment during a reconnect. Reporting that single dip as "disconnected"
 * made the owner-visible status flap. The supervisor therefore probes
 * SEQUENTIALLY (never overlapping), ignores results from a previous child, and
 * only leaves `connected` after a bounded number of consecutive failures.
 */
const READY_PROBE_INTERVAL_MS = 2000;
/** Strictly below the interval so one probe can never outlive its own slot. */
const READY_PROBE_TIMEOUT_MS = 1500;
const READY_FAILURE_THRESHOLD = 3;

export const TunnelStatusSchema = z.object({
  mode: z.literal('managed'),
  running: z.boolean(),
  phase: z.enum(['starting', 'connecting', 'connected', 'degraded', 'disconnected', 'backoff', 'stopping', 'stopped', 'failed']),
  connected: z.boolean(),
  startedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  restarts: z.number().int().min(0).max(5),
  maxRestarts: z.number().int().min(0).max(5),
  metricsUrl: z.string().url().max(2048),
  publicOrigin: z.string().url().max(2048),
  credentialSource: z.literal('configured'),
  lastExitCode: z.number().int().nullable(),
  lastError: z.string().max(500).nullable(),
  // Defaulted so a state.json written by an older DODO still parses.
  lastReadyAt: z.string().datetime().nullable().default(null),
  lastFailureAt: z.string().datetime().nullable().default(null),
  consecutiveReadyFailures: z.number().int().min(0).max(100000).default(0),
}).strict();
export type TunnelPhase = z.infer<typeof TunnelStatusSchema>['phase'];
export type TunnelStatus = z.infer<typeof TunnelStatusSchema>;

export interface RunningTunnelSupervisor {
  status(): TunnelStatus;
  stop(): void;
  wait(): Promise<number>;
}

function securityWorkspaceRoot(): string { return fs.realpathSync.native(process.cwd()); }

export function tunnelIpcPath(configDir: string): string {
  return ipcSocketPath(configDir, 'tunnel-supervisor', { createDirectory: false });
}

export function resolveCloudflared(config: GlobalConfig, exclusionRoot = securityWorkspaceRoot()): string {
  if (config.tunnel.executable) {
    return resolveTrustedExecutable(config.tunnel.executable, exclusionRoot, { allowAbsolute: true, allowBatch: false });
  }
  return resolveTrustedExecutable('cloudflared', exclusionRoot, { allowBatch: false });
}

function writeState(directory: string, state: TunnelStatus): void {
  ensurePrivateDirectory(directory);
  const target = path.join(directory, 'state.json');
  const temporary = path.join(directory, `.state-${randomBytes(12).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    renameWithRetry(temporary, target);
    if (process.platform !== 'win32') fs.chmodSync(target, 0o600);
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* renamed or absent */ }
  }
}

export function probeTunnelReady(port: number, timeoutMs: number = READY_PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false;
    const finish = (value: boolean) => { if (settled) return; settled = true; resolve(value); };
    // `agent: false` forces a fresh socket per probe. Node's keep-alive global
    // agent pools sockets between probes, and a pooled socket the peer already
    // closed surfaces as a connection error — a spurious "not connected".
    const request = http.get({ host: '127.0.0.1', port, path: '/ready', timeout: timeoutMs, agent: false, headers: { Host: `127.0.0.1:${port}` } }, response => {
      response.resume();
      response.once('end', () => finish(response.statusCode === 200));
    });
    request.once('timeout', () => { request.destroy(); finish(false); });
    request.once('error', () => finish(false));
  });
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function assertMetricsPortAvailable(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => reject(new DodoError('CONFLICT', `tunnel metrics port ${port} is already in use`, { recovery: 'choose another owner-only loopback port with dodo tunnel configure --metrics-port <port>' })));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve()));
  });
}

export async function startManagedTunnel(options: {
  configDir: string;
  config: GlobalConfig;
  env?: NodeJS.ProcessEnv;
  retryDelayMs?: number;
  /** Test hooks: production uses the debounced defaults above. */
  readinessIntervalMs?: number;
  readinessFailureThreshold?: number;
  onLog?: (line: string) => void;
}): Promise<RunningTunnelSupervisor> {
  const configDir = path.resolve(options.configDir);
  const config = options.config;
  if (config.tunnel.connectionMode !== 'tunnel') throw new DodoError('CONFLICT', 'DODO is not configured to own the Tunnel process', { recovery: 'run dodo tunnel configure --tunnel first' });
  if (!config.tunnel.credentialRef) throw new DodoError('NOT_FOUND', 'no saved Cloudflare Tunnel credential is available', { recovery: 'run dodo tunnel configure --tunnel --os-credential --public-url https://your-host' });
  if (!config.publicUrl) throw new DodoError('NOT_FOUND', 'public origin is not configured', { recovery: 'run dodo init --public-url https://your-host first' });
  const publicOrigin = validatePublicUrl(config.publicUrl, config.dangerouslyAllowInsecurePublicUrl).origin;
  const executable = resolveCloudflared(config);
  const credential = await readTunnelCredential(config.tunnel.credentialRef, options.env ?? process.env);
  const paths = statePaths(configDir);
  ensurePrivateDirectory(paths.tunnelDir);
  const log = new TunnelLog(paths.tunnelDir, credential);
  const metricsUrl = `http://127.0.0.1:${config.tunnel.metricsPort}/ready`;
  let status: TunnelStatus = {
    mode: 'managed', running: true, phase: 'starting', connected: false,
    startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), restarts: 0,
    maxRestarts: config.tunnel.maxRestarts, metricsUrl, publicOrigin,
    credentialSource: 'configured',
    lastExitCode: null, lastError: null,
    lastReadyAt: null, lastFailureAt: null, consecutiveReadyFailures: 0,
  };
  let child: ChildProcess | undefined;
  let ipcServer: net.Server | undefined;
  let stopping = false;
  let finished = false;
  let resolveWait!: (code: number) => void;
  const waitPromise = new Promise<number>(resolve => { resolveWait = resolve; });
  const update = (patch: Partial<TunnelStatus>) => {
    status = { ...status, ...patch, updatedAt: new Date().toISOString() };
    try { writeState(paths.tunnelDir, status); }
    catch { status = { ...status, lastError: 'private tunnel state could not be written' }; }
  };
  /**
   * In-memory only. The readiness probe records a timestamp every couple of
   * seconds; persisting each one would rewrite state.json continuously for no
   * owner-visible benefit and, on Windows, park the event loop in the rename
   * retry. Anything that changes `phase` still goes through `update`.
   */
  const updateVolatile = (patch: Partial<TunnelStatus>) => {
    status = { ...status, ...patch, updatedAt: new Date().toISOString() };
  };
  const appendLog = (source: 'dodo' | 'stdout' | 'stderr', line: string) => {
    try { log.append(source, line); }
    catch { status = { ...status, lastError: 'private tunnel diagnostics could not be written', updatedAt: new Date().toISOString() }; }
  };
  const ownerLog = (line: string) => { appendLog('dodo', line); options.onLog?.(line); };
  const requestStop = () => {
    if (stopping || finished) return;
    stopping = true;
    update({ phase: 'stopping', connected: false });
    ownerLog('stop requested by authenticated local owner');
    if (child) {
      const owned = child;
      try { signalOwnedProcess(owned, 'SIGTERM', true); }
      catch { update({ lastError: 'owned cloudflared process termination was not confirmed' }); }
      if (process.platform !== 'win32') {
        const force = setTimeout(() => {
          if (child === owned && owned.exitCode === null && owned.signalCode === null) {
            try { signalOwnedProcess(owned, 'SIGKILL', true); }
            catch { update({ lastError: 'owned cloudflared process did not stop within the bounded grace period' }); }
          }
        }, 5000);
        force.unref();
      }
    }
  };
  const finish = async (code: number, phase: 'stopped' | 'failed', error?: string) => {
    if (finished) return;
    finished = true;
    update({ running: false, connected: false, phase, ...(error ? { lastError: error } : {}) });
    try { log.close(); } catch { /* diagnostics are best effort at shutdown */ }
    if (ipcServer) await new Promise<void>(resolve => ipcServer!.close(() => resolve()));
    resolveWait(code);
  };

  try {
    ipcServer = await startIpcServer(tunnelIpcPath(configDir), async (cmd, args) => {
      if (cmd === 'status') return { ...status };
      if (cmd === 'logs') return log.read(typeof args['lines'] === 'number' ? args['lines'] : 200);
      if (cmd === 'stop') { setImmediate(requestStop); return { stopping: true }; }
      throw new DodoError('INVALID_INPUT', 'unsupported tunnel owner command');
    }, { replaceExisting: false, stableWindowsEndpoint: true });
  } catch {
    throw new DodoError('CONFLICT', 'a DODO-managed tunnel supervisor is already running or left an owner-private IPC endpoint', {
      recovery: 'run dodo tunnel status; if a crashed POSIX process left a stale socket, remove only the reported private tunnel IPC files after local inspection',
    });
  }
  try { await assertMetricsPortAvailable(config.tunnel.metricsPort); }
  catch (error) {
    await new Promise<void>(resolve => ipcServer!.close(() => resolve()));
    throw error;
  }
  update({ phase: 'starting' });
  ownerLog(`managed tunnel supervisor started; cloudflared=${path.basename(executable)} metrics=${metricsUrl}`);

  const args = ['tunnel', '--no-autoupdate', '--loglevel', 'info', '--output', 'json', '--metrics', `127.0.0.1:${config.tunnel.metricsPort}`, 'run'];
  const runChild = (): Promise<number | null> => new Promise(resolve => {
    const env = buildChildEnv({ parentEnv: options.env ?? process.env, workspaceRoot: securityWorkspaceRoot(), extraAllowlist: [] });
    env['TUNNEL_TOKEN'] = credential;
    child = spawn(executable, args, { cwd: configDir, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let settled = false;
    const done = (code: number | null) => { if (settled) return; settled = true; child = undefined; resolve(code); };
    const pending: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' };
    const stream = (source: 'stdout' | 'stderr', chunk: Buffer) => {
      pending[source] += chunk.toString('utf8');
      if (Buffer.byteLength(pending[source], 'utf8') > 64 * 1024) {
        pending[source] = '';
        appendLog(source, '[oversized cloudflared log line dropped]');
        return;
      }
      let newline: number;
      while ((newline = pending[source].indexOf('\n')) !== -1) {
        const line = pending[source].slice(0, newline).replace(/\r$/, '');
        pending[source] = pending[source].slice(newline + 1);
        if (line) appendLog(source, line);
      }
    };
    const flush = () => {
      for (const source of ['stdout', 'stderr'] as const) if (pending[source]) { appendLog(source, pending[source]); pending[source] = ''; }
    };
    child.stdout?.on('data', (chunk: Buffer) => stream('stdout', chunk));
    child.stderr?.on('data', (chunk: Buffer) => stream('stderr', chunk));
    child.once('spawn', () => update({ phase: 'connecting', connected: false, lastError: null }));
    child.once('error', () => { flush(); update({ lastError: 'cloudflared process could not start' }); done(null); });
    child.once('close', code => { flush(); done(code); });
  });

  const probeIntervalMs = options.readinessIntervalMs ?? READY_PROBE_INTERVAL_MS;
  const failureThreshold = Math.max(1, options.readinessFailureThreshold ?? READY_FAILURE_THRESHOLD);
  const readyLog: Partial<Record<TunnelPhase, string>> = {
    connected: 'cloudflared readiness endpoint reports connected',
    degraded: 'cloudflared readiness check failed; the edge connection is reconnecting',
    disconnected: `cloudflared readiness endpoint is not connected after ${failureThreshold} consecutive checks`,
  };
  /**
   * One sequential probe loop per spawned child. `generation` fences the loop:
   * a result that arrives after the child exited (or after stop) is discarded
   * instead of overwriting the newer state, which is what previously let a
   * stale probe resurrect a "connected" or "not connected" line.
   */
  let childGeneration = 0;
  const runReadinessLoop = async (generation: number): Promise<void> => {
    let failures = 0;
    let everReady = false;
    while (!stopping && childGeneration === generation) {
      const ready = await probeTunnelReady(config.tunnel.metricsPort, Math.min(READY_PROBE_TIMEOUT_MS, Math.max(150, probeIntervalMs - 100)));
      if (stopping || childGeneration !== generation) return;
      const now = new Date().toISOString();
      if (ready) { failures = 0; everReady = true; } else failures += 1;
      // Without readiness evidence the tunnel is still "connecting", never
      // "disconnected": we have nothing to have lost yet.
      const phase: TunnelPhase = ready
        ? 'connected'
        : !everReady
          ? 'connecting'
          : failures >= failureThreshold ? 'disconnected' : 'degraded';
      const changed = phase !== status.phase;
      const patch: Partial<TunnelStatus> = {
        phase,
        // `connected` is the DEBOUNCED belief, not the last probe result: it
        // stays true through `degraded` so anything bound to it (CLI status,
        // Local Config, the owner banner) cannot flicker while cloudflared
        // re-establishes an edge session. `phase` carries the nuance.
        connected: phase === 'connected' || phase === 'degraded',
        consecutiveReadyFailures: failures,
        ...(ready ? { lastReadyAt: now, lastError: null } : { lastFailureAt: now }),
      };
      if (changed) {
        update(patch);
        if (readyLog[phase]) ownerLog(readyLog[phase]!);
      } else updateVolatile(patch);
      await delay(probeIntervalMs);
    }
  };

  void (async () => {
    try {
      while (!stopping) {
        const generation = ++childGeneration;
        const childExit = runChild();
        void runReadinessLoop(generation);
        const code = await childExit;
        // Fence the readiness loop before recording the exit so a probe that is
        // already in flight cannot report on a process that is gone.
        childGeneration += 1;
        update({ connected: false, lastExitCode: code, consecutiveReadyFailures: 0, phase: stopping ? 'stopping' : 'disconnected' });
        if (stopping) break;
        if (status.restarts >= status.maxRestarts) {
          ownerLog(`cloudflared exited after ${status.restarts} bounded restart(s)`);
          await finish(1, 'failed', 'cloudflared exhausted the bounded restart policy');
          return;
        }
        const restarts = status.restarts + 1;
        const waitMs = Math.min(8000, (options.retryDelayMs ?? 1000) * 2 ** (restarts - 1));
        update({ phase: 'backoff', restarts, lastError: 'cloudflared exited before stop was requested' });
        ownerLog(`cloudflared exited; restart ${restarts}/${status.maxRestarts} in ${waitMs}ms`);
        await delay(waitMs);
      }
      childGeneration += 1;
      await finish(0, 'stopped');
    } catch {
      childGeneration += 1;
      await finish(1, 'failed', 'tunnel supervisor failed without exposing child diagnostics');
    }
  })();

  return { status: () => ({ ...status }), stop: requestStop, wait: () => waitPromise };
}
