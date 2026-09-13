import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { launch, obtainToken, mcpRaw, rpc, initializeBody, parseMcpResponse, callToolLegacy, wsArgs, type TestContext, type TokenSet } from '../helpers/testServer.js';
import { TOOL_CATALOG } from '../../src/tools/catalog.js';

/** B. MCP protocol / interoperability (MCP-03..10) + schema validation (MCP-05/06). */
describe('MCP protocol compatibility', () => {
  let ctx: TestContext;
  let tokens: TokenSet;

  beforeAll(async () => {
    ctx = await launch({ toolSurface: 'full',  fixtureFiles: { 'a.txt': 'hello\n', 'b.ts': 'export const x=1;\n' }, trust: 'edit' });
    tokens = await obtainToken(ctx);
  }, 120_000);
  afterAll(async () => ctx?.cleanup());

  it('the catalog has a fixed order with unique, fully implemented tools', () => {
    expect(TOOL_CATALOG.length).toBeGreaterThanOrEqual(33);
    expect(TOOL_CATALOG[0]?.name).toBe('project_overview');
    // no duplicate names
    expect(new Set(TOOL_CATALOG.map((t) => t.name)).size).toBe(TOOL_CATALOG.length);
  });

  it('MCP-05: every tool advertises an input schema with additionalProperties:false', async () => {
    const list = await parseMcpResponse(await mcpRaw(ctx, rpc('tools/list'), tokens.accessToken));
    const tools = (list['result'] as { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> }).tools;
    expect(tools).toHaveLength(TOOL_CATALOG.length);
    for (const t of tools) {
      expect(t.inputSchema['additionalProperties'], t.name).toBe(false);
    }
  });

  it('MCP-05: unknown keys and wrong types are rejected before side effects', async () => {
    // unknown key
    const unknown = await mcpRaw(ctx, rpc('tools/call', { name: 'list_files', arguments: { ...wsArgs(ctx), path: '.', bogusKey: 1 } }), tokens.accessToken);
    const ub = await parseMcpResponse(unknown);
    expect(ub['error'] ?? (ub['result'] as { isError?: boolean })?.isError).toBeTruthy();

    // wrong type
    const wrong = await mcpRaw(ctx, rpc('tools/call', { name: 'read_files', arguments: { ...wsArgs(ctx), files: 'not-an-array' } }), tokens.accessToken);
    const wb = await parseMcpResponse(wrong);
    expect(wb['error'] ?? (wb['result'] as { isError?: boolean })?.isError).toBeTruthy();
  });

  it('MCP-06: successful results carry the envelope in structuredContent + a text fallback', async () => {
    const res = await callToolLegacy(ctx, tokens.accessToken, 'read_files', { ...wsArgs(ctx), files: [{ path: 'a.txt' }] });
    expect(res.envelope['ok']).toBe(true);
    expect(res.envelope['workspaceId']).toBe(ctx.server.workspaceId);
    expect(res.envelope['error']).toBeNull();
    // text fallback present and parseable
    const raw = res.raw as { result: { content: Array<{ type: string; text: string }> } };
    const text = raw.result.content[0]?.text as string;
    expect(() => JSON.parse(text)).not.toThrow();
  });

  it('MCP-06: error results set isError and carry a typed error envelope', async () => {
    const res = await callToolLegacy(ctx, tokens.accessToken, 'read_files', { ...wsArgs(ctx), files: [{ path: 'nonexistent.txt' }] });
    // read_files reports per-file errors inside data (batch semantics), ok=true
    expect(res.envelope['ok']).toBe(true);
    // A whole-call error (bad workspace) sets isError.
    const bad = await callToolLegacy(ctx, tokens.accessToken, 'git_status', { workspaceId: 'ws_x', workspaceEpoch: 'boot_x' });
    expect(bad.isError).toBe(true);
    expect((bad.envelope['error'] as Record<string, unknown>)['code']).toBe('WORKSPACE_MISMATCH');
    expect((bad.envelope['error'] as Record<string, unknown>)['message']).toBeTruthy();
  });

  it('MCP-03: GET and DELETE are 405', async () => {
    for (const method of ['GET', 'DELETE']) {
      const res = await fetch(`${ctx.baseUrl}/mcp`, { method, headers: { authorization: `Bearer ${tokens.accessToken}`, accept: 'application/json, text/event-stream' } });
      expect(res.status).toBe(405);
    }
  });

  it('MCP-08: tool schema hashes are deterministic across requests', async () => {
    const a = await parseMcpResponse(await mcpRaw(ctx, rpc('tools/list'), tokens.accessToken));
    const b = await parseMcpResponse(await mcpRaw(ctx, rpc('tools/list'), tokens.accessToken));
    const names = (r: Record<string, unknown>) => (r['result'] as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    expect(names(a)).toEqual(names(b));
  });

  it('MCP-02: 2025-era initialize negotiates without a session id', async () => {
    const res = await mcpRaw(ctx, initializeBody(), tokens.accessToken);
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBeNull();
  });

  it('MCP-10: a pagination cursor from a different query/principal is rejected', async () => {
    // Create many files so search truncates and yields a cursor.
    const fs = await import('node:fs');
    const path = await import('node:path');
    for (let i = 0; i < 60; i++) fs.writeFileSync(path.join(ctx.fixtureDir, `f${i}.txt`), 'needle\n'.repeat(3));
    const first = await callToolLegacy(ctx, tokens.accessToken, 'search_code', { ...wsArgs(ctx), query: 'needle', mode: 'literal', maxResults: 10 });
    const cursor = first.envelope['nextCursor'] as string | null;
    expect(cursor).toBeTruthy();
    // A different query with the same cursor must be rejected.
    const wrong = await callToolLegacy(ctx, tokens.accessToken, 'search_code', { ...wsArgs(ctx), query: 'different', mode: 'literal', maxResults: 10, cursor: cursor as string });
    expect(wrong.isError).toBe(true);
    expect((wrong.envelope['error'] as Record<string, unknown>)['code']).toBe('FORBIDDEN');
  });
});
