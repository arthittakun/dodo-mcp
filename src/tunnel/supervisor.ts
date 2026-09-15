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

export const TunnelStatusSchema = z.object({
  mode: z.literal('managed'),
  running: z.boolean(),
  phase: z.enum(['starting', 'connecting', 'connected', 'backoff', 'stopping', 'stopped', 'failed']),
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

export function probeTunnelReady(port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false;
    const finish = (value: boolean) => { if (settled) return; settled = true; resolve(value); };
    const request = http.get({ host: '127.0.0.1', port, path: '/ready', timeout: timeoutMs, headers: { Host: `127.0.0.1:${port}` } }, response => {
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
  onLog?: (line: string) => void;
}): Promise<RunningTunnelSupervisor> {
  const configDir = path.resolve(options.configDir);
  const config = options.config;
  if (config.tunnel.connectionMode !== 'tunnel') throw new DodoError('CONFLICT', 'DODO is configured for local connection mode', { recovery: 'run dodo tunnel configure --tunnel first' });
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

  void (async () => {
    let readyTimer: NodeJS.Timeout | undefined;
    try {
      while (!stopping) {
        const readiness = async () => {
          if (stopping || !child) return;
          const connected = await probeTunnelReady(config.tunnel.metricsPort);
          if (connected !== status.connected) {
            update({ connected, phase: connected ? 'connected' : 'connecting' });
            ownerLog(connected ? 'cloudflared readiness endpoint reports connected' : 'cloudflared readiness endpoint is not connected');
          }
        };
        readyTimer = setInterval(() => void readiness(), 1000);
        readyTimer.unref();
        const code = await runChild();
        clearInterval(readyTimer); readyTimer = undefined;
        update({ connected: false, lastExitCode: code });
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
      if (readyTimer) clearInterval(readyTimer);
      await finish(0, 'stopped');
    } catch {
      if (readyTimer) clearInterval(readyTimer);
      await finish(1, 'failed', 'tunnel supervisor failed without exposing child diagnostics');
    }
  })();

  return { status: () => ({ ...status }), stop: requestStop, wait: () => waitPromise };
}
