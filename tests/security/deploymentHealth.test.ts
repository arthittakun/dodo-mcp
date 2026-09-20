import http from 'node:http';
import dns from 'node:dns/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeploymentHealthCheck, DeploymentTargetSchema } from '../../src/services/recovery/deploymentContracts.js';
import { readHealth, evaluateHealth, validateHealthUrl } from '../../src/services/recovery/deploymentHealth.js';
import { digestOf } from '../../src/util/hash.js';
const config = { port: 21730, configPort: 21731, publicUrl: 'https://dodo.example' };
const check = (url: string) => DeploymentHealthCheck.parse({ id: 'health', kind: 'http', url, allowPrivateNetwork: true });
describe('R05 explicit health network and contract evidence', () => {
  let server: http.Server | undefined;
  afterEach(async () => { vi.restoreAllMocks(); if (server) { server.closeAllConnections(); await new Promise<void>(r => server!.close(() => r())); server = undefined; } });
  async function listen(handler: http.RequestListener) {
    server = http.createServer(handler);
    await new Promise<void>(r => server!.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  }
  it('performs a real bounded GET, preserves expected 401, and exposes no response contents in evidence', async () => {
    const url = await listen((req, res) => { expect(req.headers.authorization).toBeUndefined(); expect(req.headers.cookie).toBeUndefined(); res.writeHead(401).end('PRIVATE_RESPONSE_SENTINEL'); });
    const c = { ...check(url), expectedStatus: 401 };
    const result = evaluateHealth(c, await readHealth(c, config, () => {}));
    expect(result.passed).toBe(true); expect(JSON.stringify(result)).not.toContain('PRIVATE_RESPONSE_SENTINEL');
  });
  it('never follows a redirect or sends after expired authority, and bounds response bytes', async () => {
    let count = 0;
    const url = await listen((req, res) => { count++; if (req.url === '/large') res.end('x'.repeat(2 * 1024 * 1024 + 1)); else res.writeHead(302, { location: 'http://169.254.169.254/metadata' }).end(); });
    await expect(readHealth(check(url), config, () => {})).rejects.toMatchObject({ code: 'FORBIDDEN' }); expect(count).toBe(1);
    await expect(readHealth(check(url), config, () => { throw Error('expired'); })).rejects.toThrow('expired'); expect(count).toBe(1);
    await expect(readHealth(check(url + '/large'), config, () => {})).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' });
  });
  it('rejects metadata/admin/public HTTP and validates every DNS answer before connecting', async () => {
    for (const url of ['http://169.254.169.254/a', 'http://100.100.100.200/a', 'http://[::ffff:169.254.169.254]/a', 'http://127.0.0.1:21731/a', 'https://dodo.example/a', 'http://8.8.8.8/a', 'https://user:pass@example.test/a', 'https://example.test/a?key=secret']) expect(() => validateHealthUrl(check(url), config)).toThrow();
    expect(() => validateHealthUrl({ ...check('http://127.0.0.1:8080'), allowPrivateNetwork: false }, config)).toThrow();
    vi.spyOn(dns, 'lookup').mockImplementation((async () => [{ address: '8.8.8.8', family: 4 }, { address: '169.254.169.254', family: 4 }]) as unknown as typeof dns.lookup);
    await expect(readHealth(check('https://fixture.test/health'), config, () => {})).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('required API operations/statuses and referenced component hashes must match; unsupported documents do not pass', () => {
    const operation = { responses: { '200': { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Result' } } } } } };
    const components = { schemas: { Result: { type: 'string' } } };
    const c = DeploymentHealthCheck.parse({ id: 'api', kind: 'openapi', url: 'https://fixture.test/openapi.json', requiredOperations: [{ path: '/critical', method: 'get', responses: ['200'], contractHash: digestOf({ operation, components }) }] });
    const spec = { openapi: '3.1.0', paths: { '/critical': { get: operation } }, components };
    const run = (body: unknown) => evaluateHealth(c, { status: 200, body: Buffer.from(JSON.stringify(body)) });
    expect(run(spec).passed).toBe(true);
    expect(run({ ...spec, paths: {} }).passed).toBe(false);
    expect(run({ ...spec, components: { schemas: { Result: { type: 'number' } } } }).passed).toBe(false);
    expect(run({ ...spec, openapi: 'future' }).passed).toBe(false);
    expect(run({ ...spec, paths: { '/critical': { get: { responses: { '404': {} } } } } }).passed).toBe(false);
  });
  it('rejects arbitrary Compose knobs, duplicate checks and source/volume overlap at registration', () => {
    const base = { name: 'fixture', adapter: 'docker-compose', composeProject: 'fixture', service: 'web', requiredChecks: [{ taskId: 'test', recipeDigest: 'sha256:' + 'a'.repeat(64) }], health: [check('https://fixture.example')] };
    expect(DeploymentTargetSchema.safeParse(base).success).toBe(true);
    for (const extra of [{ privileged: true }, { host: '/var/run/docker.sock' }, { health: [base.health[0], base.health[0]] }, { sourceMapping: { containerRoot: '/src' }, volumes: [{ name: 'data', target: '/src/data' }] }])
      expect(DeploymentTargetSchema.safeParse({ ...base, ...extra }).success).toBe(false);
  });
});
