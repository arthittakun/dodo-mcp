import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { describe, it, expect } from 'vitest';
import { launch, obtainToken, mcpRaw, rpc, parseMcpResponse, callToolLegacy, wsArgs, mkTmpDir, writeFixture, type TestContext } from '../helpers/testServer.js';
import { ipcCall } from '../../src/ipc/client.js';
import { ipcSocketPath } from '../../src/config/paths.js';

/**
 * Runtime workspace switch (ADR-019): owner-only over the Local Config plane;
 * the MCP listener, OAuth/ACL checks, IPC and history must all follow the
 * ACTIVE workspace, and every failure must leave the old workspace serving.
 */
type Json = Record<string, unknown>;
/** Safe nested read for loosely typed JSON in assertions. */
const get = (o: unknown, ...keys: string[]): unknown => keys.reduce<unknown>((v, k) => (v as Json | undefined)?.[k], o);
const str = (v: unknown): string => String(v);
const real = (p: string) => fs.realpathSync(p);

function adminUrl(ctx: TestContext): { origin: string; token: string } {
  const u = new URL(ctx.configUrl as string);
  return { origin: u.origin, token: u.hash.slice(1) };
}
async function adminPost(ctx: TestContext, route: string, body: unknown, opts: { auth?: boolean; headers?: Record<string, string> } = {}): Promise<Response> {
  const { origin, token } = adminUrl(ctx);
  return fetch(`${origin}/api/${route}`, {
    method: 'POST',
    headers: { 'x-dodo-workspace': ctx.server.workspaceId, 'x-dodo-epoch': ctx.server.epoch, 'content-type': 'application/json', ...(opts.auth === false ? {} : { authorization: `Bearer ${token}` }), ...(opts.headers ?? {}) },
    body: JSON.stringify(body),
  });
}
async function adminState(ctx: TestContext): Promise<Json> {
  const { origin, token } = adminUrl(ctx);
  const res = await fetch(`${origin}/api/state`, { headers: { authorization: `Bearer ${token}` } });
  expect(res.status).toBe(200);
  return (await res.json()) as Json;
}

describe('WS: runtime workspace switch', () => {
  it('WS-07: stale admin tabs cannot change ACL, trust, or switch the new root', async () => {
    const a = await launch({ toolSurface: 'full', configPort:0});
    const t = await obtainToken(a);
    const old = {'x-dodo-workspace':a.server.workspaceId,'x-dodo-epoch':a.server.epoch};
    const b = mkTmpDir('dodo-stale-b-');
    try {
      await a.server.switchWorkspace({path:b});
      for (const [route, body] of [
        ['access',{clientId:t.clientId,scopes:['dodo:exec']}],
        ['config',{mode:'trusted'}],
        ['workspace/switch',{path:a.fixtureDir}],
      ] as const) {
        expect((await adminPost(a,route,body,{headers:old})).status).toBe(409);
      }
      expect(a.server.services.store.clientAccess(a.server.workspaceId,t.clientId)).toEqual([]);
      expect(a.server.services.trustMode()).toBe('inspect');
      // Even A -> B -> A must reject the old A epoch.
      await a.server.switchWorkspace({path:a.fixtureDir});
      expect((await adminPost(a,'config',{mode:'trusted'},{headers:old})).status).toBe(409);
      expect((await adminPost(a,'config',{mode:'edit'})).status).toBe(200);
    } finally { await a.cleanup(); }
  });

  it('WS-08: disconnected HTTP does not release a still-running tool lease', async () => {
    const a = await launch({ toolSurface: 'full', configPort:0});
    const t = await obtainToken(a);
    const b = mkTmpDir('dodo-disconnected-b-');
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>(r => { enter = r; });
    const paused = new Promise<void>(r => { release = r; });
    const original = a.server.services.overview.build.bind(a.server.services.overview);
    a.server.services.overview.build = async (...args) => { enter(); await paused; return original(...args); };
    const controller = new AbortController();
    const request = fetch(`${a.baseUrl}/mcp`, {method:'POST',signal:controller.signal,headers:{authorization:`Bearer ${t.accessToken}`,'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify(rpc('tools/call',{name:'project_overview',arguments:{}}))}).catch(() => undefined);
    try {
      await entered;
      controller.abort(); await request;
      await expect(a.server.switchWorkspace({path:b,drainTimeoutMs:150})).rejects.toThrow(/in flight/);
      expect(a.server.services.store.getWorkspace(a.server.workspaceId)).toBeDefined();
      release();
      await expect.poll(() => a.server.host.inflight.count()).toBe(0);
      expect((await a.server.switchWorkspace({path:b})).changed).toBe(true);
    } finally {release();await a.cleanup();}
  });

  it('WS-09: shutdown destroys old partial HTTP connections before closing OAuth state', async () => {
    const a = await launch({ toolSurface: 'full' });
    const t = await obtainToken(a);
    const revoked = await obtainToken(a);
    a.server.services.store.revokeGrant(revoked.grantId);
    const socket = net.connect(a.port,'127.0.0.1');
    socket.on('error', () => {});
    let oldResponse = '';
    socket.on('data', c => { oldResponse += String(c); });
    try {
      await once(socket,'connect');
      // Authentication now runs before body parsing: a revoked token is
      // rejected immediately. Use a valid token to exercise the partial-body
      // drain; the revoked-token assertion after restart remains below.
      socket.write(`POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${a.port}\r\nContent-Type: application/json\r\nContent-Length: 1000\r\nAuthorization: Bearer ${t.accessToken}\r\n\r\n{`);
      await expect.poll(() => a.server.host.inflight.count()).toBeGreaterThan(0);
      await a.server.close();
      await expect.poll(() => socket.destroyed).toBe(true);
      expect(oldResponse).not.toContain('500');
      const next = await launch({ toolSurface: 'full', configDir:a.configDir,fixtureDir:a.fixtureDir,port:a.port});
      try {
        expect((await mcpRaw(next,rpc('tools/list'),t.accessToken)).status).toBe(200);
        expect((await mcpRaw(next,rpc('tools/list'),revoked.accessToken)).status).toBe(401);
      } finally {await next.cleanup();}
    } finally {socket.destroy();await a.cleanup();}
  });

  it('WS-01: the switch endpoint needs the private capability and rejects foreign origins', async () => {
    const a = await launch({ toolSurface: 'full',  configPort: 0 });
    const rootB = mkTmpDir('dodo-ws-b-');
    try {
      expect((await adminPost(a, 'workspace/switch', { path: rootB }, { auth: false })).status).toBe(401);
      expect((await adminPost(a, 'workspace/switch', { path: rootB }, { headers: { origin: 'https://evil.example' } })).status).toBe(403);
      expect((await adminPost(a, 'workspace/switch', { path: rootB }, { headers: { 'x-forwarded-for': '127.0.0.1' } })).status).toBe(403);
      expect(real(a.server.root)).toBe(real(a.fixtureDir)); // nothing happened
      // No MCP tool can do this: the catalog has no switch tool.
      const t = await obtainToken(a);
      const list = await mcpRaw(a, rpc('tools/list'), t.accessToken);
      expect(list.status).toBe(200);
      expect(JSON.stringify(await parseMcpResponse(list))).not.toMatch(/switch_workspace|set_root|change_workspace/);
    } finally {
      await a.cleanup();
    }
  });

  it('WS-02: A → B serves B for real; stale context, missing ACL, IPC and history all follow the active workspace', async () => {
    const a = await launch({ toolSurface: 'full',  fixtureFiles: { 'a.txt': 'A' }, configPort: 0, trust: 'trusted' });
    const rootB = mkTmpDir('dodo-ws-b-');
    writeFixture(rootB, { 'b.txt': 'B' });
    try {
      const t = await obtainToken(a);
      const rootA = a.server.root;
      const wsA = wsArgs(a);
      const ovA = await callToolLegacy(a, t.accessToken, 'project_overview', {});
      expect(ovA.envelope['ok']).toBe(true);
      // A write on A (trusted, write scope) that must never show up in B's history.
      const w = await callToolLegacy(a, t.accessToken, 'write_file', { ...wsA, path: 'from-a.txt', content: 'written in A\n' });
      expect(w.envelope['ok']).toBe(true);

      const res = await adminPost(a, 'workspace/switch', { path: rootB });
      expect(res.status).toBe(200);
      const sw = (await res.json()) as Json;
      expect(sw['changed']).toBe(true);
      expect(real(str(sw['root']))).toBe(real(rootB));
      expect(sw['workspaceId']).not.toBe(wsA.workspaceId);
      expect(sw['epoch']).not.toBe(wsA.workspaceEpoch);
      expect(sw['needsProjectOverview']).toBe(true);
      // The RunningServer view follows too.
      expect(real(a.server.root)).toBe(real(rootB));
      expect(a.server.workspaceId).toBe(sw['workspaceId']);

      // The client consented for A only: on B it is refused until the owner allows it.
      const denied = await mcpRaw(a, rpc('tools/call',{name:'project_overview',arguments:{}}), t.accessToken);
      expect(denied.status).toBe(200);
      expect(denied.headers.get('www-authenticate')).toBeNull();
      const refusal = await parseMcpResponse(denied);
      expect(get(refusal,'result','structuredContent','error','code')).toBe('WORKSPACE_ACCESS_REQUIRED');
      expect(get(refusal,'result','structuredContent','workspaceId')).toBeNull();

      // B's own trust (default inspect), not A's trusted; ACL empty.
      let st = await adminState(a);
      expect(real(str(get(st, 'workspace', 'root')))).toBe(real(rootB));
      expect(get(st, 'permissions', 'savedMode')).toBe('inspect');
      expect(get(st, 'permissions', 'effectiveMode')).toBe('inspect');
      const clientRow = (st['clients'] as Array<{ id: string; scopes: string[] }>).find((c) => c.id === t.clientId);
      expect(clientRow).toBeUndefined();

      // Owner grants read on B → project_overview sees B; old context is refused; write is FORBIDDEN.
      expect((await adminPost(a, 'access', { clientId: t.clientId, scopes: ['dodo:read'] })).status).toBe(200);
      expect((await adminState(a))['clients']).toEqual([expect.objectContaining({id:t.clientId,scopes:['dodo:read']})]);
      const ovB = await callToolLegacy(a, t.accessToken, 'project_overview', {});
      expect(ovB.envelope['ok']).toBe(true);
      expect(real(str(get(ovB.envelope, 'data', 'root')))).toBe(real(rootB));
      const stale = await callToolLegacy(a, t.accessToken, 'read_files', { ...wsA, files: [{ path: 'b.txt' }] });
      expect(get(stale.envelope, 'error', 'code')).toBe('WORKSPACE_MISMATCH');
      const fresh = await callToolLegacy(a, t.accessToken, 'read_files', { ...wsArgs(a), files: [{ path: 'b.txt' }] });
      expect(fresh.envelope['ok']).toBe(true);
      expect(JSON.stringify(fresh.envelope['data'])).toContain('B');
      const notThere = await callToolLegacy(a, t.accessToken, 'read_files', { ...wsArgs(a), files: [{ path: 'from-a.txt' }] });
      expect(JSON.stringify(notThere.envelope)).toMatch(/NOT_FOUND/);
      const write = await callToolLegacy(a, t.accessToken, 'write_file', { ...wsArgs(a), path: 'x.txt', content: 'no' });
      expect(get(write.envelope, 'error', 'code')).toBe('FORBIDDEN');
      // History is per workspace.
      const histB = await callToolLegacy(a, t.accessToken, 'change_history', { ...wsArgs(a), limit: 20 });
      expect(histB.envelope['ok']).toBe(true);
      expect((get(histB.envelope, 'data', 'changesets') as unknown[]).length).toBe(0);

      // IPC socket follows the active workspace; the old one is gone.
      const status = (await ipcCall(ipcSocketPath(a.configDir, str(sw['workspaceId'])), 'status')) as Json;
      expect(real(str(status['root']))).toBe(real(rootB));
      await expect(ipcCall(ipcSocketPath(a.configDir, wsA.workspaceId), 'status')).rejects.toThrow('no running DODO server');
      // Audit trail in the new workspace.
      expect(JSON.stringify(a.server.services.store.recentAudit(str(sw['workspaceId']), 20))).toContain('local.workspace.switch');

      // Back to A: A's own saved trust and ACL come back (nothing was copied), history is intact.
      const back = await adminPost(a, 'workspace/switch', { path: rootA });
      expect(back.status).toBe(200);
      st = await adminState(a);
      expect(real(str(get(st, 'workspace', 'root')))).toBe(real(rootA));
      expect(get(st, 'permissions', 'savedMode')).toBe('trusted');
      const ovA2 = await callToolLegacy(a, t.accessToken, 'project_overview', {});
      expect(ovA2.envelope['ok']).toBe(true);
      expect(get(ovA2.envelope, 'data', 'workspaceEpoch')).not.toBe(wsA.workspaceEpoch); // a fresh epoch again
      const histA = await callToolLegacy(a, t.accessToken, 'change_history', { ...wsArgs(a), limit: 20 });
      const changesetsA = get(histA.envelope, 'data', 'changesets') as Array<{ summary: string; status: string }>;
      expect(changesetsA.length).toBe(1);
      expect(changesetsA[0]?.summary).toContain('1 create');
    } finally {
      await a.cleanup();
    }
  });

  it('WS-03: refuses while a job runs or a request is in flight, without killing anything; A keeps serving', async () => {
    const a = await launch({ toolSurface: 'full',  configPort: 0, trust: 'trusted', drainTimeoutMs: 200 });
    const rootB = mkTmpDir('dodo-ws-b-');
    try {
      const t = await obtainToken(a);
      const ws = wsArgs(a);
      const started = await callToolLegacy(a, t.accessToken, 'run_command', { ...ws, command: 'sleep 4', background: true });
      expect(started.envelope['ok']).toBe(true);
      const jobId = str(get(started.envelope, 'data', 'jobId'));
      const refused = await adminPost(a, 'workspace/switch', { path: rootB });
      expect(refused.status).toBe(409);
      const body = (await refused.json()) as Json;
      expect(body['code']).toBe('CONFLICT');
      expect(str(body['error'])).toMatch(/job/);
      expect(real(a.server.root)).toBe(real(a.fixtureDir));
      // The job was not touched.
      const js = await callToolLegacy(a, t.accessToken, 'job_status', { ...ws, jobId });
      expect(get(js.envelope, 'data', 'status')).toBe('running');
      const cancel = await callToolLegacy(a, t.accessToken, 'job_cancel', { ...ws, jobId });
      expect(cancel.envelope['ok']).toBe(true);
      await callToolLegacy(a, t.accessToken, 'job_wait', { ...ws, jobId, waitMs: 5000 });

      // In-flight request: the switch drains, then refuses after the bounded wait.
      const release = a.server.host.inflight.enter();
      await expect(a.server.switchWorkspace({ path: rootB, drainTimeoutMs: 150 })).rejects.toThrow(/in flight/);
      expect(real(a.server.root)).toBe(real(a.fixtureDir));
      release();
      const ok = await a.server.switchWorkspace({ path: rootB });
      expect(ok.changed).toBe(true);
      expect(real(a.server.root)).toBe(real(rootB));
    } finally {
      await a.cleanup();
    }
  });

  it('WS-04: invalid targets are refused with typed errors and the current workspace is untouched', async () => {
    const a = await launch({ toolSurface: 'full',  configPort: 0 });
    try {
      const epoch = a.server.epoch;
      fs.writeFileSync(path.join(a.fixtureDir, 'not-a-dir.txt'), 'x');
      const cases: Array<[unknown, number, string]> = [
        [path.join(os.tmpdir(), `dodo-nope-${Date.now()}`), 400, 'NOT_FOUND'],
        [path.join(a.fixtureDir, 'not-a-dir.txt'), 400, 'PATH_DENIED'],
        [os.homedir(), 400, 'PATH_DENIED'],
        ['relative/path', 400, 'INVALID_INPUT'],
        ['', 400, 'INVALID_INPUT'],
        [42, 400, 'INVALID_INPUT'],
      ];
      for (const [target, status, code] of cases) {
        const res = await adminPost(a, 'workspace/switch', { path: target });
        expect(res.status, String(target)).toBe(status);
        expect(((await res.json()) as Json)['code'], String(target)).toBe(code);
      }
      expect((await adminPost(a, 'workspace/switch', { path: a.fixtureDir, extra: 1 })).status).toBe(400);
      // Same root: no-op, same epoch.
      const same = await adminPost(a, 'workspace/switch', { path: a.fixtureDir });
      expect(same.status).toBe(200);
      expect(((await same.json()) as Json)['changed']).toBe(false);
      expect(a.server.epoch).toBe(epoch);
      expect(a.server.host.state()).toBe('ready');
      const t = await obtainToken(a);
      expect((await callToolLegacy(a, t.accessToken, 'project_overview', {})).envelope['ok']).toBe(true);
    } finally {
      await a.cleanup();
    }
  });

  it('WS-05: refuses to take over a root that another live DODO process serves', async () => {
    const a = await launch({ toolSurface: 'full',  configPort: 0 });
    const rootB = mkTmpDir('dodo-ws-b-');
    const b = await launch({ toolSurface: 'full',  fixtureDir: rootB, configDir: a.configDir });
    try {
      const res = await adminPost(a, 'workspace/switch', { path: rootB });
      expect(res.status).toBe(409);
      expect(str(((await res.json()) as Json)['error'])).toMatch(/another DODO process/);
      expect(real(a.server.root)).toBe(real(a.fixtureDir));
      expect(real(b.server.root)).toBe(real(rootB)); // the other process was not clobbered
      await b.cleanup();
      const ok = await adminPost(a, 'workspace/switch', { path: rootB });
      expect(ok.status).toBe(200);
    } finally {
      await a.cleanup();
    }
  });

  it('WS-06: pending action approvals of the old workspace are denied, not left dangling', async () => {
    const a = await launch({ toolSurface: 'full',  configPort: 0 }); // inspect mode → writes need approval
    const rootB = mkTmpDir('dodo-ws-b-');
    try {
      const t = await obtainToken(a);
      const ws = wsArgs(a);
      const blocked = await callToolLegacy(a, t.accessToken, 'write_file', { ...ws, path: 'pending.txt', content: 'x' });
      expect(get(blocked.envelope, 'error', 'code')).toBe('APPROVAL_REQUIRED');
      const pendingBefore = a.server.services.store.listPendingApprovals('action');
      expect(pendingBefore.length).toBe(1);
      const id = pendingBefore[0]?.id as string;
      await a.server.switchWorkspace({ path: rootB });
      expect(a.server.services.store.getApproval(id)?.status).toBe('denied');
    } finally {
      await a.cleanup();
    }
  });
});
