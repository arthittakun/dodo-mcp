import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { probeTunnelReady, TunnelStatusSchema } from '../../src/tunnel/supervisor.js';

/**
 * Readiness probe and status contract.
 *
 * The owner saw the tunnel status alternate between "reports connected" and
 * "is not connected" on Windows. These tests pin the properties that stopped
 * it: a probe never reuses a pooled socket, the status schema can express a
 * debounced middle state, and a state.json written by an older DODO (without
 * the new fields) still parses.
 */
describe('tunnel readiness probe', () => {
  const servers: http.Server[] = [];
  afterEach(async () => {
    while (servers.length) {
      const s = servers.pop()!;
      await new Promise<void>((r) => { s.closeAllConnections?.(); s.close(() => r()); });
    }
  });

  const listen = (handler: http.RequestListener): Promise<number> => new Promise((resolve) => {
    const server = http.createServer(handler);
    servers.push(server);
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
  });

  it('reports ready only for HTTP 200 on /ready', async () => {
    const ok = await listen((req, res) => { res.writeHead(req.url === '/ready' ? 200 : 404).end(); });
    expect(await probeTunnelReady(ok)).toBe(true);

    const notReady = await listen((_req, res) => { res.writeHead(503).end(); });
    expect(await probeTunnelReady(notReady)).toBe(false);
  });

  it('reports not-ready instead of throwing when nothing is listening', async () => {
    // A closed port is the normal state while cloudflared is still starting.
    const port = await listen((_req, res) => res.end());
    const server = servers.pop()!;
    await new Promise<void>((r) => server.close(() => r()));
    expect(await probeTunnelReady(port, 300)).toBe(false);
  });

  it('times out instead of hanging when the metrics endpoint stalls', async () => {
    const stalled = await listen(() => { /* never responds */ });
    const started = Date.now();
    expect(await probeTunnelReady(stalled, 250)).toBe(false);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('does not reuse a pooled socket between probes', async () => {
    // Node's keep-alive global agent pools sockets; a pooled socket the peer
    // already closed surfaced as a spurious "not connected". Each probe must
    // open its own connection.
    let connections = 0;
    const port = await listen((_req, res) => { res.writeHead(200).end(); });
    servers[servers.length - 1]!.on('connection', () => { connections += 1; });
    expect(await probeTunnelReady(port)).toBe(true);
    expect(await probeTunnelReady(port)).toBe(true);
    expect(connections).toBe(2);
  });
});

describe('tunnel status contract', () => {
  const base = {
    mode: 'managed' as const, running: true, connected: false,
    startedAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    restarts: 0, maxRestarts: 2,
    metricsUrl: 'http://127.0.0.1:21732/ready', publicOrigin: 'https://dodo.example.com',
    credentialSource: 'configured' as const, lastExitCode: null, lastError: null,
  };

  it('can express every phase the owner UI distinguishes', () => {
    for (const phase of ['starting', 'connecting', 'connected', 'degraded', 'disconnected', 'backoff', 'stopping', 'stopped', 'failed']) {
      expect(TunnelStatusSchema.safeParse({ ...base, phase }).success, phase).toBe(true);
    }
    expect(TunnelStatusSchema.safeParse({ ...base, phase: 'whatever' }).success).toBe(false);
  });

  it('parses a state.json written before the readiness fields existed', () => {
    // Migration: a 1.0.x supervisor wrote no lastReadyAt/lastFailureAt.
    const parsed = TunnelStatusSchema.parse({ ...base, phase: 'connected', connected: true });
    expect(parsed.lastReadyAt).toBeNull();
    expect(parsed.lastFailureAt).toBeNull();
    expect(parsed.consecutiveReadyFailures).toBe(0);
  });

  it('keeps readiness timestamps and the failure counter when present', () => {
    const now = new Date().toISOString();
    const parsed = TunnelStatusSchema.parse({ ...base, phase: 'degraded', lastReadyAt: now, lastFailureAt: now, consecutiveReadyFailures: 2 });
    expect(parsed.lastReadyAt).toBe(now);
    expect(parsed.consecutiveReadyFailures).toBe(2);
  });

  it('rejects unknown fields so status stays a closed contract', () => {
    expect(TunnelStatusSchema.safeParse({ ...base, phase: 'connected', token: 'secret' }).success).toBe(false);
  });
});
