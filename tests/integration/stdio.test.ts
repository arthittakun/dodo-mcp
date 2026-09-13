import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { TOOL_CATALOG } from '../../src/tools/catalog.js';

/** `dodo stdio`: local clients (Claude Code / Cursor / Codex) over stdin/stdout — no tunnel, no OAuth. */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(ROOT, 'dist/cli/main.js');

describe('STDIO mode', () => {
  let fixture: string;
  let cfg: string;
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => {
    fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'dodo-stdio-'));
    cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'dodo-stdio-cfg-'));
    fs.writeFileSync(path.join(fixture, 'hello.txt'), 'hello stdio\n');
    // Owner sets trust for this workspace through the CLI (offline write).
    execFileSync('node', [CLI, 'trust', '--mode', 'trusted', '--yes'], { cwd: fixture, env: { ...process.env, DODO_CONFIG_DIR: cfg }, stdio: 'pipe' });
    transport = new StdioClientTransport({
      command: 'node',
      args: [CLI, 'stdio', '--root', fixture],
      env: { ...process.env, DODO_CONFIG_DIR: cfg } as Record<string, string>,
      stderr: 'pipe',
    });
    client = new Client({ name: 'stdio-test-client', version: '1.0.0' });
    await client.connect(transport);
  }, 60_000);

  afterAll(async () => {
    await client?.close();
    fs.rmSync(fixture, { recursive: true, force: true });
  });

  it('lists the full catalog and runs the coding loop without OAuth', async () => {
    const list = await client.listTools();
    expect(list.tools.length).toBe(TOOL_CATALOG.length);
    const ov = await client.callTool({ name: 'project_overview', arguments: {} });
    const env = ov.structuredContent as Record<string, unknown>;
    expect(env['ok']).toBe(true);
    const data = env['data'] as Record<string, unknown>;
    expect(fs.realpathSync(data['root'] as string)).toBe(fs.realpathSync(fixture));
    const ws = { workspaceId: data['workspaceId'] as string, workspaceEpoch: data['workspaceEpoch'] as string };

    const w = await client.callTool({ name: 'write_file', arguments: { ...ws, path: 'src/x.ts', content: 'export const x = 1;\n' } });
    expect((w.structuredContent as Record<string, unknown>)['ok']).toBe(true);
    expect(fs.readFileSync(path.join(fixture, 'src/x.ts'), 'utf8')).toBe('export const x = 1;\n');

    const r = await client.callTool({ name: 'run_command', arguments: { ...ws, command: 'cat hello.txt && echo done' } });
    const rd = (r.structuredContent as Record<string, unknown>)['data'] as Record<string, unknown>;
    expect(rd['exitCode']).toBe(0);
    expect(rd['stdout']).toContain('hello stdio');
  }, 60_000);

  it('still enforces path policy and the workspace context in stdio mode', async () => {
    const ov = await client.callTool({ name: 'project_overview', arguments: {} });
    const data = ((ov.structuredContent as Record<string, unknown>)['data']) as Record<string, unknown>;
    const ws = { workspaceId: data['workspaceId'] as string, workspaceEpoch: data['workspaceEpoch'] as string };
    const bad = await client.callTool({ name: 'read_files', arguments: { ...ws, files: [{ path: '../../etc/passwd' }] } });
    const d = ((bad.structuredContent as Record<string, unknown>)['data']) as { errors: Array<{ error: { code: string } }> };
    expect(d.errors[0]?.error.code).toBe('PATH_DENIED');
    const wrongWs = await client.callTool({ name: 'list_files', arguments: { workspaceId: 'ws_nope', workspaceEpoch: ws.workspaceEpoch, path: '.' } });
    expect(((wrongWs.structuredContent as Record<string, unknown>)['error'] as Record<string, unknown>)['code']).toBe('WORKSPACE_MISMATCH');
  });

  it('STDIO-03: explicit stdio without --root serves the client cwd', async () => {
    // The npx convention: an MCP client runs `npx -y dodo-mcp` with cwd = the project.
    const t = new StdioClientTransport({
      command: 'node',
      args: [CLI, 'stdio'],
      cwd: fixture,
      env: { ...process.env, DODO_CONFIG_DIR: cfg } as Record<string, string>,
      stderr: 'pipe',
    });
    const c = new Client({ name: 'stdio-bare-client', version: '1.0.0' });
    await c.connect(t);
    try {
      const list = await c.listTools();
      expect(list.tools.length).toBe(TOOL_CATALOG.length);
      const ov = await c.callTool({ name: 'project_overview', arguments: {} });
      const data = ((ov.structuredContent as Record<string, unknown>)['data']) as Record<string, unknown>;
      expect(fs.realpathSync(data['root'] as string)).toBe(fs.realpathSync(fixture));
    } finally {
      await c.close();
    }
  }, 60_000);

  it('STDIO-04: --help describes explicit stdio and local config', () => {
    const help = execFileSync('node', [CLI, '--help'], { encoding: 'utf8' });
    expect(help).toContain('21731');
    expect(help).toContain('dodo stdio');
  });
});
