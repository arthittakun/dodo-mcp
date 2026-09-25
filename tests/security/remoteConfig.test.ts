import { describe, expect, it, vi } from 'vitest';
import { launch, rawHttp } from '../helpers/testServer.js';
import { installationIpcCall } from '../../src/ipc/installationClient.js';
import type { TunnelRuntime } from '../../src/tunnel/runtime.js';
import { ProjectRegistry } from '../../src/projects/registry.js';

function sessionCookie(headers: import('node:http').IncomingHttpHeaders): string {
  const raw = headers['set-cookie'];
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (!first) throw new Error('pairing response did not set a cookie');
  return first.split(';')[0] ?? '';
}

describe('temporary Remote Config on the public MCP listener', () => {
  const runningTunnel = {
    status: () => ({ available: true as const, running: true, current: null, lastKnown: null }),
  } as unknown as TunnelRuntime;
  it('opens a fresh remote owner session after the local eight-hour link expires', async () => {
    const ctx = await launch({ configPort: 0, connectionMode: 'external' });
    const project = new ProjectRegistry(ctx.server.services.store).add(ctx.fixtureDir).project;
    const local = new URL(ctx.configUrl!);
    const localHeaders = { authorization: `Bearer ${local.hash.slice(1)}` };
    const time = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 9 * 60 * 60 * 1000);
    try {
      expect((await fetch(`${local.origin}/api/state`, { headers: localHeaders })).status).toBe(401);
      const opened = await installationIpcCall(ctx.configDir, 'remoteConfig.open') as { pairingCode: string; expiresAt: number };
      const pair = await rawHttp(ctx, { method: 'POST', path: '/config/pair', headers: { origin: ctx.baseUrl }, body: JSON.stringify({ code: opened.pairingCode }) });
      expect(pair.status).toBe(200);
      const cookie = sessionCookie(pair.headers);
      const remote = await rawHttp(ctx, { method: 'GET', path: '/config/api/state', headers: { cookie } });
      expect(remote.status).toBe(200);
      const state = JSON.parse(remote.body);
      expect(state.connection.expiresAt).toBe(opened.expiresAt);
      const context = { cookie, origin: ctx.baseUrl, 'x-dodo-workspace': state.controlContext.workspaceId, 'x-dodo-epoch': state.controlContext.epoch };
      const list = vi.spyOn(ctx.server.services.installation!.ai, 'list');
      const ai = await rawHttp(ctx, { method: 'GET', path: '/config/api/ai/state', headers: { cookie } });
      expect(ai.status).toBe(200);
      expect(list.mock.lastCall?.[0].expiresAt).toBe(opened.expiresAt / 1000);
      list.mockRestore();
      const openProject = await rawHttp(ctx, { method: 'POST', path: '/config/api/ai/project', headers: context, body: JSON.stringify({ projectId: project.projectId }) });
      expect(openProject.status).toBe(200);
      const saved = await rawHttp(ctx, { method: 'POST', path: '/config/api/config', headers: context, body: JSON.stringify({ mode: 'edit' }) });
      expect(saved.status).toBe(200);
      expect(ctx.server.services.trustMode()).toBe('edit');
      expect(remote.body + ai.body).not.toContain(local.hash.slice(1));
      expect(remote.body + ai.body).not.toContain(opened.pairingCode);
      // Opening a domain session must never resurrect the expired local URL.
      expect((await fetch(`${local.origin}/api/state`, { headers: localHeaders })).status).toBe(401);
      time.mockReturnValue(opened.expiresAt);
      expect((await rawHttp(ctx, { method: 'GET', path: '/config/api/state', headers: { cookie } })).status).toBe(404);
      const renewed = await installationIpcCall(ctx.configDir, 'remoteConfig.open') as { pairingCode: string };
      expect((await rawHttp(ctx, { method: 'GET', path: '/config/api/state', headers: { cookie } })).status).toBe(401);
      expect((await rawHttp(ctx, { method: 'POST', path: '/config/pair', body: JSON.stringify({ code: opened.pairingCode }) })).status).toBe(401);
      const nextPair = await rawHttp(ctx, { method: 'POST', path: '/config/pair', body: JSON.stringify({ code: renewed.pairingCode }) });
      expect(nextPair.status).toBe(200);
      expect((await rawHttp(ctx, { method: 'GET', path: '/config/api/state', headers: { cookie: sessionCookie(nextPair.headers) } })).status).toBe(200);
    } finally { time.mockRestore(); await ctx.cleanup(); }
  });
  it('revokes a remote owner request waiting for project acquisition when CLI reopens Config', async () => {
    const ctx = await launch({ configPort: 0, connectionMode: 'external', remoteConfig: true });
    const manager = ctx.server.services.installation!;
    const project = new ProjectRegistry(ctx.server.services.store).add(ctx.fixtureDir).project;
    const pair = await rawHttp(ctx, { method: 'POST', path: '/config/pair', body: JSON.stringify({ code: ctx.server.remoteConfig!.pairingCode }) });
    const cookie = sessionCookie(pair.headers);
    let acquired!: () => void, unblock!: () => void;
    const started = new Promise<void>(resolve => { acquired = resolve; });
    const blocked = new Promise<void>(resolve => { unblock = resolve; });
    const original = manager.acquire.bind(manager);
    const acquire = vi.spyOn(manager, 'acquire').mockImplementationOnce(async (...args) => {
      const lease = await original(...args);
      acquired(); await blocked; return lease;
    });
    const pending = rawHttp(ctx, { method: 'POST', path: '/config/api/admin/action', headers: {
      cookie, origin: ctx.baseUrl, 'x-dodo-workspace': ctx.server.workspaceId, 'x-dodo-epoch': ctx.server.epoch,
    }, body: JSON.stringify({ projectId: project.projectId, operation: 'recovery.restore_status' }) });
    try {
      await started;
      await installationIpcCall(ctx.configDir, 'remoteConfig.open');
      unblock();
      const denied = await pending;
      expect(denied.status).toBe(401);
      expect(JSON.parse(denied.body).code).toBe('REMOTE_CONFIG_AUTH_REQUIRED');
      expect(denied.body).not.toContain('8 hours');
      expect(ctx.server.services.store.recentAudit(ctx.server.workspaceId, 20).some(row => row.tool === 'web.recovery.restore_status')).toBe(false);
    } finally { unblock(); acquire.mockRestore(); await pending; await ctx.cleanup(); }
  });
  it('is absent by default and exposes no owner API', async () => {
    const ctx = await launch({ configPort: 0, tunnelRuntime: runningTunnel, connectionMode: 'tunnel' });
    try {
      expect((await rawHttp(ctx, { method: 'GET', path: '/config' })).status).toBe(404);
      expect((await rawHttp(ctx, { method: 'GET', path: '/config/api/state' })).status).toBe(404);
      expect(ctx.server.remoteConfigStatus()).toMatchObject({ active: false, paired: false });
    } finally { await ctx.cleanup(); }
  });

  it('can open through owner-managed Cloudflare without a DODO tunnel supervisor', async () => {
    const ctx = await launch({ configPort: 0, remoteConfig: true, remoteConfigLeaseMs: 30_000, connectionMode: 'external' });
    try {
      expect(ctx.server.connectionMode).toBe('external');
      expect(ctx.server.remoteConfig).toMatchObject({ url: `${ctx.baseUrl}/config` });
      expect(ctx.server.remoteConfigStatus()).toMatchObject({ active: true, paired: false });
    } finally { await ctx.cleanup(); }
  });

  it('pairs once, scopes the cookie to /config, proxies the original owner checks and expires closed', async () => {
    const ctx = await launch({ configPort: 0, remoteConfig: true, remoteConfigLeaseMs: 700, tunnelRuntime: runningTunnel, connectionMode: 'tunnel' });
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
    const ctx = await launch({ configPort: 0, tunnelRuntime: runningTunnel, connectionMode: 'tunnel' });
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

  it('never accepts a Tunnel credential through Remote Config IPC and refuses a stopped Tunnel', async () => {
    let startCalls = 0;
    const tunnelRuntime = {
      status: () => ({ available: true as const, running: false, current: null, lastKnown: null }),
      start: async () => { startCalls += 1; throw new Error('must not be reached'); },
    } as unknown as TunnelRuntime;
    const ctx = await launch({ configPort: 0, tunnelRuntime, connectionMode: 'tunnel' });
    try {
      await expect(installationIpcCall(ctx.configDir, 'remoteConfig.open', { tunnelToken: 'never-accepted-through-ipc' })).rejects.toThrow(/unsupported field/);
      await expect(installationIpcCall(ctx.configDir, 'remoteConfig.open')).rejects.toThrow(/Tunnel is not running/);
      expect(startCalls).toBe(0);
    } finally { await ctx.cleanup(); }
  });

  it('refuses to start a Tunnel when no loopback Local Config target exists', async () => {
    let startCalls = 0;
    const tunnelRuntime = {
      status: () => ({ available: true as const, running: false, current: null, lastKnown: null }),
      start: async () => { startCalls += 1; throw new Error('must not be reached'); },
    } as unknown as TunnelRuntime;
    const ctx = await launch({ tunnelRuntime, connectionMode: 'tunnel' });
    try {
      await expect(installationIpcCall(ctx.configDir, 'remoteConfig.open')).rejects.toThrow(/requires the loopback Local Config server/);
      expect(startCalls).toBe(0);
      expect(ctx.server.remoteConfigStatus()).toMatchObject({ active: false, paired: false });
    } finally { await ctx.cleanup(); }
  });
});
