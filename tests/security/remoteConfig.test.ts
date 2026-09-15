import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { launch, rawHttp } from '../helpers/testServer.js';
import { installationIpcCall } from '../../src/ipc/installationClient.js';
import type { TunnelRuntime } from '../../src/tunnel/runtime.js';

function sessionCookie(headers: import('node:http').IncomingHttpHeaders): string {
  const raw = headers['set-cookie'];
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (!first) throw new Error('pairing response did not set a cookie');
  return first.split(';')[0] ?? '';
}

describe('temporary Remote Config on the public MCP listener', () => {
  it('is absent by default and exposes no owner API', async () => {
    const ctx = await launch({ configPort: 0 });
    try {
      expect((await rawHttp(ctx, { method: 'GET', path: '/config' })).status).toBe(404);
      expect((await rawHttp(ctx, { method: 'GET', path: '/config/api/state' })).status).toBe(404);
      expect(ctx.server.remoteConfigStatus()).toMatchObject({ active: false, paired: false });
    } finally { await ctx.cleanup(); }
  });

  it('pairs once, scopes the cookie to /config, proxies the original owner checks and expires closed', async () => {
    const ctx = await launch({ configPort: 0, remoteConfig: true, remoteConfigLeaseMs: 700 });
    const lease = ctx.server.remoteConfig;
    if (!lease) throw new Error('missing initial remote config lease');
    try {
      expect(lease.url).toBe(`${ctx.baseUrl}/config`);
      expect(lease.url).not.toMatch(/[?#]/);
      expect(lease.pairingCode).toMatch(/^[2-9A-HJ-NP-Z]{4}(?:-[2-9A-HJ-NP-Z]{4}){3}$/);

      const login = await rawHttp(ctx, { method: 'GET', path: '/config' });
      expect(login.status).toBe(200);
      expect(login.body).toContain('DODO Remote Config');
      expect(login.body).not.toContain(lease.pairingCode);
      expect(login.headers['content-security-policy']).toContain("script-src 'self'");
      expect((await rawHttp(ctx, { method: 'GET', path: '/config/api/state' })).status).toBe(401);
      expect((await rawHttp(ctx, { method: 'GET', path: '/config/assets/app.js' })).status).toBe(401);
      expect((await rawHttp(ctx, {
        method: 'GET', path: '/config/api/state', headers: { cookie: '__Secure-dodo_remote_config=not-the-right-session-value' },
      })).status).toBe(401);

      const foreign = await rawHttp(ctx, {
        method: 'POST', path: '/config/pair', headers: { origin: 'https://evil.example' },
        body: JSON.stringify({ code: lease.pairingCode }),
      });
      expect(foreign.status).toBe(403);

      const paired = await rawHttp(ctx, {
        method: 'POST', path: '/config/pair', headers: { origin: ctx.baseUrl },
        body: JSON.stringify({ code: lease.pairingCode }),
      });
      expect(paired.status).toBe(200);
      const cookie = sessionCookie(paired.headers);
      expect(cookie).toMatch(/^__Secure-dodo_remote_config=/);
      const setCookie = Array.isArray(paired.headers['set-cookie']) ? paired.headers['set-cookie'][0] : paired.headers['set-cookie'];
      expect(setCookie).toContain('Path=/config');
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('Secure');
      expect(setCookie).toContain('SameSite=Strict');
      expect(setCookie).not.toContain(lease.pairingCode);

      const replay = await rawHttp(ctx, {
        method: 'POST', path: '/config/pair', headers: { origin: ctx.baseUrl },
        body: JSON.stringify({ code: lease.pairingCode }),
      });
      expect(replay.status).toBe(401);

      const page = await rawHttp(ctx, { method: 'GET', path: '/config', headers: { cookie } });
      expect(page.status).toBe(200);
      expect(page.body).toContain('/config/assets/app.js');
      expect(page.body).not.toContain(lease.pairingCode);

      const stateResponse = await rawHttp(ctx, { method: 'GET', path: '/config/api/state', headers: { cookie } });
      expect(stateResponse.status).toBe(200);
      const state = JSON.parse(stateResponse.body) as { connection: { expiresAt: number; remoteConfig: { active: boolean; expiresAt: number } }; controlContext: { workspaceId: string; epoch: string } };
      expect(state.connection).toMatchObject({ expiresAt: lease.expiresAt, remoteConfig: { active: true, expiresAt: lease.expiresAt } });
      expect(stateResponse.body).not.toContain(lease.pairingCode);

      const crossSiteMutation = await rawHttp(ctx, {
        method: 'POST', path: '/config/api/config',
        headers: {
          cookie, origin: 'https://evil.example',
          'x-dodo-workspace': state.controlContext.workspaceId,
          'x-dodo-epoch': state.controlContext.epoch,
        },
        body: JSON.stringify({ mode: 'trusted' }),
      });
      expect(crossSiteMutation.status).toBe(403);
      expect(ctx.server.services.store.trustMode(ctx.server.workspaceId)).not.toBe('trusted');

      // Authentication at the bridge does not bypass Local Config's reviewed
      // workspace/epoch binding for mutations.
      const stale = await rawHttp(ctx, {
        method: 'POST', path: '/config/api/config', headers: { cookie, origin: ctx.baseUrl }, body: JSON.stringify({ mode: 'trusted' }),
      });
      expect(stale.status).toBe(409);
      expect(JSON.parse(stale.body).code).toBe('STALE_WORKSPACE');

      const saved = await rawHttp(ctx, {
        method: 'POST', path: '/config/api/config',
        headers: {
          cookie, origin: ctx.baseUrl,
          'x-dodo-workspace': state.controlContext.workspaceId,
          'x-dodo-epoch': state.controlContext.epoch,
        },
        body: JSON.stringify({ mode: 'edit' }),
      });
      expect(saved.status).toBe(200);
      expect(ctx.server.services.store.trustMode(ctx.server.workspaceId)).toBe('edit');

      await new Promise(resolve => setTimeout(resolve, 800));
      expect(ctx.server.remoteConfigStatus()).toMatchObject({ active: false, paired: false, expiresAt: null });
      expect((await rawHttp(ctx, { method: 'GET', path: '/config', headers: { cookie } })).status).toBe(404);
      expect((await rawHttp(ctx, { method: 'GET', path: '/config/api/state', headers: { cookie } })).status).toBe(404);
    } finally { await ctx.cleanup(); }
  });

  it('can be opened again through private installation IPC without restarting MCP', async () => {
    const ctx = await launch({ configPort: 0 });
    try {
      const opened = await installationIpcCall(ctx.configDir, 'remoteConfig.open') as { url: string; pairingCode: string; expiresAt: number };
      expect(opened.url).toBe(`${ctx.baseUrl}/config`);
      expect(opened.pairingCode).toMatch(/^[2-9A-HJ-NP-Z-]+$/);
      expect(ctx.server.remoteConfigStatus()).toMatchObject({ active: true, paired: false, expiresAt: opened.expiresAt });
      expect(JSON.stringify(ctx.server.services.store.recentAudit(ctx.server.workspaceId, 20))).not.toContain(opened.pairingCode);
      expect(await installationIpcCall(ctx.configDir, 'remoteConfig.close')).toEqual({ closed: true });
      expect(ctx.server.remoteConfigStatus()).toMatchObject({ active: false, paired: false });
      expect((await rawHttp(ctx, { method: 'GET', path: '/config' })).status).toBe(404);
    } finally { await ctx.cleanup(); }
  });

  it('can attach a run-scoped Tunnel through authenticated IPC without persisting its credential', async () => {
    const temporaryToken = 'fixture-cloudflare-token-that-is-never-persisted';
    const expectedDigest = createHash('sha256').update(temporaryToken).digest('hex');
    let receivedDigest = '';
    let running = false;
    const tunnelRuntime = {
      status: () => ({ available: true as const, running, current: null, lastKnown: null }),
      start: async (config: { tunnel: { mode: string } }, token: string) => {
        receivedDigest = createHash('sha256').update(token).digest('hex');
        running = true;
        const now = new Date().toISOString();
        return {
          mode: 'managed' as const, running: true, phase: 'connecting' as const, connected: false,
          startedAt: now, updatedAt: now, restarts: 0, maxRestarts: 2,
          metricsUrl: 'http://127.0.0.1:21732/ready', publicOrigin: 'http://127.0.0.1:1',
          credentialSource: 'temporary' as const, lastExitCode: null, lastError: null,
          fixtureMode: config.tunnel.mode,
        };
      },
    } as unknown as TunnelRuntime;
    const ctx = await launch({ configPort: 0, tunnelRuntime });
    try {
      const before = await installationIpcCall(ctx.configDir, 'remoteConfig.status') as { tunnel: { running: boolean } };
      expect(before.tunnel.running).toBe(false);
      const opened = await installationIpcCall(ctx.configDir, 'remoteConfig.open', { tunnelToken: temporaryToken }) as { pairingCode: string };
      expect(receivedDigest).toBe(expectedDigest);
      expect(running).toBe(true);
      const privateEvidence = JSON.stringify(ctx.server.services.store.recentAudit(ctx.server.workspaceId, 50));
      expect(privateEvidence).not.toContain(temporaryToken);
      expect(privateEvidence).not.toContain(opened.pairingCode);
      expect(fsText(ctx.server.services.store.db.prepare("SELECT value FROM meta").all())).not.toContain(temporaryToken);
    } finally { await ctx.cleanup(); }
  });

  it('refuses to start a Tunnel when no loopback Local Config target exists', async () => {
    let startCalls = 0;
    const tunnelRuntime = {
      status: () => ({ available: true as const, running: false, current: null, lastKnown: null }),
      start: async () => { startCalls += 1; throw new Error('must not be reached'); },
    } as unknown as TunnelRuntime;
    const ctx = await launch({ tunnelRuntime });
    try {
      await expect(installationIpcCall(ctx.configDir, 'remoteConfig.open', {
        tunnelToken: 'fixture-cloudflare-token-that-is-never-persisted',
      })).rejects.toThrow(/requires the loopback Local Config server/);
      expect(startCalls).toBe(0);
      expect(ctx.server.remoteConfigStatus()).toMatchObject({ active: false, paired: false });
    } finally { await ctx.cleanup(); }
  });
});

function fsText(value: unknown): string {
  return JSON.stringify(value);
}
