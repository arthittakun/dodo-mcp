import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { launch, obtainToken, mcpRaw, initializeBody, rpc, parseMcpResponse, callToolLegacy, wsArgs, type TestContext, type TokenSet } from '../helpers/testServer.js';
import { TOOL_CATALOG } from '../../src/tools/catalog.js';

const TOOL_COUNT = TOOL_CATALOG.length;

/**
 * M0 compatibility gate: real transport + real OAuth against the actual
 * installed SDK v2 and oidc-provider. No mocks anywhere.
 */
describe('M0: transport + OAuth vertical slice', () => {
  let ctx: TestContext;
  let tokens: TokenSet;

  beforeAll(async () => {
    ctx = await launch({ toolSurface: 'full', 
      fixtureFiles: {
        'package.json': JSON.stringify({ name: 'fixture', version: '1.0.0', scripts: { hello: 'node -e "console.log(1)"' } }),
        'src/index.ts': 'export const answer = 42;\n',
        'README.md': '# Fixture project\n',
      },
    });
    tokens = await obtainToken(ctx);
  }, 120_000);

  afterAll(async () => {
    await ctx?.cleanup();
  });

  it('healthz answers without leaking paths', async () => {
    const res = await fetch(`${ctx.baseUrl}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['status']).toBe('ok');
    expect(JSON.stringify(body)).not.toContain(ctx.fixtureDir);
  });

  it('OAuth flow issued a usable access token bound to the workspace grant', () => {
    expect(tokens.accessToken.length).toBeGreaterThan(20);
    expect(tokens.grantId.length).toBeGreaterThan(5);
    const grant = ctx.server.services.store.getGrant(tokens.grantId);
    expect(grant?.workspaceId).toBe(ctx.server.workspaceId);
  });

  it(`MCP-01: modern SDK client lists all ${TOOL_COUNT} tools and calls project_overview`, async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${ctx.baseUrl}/mcp`), {
      authProvider: { token: async () => tokens.accessToken },
    });
    const client = new Client({ name: 'm0-modern-client', version: '1.0.0' });
    await client.connect(transport);
    try {
      const list = await client.listTools();
      expect(list.tools.length).toBe(TOOL_COUNT);
      const names = list.tools.map((t) => t.name);
      expect(names[0]).toBe('project_overview');
      expect(names).toContain('apply_changes');
      expect(names).toContain('handoff_write');
      const result = await client.callTool({ name: 'project_overview', arguments: {} });
      const env = result.structuredContent as Record<string, unknown>;
      expect(env['ok']).toBe(true);
      expect(env['workspaceId']).toBe(ctx.server.workspaceId);
      const data = env['data'] as Record<string, unknown>;
      expect(data['root']).toBe(ctx.server.root);
      expect((data['instructions'] as string).length).toBeGreaterThan(10);
    } finally {
      await client.close();
    }
  }, 60_000);

  it('MCP-02: 2025-era initialize + subsequent stateless tool calls work without a session id', async () => {
    const initRes = await mcpRaw(ctx, initializeBody(), tokens.accessToken);
    expect(initRes.status).toBe(200);
    const initBody = await parseMcpResponse(initRes);
    const initResult = initBody['result'] as Record<string, unknown>;
    expect(initResult['protocolVersion']).toBe('2025-03-26');
    expect(initRes.headers.get('mcp-session-id')).toBeNull();

    const listRes = await mcpRaw(ctx, rpc('tools/list'), tokens.accessToken);
    expect(listRes.status).toBe(200);
    const listBody = await parseMcpResponse(listRes);
    const tools = (listBody['result'] as { tools: Array<{ name: string }> }).tools;
    expect(tools.length).toBe(TOOL_COUNT);

    const call = await callToolLegacy(ctx, tokens.accessToken, 'project_overview', {});
    expect(call.isError).toBe(false);
    expect(call.envelope['ok']).toBe(true);
  });

  it('MCP-03: GET and DELETE are 405 in stateless mode', async () => {
    for (const method of ['GET', 'DELETE']) {
      const res = await fetch(`${ctx.baseUrl}/mcp`, {
        method,
        headers: { authorization: `Bearer ${tokens.accessToken}`, accept: 'application/json, text/event-stream' },
      });
      expect(res.status).toBe(405);
    }
  });

  it('MCP-08: tool catalog order and schemas are deterministic across requests', async () => {
    const a = await parseMcpResponse(await mcpRaw(ctx, rpc('tools/list'), tokens.accessToken));
    const b = await parseMcpResponse(await mcpRaw(ctx, rpc('tools/list'), tokens.accessToken));
    const strip = (x: unknown) => JSON.stringify(x, (k, v: unknown) => (k === 'id' ? undefined : v));
    expect(strip(a['result'])).toBe(strip(b['result']));
  });

  it('workspace context is enforced (WORKSPACE_MISMATCH / STALE_WORKSPACE)', async () => {
    const wrong = await callToolLegacy(ctx, tokens.accessToken, 'list_files', {
      workspaceId: 'ws_bogus',
      workspaceEpoch: ctx.server.epoch,
      path: '.',
    });
    expect(wrong.isError).toBe(true);
    expect((wrong.envelope['error'] as Record<string, unknown>)['code']).toBe('WORKSPACE_MISMATCH');

    const stale = await callToolLegacy(ctx, tokens.accessToken, 'list_files', {
      workspaceId: ctx.server.workspaceId,
      workspaceEpoch: 'boot_bogus',
      path: '.',
    });
    expect(stale.isError).toBe(true);
    expect((stale.envelope['error'] as Record<string, unknown>)['code']).toBe('STALE_WORKSPACE');

    const good = await callToolLegacy(ctx, tokens.accessToken, 'list_files', { ...wsArgs(ctx), path: '.' });
    expect(good.isError).toBe(false);
  });

  it('read_files returns content + raw-byte hash for the fixture', async () => {
    const res = await callToolLegacy(ctx, tokens.accessToken, 'read_files', {
      ...wsArgs(ctx),
      files: [{ path: 'src/index.ts' }],
    });
    expect(res.isError).toBe(false);
    const data = res.envelope['data'] as { files: Array<{ content: string; hash: string; totalLines: number }> };
    expect(data.files[0]?.content).toContain('answer = 42');
    expect(data.files[0]?.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
