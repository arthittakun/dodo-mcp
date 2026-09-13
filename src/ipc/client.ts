import net from 'node:net';
import { randomBytes } from 'node:crypto';
import type { IpcRequest, IpcResponse } from './protocol.js';
import { IPC_FRAME_BYTES, loadIpcCredential, ipcMac, validMac } from './authentication.js';

export class IpcError extends Error {}
const NOT_RUNNING = 'no running DODO server for this workspace (start it with `dodo start`)';

/** No unauthenticated fallback, including status/stop. A process using an
 * incompatible IPC contract must be stopped with its matching CLI first. */
export async function ipcCall(socketPath: string, cmd: string, args: Record<string, unknown> = {}, timeoutMs = 10000): Promise<unknown> {
  let credential;
  try { credential = loadIpcCredential(socketPath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new IpcError(NOT_RUNNING);
    throw new IpcError('IPC authentication descriptor is invalid or not private');
  }
  const req: IpcRequest = { id: 1, cmd, args };
  const payload = JSON.stringify(req);
  if (Buffer.byteLength(payload, 'utf8') > IPC_FRAME_BYTES / 2) throw new IpcError('IPC request exceeds size limit');
  const clientNonce = randomBytes(32).toString('hex');
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(credential.endpoint);
    let buffer = '', serverNonce = '', phase: 'hello' | 'response' = 'hello', done = false;
    const finish = (error?: Error, data?: unknown) => {
      if (done) return;
      done = true; clearTimeout(timer); conn.destroy();
      if (error) reject(error); else resolve(data);
    };
    const timer = setTimeout(() => finish(new IpcError('IPC timeout')), timeoutMs);
    conn.setEncoding('utf8');
    conn.on('connect', () => conn.write(JSON.stringify({ version: 1, nonce: clientNonce }) + '\n'));
    conn.on('data', (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > IPC_FRAME_BYTES) { finish(new IpcError('IPC response exceeds size limit')); return; }
      const index = buffer.indexOf('\n'); if (index === -1) return;
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      try {
        const frame = JSON.parse(line) as Record<string, unknown>;
        if (buffer.length) throw new Error('extra IPC data');
        if (phase === 'hello') {
          if (frame['version'] !== 1 || typeof frame['nonce'] !== 'string' || !/^[a-f0-9]{64}$/.test(frame['nonce'])) throw new Error('invalid hello');
          serverNonce = frame['nonce'];
          if (!validMac(frame['mac'], ipcMac(credential.token, 'hello', clientNonce, serverNonce))) throw new Error('server authentication failed');
          phase = 'response';
          conn.write(JSON.stringify({ payload, mac: ipcMac(credential.token, 'request', clientNonce, serverNonce, payload) }) + '\n');
          return;
        }
        const text = frame['payload'];
        if (typeof text !== 'string' || !validMac(frame['mac'], ipcMac(credential.token, 'response', clientNonce, serverNonce, text))) throw new Error('response authentication failed');
        const response = JSON.parse(text) as IpcResponse;
        if (!response || response.id !== 1 || typeof response.ok !== 'boolean') throw new Error('bad IPC response');
        if (response.ok) finish(undefined, response.data);
        else finish(new IpcError(typeof response.error === 'string' ? response.error : 'owner request failed'));
      } catch { finish(new IpcError('bad or unauthenticated IPC response')); }
    });
    conn.on('error', (error: NodeJS.ErrnoException) => finish(new IpcError(['ENOENT', 'ECONNREFUSED', 'EPIPE'].includes(error.code ?? '') ? NOT_RUNNING : error.message)));
    conn.on('close', () => { if (!done) finish(new IpcError('IPC closed before an authenticated response')); });
  });
}
