import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import net from 'node:net';
import { DodoError } from '../../errors.js';
import type { Provider } from './contracts.js';
export function validateEndpoint(connection: Provider, adminPorts: number[]): URL {
  const u = new URL(connection.baseUrl);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw new DodoError('INVALID_INPUT', 'provider URL must be an HTTP(S) base URL without credentials, query or fragment');
  if (/(?:^|\/)(?:models|responses|messages|interactions|chat\/completions|chat|tags|show)\/?$/.test(u.pathname)) throw new DodoError('INVALID_INPUT', 'provider URL must stop at the API base (for example /v1); remove /models, /responses, /messages or /chat/completions');
  if (u.protocol === 'http:' && !connection.allowPrivateNetwork) throw new DodoError('FORBIDDEN', 'HTTP requires explicit private endpoint permission');
  if (adminPorts.includes(Number(u.port || (u.protocol === 'https:' ? 443 : 80)))) throw new DodoError('FORBIDDEN', 'DODO control and MCP ports cannot be AI endpoints');
  return u;
}
function addressClass(ip: string): 'public' | 'private' | 'denied' {
  ip = ip.toLowerCase().replace(/^::ffff:/, '');
  if (ip.includes(':')) {
    if (ip.startsWith('2002:') || ip.startsWith('2001:0:') || ip === '::' || /^fe[89ab]/.test(ip) || ip.startsWith('ff') || ip.includes('.')) return 'denied';
    if (ip === '::1' || /^f[cd]/.test(ip)) return 'private';
    if (!ip.startsWith('2') && !ip.startsWith('3')) return 'denied';
    return 'public';
  }
  const [a = 0,b = 0] = ip.split('.').map(Number);
  if (a === 0 || (a === 169 && b === 254) || a >= 224 || (a === 100 && b >= 64 && b <= 127)) return 'denied';
  if (a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'private';
  return 'public';
}
/** Resolve once, validate every address, then pin the selected address on the actual socket. */
export async function providerRequest(connection: Provider, suffix: string, key: string, body: unknown | undefined,
  adminPorts: number[], signal?: AbortSignal, onChunk?: (line: string) => void, beforeSend?: () => void): Promise<{ status: number; text: string }> {
  const base = validateEndpoint(connection, adminPorts);
  const host = base.hostname.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await dns.lookup(host, { all: true });
  if (!addresses.length) throw new DodoError('NOT_SUPPORTED', 'provider hostname has no address');
  for (const { address } of addresses) {
    const kind = addressClass(address);
    if (kind === 'denied' || (kind === 'private' && !connection.allowPrivateNetwork) || (kind === 'public' && base.protocol === 'http:')) throw new DodoError('FORBIDDEN', 'provider address is not allowed by endpoint policy');
  }
  // Node's HTTP agent requests lookup({ all:true }) so it can implement its
  // own connection ordering. Return the already-reviewed pinned address in
  // that shape; returning the legacy (address, family) tuple there makes
  // public DNS providers fail with ERR_INVALID_IP_ADDRESS on current Node.
  const chosen = addresses.find(entry => entry.family === 4) ?? addresses[0]!;
  const url = new URL(base.toString().replace(/\/$/, '') + '/' + suffix.replace(/^\//, ''));
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (key) {
    if (connection.protocol === 'anthropic') headers['x-api-key'] = key;
    else if (connection.protocol === 'gemini') headers['x-goog-api-key'] = key;
    else headers.authorization = `Bearer ${key}`;
  }
  if (connection.protocol === 'anthropic') headers['anthropic-version'] = '2023-06-01';
  signal?.throwIfAborted();
  beforeSend?.();
  return new Promise((resolve, reject) => {
    const req = (url.protocol === 'https:' ? https : http).request(url, {
      method: payload === undefined ? 'GET' : 'POST', headers, agent: false, ...(signal ? { signal } : {}),
      lookup: (_hostname, options, callback) => {
        if (typeof options === 'object' && options.all) callback(null, [chosen]);
        else callback(null, chosen.address, chosen.family);
      },
    }, response => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400) { response.resume(); reject(new DodoError('FORBIDDEN', 'provider redirects are refused; credentials were not forwarded')); return; }
      let bytes = 0; let text = ''; let pending = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        bytes += Buffer.byteLength(chunk); if (bytes > 4 * 1024 * 1024) { req.destroy(); reject(new DodoError('RESOURCE_LIMIT', 'provider response is too large')); return; }
        text += chunk; pending += chunk;
        for (let i = pending.indexOf('\n'); i >= 0; i = pending.indexOf('\n')) { const line = pending.slice(0, i).trim(); pending = pending.slice(i + 1); if (onChunk && status < 400) onChunk(line); }
      });
      response.on('error', () => reject(new DodoError('CONFLICT', 'provider response failed; not retried')));
      response.on('aborted', () => reject(new DodoError('CONFLICT', 'provider response interrupted; outcome uncertain, not retried')));
      response.on('end', () => resolve({ status, text }));
    });
    req.setTimeout(120000, () => req.destroy());
    req.on('error', () => reject(new DodoError('CONFLICT', 'provider connection failed or canceled; outcome uncertain, not retried')));
    req.end(payload);
  });
}
