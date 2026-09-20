import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import net from 'node:net';
import { DodoError } from '../../errors.js';
import type { GlobalConfig } from '../../config/globalConfig.js';
import { addressClass } from '../../security/outboundAddress.js';
import { digestOf } from '../../util/hash.js';
import type { HealthCheck } from './deploymentContracts.js';

type NetworkConfig = Pick<GlobalConfig, 'port' | 'configPort' | 'publicUrl'> & { controlPorts?: readonly number[] };
export function validateHealthUrl(check: HealthCheck, config: NetworkConfig): URL {
  let u: URL;
  try { u = new URL(check.url); } catch { throw new DodoError('INVALID_INPUT', 'invalid deployment health URL'); }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash)
    throw new DodoError('INVALID_INPUT', 'health URL must be HTTP(S), without credentials, query or fragment');
  const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  if ([21730, 21731, 21732, config.port, config.configPort, ...(config.controlPorts ?? [])].includes(port)
    || (config.publicUrl && u.origin === new URL(config.publicUrl).origin))
    throw new DodoError('FORBIDDEN', 'DODO endpoints cannot be deployment health targets');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'metadata.google.internal' || host.endsWith('.metadata.google.internal'))
    throw new DodoError('FORBIDDEN', 'metadata endpoints cannot be health targets');
  if (u.protocol === 'http:' && !check.allowPrivateNetwork) throw new DodoError('FORBIDDEN', 'HTTP health requires explicit owner permission for this private target');
  if (net.isIP(host)) validateHealthAddress(host, check, u);
  return u;
}
export function validateHealthAddress(ip: string, check: HealthCheck, url: URL): void {
  const type = addressClass(ip);
  if (!net.isIP(ip) || type === 'denied' || (type === 'private' && !check.allowPrivateNetwork) || (type === 'public' && url.protocol !== 'https:'))
    throw new DodoError('FORBIDDEN', 'deployment health address is not permitted');
}

/** A bounded GET with a pinned, pre-validated DNS result. No auth, cookies, redirect or retries. */
export async function readHealth(check: HealthCheck, config: NetworkConfig, revalidate: () => void, signal?: AbortSignal): Promise<{ status: number; body: Buffer }> {
  const url = validateHealthUrl(check, config), host = url.hostname.replace(/^\[|\]$/g, '');
  const deadline = AbortSignal.timeout(10000), combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  combined.throwIfAborted(); revalidate();
  // dns.lookup has no AbortSignal: cap waiting and never send a late result after expiry.
  let abort: (() => void) | undefined;
  const addresses = await Promise.race([
    net.isIP(host) ? Promise.resolve([{ address: host, family: net.isIP(host) }]) : dns.lookup(host, { all: true }),
    new Promise<never>((_resolve, reject) => { abort = () => reject(new DodoError('TIMEOUT', 'deployment health DNS deadline expired')); combined.addEventListener('abort', abort, { once: true }); }),
  ]).catch(() => { throw new DodoError('CONFLICT', 'deployment health DNS unavailable; no request sent'); })
    .finally(() => { if (abort) combined.removeEventListener('abort', abort); });
  if (!addresses.length) throw new DodoError('NOT_SUPPORTED', 'deployment health hostname has no address');
  for (const entry of addresses) validateHealthAddress(entry.address, check, url);
  const chosen = addresses.find(a => a.family === 4) ?? addresses[0]!;
  combined.throwIfAborted(); revalidate();
  return new Promise((resolve, reject) => {
    const req = (url.protocol === 'https:' ? https : http).request(url, {
      method: 'GET', headers: { accept: 'application/json', 'accept-encoding': 'identity' }, agent: false, signal: combined,
      lookup: (_host, options, callback) => {
        if (typeof options === 'object' && options.all) callback(null, [chosen]); else callback(null, chosen.address, chosen.family);
      },
    }, response => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 || response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
        reject(new DodoError('FORBIDDEN', 'health redirects and compressed responses are refused')); response.destroy(); return;
      }
      const chunks: Buffer[] = []; let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) { reject(new DodoError('RESOURCE_LIMIT', 'deployment health response exceeds its limit')); response.destroy(); }
        else chunks.push(chunk);
      });
      response.on('aborted', () => reject(new DodoError('CONFLICT', 'deployment health response was interrupted')));
      response.on('error', () => reject(new DodoError('CONFLICT', 'deployment health response failed')));
      response.on('end', () => { try { revalidate(); resolve({ status, body: Buffer.concat(chunks) }); } catch (error) { reject(error); } });
    });
    req.on('error', () => reject(new DodoError('CONFLICT', 'deployment health request failed; not retried')));
    req.end();
  });
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
/** Only owner-declared operation presence/statuses or exact contracts are proven, never all semantic compatibility. */
export function evaluateHealth(check: HealthCheck, response: { status: number; body: Buffer }) {
  let passed = response.status === check.expectedStatus, reason = passed ? 'expected_status' : 'unexpected_status';
  let contractDigest: string | null = null;
  if (passed && check.kind === 'openapi') {
    let spec: Record<string, unknown> | undefined;
    try { spec = object(JSON.parse(response.body.toString('utf8'))); } catch { /* sanitized below */ }
    const paths = object(spec?.['paths']);
    passed = Boolean(paths && typeof spec?.['openapi'] === 'string' && /^3\.[01]\./.test(spec['openapi']));
    const selected: unknown[] = [];
    for (const expected of check.requiredOperations) {
      const operation = object(object(paths?.[expected.path])?.[expected.method]), responses = object(operation?.['responses']);
      if (!operation || operation['$ref'] || !responses || expected.responses.some(code => !Object.hasOwn(responses, code))) passed = false;
      else {
        selected.push(operation);
        if (expected.contractHash) {
          // The entire document participates so a changed referenced component cannot pass unnoticed.
          try { if (digestOf({ operation, components: spec?.['components'] ?? {} }) !== expected.contractHash) passed = false; }
          catch { passed = false; }
        }
      }
    }
    try { contractDigest = digestOf(selected); } catch { passed = false; }
    reason = passed ? 'declared_contract_matched' : 'contract_missing_incompatible_or_unknown';
  }
  return { checkId: check.id, kind: check.kind, passed, reason, status: response.status, contractDigest,
    checkedAt: Date.now(), coverage: check.kind === 'openapi' ? 'owner_declared_operations_only' : 'expected_http_status_only' };
}
