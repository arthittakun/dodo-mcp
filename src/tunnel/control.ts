import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { validatePublicUrl, type GlobalConfig } from '../config/globalConfig.js';
import { statePaths } from '../config/paths.js';
import { DodoError } from '../errors.js';
import { ipcCall, IpcError } from '../ipc/client.js';
import { assertPrivatePath } from '../platform/privateFs.js';
import { osCredentialAvailability, readTunnelCredential } from './credentials.js';
import { readTunnelLog } from './log.js';
import { resolveCloudflared, TunnelStatusSchema, tunnelIpcPath, type TunnelStatus } from './supervisor.js';
import type { ConnectionMode } from '../config/tunnelConfig.js';

export interface TunnelStatusReport {
  configuredMode: ConnectionMode;
  supervisor: TunnelStatus | null;
  lastKnown: TunnelStatus | null;
}

function readLastKnown(configDir: string): TunnelStatus | null {
  const file = path.join(statePaths(configDir).tunnelDir, 'state.json');
  try {
    const stat = assertPrivatePath(file);
    if (stat.size > 32 * 1024) return null;
    const raw = TunnelStatusSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
    return { ...raw, running: false, connected: false };
  } catch { return null; }
}

export async function tunnelStatus(configDir: string, config: GlobalConfig): Promise<TunnelStatusReport> {
  try {
    const parsed = TunnelStatusSchema.safeParse(await ipcCall(tunnelIpcPath(configDir), 'status'));
    if (!parsed.success) throw new DodoError('INTERNAL_ERROR', 'authenticated tunnel supervisor returned an invalid status');
    const supervisor = parsed.data;
    return { configuredMode: config.tunnel.connectionMode, supervisor, lastKnown: supervisor };
  } catch (error) {
    if (!(error instanceof IpcError)) throw error;
    return { configuredMode: config.tunnel.connectionMode, supervisor: null, lastKnown: readLastKnown(configDir) };
  }
}

export async function stopTunnel(configDir: string): Promise<{ stopping: boolean }> {
  return await ipcCall(tunnelIpcPath(configDir), 'stop') as { stopping: boolean };
}

export async function tunnelLogs(configDir: string, lines: number): Promise<{ lines: string[]; truncated: boolean; live: boolean }> {
  try {
    const raw = await ipcCall(tunnelIpcPath(configDir), 'logs', { lines });
    if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { lines?: unknown }).lines) || !(raw as { lines: unknown[] }).lines.every(line => typeof line === 'string' && line.length <= 2200) || typeof (raw as { truncated?: unknown }).truncated !== 'boolean') throw new DodoError('INTERNAL_ERROR', 'authenticated tunnel supervisor returned invalid diagnostics');
    const result = raw as { lines: string[]; truncated: boolean };
    return { lines: result.lines.slice(-500), truncated: result.truncated, live: true };
  } catch (error) {
    if (!(error instanceof IpcError)) throw error;
    return { ...readTunnelLog(statePaths(configDir).tunnelDir, lines), live: false };
  }
}

function health(url: URL, timeoutMs = 4000): Promise<{ ok: boolean; status: number | null }> {
  return new Promise(resolve => {
    const transport = url.protocol === 'https:' ? https : http;
    let done = false;
    const finish = (ok: boolean, status: number | null) => { if (done) return; done = true; resolve({ ok, status }); };
    const request = transport.get(url, { timeout: timeoutMs, headers: { Accept: 'application/json' } }, response => {
      response.resume();
      response.once('end', () => finish(response.statusCode === 200, response.statusCode ?? null));
    });
    request.once('timeout', () => { request.destroy(); finish(false, null); });
    request.once('error', () => finish(false, null));
  });
}

export async function tunnelDoctor(configDir: string, config: GlobalConfig): Promise<Record<string, unknown>> {
  const status = await tunnelStatus(configDir, config);
  let executable: 'available' | 'missing' = 'missing';
  try { resolveCloudflared(config); executable = 'available'; } catch { /* reported as missing */ }
  let credential: 'configured' | 'missing' | 'invalid' | 'not-used' = config.tunnel.connectionMode === 'tunnel'
    ? config.tunnel.credentialRef ? 'invalid' : 'missing'
    : 'not-used';
  if (config.tunnel.connectionMode === 'tunnel' && config.tunnel.credentialRef) {
    try { await readTunnelCredential(config.tunnel.credentialRef); credential = 'configured'; } catch { credential = 'invalid'; }
  }
  const local = await health(new URL(`http://127.0.0.1:${config.port}/healthz`));
  let publicHealth = { ok: false, status: null as number | null };
  if (config.publicUrl) {
    try { publicHealth = await health(new URL('/healthz', validatePublicUrl(config.publicUrl, config.dangerouslyAllowInsecurePublicUrl))); }
    catch { /* invalid owner config is reported as unavailable, never contacted */ }
  }
  return {
    mode: config.tunnel.connectionMode,
    cloudflared: executable,
    credential,
    credentialStore: osCredentialAvailability(),
    supervisor: status.supervisor,
    localMcpHealth: local,
    publicHealth,
    evidence: {
      connected: config.tunnel.connectionMode === 'tunnel' && status.supervisor?.connected === true,
      processOwnership: config.tunnel.connectionMode === 'tunnel'
        ? 'dodo'
        : config.tunnel.connectionMode === 'external' ? 'owner' : 'none',
      note: config.tunnel.connectionMode === 'external'
        ? 'Public health proves only that the owner-managed HTTPS origin returned DODO health; DODO does not supervise that cloudflared process or prove an AI client is connected.'
        : 'Public health proves only that the configured HTTPS origin returned DODO health; it does not prove an AI client is connected.',
    },
  };
}
