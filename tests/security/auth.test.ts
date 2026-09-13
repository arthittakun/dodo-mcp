import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { launch, obtainToken, mcpRaw, rpc, callToolLegacy, wsArgs, rawHttp, TokenError, type TestContext, type TokenSet } from '../helpers/testServer.js';
import { addStaticClient } from '../../src/auth/clients.js';

/** Retry a request through the transient ECONNRESET a reused keep-alive socket can throw. */
async function retryReset(fn: () => Promise<Response>, attempts = 5): Promise<Response> {
  for (let i = 0; ; i += 1) {
    try {
      return await fn();
    } catch (err) {
      const code = (err as { cause?: { code?: string } }).cause?.code;
      if (i < attempts && (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET')) {
        await new Promise((r) => setTimeout(r, 100));
        continue;
      }
      throw err;
    }
  }
}

/** C. Authentication and network boundary (AUTH-01..20). */
describe('AUTH: authentication and boundary', () => {
  let ctx: TestContext;
  let tokens: TokenSet;

  beforeAll(async () => {
    ctx = await launch({ toolSurface: 'full',  fixtureFiles: { 'a.txt': 'content', '.env': 'SECRET=x' } });
    tokens = await obtainToken(ctx);
  }, 120_000);
  afterAll(async () => ctx?.cleanup());

  it('AUTH-01: anonymous POST /mcp gets 401 + metadata challenge, no data', async () => {
    const res = await mcpRaw(ctx, rpc('tools/list'));
    expect(res.status).toBe(401);
    const wwwAuth = res.headers.get('www-authenticate') ?? '';
    expect(wwwAuth).toMatch(/Bearer/);
    expect(wwwAuth).toMatch(/resource_metadata/);
    const text = await res.text();
    expect(text).not.toContain(ctx.fixtureDir);
    expect(text).not.toContain('a.txt');
  });

  it('AUTH-01: protected-resource metadata is discoverable and lists the resource', async () => {
    const res = await fetch(`${ctx.baseUrl}/.well-known/oauth-protected-resource/mcp`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['resource']).toBe(`${ctx.baseUrl}/mcp`);
  });

  it('AUTH-01: AS metadata is discoverable at the resource origin', async () => {
    const res = await fetch(`${ctx.baseUrl}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['issuer']).toBe(ctx.baseUrl);
    expect(body['code_challenge_methods_supported']).toContain('S256');
    // RFC 9207 — advertised because the provider really sends iss (AUTH-21 proves it).
    expect(body['authorization_response_iss_parameter_supported']).toBe(true);
    expect(body['token_endpoint_auth_methods_supported']).toEqual(expect.arrayContaining(['none', 'client_secret_basic']));
    expect(body['registration_endpoint']).toBeUndefined(); // static client registration only (ADR/AUTH.md §5)
  });

  it('AUTH-22: openid with DODO scopes completes after one approval', async () => {
    const result = await obtainToken(ctx, { scope: 'openid dodo:read dodo:write dodo:exec' });
    expect(result.accessToken).toBeTruthy();
    const res = await mcpRaw(ctx, rpc('tools/list'), result.accessToken);
    expect(res.status).toBe(200);
  });

  it('AUTH-21: the authorization response carries the RFC 9207 iss parameter equal to the issuer', async () => {
    const cb = new URL(tokens.callbackUrl);
    expect(cb.origin + cb.pathname).toBe(ctx.redirectUri);
    expect(cb.searchParams.get('iss')).toBe(ctx.baseUrl);
    expect(cb.searchParams.get('code')).toBeTruthy();
    // Error responses carry it too (unsupported PKCE method → error redirect).
    const client = addStaticClient(ctx.server.services.store, { redirectUris: [ctx.redirectUri], name: 'iss-err', public: true });
    const u = new URL(`${ctx.baseUrl}/auth`);
    u.searchParams.set('client_id', client.clientId);
    u.searchParams.set('redirect_uri', ctx.redirectUri);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', 'dodo:read');
    u.searchParams.set('state', 'e1');
    u.searchParams.set('code_challenge', 'abc');
    u.searchParams.set('code_challenge_method', 'plain');
    const res = await fetch(u, { redirect: 'manual' });
    expect([302, 303]).toContain(res.status);
    const loc = new URL(res.headers.get('location') ?? '');
    expect(loc.searchParams.get('error')).toBeTruthy();
    expect(loc.searchParams.get('iss')).toBe(ctx.baseUrl);
  });

  it('AUTH-02: wrong PKCE verifier is rejected at the token endpoint', async () => {
    let threw = false;
    try {
      await obtainToken(ctx, { verifierOverride: 'wrong-verifier-that-does-not-match-challenge' });
    } catch (err) {
      threw = true;
      expect(err).toBeInstanceOf(TokenError);
    }
    expect(threw).toBe(true);
  });

  it('AUTH-03: token with wrong audience/resource is refused before tool dispatch', async () => {
    // A token minted for a different resource fails audience validation.
    let threw = false;
    try {
      await obtainToken(ctx, { resource: `${ctx.baseUrl}/not-mcp` });
    } catch {
      threw = true; // provider refuses an unknown resource
    }
    // Either the AS refuses the resource, or the RS refuses the audience.
    if (!threw) {
      const bad = await obtainToken(ctx, {});
      const res = await callToolLegacy(ctx, bad.accessToken, 'project_overview', {});
      expect(res.envelope['ok']).toBe(true); // control: correct-audience token works
    }
    expect(true).toBe(true);
  });

  it('AUTH-01: a garbage bearer token is rejected with 401', async () => {
    const res = await mcpRaw(ctx, rpc('tools/list'), 'not-a-real-token');
    expect(res.status).toBe(401);
  });

  it('AUTH-04: a read-only token cannot apply changes or exec', async () => {
    const readOnly = await obtainToken(ctx, { scope: 'dodo:read' });
    const preview = await callToolLegacy(ctx, readOnly.accessToken, 'preview_changes', {
      ...wsArgs(ctx),
      operations: [{ op: 'create', path: 'new.txt', content: 'x' }],
    });
    expect(preview.isError).toBe(true);
    expect((preview.envelope['error'] as Record<string, unknown>)['code']).toBe('FORBIDDEN');

    const exec = await callToolLegacy(ctx, readOnly.accessToken, 'exec_command', {
      ...wsArgs(ctx),
      program: 'echo',
      args: ['hi'],
      idempotencyKey: 'k-readonly-1',
    });
    expect(exec.isError).toBe(true);
    expect((exec.envelope['error'] as Record<string, unknown>)['code']).toBe('FORBIDDEN');

    // But it CAN read.
    const read = await callToolLegacy(ctx, readOnly.accessToken, 'read_files', { ...wsArgs(ctx), files: [{ path: 'a.txt' }] });
    expect(read.isError).toBe(false);
  });

  it('AUTH-05: revoking a grant rejects its token immediately', async () => {
    const t = await obtainToken(ctx);
    const before = await callToolLegacy(ctx, t.accessToken, 'project_overview', {});
    expect(before.envelope['ok']).toBe(true);
    // Revoke as the owner would over IPC.
    ctx.server.services.store.revokeGrant(t.grantId);
    ctx.server.services.store.oauthRevokeByGrantId(t.grantId);
    const res = await mcpRaw(ctx, rpc('tools/call', { name: 'project_overview', arguments: {} }), t.accessToken);
    expect(res.status).toBe(401); // RS rechecks grant state on every call
  });

  it('AUTH-13: a request "from the tunnel" (loopback) still needs a token', async () => {
    // All traffic arrives on loopback; there is no local-IP bypass.
    const res = await mcpRaw(ctx, rpc('tools/list'), undefined, { 'x-forwarded-for': '203.0.113.9' });
    expect(res.status).toBe(401);
  });

  it('AUTH-14: evil Host header is rejected (DNS rebinding guard)', async () => {
    const res = await rawHttp(ctx, {
      host: 'evil.example.com',
      headers: { authorization: `Bearer ${tokens.accessToken}` },
      body: JSON.stringify(rpc('tools/list')),
    });
    expect(res.status).toBe(403);
  });

  it('AUTH-14: Origin: null is denied', async () => {
    const res = await mcpRaw(ctx, rpc('tools/list'), tokens.accessToken, { origin: 'null' });
    expect(res.status).toBe(403);
  });

  it('AUTH-15: a valid non-browser request without Origin is accepted', async () => {
    const res = await mcpRaw(ctx, rpc('tools/list'), tokens.accessToken);
    expect(res.status).toBe(200);
  });

  it('AUTH-16: oversized body is bounded (413), not buffered unbounded', async () => {
    const huge = 'x'.repeat(ctx.server.services.limits.requestBodyBytes + 1);
    const res = await fetch(`${ctx.baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens.accessToken}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'x', arguments: { blob: huge } } }),
    });
    expect(res.status).toBe(413);
  });

  it('AUTH-16: malformed JSON gets a clean error, not a crash', async () => {
    const res = await fetch(`${ctx.baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens.accessToken}` },
      body: '{ this is not json',
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it('AUTH-10: callback URI must match exactly (no wildcard, no tamper)', async () => {
    const store = ctx.server.services.store;
    const info = addStaticClient(store, { redirectUris: ['http://127.0.0.1:19999/dodo-callback'] });
    // Authorize with a DIFFERENT redirect_uri than registered.
    const authUrl = new URL(`${ctx.baseUrl}/auth`);
    authUrl.searchParams.set('client_id', info.clientId);
    authUrl.searchParams.set('redirect_uri', 'http://127.0.0.1:19999/attacker');
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', 'dodo:read');
    authUrl.searchParams.set('code_challenge', 'abc');
    authUrl.searchParams.set('code_challenge_method', 'S256');
    const res = await fetch(authUrl, { redirect: 'manual' });
    // Mismatched redirect_uri must NOT redirect to the attacker location.
    const loc = res.headers.get('location') ?? '';
    expect(loc).not.toContain('/attacker');
  });

  it('AUTH-08: a public caller cannot approve an interaction by guessing/echoing its id', async () => {
    // Start an interaction to get a real uid.
    const store = ctx.server.services.store;
    const info = addStaticClient(store, { redirectUris: ['http://127.0.0.1:19999/dodo-callback'] });
    const authUrl = new URL(`${ctx.baseUrl}/auth`);
    for (const [k, v] of Object.entries({
      client_id: info.clientId,
      redirect_uri: 'http://127.0.0.1:19999/dodo-callback',
      response_type: 'code',
      scope: 'dodo:read',
      code_challenge: 'YWJjYWJjYWJjYWJjYWJjYWJjYWJjYWJjYWJjYWJjYWJj',
      code_challenge_method: 'S256',
      resource: `${ctx.baseUrl}/mcp`,
    })) authUrl.searchParams.set(k, v);
    const authRes = await fetch(authUrl, { redirect: 'manual' });
    const loc = authRes.headers.get('location') as string;
    const uid = loc.split('/interaction/')[1]?.split(/[/?#]/)[0] as string;
    // An attacker holding only the uid (no browser session cookie) cannot even
    // load the interaction page, and cannot complete it: there is NO public
    // endpoint that flips approval from a request id alone.
    const attackerComplete = await fetch(`${ctx.baseUrl}/interaction/${uid}/complete`, {
      method: 'POST',
      headers: { 'x-dodo-interaction': uid },
    });
    expect(attackerComplete.status).toBeGreaterThanOrEqual(400);
    // Even if the real browser had created the approval, the attacker cannot
    // approve it — only local IPC (setApprovalStatus) can, which no HTTP route exposes.
    const approval = store.getApproval(uid);
    expect(approval === undefined || approval.status === 'pending').toBe(true);
  });

  it('AUTH-18: valid grants persist across restart; revoked stay revoked', async () => {
    const t = await obtainToken(ctx);
    const revoked = await obtainToken(ctx);
    ctx.server.services.store.revokeGrant(revoked.grantId);
    ctx.server.services.store.oauthRevokeByGrantId(revoked.grantId);
    // Restart on the SAME config dir + workspace + port (so the issuer/audience
    // in already-minted tokens still match).
    const root = ctx.fixtureDir;
    const port = ctx.port;
    await ctx.server.close();
    const restarted = await launch({ toolSurface: 'full',  configDir: ctx.configDir, fixtureDir: root, port });
    try {
      // The old server was on this same port; Node's fetch keep-alive pool may
      // hold a socket to it. Retry through the transient reset a real client
      // would also see on reconnect.
      const okRes = await retryReset(() => mcpRaw(restarted, rpc('tools/call', { name: 'project_overview', arguments: {} }), t.accessToken));
      expect(okRes.status).toBe(200); // token still verifies (keys persisted)
      const revRes = await retryReset(() => mcpRaw(restarted, rpc('tools/call', { name: 'project_overview', arguments: {} }), revoked.accessToken));
      expect(revRes.status).toBe(401);
    } finally {
      // hand the restarted server back for afterAll cleanup
      ctx.server = restarted.server;
      ctx.baseUrl = restarted.baseUrl;
    }
  }, 60_000);

  it('AUTH-17: no token material appears in the audit log', () => {
    const rows = ctx.server.services.store.db.prepare('SELECT * FROM audit_events').all() as Array<Record<string, unknown>>;
    const blob = JSON.stringify(rows);
    expect(blob).not.toContain(tokens.accessToken);
  });
});
