#!/usr/bin/env node
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { GlobalConfigSchema } from '../dist/config/globalConfig.js';
import { startManagedTunnel } from '../dist/tunnel/supervisor.js';
import { tunnelLogs } from '../dist/tunnel/control.js';
import { validateTunnelToken } from '../dist/tunnel/credentials.js';

const TOKEN_ENV = 'DODO_LIVE_TUNNEL_TOKEN';
const EXECUTABLE_ENV = 'DODO_CLOUDFLARED_PATH';
const CONNECT_TIMEOUT_MS = 45_000;
const STABILITY_WINDOW_MS = 3_000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise(resolve => server.close(resolve));
  if (!port) throw new Error('could not allocate a loopback metrics port');
  return port;
}

function cloudflaredVersion(executable) {
  const result = spawnSync(executable, ['--version'], {
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    timeout: 10_000,
  });
  if (result.status !== 0) throw new Error('cloudflared --version failed');
  const match = `${result.stdout ?? ''} ${result.stderr ?? ''}`.match(/cloudflared version\s+([^\s]+)/i);
  return match?.[1] ?? 'unknown';
}

function failureCategory(lines, status) {
  const text = lines.join('\n');
  if (/invalid tunnel secret|failed to parse token|unauthori[sz]ed|authentication failed|access denied/i.test(text)) return 'credential_rejected';
  if (/could not start|not found|is not recognized|permission denied|access is denied/i.test(text)) return 'process_start_failed';
  if (/failed to dial|i\/o timeout|network is unreachable|no route to host|temporary failure in name resolution/i.test(text)) return 'network_unreachable';
  if (status?.lastExitCode !== null && status?.lastExitCode !== undefined) return 'cloudflared_exited';
  return 'readiness_timeout';
}

function assertNoCredentialPersisted(directory, credential) {
  const pending = [directory];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else if (entry.isFile() && fs.statSync(target).size <= 2 * 1024 * 1024) {
        if (fs.readFileSync(target).includes(Buffer.from(credential))) {
          throw new Error('run-scoped tunnel credential was persisted');
        }
      }
    }
  }
}

let rawToken = process.env[TOKEN_ENV] ?? '';
delete process.env[TOKEN_ENV];
const configuredExecutable = process.env[EXECUTABLE_ENV] ?? '';
delete process.env[EXECUTABLE_ENV];

let credential;
try {
  credential = validateTunnelToken(rawToken);
} finally {
  rawToken = '';
}

if (!configuredExecutable || !path.isAbsolute(configuredExecutable)) {
  throw new Error(`${EXECUTABLE_ENV} must name an absolute job-local or owner-installed executable`);
}

const executable = fs.realpathSync.native(configuredExecutable);
const configDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dodo-live-tunnel-')));
if (process.platform !== 'win32') fs.chmodSync(configDir, 0o700);
const metricsPort = await freePort();
const version = cloudflaredVersion(executable);
const startedAt = Date.now();
let supervisor;

try {
  const config = GlobalConfigSchema.parse({
    publicUrl: 'https://tunnel-smoke.invalid',
    tunnel: {
      mode: 'managed',
      executable,
      metricsPort,
      maxRestarts: 0,
    },
  });
  supervisor = await startManagedTunnel({ configDir, config, temporaryToken: credential });

  const deadline = Date.now() + CONNECT_TIMEOUT_MS;
  while (Date.now() < deadline && supervisor.status().running && !supervisor.status().connected) {
    await sleep(250);
  }

  const connected = supervisor.status();
  if (!connected.connected) {
    const logs = await tunnelLogs(configDir, 200).catch(() => ({ lines: [] }));
    throw new Error(`tunnel did not become ready (${failureCategory(logs.lines, connected)})`);
  }

  await sleep(STABILITY_WINDOW_MS);
  const stable = supervisor.status();
  if (!stable.running || !stable.connected) throw new Error('tunnel lost readiness during the stability window');

  supervisor.stop();
  const exitCode = await supervisor.wait();
  assertNoCredentialPersisted(configDir, credential);
  const stopped = supervisor.status();
  if (exitCode !== 0 || stopped.phase !== 'stopped' || stopped.running || stopped.connected) {
    throw new Error('DODO did not stop its owned cloudflared child cleanly');
  }

  console.log(JSON.stringify({
    ok: true,
    platform: process.platform,
    arch: process.arch,
    cloudflaredVersion: version,
    connected: true,
    stableForMs: STABILITY_WINDOW_MS,
    stoppedCleanly: true,
    credentialPersisted: false,
    elapsedMs: Date.now() - startedAt,
  }));
} catch (error) {
  if (supervisor?.status().running) {
    supervisor.stop();
    await supervisor.wait().catch(() => undefined);
  }
  const message = String(error instanceof Error ? error.message : error).split(credential).join('[REDACTED]');
  console.error(JSON.stringify({
    ok: false,
    platform: process.platform,
    arch: process.arch,
    cloudflaredVersion: version,
    error: message,
    elapsedMs: Date.now() - startedAt,
  }));
  process.exitCode = 1;
} finally {
  credential = '';
  fs.rmSync(configDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
