import http from 'node:http';
import dns from 'node:dns/promises';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DodoError } from '../../src/errors.js';
import { openDatabase } from '../../src/store/db.js';
import { Store } from '../../src/store/store.js';
import { ProviderInput, type Provider } from '../../src/services/ai/contracts.js';
import { providerRequest } from '../../src/services/ai/network.js';
import { AISettings } from '../../src/services/ai/settings.js';

const key = 'synthetic-discovery-credential';
const connection = (baseUrl: string): Provider => ({ ...ProviderInput.parse({ name: 'Metadata fixture', provider: 'custom', protocol: 'responses', baseUrl, allowPrivateNetwork: true }), id: 'ai_metadatafixture' });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function fixture(handle: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
  const server = http.createServer(handle);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }) };
}

describe('bounded model discovery before provider effects', () => {
  let settings: AISettings;
  beforeEach(() => { settings = new AISettings(new Store(openDatabase(':memory:')), []); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); settings.credentials.close(); settings.store.db.close(); });

  it('cancels a pending DNS lookup promptly and never sends HTTP when DNS resolves later', async () => {
    let requests = 0;
    const server = await fixture((_req, res) => { requests++; res.end('{}'); });
    const lookupResult = deferred<Array<{ address: string; family: number }>>();
    const lookup = vi.spyOn(dns, 'lookup').mockImplementation(() => lookupResult.promise as never);
    const controller = new AbortController(), beforeSend = vi.fn();
    try {
      const c = connection(server.baseUrl.replace('127.0.0.1', 'metadata.fixture'));
      const pending = providerRequest(c, 'models', key, undefined, [], controller.signal, undefined, beforeSend);
      const result = expect(pending).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(lookup).toHaveBeenCalledTimes(1); controller.abort(); await result;
      lookupResult.resolve([{ address: '127.0.0.1', family: 4 }]); await nextTurn();
      expect(beforeSend).not.toHaveBeenCalled(); expect(requests).toBe(0);
    } finally { await server.close(); }
  });

  it('does not resolve DNS after an earlier abort or send after the final guard aborts', async () => {
    let requests = 0;
    const server = await fixture((_req, res) => { requests++; res.end('{}'); });
    const lookup = vi.spyOn(dns, 'lookup');
    const beforeSend = vi.fn();
    try {
      await expect(providerRequest(connection('https://metadata.fixture/v1'), 'models', key, undefined, [], AbortSignal.abort(), undefined, beforeSend)).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(lookup).not.toHaveBeenCalled(); expect(beforeSend).not.toHaveBeenCalled();
      const controller = new AbortController();
      await expect(providerRequest(connection(server.baseUrl), 'models', key, undefined, [], controller.signal, undefined, () => controller.abort())).rejects.toMatchObject({ code: 'CONFLICT' });
      await nextTurn(); expect(requests).toBe(0);
    } finally { await server.close(); }
  });

  it('enforces the default 15 second absolute deadline while credentials are pending and releases its lease', async () => {
    const c = await settings.saveConnection(connection('https://metadata.fixture/v1'), key);
    const credential = deferred<string>();
    vi.spyOn(settings.credentials, 'get').mockImplementation(() => credential.promise);
    const lookup = vi.spyOn(dns, 'lookup');
    vi.useFakeTimers();
    const result = expect(settings.models(c.id)).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
    await vi.advanceTimersByTimeAsync(15000); await result;
    await expect(settings.saveConnection({ ...c, name: 'Lease released' })).resolves.toMatchObject({ name: 'Lease released' });
    credential.resolve(key); await Promise.resolve(); await Promise.resolve();
    expect(lookup).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it('includes unfinished DNS in the default deadline and consumes a later DNS rejection', async () => {
    const c = await settings.saveConnection(connection('https://metadata.fixture/v1'), key);
    const lookupResult = deferred<Array<{ address: string; family: number }>>();
    const lookup = vi.spyOn(dns, 'lookup').mockImplementation(() => lookupResult.promise as never);
    const beforeSend = vi.fn();
    vi.useFakeTimers();
    const result = expect(settings.models(c.id, { beforeSend })).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
    await vi.advanceTimersByTimeAsync(14999); expect(lookup).toHaveBeenCalledTimes(1); expect(beforeSend).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); await result;
    lookupResult.reject(new Error('late synthetic DNS failure')); await Promise.resolve();
    expect(beforeSend).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels a continuously trickling response without retrying metadata or generation', async () => {
    let requests = 0, chunks = 0;
    const started = deferred<void>();
    const server = await fixture((req, res) => {
      requests++; expect(req.url).toBe('/v1/models'); expect(req.method).toBe('GET'); expect(req.headers.authorization).toBe(`Bearer ${key}`);
      res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"data":['); started.resolve();
      const interval = setInterval(() => { chunks++; res.write(' '); }, 5);
      res.once('close', () => clearInterval(interval));
    });
    try {
      const c = await settings.saveConnection(connection(server.baseUrl), key), controller = new AbortController();
      const result = expect(settings.models(c.id, { signal: controller.signal })).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
      await started.promise;
      await new Promise<void>(resolve => setTimeout(resolve, 35)); controller.abort(); await result;
      expect(chunks).toBeGreaterThan(1); expect(requests).toBe(1);
      await expect(settings.saveConnection({ ...c, name: 'Stopped metadata' })).resolves.toMatchObject({ name: 'Stopped metadata' });
    } finally { await server.close(); }
  });

  it.each(['AUTH_REQUIRED', 'FORBIDDEN', 'RESOURCE_LIMIT'] as const)('rechecks %s authority after DNS and before sending credentials', async code => {
    let requests = 0;
    const server = await fixture((_req, res) => { requests++; res.end('{}'); });
    const lookupResult = deferred<Array<{ address: string; family: number }>>();
    const lookup = vi.spyOn(dns, 'lookup').mockImplementation(() => lookupResult.promise as never);
    const beforeSend = vi.fn(() => { throw new DodoError(code, 'synthetic metadata authority change'); });
    try {
      const c = await settings.saveConnection(connection(server.baseUrl.replace('127.0.0.1', 'metadata.fixture')), key);
      const result = expect(settings.models(c.id, { beforeSend })).rejects.toMatchObject({ code });
      await Promise.resolve(); await Promise.resolve(); expect(lookup).toHaveBeenCalledTimes(1); expect(beforeSend).not.toHaveBeenCalled();
      lookupResult.resolve([{ address: '127.0.0.1', family: 4 }]); await result; await nextTurn();
      expect(beforeSend).toHaveBeenCalledTimes(1); expect(requests).toBe(0);
    } finally { await server.close(); }
  });
});
