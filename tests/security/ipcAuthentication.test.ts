import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ipcSocketPath } from '../../src/config/paths.js';
import { ipcCall } from '../../src/ipc/client.js';
import { startIpcServer } from '../../src/ipc/server.js';
import { credentialPath, ipcMac, loadIpcCredential, newIpcCredential, publishIpcCredential, removeIpcCredential } from '../../src/ipc/authentication.js';
import { ensurePrivateDirectory } from '../../src/platform/privateFs.js';
import { windowsSystemExecutable } from '../../src/platform/system.js';
import { removeWithRetry } from '../../src/platform/fsRetry.js';

const close = (server: net.Server) => new Promise<void>(resolve => server.close(() => resolve()));

/** Test-owned client. Resolves only on peer close, not on a timeout. */
function raw(endpoint: string, first: unknown, answer?: (hello: Record<string, unknown>) => unknown): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint), lines: string[] = [];
    let buffer = '', replied = false;
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('IPC test peer failed to close')); }, 6000);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(JSON.stringify(first) + '\n'));
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); lines.push(line);
        if (!replied && answer) {
          replied = true;
          try { socket.write(JSON.stringify(answer(JSON.parse(line) as Record<string, unknown>)) + '\n'); }
          catch (error) { socket.destroy(); reject(error); }
        }
      }
    });
    socket.on('error', reject);
    socket.on('close', () => { clearTimeout(timer); resolve(lines); });
  });
}

describe('authenticated owner IPC (real sockets/pipes)', () => {
  let base: string, serial = 0;
  beforeAll(() => { base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dodo-ipc-'))); ensurePrivateDirectory(base); }, 120000);
  afterAll(() => { removeWithRetry(base, true); });
  const locator = () => ipcSocketPath(base, `auth-test-${++serial}`);

  it('authenticates both directions and removes the descriptor when closed', async () => {
    const file = locator();
    const server = await startIpcServer(file, async (cmd, args) => ({ cmd, args }));
    try {
      expect(await ipcCall(file, 'ping', { text: 'ไทย space' })).toEqual({ cmd: 'ping', args: { text: 'ไทย space' } });
      expect(fs.existsSync(credentialPath(file))).toBe(true);
    } finally { await close(server); }
    expect(fs.existsSync(credentialPath(file))).toBe(false);
  });

  it('rejects a legacy unauthenticated command before dispatch', async () => {
    const file = locator(); let calls = 0;
    const server = await startIpcServer(file, async () => { calls++; return 'forbidden'; });
    try {
      await raw(loadIpcCredential(file).endpoint, { id: 1, cmd: 'stop', args: {} });
      expect(calls).toBe(0);
    } finally { await close(server); }
  });

  it('rejects an invalid request proof without executing the command', async () => {
    const file = locator(); let calls = 0;
    const server = await startIpcServer(file, async () => { calls++; return 'forbidden'; });
    try {
      const result = await raw(loadIpcCredential(file).endpoint, { version: 1, nonce: randomBytes(32).toString('hex') }, () => ({ payload: JSON.stringify({ id: 1, cmd: 'stop' }), mac: '0'.repeat(64) }));
      expect(result).toHaveLength(1); // hello only, no command response
      expect(calls).toBe(0);
    } finally { await close(server); }
  });

  it('does not replay an authenticated request on a new connection', async () => {
    const file = locator(); let calls = 0;
    const server = await startIpcServer(file, async () => ++calls);
    try {
      const credential = loadIpcCredential(file), nonce = randomBytes(32).toString('hex');
      let proof: { payload: string; mac: string };
      const first = await raw(credential.endpoint, { version: 1, nonce }, hello => {
        const payload = JSON.stringify({ id: 1, cmd: 'increment' });
        proof = { payload, mac: ipcMac(credential.token, 'request', nonce, String(hello['nonce']), payload) };
        return proof;
      });
      expect(first).toHaveLength(2);
      expect(calls).toBe(1);
      const replay = await raw(credential.endpoint, { version: 1, nonce }, () => proof);
      expect(replay).toHaveLength(1);
      expect(calls).toBe(1);
    } finally { await close(server); }
  });

  it('does not disclose a privileged request to a spoofed server', async () => {
    const file = locator(); ensurePrivateDirectory(path.dirname(file));
    const credential = newIpcCredential(file); let seen = '';
    const server = net.createServer(socket => {
      socket.on('error', () => undefined);
      socket.once('data', chunk => {
        seen += chunk.toString();
        socket.end(JSON.stringify({ version: 1, nonce: 'a'.repeat(64), mac: '0'.repeat(64) }) + '\n');
      });
    });
    await new Promise<void>(resolve => server.listen(credential.endpoint, resolve));
    publishIpcCredential(file, credential);
    try {
      await expect(ipcCall(file, 'stop', { expectedPid: 1234 })).rejects.toThrow('unauthenticated');
      expect(seen).not.toContain('stop');
      expect(seen).not.toContain(credential.token);
    } finally { await close(server); removeIpcCredential(file, credential); }
  });

  it('rejects a descriptor whose endpoint has been redirected', async () => {
    const file = locator(), server = await startIpcServer(file, async () => 'ok');
    const credential = loadIpcCredential(file);
    try {
      fs.writeFileSync(credentialPath(file), JSON.stringify({ ...credential, endpoint: 'untrusted-endpoint' }));
      await expect(ipcCall(file, 'status')).rejects.toThrow('descriptor');
    } finally { publishIpcCredential(file, credential); await close(server); }
  });

  it.skipIf(process.platform === 'win32')('rejects a world-readable POSIX descriptor', async () => {
    const file = locator(), server = await startIpcServer(file, async () => 'ok');
    try {
      fs.chmodSync(credentialPath(file), 0o644);
      await expect(ipcCall(file, 'status')).rejects.toThrow('not private');
    } finally { fs.chmodSync(credentialPath(file), 0o600); await close(server); }
  });

  it.skipIf(process.platform !== 'win32')('rejects a Windows descriptor with an Everyone read ACE', async () => {
    // Only our disposable fixture is changed; no real DODO state/ACL is used.
    const file = locator(), server = await startIpcServer(file, async () => 'ok');
    const utility = windowsSystemExecutable('icacls.exe'), target = credentialPath(file);
    try {
      execFileSync(utility, [target, '/grant', '*S-1-1-0:(R)'], { shell: false, windowsHide: true, timeout: 10000, stdio: 'ignore' });
      await expect(ipcCall(file, 'status')).rejects.toThrow('not private');
    } finally {
      execFileSync(utility, [target, '/remove:g', '*S-1-1-0'], { shell: false, windowsHide: true, timeout: 10000, stdio: 'ignore' });
      await close(server);
    }
  });
});
