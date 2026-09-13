import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { launch, mkTmpDir } from '../helpers/testServer.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const CLI = path.join(ROOT, 'dist', 'cli', 'main.js');
const owned: string[] = [];

function fixture() {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dodo-project-cli-')));
  owned.push(base);
  const configDir = path.join(base, 'config');
  const root = path.join(base, 'โปรเจกต์ เว็บ');
  fs.mkdirSync(root, { recursive: true });
  return { base, configDir, root, env: { ...process.env, DODO_CONFIG_DIR: configDir } };
}

function cli(args: string[], cwd: string, env: NodeJS.ProcessEnv, expectFailure = false) {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: 'utf8' });
  if (!expectFailure && result.status !== 0) throw new Error(`CLI failed (${result.status}): ${result.stderr}`);
  return result;
}

afterEach(() => {
  for (const directory of owned.splice(0)) fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
});

describe('project registry CLI', () => {
  it('supports add/list/info/reviewed-remove with machine-readable output and keeps project files', () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.root, 'keep.txt'), 'keep');
    const added = JSON.parse(cli(['project', 'add', f.root, '--name', 'เว็บหลัก', '--json'], f.base, f.env).stdout) as { project: { projectId: string; root: string; availability: string } };
    expect(added.project.root).toBe(fs.realpathSync.native(f.root));
    expect(added.project.availability).toBe('ready');

    const duplicate = JSON.parse(cli(['project', 'add', path.join(f.root, '.'), '--json'], f.base, f.env).stdout) as { changed: boolean; project: { projectId: string } };
    expect(duplicate.changed).toBe(false);
    expect(duplicate.project.projectId).toBe(added.project.projectId);
    const listed = JSON.parse(cli(['project', 'list', '--json'], f.base, f.env).stdout) as Array<{ projectId: string }>;
    expect(listed.map((project) => project.projectId)).toEqual([added.project.projectId]);
    expect(JSON.parse(cli(['project', 'info', added.project.projectId, '--json'], f.base, f.env).stdout)).toMatchObject({ displayName: 'เว็บหลัก', available: true });

    const unreviewed = cli(['project', 'remove', added.project.projectId], f.base, f.env, true);
    expect(unreviewed.status).not.toBe(0);
    expect(unreviewed.stderr).toContain('APPROVAL_REQUIRED');
    expect(JSON.parse(cli(['project', 'list', '--json'], f.base, f.env).stdout)).toHaveLength(1);

    const removed = JSON.parse(cli(['project', 'remove', added.project.projectId, '--yes', '--json'], f.base, f.env).stdout) as { removed: boolean; filesDeleted: boolean; authorityDeleted: boolean };
    expect(removed).toMatchObject({ removed: true, filesDeleted: false, authorityDeleted: false });
    expect(fs.readFileSync(path.join(f.root, 'keep.txt'), 'utf8')).toBe('keep');
    expect(JSON.parse(cli(['project', 'list', '--json'], f.base, f.env).stdout)).toEqual([]);
    expect(JSON.parse(cli(['project', 'list', '--all', '--json'], f.base, f.env).stdout)).toHaveLength(1);
  });

  it('serializes concurrent duplicate adds into one stable project row', async () => {
    const f = fixture();
    const children = Array.from({ length: 6 }, () => spawn(process.execPath, [CLI, 'project', 'add', f.root, '--json'], {
      cwd: f.base, env: f.env, stdio: ['ignore', 'pipe', 'pipe'],
    }));
    const results = await Promise.all(children.map((child) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      let stdout = '', stderr = '';
      child.stdout.on('data', (chunk) => { stdout += String(chunk); });
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    })));
    expect(results.map((result) => result.code), results.map((result) => result.stderr).join('\n')).toEqual([0, 0, 0, 0, 0, 0]);
    const ids = new Set(results.map((result) => (JSON.parse(result.stdout) as { project: { projectId: string } }).project.projectId));
    expect(ids.size).toBe(1);
    expect(JSON.parse(cli(['project', 'list', '--json'], f.base, f.env).stdout)).toHaveLength(1);
  }, 30_000);

  it('persists through the real Local Config server and opens a registered root through the existing safe switch lifecycle', async () => {
    const rootA = mkTmpDir('dodo-project-live-a-');
    const rootB = mkTmpDir('dodo-project-live-b-');
    owned.push(rootA, rootB);
    fs.writeFileSync(path.join(rootA, 'a.txt'), 'A');
    fs.writeFileSync(path.join(rootB, 'b.txt'), 'B');
    const ctx = await launch({ fixtureDir: rootA, configPort: 0, toolSurface: 'full' });
    owned.push(ctx.configDir);
    try {
      const configUrl = new URL(ctx.configUrl as string);
      const auth = { authorization: `Bearer ${configUrl.hash.slice(1)}` };
      const context = () => ({ ...auth, 'x-dodo-workspace': ctx.server.workspaceId, 'x-dodo-epoch': ctx.server.epoch });
      const post = (route: string, body: unknown) => fetch(`${configUrl.origin}/api/${route}`, {
        method: 'POST', headers: { ...context(), 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      expect((await post('projects/add', { path: rootA, displayName: 'Project A' })).status).toBe(200);
      const addedB = await (await post('projects/add', { path: rootB, displayName: 'Project B' })).json() as { project: { projectId: string } };
      let projects = await (await fetch(`${configUrl.origin}/api/projects`, { headers: context() })).json() as { projects: Array<{ projectId: string; displayName: string }> };
      expect(projects.projects.map((project) => project.displayName).sort()).toEqual(['Project A', 'Project B']);

      const switched = await post('workspace/switch', { path: rootB });
      expect(switched.status).toBe(200);
      expect(fs.realpathSync.native(ctx.server.root)).toBe(fs.realpathSync.native(rootB));
      projects = await (await fetch(`${configUrl.origin}/api/projects`, { headers: context() })).json() as typeof projects;
      expect(projects.projects.find((project) => project.projectId === addedB.project.projectId)?.displayName).toBe('Project B');
      expect(fs.readFileSync(path.join(ctx.server.root, 'b.txt'), 'utf8')).toBe('B');
    } finally { await ctx.cleanup(); }
  });
});
