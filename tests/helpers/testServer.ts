import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { startServer, type RunningServer } from '../../src/server/appServer.js';
import { saveGlobalConfig, GlobalConfigSchema } from '../../src/config/globalConfig.js';
import { statePaths } from '../../src/config/paths.js';
import { addStaticClient } from '../../src/auth/clients.js';
import type { TrustMode } from '../../src/store/store.js';

/**
 * Test harness: boots a REAL DODO server (real HTTP, real OAuth provider,
 * real SQLite) on an ephemeral port with an isolated config dir and fixture
 * workspace under os.tmpdir() (short paths keep Unix sockets legal).
 */
export interface TestContext {
  server: RunningServer;
  baseUrl: string;
  port: number;
  fixtureDir: string;
  configDir: string;
  redirectUri: string;
  /** Private Local Config URL (with capability fragment) when launched with configPort. */
  configUrl: string | null;
  cleanup: () => Promise<void>;
}

export interface LaunchOptions {
  fixtureFiles?: Record<string, string>;
  trust?: TrustMode;
  locked?: boolean;
  limitsPatch?: Record<string, number>;
  configPatch?: Record<string, unknown>;
  fixtureDir?: string; // reuse an existing fixture dir
  configDir?: string; // reuse an existing config dir (restart scenarios)
  rootOverride?: string;
  port?: number; // reuse a fixed port (restart scenarios keep the same issuer)
  configPort?: number; // start the owner-only Local Config plane (0 = ephemeral)
  toolSurface?: 'compact' | 'full' | 'hybrid'; // explicit surface override for this run
  drainTimeoutMs?: number; // workspace-switch drain wait (tests use a short one)
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

export function mkTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function writeFixture(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
}

const ENV_KEY = 'DODO_CONFIG_DIR';

/**
 * fetch with one retry on a transient socket reset. Node's global fetch pools
 * keep-alive connections; tests that restart a server on the SAME port can
 * hit a stale pooled socket on the first request afterwards — exactly the
 * reconnect a real client performs.
 */
export async function rfetch(input: string | URL, init?: RequestInit, attempts = 3): Promise<Response> {
  for (let i = 0; ; i += 1) {
    try {
      return await fetch(input, init);
    } catch (err) {
      const code = (err as { cause?: { code?: string } }).cause?.code;
      if (i < attempts && (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET' || code === 'ECONNREFUSED')) {
        await new Promise((r) => setTimeout(r, 150 * (i + 1)));
        continue;
      }
      throw err;
    }
  }
}

export async function launch(opts: LaunchOptions = {}): Promise<TestContext> {
  const fixtureDir = opts.fixtureDir ?? mkTmpDir('dodo-fix-');
  if (opts.fixtureFiles) writeFixture(fixtureDir, opts.fixtureFiles);
  const configDir = opts.configDir ?? mkTmpDir('dodo-cfg-');
  const port = opts.port ?? (await freePort());
  const publicUrl = `http://127.0.0.1:${port}`;
  const paths = statePaths(configDir);
  fs.mkdirSync(configDir, { recursive: true });
  if (!opts.locked) {
    const config = GlobalConfigSchema.parse({
      publicUrl,
      port,
      dangerouslyAllowInsecurePublicUrl: true,
      ...(opts.limitsPatch ? { limits: opts.limitsPatch } : {}),
      ...(opts.configPatch ?? {}),
    });
    saveGlobalConfig(paths.configFile, config);
  } else if (opts.limitsPatch || opts.configPatch) {
    saveGlobalConfig(paths.configFile, GlobalConfigSchema.parse({ ...(opts.limitsPatch ? { limits: opts.limitsPatch } : {}), ...(opts.configPatch ?? {}) }));
  }

  const prevEnv = process.env[ENV_KEY];
  process.env[ENV_KEY] = configDir;
  let server: RunningServer;
  try {
    server = await startServer({
      invokedCwd: opts.rootOverride ?? fixtureDir,
      portOverride: port,
      quiet: true,
      ...(opts.configPort !== undefined ? { configPort: opts.configPort } : {}),
      ...(opts.toolSurface !== undefined ? { toolSurface: opts.toolSurface } : {}),
      ...(opts.drainTimeoutMs !== undefined ? { drainTimeoutMs: opts.drainTimeoutMs } : {}),
    });
  } finally {
    if (prevEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = prevEnv;
  }
  if (opts.trust) {
    server.services.store.setTrustMode(server.workspaceId, opts.trust);
  }
  return {
    server,
    baseUrl: publicUrl,
    port,
    fixtureDir,
    configDir,
    redirectUri: 'http://127.0.0.1:19999/dodo-callback',
    configUrl: server.configUrl,
    cleanup: async () => {
      await server.close();
    },
  };
}

// ---------------------------------------------------------------------------
// OAuth flow driver (cookie jar + PKCE) — exercises the REAL provider routes.
// ---------------------------------------------------------------------------
export class CookieJar {
  private cookies = new Map<string, string>();

  absorb(res: Response): void {
    for (const raw of res.headers.getSetCookie()) {
      const [pair] = raw.split(';');
      if (!pair) continue;
      const eq = pair.indexOf('=');
      if (eq === -1) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === '' || raw.toLowerCase().includes('expires=thu, 01 jan 1970')) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  header(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  clientId: string;
  clientSecret: string;
  grantId: string;
  interactionUid: string;
  callbackUrl: string; // the final redirect back to the client (code, state, iss)
}

export interface OAuthFlowOptions {
  scope?: string;
  approve?: boolean; // default true: owner approves over (simulated) IPC path
  clientId?: string;
  clientSecret?: string;
  verifierOverride?: string; // to test wrong-PKCE
  resource?: string;
}

/** Full authorization-code + PKCE dance against a running test server. */
export async function obtainToken(ctx: TestContext, opts: OAuthFlowOptions = {}): Promise<TokenSet> {
  const store = ctx.server.services.store;
  let clientId = opts.clientId;
  let clientSecret = opts.clientSecret;
  if (!clientId) {
    const info = addStaticClient(store, { redirectUris: [ctx.redirectUri], name: 'test client' });
    clientId = info.clientId;
    clientSecret = info.clientSecret as string;
  }
  const { verifier, challenge } = pkcePair();
  const jar = new CookieJar();
  const scope = opts.scope ?? 'dodo:read dodo:write dodo:exec offline_access';
  const resource = opts.resource ?? `${ctx.baseUrl}/mcp`;
  const authUrl = new URL(`${ctx.baseUrl}/auth`);
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', ctx.redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', scope);
  authUrl.searchParams.set('state', randomBytes(8).toString('hex'));
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('resource', resource);

  const authRes = await rfetch(authUrl, { redirect: 'manual' });
  jar.absorb(authRes);
  if (authRes.status !== 303 && authRes.status !== 302) {
    throw new Error(`authorize: expected redirect, got ${authRes.status}: ${await authRes.text()}`);
  }
  const interactionLoc = authRes.headers.get('location') as string;
  const interactionUrl = interactionLoc.startsWith('http') ? interactionLoc : `${ctx.baseUrl}${interactionLoc}`;
  const uid = interactionUrl.split('/interaction/')[1]?.split(/[/?#]/)[0] as string;

  const pageRes = await rfetch(interactionUrl, { headers: { cookie: jar.header() }, redirect: 'manual' });
  jar.absorb(pageRes);
  if (pageRes.status !== 200) throw new Error(`interaction page: ${pageRes.status} ${await pageRes.text()}`);

  if (opts.approve === false) {
    return { accessToken: '', clientId, clientSecret: clientSecret ?? '', grantId: '', interactionUid: uid, callbackUrl: '' };
  }
  // Owner approval — the same state change `dodo auth approve` performs over IPC.
  if (!store.setApprovalStatus(uid, 'approved')) throw new Error('could not approve interaction');

  const completeRes = await rfetch(`${ctx.baseUrl}/interaction/${uid}/complete`, {
    method: 'POST',
    headers: { cookie: jar.header(), 'x-dodo-interaction': uid },
  });
  jar.absorb(completeRes);
  const completeBody = (await completeRes.json()) as { returnTo?: string; error?: string };
  if (!completeBody.returnTo) throw new Error(`complete failed: ${JSON.stringify(completeBody)}`);

  const resumeRes = await rfetch(completeBody.returnTo, { headers: { cookie: jar.header() }, redirect: 'manual' });
  jar.absorb(resumeRes);
  const finalLoc = resumeRes.headers.get('location');
  if (!finalLoc || !finalLoc.startsWith(ctx.redirectUri)) {
    throw new Error(`resume: expected redirect to client, got ${resumeRes.status} ${finalLoc ?? ''} ${await resumeRes.text()}`);
  }
  const cbUrl = new URL(finalLoc);
  const code = cbUrl.searchParams.get('code');
  if (!code) throw new Error(`no code on callback: ${finalLoc}`);

  const tokenRes = await rfetch(`${ctx.baseUrl}/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: ctx.redirectUri,
      code_verifier: opts.verifierOverride ?? verifier,
      resource,
    }).toString(),
  });
  const tokenBody = (await tokenRes.json()) as Record<string, unknown>;
  if (tokenRes.status !== 200) {
    throw new TokenError(`token endpoint ${tokenRes.status}: ${JSON.stringify(tokenBody)}`, tokenBody);
  }
  const grants = store.listGrants(ctx.server.workspaceId);
  const grantId = grants[grants.length - 1]?.id ?? '';
  const out: TokenSet = {
    accessToken: tokenBody['access_token'] as string,
    clientId,
    clientSecret: clientSecret ?? '',
    grantId,
    interactionUid: uid,
    callbackUrl: finalLoc,
  };
  if (typeof tokenBody['refresh_token'] === 'string') out.refreshToken = tokenBody['refresh_token'];
  return out;
}

export class TokenError extends Error {
  constructor(
    message: string,
    readonly body: Record<string, unknown>,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// MCP call helpers
// ---------------------------------------------------------------------------

/** Raw 2025-era (legacy stateless) JSON-RPC POST. */
export async function mcpRaw(ctx: TestContext, body: unknown, token?: string, extraHeaders: Record<string, string> = {}): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...extraHeaders,
  };
  if (token) headers['authorization'] = `Bearer ${token}`;
  return fetch(`${ctx.baseUrl}/mcp`, { method: 'POST', headers, body: JSON.stringify(body) });
}

let rpcId = 100;

export function initializeBody(): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id: rpcId++,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'legacy-test-client', version: '1.0.0' },
    },
  };
}

export function rpc(method: string, params?: unknown): Record<string, unknown> {
  const body: Record<string, unknown> = { jsonrpc: '2.0', id: rpcId++, method };
  if (params !== undefined) body['params'] = params;
  return body;
}

/** Parse a JSON or single-event SSE MCP response body. */
export async function parseMcpResponse(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('text/event-stream')) {
    for (const line of text.split('\n')) {
      if (line.startsWith('data: ')) {
        return JSON.parse(line.slice(6)) as Record<string, unknown>;
      }
    }
    throw new Error(`no data event in SSE body: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text) as Record<string, unknown>;
}

/** Call one tool over the legacy stateless wire and return the envelope. */
export async function callToolLegacy(
  ctx: TestContext,
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ envelope: Record<string, unknown>; isError: boolean; raw: Record<string, unknown> }> {
  const res = await mcpRaw(ctx, rpc('tools/call', { name, arguments: args }), token);
  if (res.status !== 200) throw new Error(`tools/call HTTP ${res.status}: ${await res.text()}`);
  const body = await parseMcpResponse(res);
  // A JSON-RPC error (e.g. input-schema validation) never reaches the handler.
  if (body['error']) throw new Error(`tools/call rejected (${name}): ${JSON.stringify(body['error']).slice(0, 400)}`);
  const result = body['result'] as Record<string, unknown> | undefined;
  if (!result) throw new Error(`no result: ${JSON.stringify(body).slice(0, 500)}`);
  return {
    envelope: (result['structuredContent'] ?? {}) as Record<string, unknown>,
    isError: result['isError'] === true,
    raw: body,
  };
}

/** Convenience: full workspace context for tool args. */
export function wsArgs(ctx: TestContext): { workspaceId: string; workspaceEpoch: string } {
  return { workspaceId: ctx.server.workspaceId, workspaceEpoch: ctx.server.epoch };
}

/**
 * Raw HTTP request that CAN set the Host header (Node's fetch forbids it), for
 * DNS-rebinding / Host-allowlist tests.
 */
export async function rawHttp(
  ctx: TestContext,
  opts: { method?: string; path?: string; host?: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; body: string }> {
  const http = await import('node:http');
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: ctx.port,
        method: opts.method ?? 'POST',
        path: opts.path ?? '/mcp',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(opts.host ? { host: opts.host } : {}),
          ...(opts.headers ?? {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}
