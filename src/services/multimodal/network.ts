import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { DodoError } from '../../errors.js';

/** A public browser request is proxied by Node to a vetted/pinned IP, not DNS-checked then independently resolved by Chromium. */
export function isPublicAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a, b, c] = address.split('.').map(Number) as [number, number, number, number];
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  // Only global unicast 2000::/3. Reject mapped IPv4, link-local, ULA, multicast and documentation ranges.
  return net.isIPv6(address) && /^[23]/i.test(address) && !/^2001:0?db8:/i.test(address);
}
export function validatePublicUrl(raw: string, origins: Set<string>, ownOrigin?: string): URL {
  let url: URL; try { url = new URL(raw); } catch { throw new DodoError('INVALID_INPUT', 'invalid browser URL'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || !origins.has(url.origin) || (ownOrigin && url.origin === ownOrigin)) throw new DodoError('FORBIDDEN', 'browser URL is outside the explicitly selected public origins');
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!hostname.includes('.') || /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid)$/.test(hostname) || (net.isIP(hostname) && !isPublicAddress(hostname))) throw new DodoError('FORBIDDEN', 'browser refuses local, private, reserved and owner-control targets');
  return url;
}
export async function publicRequest(raw: string, options: { origins: Set<string>; ownOrigin?: string | undefined; method: string; headers: Record<string, string>; body?: Buffer | null | undefined }): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
  const url = validatePublicUrl(raw, options.origins, options.ownOrigin);
  if ((options.body?.length ?? 0) > 1024 * 1024) throw new DodoError('RESOURCE_LIMIT', 'browser request body exceeds 1 MiB');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = await dns.lookup(hostname, { all: true });
  if (!addresses.length || addresses.some(v => !isPublicAddress(v.address))) throw new DodoError('FORBIDDEN', 'browser target resolves to private/reserved addresses');
  const chosen = addresses[0]!;
  const headers = Object.fromEntries(Object.entries(options.headers).filter(([name]) => !['host', 'connection', 'content-length', 'proxy-authorization', 'accept-encoding'].includes(name.toLowerCase())));
  headers['accept-encoding'] = 'identity';
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).request(url, {
      method: options.method, headers, agent: false,
      lookup: (_host, _opts, callback) => callback(null, chosen.address, chosen.family),
    }, response => {
      const chunks: Buffer[] = []; let bytes = 0;
      response.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) request.destroy(new Error('browser response exceeds 8 MiB')); else chunks.push(chunk); });
      response.on('error', reject);
      response.on('end', () => {
        const out: Record<string, string> = {};
        for (const [name, value] of Object.entries(response.headers)) if (value !== undefined && !['transfer-encoding', 'connection', 'content-length'].includes(name)) out[name] = Array.isArray(value) ? value.join('\n') : value;
        resolve({ status: response.statusCode ?? 502, headers: out, body: Buffer.concat(chunks) });
      });
    });
    const timer = setTimeout(() => request.destroy(new Error('browser request deadline exceeded')), 15000);
    request.once('close', () => clearTimeout(timer)); request.once('error', reject);
    if (options.body) request.write(options.body); request.end();
  });
}
