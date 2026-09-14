import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { TOOL_CATALOG } from '../../src/tools/catalog.js';
import { COMPACT_CATALOG, surfaceCatalog } from '../../src/tools/surface.js';
import { GlobalConfigSchema, saveGlobalConfig } from '../../src/config/globalConfig.js';
import { statePaths } from '../../src/config/paths.js';

/** ADR-029: STDIO keeps the FULL catalog by default; --tools compact is an explicit opt-in. */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(ROOT, 'dist/cli/main.js');

function spawnClient(fixture: string, cfg: string, extraArgs: string[]) {
  const transport = new StdioClientTransport({
    command: 'node',
    args: [CLI, 'stdio', '--root', fixture, ...extraArgs],
    env: { ...process.env, DODO_CONFIG_DIR: cfg } as Record<string, string>,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'compact-stdio-test', version: '1.0.0' });
  return { client, transport };
}

describe('STDIO surfaces', () => {
  let fixture: string;
  let cfg: string;
  beforeAll(() => {
    fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'dodo-cstdio-'));
    cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'dodo-cstdio-cfg-'));
    fs.writeFileSync(path.join(fixture, 'hello.txt'), 'hello\n');
    execFileSync('node', [CLI, 'trust', '--mode', 'trusted', '--yes'], { cwd: fixture, env: { ...process.env, DODO_CONFIG_DIR: cfg }, stdio: 'pipe' });
  });
  afterAll(() => {
    fs.rmSync(fixture, { recursive: true, force: true });
    fs.rmSync(cfg, { recursive: true, force: true });
  });

  it('default STDIO serves the full catalog with optional sub-agent tools hidden', async () => {
    const { client, transport } = spawnClient(fixture, cfg, []);
    await client.connect(transport);
    try {
      const list = await client.listTools();
      expect(list.tools.map((t) => t.name)).toEqual(surfaceCatalog('full', { subagents: false }).map((d) => d.name));
      const ov = await client.callTool({ name: 'project_overview', arguments: {} });
      const env = ov.structuredContent as { ok: boolean; workspaceId: string; workspaceEpoch: string; data: Record<string, unknown> };
      expect(env.ok).toBe(true);
      expect(env.data['toolSurface']).toBeUndefined();
      expect(env.data['mcpSubagentsEnabled']).toBe(false);
      const ws = { workspaceId: env.workspaceId, workspaceEpoch: env.workspaceEpoch };
      const w = await client.callTool({ name: 'write_file', arguments: { ...ws, path: 'full.txt', content: 'full\n' } });
      expect((w.structuredContent as { ok: boolean }).ok).toBe(true);
    } finally {
      await client.close();
    }
  }, 60_000);

  it('dodo stdio --tools compact serves the gateway surface and the coding loop works through it', async () => {
    const { client, transport } = spawnClient(fixture, cfg, ['--tools', 'compact']);
    await client.connect(transport);
    try {
      const list = await client.listTools();
      expect(list.tools.map((t) => t.name)).toEqual(COMPACT_CATALOG.map((d) => d.name));
      expect(list.tools.length).toBeLessThanOrEqual(20);
      const ov = await client.callTool({ name: 'project_overview', arguments: {} });
      const env = ov.structuredContent as { ok: boolean; workspaceId: string; workspaceEpoch: string; data: Record<string, unknown> };
      expect(env.data['toolSurface']).toBe('compact');
      expect(env.data['mcpSubagentsEnabled']).toBe(false);
      expect(env.data['fullToolCount']).toBe(121);
      const ws = { workspaceId: env.workspaceId, workspaceEpoch: env.workspaceEpoch };
      const w = await client.callTool({ name: 'dodo_write', arguments: { ...ws, operation: 'write_file', args: { path: 'compact.txt', content: 'alpha\n' } } });
      expect((w.structuredContent as { ok: boolean }).ok).toBe(true);
      const r = await client.callTool({ name: 'dodo_read', arguments: { ...ws, operation: 'read_files', args: { files: [{ path: 'compact.txt' }] } } });
      const files = ((r.structuredContent as { data: { files: Array<{ content: string; hash?: string; sha256?: string }> } }).data).files;
      expect(files[0]?.content).toBe('alpha\n');
      const e = await client.callTool({
        name: 'dodo_write',
        arguments: { ...ws, operation: 'edit_file', args: { path: 'compact.txt', edits: [{ find: 'alpha', replace: 'beta' }], expectedHash: files[0]?.sha256 ?? files[0]?.hash } },
      });
      expect((e.structuredContent as { ok: boolean }).ok).toBe(true);
      const r2 = await client.callTool({ name: 'dodo_read', arguments: { ...ws, operation: 'read_files', args: { files: [{ path: 'compact.txt' }] } } });
      expect(((r2.structuredContent as { data: { files: Array<{ content: string }> } }).data).files[0]?.content).toBe('beta\n');
    } finally {
      await client.close();
    }
  }, 60_000);

  it('owner opt-in restores all four sub-agent operations to the STDIO catalog', async () => {
    const enabledCfg = fs.mkdtempSync(path.join(os.tmpdir(), 'dodo-cstdio-enabled-'));
    try {
      saveGlobalConfig(statePaths(enabledCfg).configFile, GlobalConfigSchema.parse({ exposeSubagentsToMcp: true }));
      execFileSync('node', [CLI, 'trust', '--mode', 'trusted', '--yes'], { cwd: fixture, env: { ...process.env, DODO_CONFIG_DIR: enabledCfg }, stdio: 'pipe' });
      const { client, transport } = spawnClient(fixture, enabledCfg, []);
      await client.connect(transport);
      try {
        const names = (await client.listTools()).tools.map((tool) => tool.name);
        expect(names).toEqual(TOOL_CATALOG.map((tool) => tool.name));
        expect(names.slice(-4)).toEqual(['subagent_spawn', 'subagent_status', 'subagent_result', 'subagent_control']);
      } finally {
        await client.close();
      }
    } finally {
      fs.rmSync(enabledCfg, { recursive: true, force: true });
    }
  }, 60_000);
});
