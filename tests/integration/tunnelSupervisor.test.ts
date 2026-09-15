import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GlobalConfigSchema } from '../../src/config/globalConfig.js';
import { ensurePrivateDirectory } from '../../src/platform/privateFs.js';
import { credentialPath } from '../../src/ipc/authentication.js';
import { startManagedTunnel, tunnelIpcPath } from '../../src/tunnel/supervisor.js';
import { stopTunnel, tunnelDoctor, tunnelLogs, tunnelStatus } from '../../src/tunnel/control.js';
import { TunnelRuntime } from '../../src/tunnel/runtime.js';

const owned: string[] = [];
const token = 'fixture-cloudflare-tunnel-token-123456789';
function fixture(): string { const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dodo-tunnel-integration-'))); ensurePrivateDirectory(dir); owned.push(dir); return dir; }
afterEach(() => { for (const dir of owned.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>(resolve => server.close(() => resolve())); return port;
}
async function until(predicate: () => boolean | Promise<boolean>, timeoutMs = 6000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 40)); }
  throw new Error('tunnel fixture condition timed out');
}
function fakeCloudflared(dir: string, proof: string, expectedToken: string, exitImmediately = false): string {
  const file = path.join(dir, exitImmediately ? 'fake-exit.cjs' : 'fake-cloudflared.cjs');
  const source = `#!/usr/bin/env node
const fs=require('node:fs'),http=require('node:http');
const args=process.argv.slice(2), expected=${JSON.stringify(expectedToken)}, proof=${JSON.stringify(proof)};
fs.writeFileSync(proof,JSON.stringify({args,tokenInArg:args.some(x=>x.includes(expected)),tokenPresent:process.env.TUNNEL_TOKEN===expected}));
const leaked='fixture credential='+process.env.TUNNEL_TOKEN;process.stderr.write(leaked.slice(0,23));setTimeout(()=>process.stderr.write(leaked.slice(23)+'\\n'),5);
${exitImmediately ? "process.exit(17);" : `const value=args[args.indexOf('--metrics')+1], port=Number(value.split(':').pop());
const server=http.createServer((req,res)=>{res.statusCode=req.url==='/ready'?200:404;res.end('fixture');});
server.listen(port,'127.0.0.1');
const stop=()=>server.close(()=>process.exit(0));process.on('SIGTERM',stop);process.on('SIGINT',stop);`}
`;
  fs.writeFileSync(file, source, { flag: 'wx', mode: 0o700 }); fs.chmodSync(file, 0o700); return file;
}

describe.skipIf(process.platform === 'win32')('DODO-managed tunnel supervisor with a local fake cloudflared', () => {
  it('binds the saved tunnel to one DODO runtime and stops its owned child on close', async () => {
    const dir = fixture(), proof = path.join(dir, 'runtime-proof.json'), port = await freePort();
    const executable = fakeCloudflared(dir, proof, token);
    const config = GlobalConfigSchema.parse({ publicUrl: 'https://dodo.fixture.invalid', tunnel: { connectionMode: 'tunnel', credentialRef: { provider: 'env', name: 'FIXTURE_TUNNEL_TOKEN' }, executable, metricsPort: port, maxRestarts: 0 } });
    const runtime = new TunnelRuntime(dir);
    const previous = process.env['FIXTURE_TUNNEL_TOKEN']; process.env['FIXTURE_TUNNEL_TOKEN'] = token;
    try {
      await runtime.start(config);
      await until(() => runtime.status().current?.connected === true);
      expect(runtime.status()).toMatchObject({ available: true, running: true, current: { credentialSource: 'configured', connected: true } });
    } finally {
      if (previous === undefined) delete process.env['FIXTURE_TUNNEL_TOKEN']; else process.env['FIXTURE_TUNNEL_TOKEN'] = previous;
    }
    await runtime.close();
    expect(runtime.status()).toMatchObject({ available: true, running: false, current: null, lastKnown: { phase: 'stopped', running: false } });
    expect(JSON.stringify(runtime.status())).not.toContain(token);
  });

  it('uses a saved credential reference, authenticated IPC, real readiness, redacted logs and owned stop', async () => {
    const dir = fixture(), proof = path.join(dir, 'proof.json'), port = await freePort();
    const executable = fakeCloudflared(dir, proof, token);
    const config = GlobalConfigSchema.parse({ publicUrl: 'https://dodo.fixture.invalid', tunnel: { connectionMode: 'tunnel', credentialRef: { provider: 'env', name: 'FIXTURE_TUNNEL_TOKEN' }, executable, metricsPort: port, maxRestarts: 1 } });
    expect(JSON.stringify(config)).not.toContain(token);
    expect(config.tunnel.credentialRef).toEqual({ provider: 'env', name: 'FIXTURE_TUNNEL_TOKEN' });
    const supervisor = await startManagedTunnel({ configDir: dir, config, env: { ...process.env, FIXTURE_TUNNEL_TOKEN: token }, retryDelayMs: 10 });
    try {
      await until(() => supervisor.status().connected);
      const live = await tunnelStatus(dir, config);
      expect(live.supervisor).toMatchObject({ running: true, phase: 'connected', connected: true, publicOrigin: 'https://dodo.fixture.invalid' });
      expect(fs.existsSync(credentialPath(tunnelIpcPath(dir)))).toBe(true);
      const childProof = JSON.parse(fs.readFileSync(proof, 'utf8')) as { args: string[]; tokenInArg: boolean; tokenPresent: boolean };
      expect(childProof.tokenPresent).toBe(true); expect(childProof.tokenInArg).toBe(false);
      expect(childProof.args).toEqual(['tunnel', '--no-autoupdate', '--loglevel', 'info', '--output', 'json', '--metrics', `127.0.0.1:${port}`, 'run']);
      await expect(startManagedTunnel({ configDir: dir, config, env: { ...process.env, FIXTURE_TUNNEL_TOKEN: token }, retryDelayMs: 10 })).rejects.toThrow(/already running/);
      expect(await stopTunnel(dir)).toEqual({ stopping: true });
      expect(await supervisor.wait()).toBe(0);
      expect(fs.existsSync(credentialPath(tunnelIpcPath(dir)))).toBe(false);
      const logs = await tunnelLogs(dir, 100);
      expect(logs.live).toBe(false); expect(logs.lines.join('\n')).toContain('[REDACTED_TUNNEL_TOKEN]');
      expect(logs.lines.join('\n')).not.toContain(token);
      expect(fs.readFileSync(path.join(dir, 'tunnel', 'state.json'), 'utf8')).not.toContain(token);
    } finally { supervisor.stop(); await supervisor.wait(); }
  });

  it('bounds restart attempts after cloudflared exits', async () => {
    const dir = fixture(), proof = path.join(dir, 'proof.json'), port = await freePort();
    const executable = fakeCloudflared(dir, proof, token, true);
    const config = GlobalConfigSchema.parse({ publicUrl: 'https://dodo.fixture.invalid', tunnel: { connectionMode: 'tunnel', credentialRef: { provider: 'env', name: 'FIXTURE_TUNNEL_TOKEN' }, executable, metricsPort: port, maxRestarts: 1 } });
    const supervisor = await startManagedTunnel({ configDir: dir, config, env: { ...process.env, FIXTURE_TUNNEL_TOKEN: token }, retryDelayMs: 10 });
    expect(await supervisor.wait()).toBe(1);
    expect(supervisor.status()).toMatchObject({ running: false, phase: 'failed', connected: false, restarts: 1, lastExitCode: 17 });
    expect((await tunnelLogs(dir, 100)).lines.join('\n')).not.toContain(token);
  });

  it('rejects an invalid credential before opening IPC or spawning cloudflared', async () => {
    const dir = fixture(), proof = path.join(dir, 'proof.json'), port = await freePort();
    const executable = fakeCloudflared(dir, proof, token);
    const config = GlobalConfigSchema.parse({ publicUrl: 'https://dodo.fixture.invalid', tunnel: { connectionMode: 'tunnel', credentialRef: { provider: 'env', name: 'FIXTURE_TUNNEL_TOKEN' }, executable, metricsPort: port, maxRestarts: 1 } });
    await expect(startManagedTunnel({ configDir: dir, config, env: { ...process.env, FIXTURE_TUNNEL_TOKEN: 'invalid' } })).rejects.toThrow(/invalid format/);
    expect(fs.existsSync(proof)).toBe(false);
    expect(fs.existsSync(credentialPath(tunnelIpcPath(dir)))).toBe(false);
  });

  it('fails closed when Tunnel mode has no saved credential', async () => {
    const dir = fixture(), proof = path.join(dir, 'proof.json'), port = await freePort();
    const executable = fakeCloudflared(dir, proof, token);
    const config = GlobalConfigSchema.parse({ publicUrl: 'https://dodo.fixture.invalid', tunnel: { connectionMode: 'tunnel', executable, metricsPort: port, maxRestarts: 1 } });
    await expect(startManagedTunnel({ configDir: dir, config })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(fs.existsSync(proof)).toBe(false);
    expect(fs.existsSync(credentialPath(tunnelIpcPath(dir)))).toBe(false);
  });

  it('refuses an occupied metrics port without killing or replacing its listener', async () => {
    const dir = fixture(), proof = path.join(dir, 'proof.json'), blocker = net.createServer();
    await new Promise<void>(resolve => blocker.listen(0, '127.0.0.1', resolve));
    const address = blocker.address(), port = typeof address === 'object' && address ? address.port : 0;
    const executable = fakeCloudflared(dir, proof, token);
    const config = GlobalConfigSchema.parse({ publicUrl: 'https://dodo.fixture.invalid', tunnel: { connectionMode: 'tunnel', credentialRef: { provider: 'env', name: 'FIXTURE_TUNNEL_TOKEN' }, executable, metricsPort: port, maxRestarts: 1 } });
    try {
      await expect(startManagedTunnel({ configDir: dir, config, env: { ...process.env, FIXTURE_TUNNEL_TOKEN: token } })).rejects.toThrow(/already in use/);
      expect(blocker.listening).toBe(true); expect(fs.existsSync(proof)).toBe(false);
      expect(fs.existsSync(credentialPath(tunnelIpcPath(dir)))).toBe(false);
    } finally { await new Promise<void>(resolve => blocker.close(() => resolve())); }
  });
});

describe('tunnel connectivity diagnostics', () => {
  it('separates real loopback MCP health from public-origin health', async () => {
    const dir = fixture();
    const local = http.createServer((request, response) => { response.statusCode = request.url === '/healthz' ? 200 : 404; response.end(); });
    const publicServer = http.createServer((request, response) => { response.statusCode = request.url === '/healthz' ? 200 : 404; response.end(); });
    await Promise.all([
      new Promise<void>(resolve => local.listen(0, '127.0.0.1', resolve)),
      new Promise<void>(resolve => publicServer.listen(0, '127.0.0.1', resolve)),
    ]);
    try {
      const localAddress = local.address(), publicAddress = publicServer.address();
      const localPort = typeof localAddress === 'object' && localAddress ? localAddress.port : 0;
      const publicPort = typeof publicAddress === 'object' && publicAddress ? publicAddress.port : 0;
      const config = GlobalConfigSchema.parse({ port: localPort, publicUrl: `http://127.0.0.1:${publicPort}`, dangerouslyAllowInsecurePublicUrl: true, tunnel: { connectionMode: 'local' } });
      const report = await tunnelDoctor(dir, config) as { mode: string; localMcpHealth: { ok: boolean; status: number }; publicHealth: { ok: boolean; status: number }; evidence: { connected: boolean } };
      expect(report.mode).toBe('local');
      expect(report.localMcpHealth).toEqual({ ok: true, status: 200 });
      expect(report.publicHealth).toEqual({ ok: true, status: 200 });
      expect(report.evidence.connected).toBe(false);
    } finally {
      await Promise.all([new Promise<void>(resolve => local.close(() => resolve())), new Promise<void>(resolve => publicServer.close(() => resolve()))]);
    }
  });
});
