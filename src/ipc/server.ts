import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { IpcRequest, IpcResponse } from './protocol.js';
import { ensurePrivateDirectory } from '../platform/privateFs.js';
import { IPC_FRAME_BYTES, newIpcCredential, publishIpcCredential, removeIpcCredential, ipcMac, validMac } from './authentication.js';

export type IpcHandler = (cmd: string, args: Record<string, unknown>) => Promise<unknown>;

/** Authenticated one-shot IPC on Unix sockets / Windows named pipes. The
 * token is never sent over the wire; both peers prove possession using fresh
 * challenges, and request/response bodies are authenticated and bounded. */
export async function startIpcServer(socketPath: string, handler: IpcHandler, options: { replaceExisting?: boolean; stableWindowsEndpoint?: boolean } = {}): Promise<net.Server> {
  ensurePrivateDirectory(path.dirname(socketPath));
  const credential = newIpcCredential(socketPath, options.stableWindowsEndpoint === undefined ? {} : { stableWindowsEndpoint: options.stableWindowsEndpoint });
  if (process.platform !== 'win32' && fs.existsSync(socketPath)) {
    const stat = fs.lstatSync(socketPath);
    if (!stat.isSocket() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()) throw new Error('refusing unexpected IPC path');
    if (options.replaceExisting === false) throw new Error('authenticated IPC listener already exists');
    // Preserve the legacy root alias: older clients retain their independent
    // instance socket, while the newest local client owns this root alias.
    fs.unlinkSync(socketPath);
  }
  const connections = new Set<net.Socket>();
  const server = net.createServer(conn => {
    if (connections.size >= 64) { conn.destroy(); return; }
    connections.add(conn);
    let buffer = '', phase: 'hello' | 'request' | 'done' = 'hello';
    let clientNonce = '', serverNonce = '';
    conn.setEncoding('utf8');
    conn.setTimeout(10000, () => conn.destroy());
    conn.on('error', () => conn.destroy());
    conn.on('close', () => connections.delete(conn));
    conn.on('data', (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > IPC_FRAME_BYTES) { conn.destroy(); return; }
      const index = buffer.indexOf('\n');
      if (index === -1) return;
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (buffer.length || phase === 'done') { conn.destroy(); return; }
      try {
        const frame = JSON.parse(line) as Record<string, unknown>;
        if (phase === 'hello') {
          if (frame['version'] !== 1 || typeof frame['nonce'] !== 'string' || !/^[a-f0-9]{64}$/.test(frame['nonce'])) throw new Error('bad hello');
          clientNonce = frame['nonce']; serverNonce = randomBytes(32).toString('hex'); phase = 'request';
          conn.write(JSON.stringify({ version: 1, nonce: serverNonce, mac: ipcMac(credential.token, 'hello', clientNonce, serverNonce) }) + '\n');
          return;
        }
        phase = 'done'; // one-use even if parsing/dispatch fails
        const payload = frame['payload'];
        if (typeof payload !== 'string' || !validMac(frame['mac'], ipcMac(credential.token, 'request', clientNonce, serverNonce, payload))) throw new Error('bad request authentication');
        const req = JSON.parse(payload) as IpcRequest;
        if (!req || !Number.isSafeInteger(req.id) || typeof req.cmd !== 'string' || req.cmd.length > 100 || (req.args !== undefined && (!req.args || typeof req.args !== 'object' || Array.isArray(req.args)))) throw new Error('invalid IPC request');
        void (async () => {
          let response: IpcResponse;
          try { response = { id: req.id, ok: true, data: await handler(req.cmd, req.args ?? {}) }; }
          catch (error) { response = { id: req.id, ok: false, error: error instanceof Error ? error.message : 'owner request failed' }; }
          const text = JSON.stringify(response);
          const wire = JSON.stringify({ payload: text, mac: ipcMac(credential.token, 'response', clientNonce, serverNonce, text) }) + '\n';
          if (Buffer.byteLength(wire, 'utf8') > IPC_FRAME_BYTES) conn.destroy();
          else conn.end(wire);
        })().catch(() => conn.destroy());
      } catch { conn.destroy(); }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(credential.endpoint, () => { server.removeListener('error', reject); resolve(); });
  });
  try {
    if (process.platform !== 'win32') fs.chmodSync(socketPath, 0o600);
    publishIpcCredential(socketPath, credential);
  } catch (error) { server.close(); for (const conn of connections) conn.destroy(); throw error; }
  server.on('close', () => removeIpcCredential(socketPath, credential));
  return server;
}
