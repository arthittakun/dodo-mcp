import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { launch, obtainToken, mcpRaw, rpc, parseMcpResponse, callToolLegacy, wsArgs, type TestContext, type TokenSet } from '../helpers/testServer.js';
import { TOOL_CATALOG } from '../../src/tools/catalog.js';
import { COMPACT_CATALOG, HYBRID_CATALOG, surfaceCatalog } from '../../src/tools/surface.js';

/** ADR-029: HTTP defaults to the compact surface; explicit full override keeps the old contract. */

async function listTools(ctx: TestContext, token: string): Promise<Array<{ name: string; inputSchema?: Record<string, unknown> }>> {
  const res = await mcpRaw(ctx, rpc('tools/list'), token);
  expect(res.status).toBe(200);
  const body = (await parseMcpResponse(res)) as { result?: { tools?: Array<{ name: string; inputSchema?: Record<string, unknown> }> } };
  return body.result?.tools ?? [];
}

describe('compact surface over HTTP (default)', () => {
  let ctx: TestContext;
  let tokens: TokenSet;
  beforeAll(async () => {
    ctx = await launch({ fixtureFiles: { 'hello.txt': 'hello\n' }, trust: 'trusted' });
    tokens = await obtainToken(ctx);
  }, 120_000);
  afterAll(async () => ctx?.cleanup());

  const gw = (name: string, operation: string, args: Record<string, unknown> = {}) =>
    callToolLegacy(ctx, tokens.accessToken, name, { ...wsArgs(ctx), operation, args });
  const data = (r: Awaited<ReturnType<typeof gw>>) => {
    expect(r.isError, JSON.stringify(r.envelope['error'])).toBe(false);
    return r.envelope['data'] as Record<string, unknown>;
  };

  it('lists at most 20 tools: overview, discover and every gateway — far smaller on the wire than full', async () => {
    const tools = await listTools(ctx, tokens.accessToken);
    expect(tools.length).toBe(COMPACT_CATALOG.length);
    expect(tools.length).toBeLessThanOrEqual(20);
    expect(tools.map((t) => t.name)).toEqual(COMPACT_CATALOG.map((d) => d.name));
    const compactBytes = Buffer.byteLength(JSON.stringify(tools), 'utf8');
    expect(compactBytes).toBeGreaterThan(0);
  });

  it('project_overview reports the surface and both catalog sizes', async () => {
    const ov = await callToolLegacy(ctx, tokens.accessToken, 'project_overview', {});
    const d = ov.envelope['data'] as { toolSurface: string; compactToolCount: number; fullToolCount: number };
    expect(d.toolSurface).toBe('compact');
    expect(d.compactToolCount).toBe(COMPACT_CATALOG.length);
    expect(d.fullToolCount).toBe(TOOL_CATALOG.length);
  });

  it('discover → write → read → edit → read-back → delete, all through gateways', async () => {
    const disc = await callToolLegacy(ctx, tokens.accessToken, 'dodo_discover', { ...wsArgs(ctx), query: 'edit a TypeScript file', limit: 5 });
    const matches = (disc.envelope['data'] as { matches: Array<{ operation: string; gateway: string }> }).matches;
    expect(matches.map((m) => m.operation)).toContain('write_file');
    const detail = await callToolLegacy(ctx, tokens.accessToken, 'dodo_discover', { ...wsArgs(ctx), operation: 'write_file' });
    expect(((detail.envelope['data'] as { inputSchema: { properties: Record<string, unknown> } }).inputSchema.properties)['content']).toBeDefined();

    const w = data(await gw('dodo_write', 'write_file', { path: 'tmp/compact-write-test.txt', content: 'alpha\n' }));
    expect(w['path']).toBe('tmp/compact-write-test.txt');
    const r1 = data(await gw('dodo_read', 'read_files', { files: [{ path: 'tmp/compact-write-test.txt' }] })) as { files: Array<{ content: string; hash?: string; sha256?: string }> };
    expect(r1.files[0]?.content).toBe('alpha\n');
    const hash = r1.files[0]?.sha256 ?? r1.files[0]?.hash;
    data(await gw('dodo_write', 'edit_file', { path: 'tmp/compact-write-test.txt', edits: [{ find: 'alpha', replace: 'beta' }], expectedHash: hash }));
    const r2 = data(await gw('dodo_read', 'read_files', { files: [{ path: 'tmp/compact-write-test.txt' }] })) as { files: Array<{ content: string }> };
    expect(r2.files[0]?.content).toBe('beta\n');
    data(await gw('dodo_write', 'delete_path', { path: 'tmp/compact-write-test.txt' }));
    const gone = await gw('dodo_read', 'read_files', { files: [{ path: 'tmp/compact-write-test.txt' }] });
    const errs = (gone.envelope['data'] as { errors: Array<{ error: { code: string } }> }).errors;
    expect(errs[0]?.error.code).toBe('NOT_FOUND');
  });

  it('exec through the gateway with idempotency: same key replays the same job receipt', async () => {
    const first = data(await gw('dodo_exec', 'run_command', { command: 'echo compact-gw', idempotencyKey: 'compact-exec-001', waitMs: 15000 })) as { jobId: string; replayed?: boolean };
    const second = data(await gw('dodo_exec', 'run_command', { command: 'echo compact-gw', idempotencyKey: 'compact-exec-001', waitMs: 15000 })) as { jobId: string; replayed?: boolean };
    expect(second.jobId).toBe(first.jobId);
    expect(second.replayed).toBe(true);
    const out = data(await gw('dodo_read', 'job_output', { jobId: first.jobId, stream: 'stdout' })) as { content?: string };
    expect(JSON.stringify(out)).toContain('compact-gw');
  });

  it('git read through the gateway works on a non-repo fixture with the same envelope semantics', async () => {
    const status = data(await gw('dodo_git_read', 'git_status', {}));
    expect(status['isRepo']).toBe(false);
  });
});

describe('hybrid surface over HTTP (explicit override)', () => {
  it('serves 49 tools (coverage core first), direct write works AND gateway capabilities work in one session', async () => {
    const ctx = await launch({ toolSurface: 'hybrid', fixtureFiles: { 'a.txt': 'A\n' }, trust: 'trusted' });
    try {
      const tokens = await obtainToken(ctx);
      const tools = await listTools(ctx, tokens.accessToken);
      expect(tools.length).toBe(49);
      expect(tools.map((t) => t.name)).toEqual(HYBRID_CATALOG.map((d) => d.name));
      // coverage core is the exact compact prefix
      expect(tools.slice(0, COMPACT_CATALOG.length).map((t) => t.name)).toEqual(COMPACT_CATALOG.map((d) => d.name));
      const ov = await callToolLegacy(ctx, tokens.accessToken, 'project_overview', {});
      const d = ov.envelope['data'] as { toolSurface: string; hybridToolCount: number; fullToolCount: number };
      expect(d.toolSurface).toBe('hybrid');
      expect(d.hybridToolCount).toBe(49);
      // direct tool path (original name/schema)
      const w = await callToolLegacy(ctx, tokens.accessToken, 'write_file', { ...wsArgs(ctx), path: 'direct.txt', content: 'direct\n' });
      expect(w.envelope['ok']).toBe(true);
      // gateway path in the same session covers a non-direct capability
      const status = await callToolLegacy(ctx, tokens.accessToken, 'dodo_media', { ...wsArgs(ctx), operation: 'multimodal_status', args: {} });
      expect(status.envelope['ok']).toBe(true);
      const todo = await callToolLegacy(ctx, tokens.accessToken, 'dodo_write', { ...wsArgs(ctx), operation: 'todo_write', args: { todos: [{ id: 't1', content: 'via gateway', status: 'pending' }] } });
      expect(todo.envelope['ok'], JSON.stringify(todo.envelope['error'])).toBe(true);
      // discover still routes: a non-direct op maps to its gateway
      const disc = await callToolLegacy(ctx, tokens.accessToken, 'dodo_discover', { ...wsArgs(ctx), operation: 'context_for_task' });
      expect((disc.envelope['data'] as { gateway: string }).gateway).toBe('dodo_assist_read');
    } finally {
      await ctx.cleanup();
    }
  }, 120_000);
});

describe('full surface over HTTP (explicit override)', () => {
  it('config toolSurface=full restores the exact full catalog, names and order', async () => {
    const ctx = await launch({ configPatch: { toolSurface: 'full' }, fixtureFiles: { 'a.txt': 'A\n' }, trust: 'trusted' });
    try {
      const tokens = await obtainToken(ctx);
      const tools = await listTools(ctx, tokens.accessToken);
      expect(tools.map((t) => t.name)).toEqual(TOOL_CATALOG.map((d) => d.name));
      // direct write_file still works exactly as before
      const w = await callToolLegacy(ctx, tokens.accessToken, 'write_file', { ...wsArgs(ctx), path: 'x.txt', content: 'full\n' });
      expect(w.envelope['ok']).toBe(true);
      const ov = await callToolLegacy(ctx, tokens.accessToken, 'project_overview', {});
      expect((ov.envelope['data'] as Record<string, unknown>)['toolSurface']).toBeUndefined();
    } finally {
      await ctx.cleanup();
    }
  }, 120_000);

  it('StartOptions.toolSurface overrides config in the other direction', async () => {
    const ctx = await launch({ configPatch: { toolSurface: 'full' }, toolSurface: 'compact' });
    try {
      const tokens = await obtainToken(ctx);
      const tools = await listTools(ctx, tokens.accessToken);
      expect(tools.length).toBe(COMPACT_CATALOG.length);
    } finally {
      await ctx.cleanup();
    }
  }, 120_000);
});

describe('sub-agent MCP exposure switch', () => {
  it('defaults off for a live compact server while preserving the 20-tool gateway surface', async () => {
    const ctx = await launch({ configPatch: { exposeSubagentsToMcp: false }, trust: 'trusted' });
    try {
      const tokens = await obtainToken(ctx);
      const tools = await listTools(ctx, tokens.accessToken);
      expect(tools.map((tool) => tool.name)).toEqual(surfaceCatalog('compact', { subagents: false }).map((tool) => tool.name));
      expect(tools).toHaveLength(20);

      const readGateway = tools.find((tool) => tool.name === 'dodo_assist_read');
      const changeGateway = tools.find((tool) => tool.name === 'dodo_assist_change');
      const operations = (tool: typeof readGateway) => (((tool?.inputSchema?.['properties'] as Record<string, unknown>)?.['operation'] as { enum?: string[] })?.enum ?? []);
      expect(operations(readGateway)).not.toEqual(expect.arrayContaining(['subagent_status', 'subagent_result']));
      expect(operations(changeGateway)).not.toEqual(expect.arrayContaining(['subagent_spawn', 'subagent_control']));

      const overview = await callToolLegacy(ctx, tokens.accessToken, 'project_overview', {});
      expect(overview.envelope['data']).toMatchObject({
        toolSurface: 'compact', compactToolCount: 20, fullToolCount: 158, mcpSubagentsEnabled: false,
      });
      const hidden = await callToolLegacy(ctx, tokens.accessToken, 'dodo_discover', { ...wsArgs(ctx), operation: 'subagent_spawn' });
      expect(hidden.isError).toBe(true);
      expect(hidden.envelope['error']).toMatchObject({ code: 'NOT_FOUND' });
    } finally {
      await ctx.cleanup();
    }
  }, 120_000);

  it('removes all four direct definitions from Full when disabled', async () => {
    const ctx = await launch({ toolSurface: 'full', configPatch: { exposeSubagentsToMcp: false } });
    try {
      const tokens = await obtainToken(ctx);
      const names = (await listTools(ctx, tokens.accessToken)).map((tool) => tool.name);
      expect(names).toEqual(surfaceCatalog('full', { subagents: false }).map((tool) => tool.name));
      expect(names).toHaveLength(158);
      expect(names).not.toEqual(expect.arrayContaining(['subagent_spawn', 'subagent_status', 'subagent_result', 'subagent_control']));
    } finally {
      await ctx.cleanup();
    }
  }, 120_000);
});
