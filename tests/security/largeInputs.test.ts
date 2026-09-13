import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { launch, obtainToken, callToolLegacy, wsArgs, type TestContext, type TokenSet } from '../helpers/testServer.js';

describe('large input boundaries', () => {
  let ctx: TestContext;
  let tokens: TokenSet;
  beforeEach(async () => {
    ctx = await launch({ toolSurface: 'full',  trust: 'trusted', limitsPatch: { commandBytes: 32 * 1024, readFileBytes: 16 * 1024, requestBodyBytes: 64 * 1024 } });
    tokens = await obtainToken(ctx);
  }, 60_000);
  afterEach(async () => {
    await ctx?.cleanup();
    if (ctx) { fs.rmSync(ctx.fixtureDir, { recursive: true, force: true }); fs.rmSync(ctx.configDir, { recursive: true, force: true }); }
  });
  const call = (name: string, args: Record<string, unknown>) => callToolLegacy(ctx, tokens.accessToken, name, { ...wsArgs(ctx), ...args });
  const code = (env: Record<string, unknown>) => (env['error'] as { code: string })?.code;

  it('LARGE-SEC-01: UTF-8 command byte cap is enforced; an invalid batch starts zero jobs', async () => {
    const command = '# ' + 'ก'.repeat(11000);
    const single = await call('run_command', { command });
    expect(code(single.envelope)).toBe('RESOURCE_LIMIT');
    const batch = await call('run_commands', { commands: [{ command: 'touch should-not-exist' }, { command }] });
    expect(code(batch.envelope)).toBe('RESOURCE_LIMIT');
    expect(ctx.server.services.jobs.list(ctx.server.workspaceId, 10)).toEqual([]);
    expect(fs.readdirSync(ctx.fixtureDir)).toEqual([]);
  });

  it('LARGE-SEC-02: approval is required before creating private scripts or launching processes', async () => {
    ctx.server.services.store.setTrustMode(ctx.server.workspaceId, 'inspect');
    const denied = await call('run_command', { command: '# ' + 'x'.repeat(20000) + '\ntouch denied' });
    expect(code(denied.envelope)).toBe('APPROVAL_REQUIRED');
    expect(ctx.server.services.jobs.list(ctx.server.workspaceId, 10)).toEqual([]);
    expect(fs.readdirSync(path.join(ctx.configDir, 'jobs'))).toEqual([]);
    expect(fs.readdirSync(ctx.fixtureDir)).toEqual([]);
  });

  it('LARGE-SEC-03: UTF-8 file limits, secret paths and traversal still reject before writing', async () => {
    const oversized = await call('write_file', { path: 'big.txt', content: 'ก'.repeat(5500) });
    expect(code(oversized.envelope)).toBe('FILE_TOO_LARGE');
    expect(fs.existsSync(path.join(ctx.fixtureDir, 'big.txt'))).toBe(false);
    for (const target of ['../outside.txt', '.env']) {
      const res = await call('write_file', { path: target, content: 'x'.repeat(10000) });
      expect(res.envelope['ok']).toBe(false);
    }
    expect(fs.readdirSync(ctx.fixtureDir)).toEqual([]);
  });

  it('LARGE-SEC-04: HTTP body budget returns 413 and unauthenticated requests still get 401', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'write_file', arguments: { ...wsArgs(ctx), path: 'huge.txt', content: 'x'.repeat(70000) } } });
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    const authenticated = await fetch(`${ctx.baseUrl}/mcp`, { method: 'POST', headers: { ...headers, authorization: `Bearer ${tokens.accessToken}` }, body });
    expect(authenticated.status).toBe(413);
    await authenticated.text();
    const unauthenticated = await fetch(`${ctx.baseUrl}/mcp`, { method: 'POST', headers, body });
    expect(unauthenticated.status).toBe(401);
    await unauthenticated.text();
    expect(fs.readdirSync(ctx.fixtureDir)).toEqual([]);
  });

  it('LARGE-SEC-05: a NUL in later batch source rejects the batch before the first command runs', async () => {
    const res = await call('run_commands', { commands: [{ command: 'touch forbidden' }, { command: 'echo bad\0source' }] });
    expect(code(res.envelope)).toBe('INVALID_INPUT');
    expect(ctx.server.services.jobs.list(ctx.server.workspaceId, 10)).toEqual([]);
    expect(fs.readdirSync(ctx.fixtureDir)).toEqual([]);
  });

  it('LARGE-SEC-06: multiplicative replacements fail before allocating oversized results or changing files', async () => {
    const original = 'a'.repeat(1000);
    const file = path.join(ctx.fixtureDir, 'expand.txt');
    fs.writeFileSync(file, original);
    const replace = 'x'.repeat(10000);
    const requests: Array<[string, Record<string, unknown>]> = [
      ['edit_file', { path: 'expand.txt', edits: [{ find: 'a', replace, replaceAll: true }] }],
      ['preview_changes', { operations: [{ op: 'replace_exact', path: 'expand.txt', find: 'a', replace, expectedCount: 1000 }] }],
      ['replace_in_files', { paths: ['expand.txt'], find: 'a', replace, dryRun: false }],
    ];
    for (const [name, args] of requests) {
      expect(code((await call(name, args)).envelope)).toBe('FILE_TOO_LARGE');
      expect(fs.readFileSync(file, 'utf8')).toBe(original);
    }
  });
});
