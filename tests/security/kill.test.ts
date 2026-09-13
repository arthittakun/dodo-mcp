import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { ensureConfigDir, statePaths, ipcSocketPath } from '../../src/config/paths.js';
import { openDatabase } from '../../src/store/db.js';
import { Store } from '../../src/store/store.js';
import { mintWorkspaceId } from '../../src/workspace/identity.js';
import { encodeFileIdentity } from '../../src/platform/fileIdentity.js';
import { killServers } from '../../src/cli/kill.js';
import { startIpcServer } from '../../src/ipc/server.js';
import { ipcCall } from '../../src/ipc/client.js';
import { newIpcCredential, publishIpcCredential, removeIpcCredential } from '../../src/ipc/authentication.js';
import { launch } from '../helpers/testServer.js';

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dodo-kill-policy-'));
  const config = path.join(base, 'config');
  ensureConfigDir(config);
  const store = new Store(openDatabase(statePaths(config).dbFile));
  const root = fs.realpathSync(base), id = mintWorkspaceId(store.installSecret(), root);
  const st = fs.statSync(root, { bigint: true });
  store.upsertWorkspace({ id, root, dev: encodeFileIdentity(st.dev), ino: encodeFileIdentity(st.ino), epoch: 'test-epoch' });
  const socket = ipcSocketPath(config, id);
  const status = { pid: process.pid, root, workspaceId: id, workspaceEpoch: 'test-epoch', version: '1.0.0', transport: 'http' };
  return { config, socket, status, cleanup: () => { store.db.close(); fs.rmSync(base, { recursive: true, force: true }); } };
}
const close = (server: net.Server) => new Promise<void>(resolve => server.close(() => resolve()));

describe('kill discovery and stop identity boundaries', () => {
  it('never sends stop to an IPC response with the wrong workspace identity', async () => {
    const f = fixture(); let stops = 0;
    const server = await startIpcServer(f.socket, async cmd => {
      if (cmd === 'stop') stops++;
      return { ...f.status, workspaceId: 'ws_someone_else' };
    });
    try {
      const result = await killServers(f.config, 100);
      expect(result.stopped).toEqual([]);
      expect(result.failed[0]?.reason).toContain('identity');
      expect(stops).toBe(0);
      expect(server.listening).toBe(true);
    } finally { await close(server); f.cleanup(); }
  });

  // Windows uses authenticated pipe descriptors, not chmod-able socket files.
  // Native descriptor/DACL tests are in ipcAuthentication.test.ts.
  it.skipIf(process.platform === 'win32')('does not follow socket symlinks or connect to non-private IPC paths', async () => {
    const f = fixture(); let calls = 0;
    const target = path.join(path.dirname(f.socket), 'target.sock');
    const server = await startIpcServer(target, async () => { calls++; return f.status; });
    try {
      fs.symlinkSync(target, f.socket);
      expect((await killServers(f.config, 100)).failed).toHaveLength(1);
      expect(calls).toBe(0);
      fs.unlinkSync(f.socket);
      fs.renameSync(target, f.socket);
      fs.chmodSync(f.socket, 0o666);
      expect((await killServers(f.config, 100)).failed).toHaveLength(1);
      expect(calls).toBe(0);
    } finally { await close(server); f.cleanup(); }
  });

  it('reports acknowledged but unfinished shutdown instead of claiming success or signaling the PID', async () => {
    const f = fixture();
    const server = await startIpcServer(f.socket, async cmd => cmd === 'status' ? f.status : { stopping: true });
    try {
      const result = await killServers(f.config, 100);
      expect(result.stopped).toEqual([]);
      expect(result.failed[0]?.reason).toContain('still draining');
      expect(server.listening).toBe(true);
    } finally { await close(server); f.cleanup(); }
  });

  it('refuses stale stop identities at the real owner IPC without touching the live server', async () => {
    const ctx = await launch({ locked: true });
    try {
      await expect(ipcCall(ctx.server.ipcPath, 'stop', { expectedPid: process.pid + 1, expectedEpoch: ctx.server.epoch })).rejects.toThrow('identity changed');
      await expect(ipcCall(ctx.server.ipcPath, 'stop', { expectedPid: process.pid, expectedEpoch: 'old-epoch' })).rejects.toThrow('identity changed');
      expect((await fetch(`${ctx.baseUrl}/healthz`)).status).toBe(200);
      expect((await fetch(`${ctx.baseUrl}/kill`, { method: 'POST' })).status).toBe(404);
    } finally { await ctx.cleanup(); }
  });

  it('bounds responses from a malformed local endpoint', async () => {
    const f = fixture();
    const credential = newIpcCredential(f.socket);
    const connections = new Set<net.Socket>();
    const server = net.createServer(c => { connections.add(c); c.on('error', () => undefined); c.on('data', () => c.write('x'.repeat(1024 * 1024 + 1))); c.on('close', () => connections.delete(c)); });
    await new Promise<void>(resolve => server.listen(credential.endpoint, resolve));
    publishIpcCredential(f.socket, credential);
    try { await expect(ipcCall(f.socket, 'status', {}, 1500)).rejects.toThrow('size limit'); }
    finally { for (const c of connections) c.destroy(); await close(server); removeIpcCredential(f.socket, credential); f.cleanup(); }
  });
});
