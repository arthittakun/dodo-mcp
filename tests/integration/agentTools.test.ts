import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { launch, obtainToken, callToolLegacy, wsArgs, type TestContext, type TokenSet } from '../helpers/testServer.js';

/** v1.2 coding-agent tools: parallel/background commands, patch, bulk replace, search upgrades, images, todos, env, sandbox. */
describe('AGENT: v1.2 tools', () => {
  let ctx: TestContext;
  let tokens: TokenSet;
  const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

  beforeAll(async () => {
    ctx = await launch({ toolSurface: 'full', 
      trust: 'trusted',
      fixtureFiles: {
        'package.json': JSON.stringify({ name: 'fx', version: '1.0.0' }),
        'Makefile': 'build:\n\t@echo built\n\ntest:\n\t@echo tested\n\n.PHONY: build test\n',
        'src/a.ts': 'export const alpha = 1;\nexport const beta = 2;\n// TODO: fix alpha\n',
        'src/b.ts': 'import { alpha } from "./a.js";\nexport const gamma = alpha + 1;\n',
        'src/c.py': 'alpha = 42\nprint(alpha)\n',
        'notes.md': '# notes\nalpha beta gamma\n',
        'AGENTS.md': '# Agent rules\nUse two-space indent.\n',
        '.kiro/steering/style.md': 'Prefer named exports.\n',
      },
    });
    fs.writeFileSync(path.join(ctx.fixtureDir, 'pixel.png'), PNG_1x1);
    tokens = await obtainToken(ctx);
  }, 120_000);
  afterAll(async () => ctx?.cleanup());

  const data = (env: Record<string, unknown>) => env['data'] as Record<string, unknown>;
  const errCode = (env: Record<string, unknown>) => (env['error'] as Record<string, unknown> | null)?.['code'];
  const call = (name: string, args: Record<string, unknown>) => callToolLegacy(ctx, tokens.accessToken, name, { ...wsArgs(ctx), ...args });
  const readFile = (rel: string) => fs.readFileSync(path.join(ctx.fixtureDir, rel), 'utf8');

  it('run_commands runs several commands in parallel and reports each result', async () => {
    const res = await call('run_commands', {
      commands: [
        { name: 'one', command: 'sleep 0.3; echo ONE' },
        { name: 'two', command: 'echo TWO; exit 3' },
        { name: 'three', command: 'echo THREE' },
      ],
      waitMs: 30_000,
    });
    expect(res.isError).toBe(false);
    const d = data(res.envelope);
    expect(d['allExited']).toBe(true);
    expect(d['allSucceeded']).toBe(false);
    const results = d['results'] as Array<Record<string, unknown>>;
    expect(results.map((r) => r['name'])).toEqual(['one', 'two', 'three']);
    expect(results[0]?.['stdout']).toContain('ONE');
    expect(results[1]?.['exitCode']).toBe(3);
    expect(results[2]?.['stdout']).toContain('THREE');
    // parallel: total wall time well under the sum if they were sequential? (sleep 0.3 vs others) — sanity on duration field
    expect(typeof d['durationMs']).toBe('number');
  });

  it('run_command background:true returns immediately; job_wait collects the result', async () => {
    const res = await call('run_command', { command: 'sleep 0.5; echo LATE', background: true });
    const d = data(res.envelope);
    expect(d['status']).toBe('running');
    const jobId = d['jobId'] as string;
    const w = await call('job_wait', { jobId, waitMs: 20_000 });
    const wd = data(w.envelope);
    expect(wd['exited']).toBe(true);
    expect(wd['exitCode']).toBe(0);
    expect(wd['stdout']).toContain('LATE');
  });

  it.skipIf(process.platform !== 'darwin')('run_command sandbox:true blocks writes outside the workspace on macOS', async () => {
    const outside = fs.mkdtempSync(path.join(process.env['HOME'] as string, '.dodo-sbx-'));
    try {
      const inside = await call('run_command', { command: 'echo hi > sandboxed-ok.txt && cat sandboxed-ok.txt', sandbox: true });
      expect(data(inside.envelope)['exitCode']).toBe(0);
      expect(data(inside.envelope)['sandboxed']).toBe('macos-seatbelt');
      expect(readFile('sandboxed-ok.txt')).toBe('hi\n');
      const out = await call('run_command', { command: `touch "${outside}/escaped.txt"`, sandbox: true });
      expect(data(out.envelope)['exitCode']).not.toBe(0);
      expect(fs.existsSync(path.join(outside, 'escaped.txt'))).toBe(false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  }, 60_000);

  it('search_code: context lines, fileGlob, files/count modes, regex via the JS worker', async () => {
    const ctxRes = await call('search_code', { query: 'beta', contextLines: 1, fileGlob: '*.ts' });
    const m = (data(ctxRes.envelope)['matches'] as Array<Record<string, unknown>>)[0]!;
    expect(m['path']).toBe('src/a.ts');
    expect((m['before'] as string[])[0]).toContain('alpha = 1');
    expect((m['after'] as string[])[0]).toContain('TODO');

    const filesRes = await call('search_code', { query: 'alpha', outputMode: 'files' });
    const files = (data(filesRes.envelope)['files'] as Array<{ path: string; matches: number }>).map((f) => f.path).sort();
    expect(files).toEqual(['notes.md', 'src/a.ts', 'src/b.ts', 'src/c.py']);
    expect(data(filesRes.envelope)['matches']).toEqual([]);

    const countRes = await call('search_code', { query: 'alpha', outputMode: 'count', fileGlob: 'src/**' });
    expect(data(countRes.envelope)['totalMatches']).toBe(6); // a.ts(2) + b.ts(2) + c.py(2)

    // force the JS backend to exercise the regex worker
    const js = await launch({ toolSurface: 'full',  fixtureFiles: { 'x.txt': 'foo123 bar\nfoo9 baz\n' }, trust: 'edit', configPatch: { searchBackend: 'js' } });
    try {
      const t = await obtainToken(js);
      const r = await callToolLegacy(js, t.accessToken, 'search_code', { ...wsArgs(js), query: 'foo\\d+', mode: 'regex' });
      expect(data(r.envelope)['backend']).toBe('js');
      expect((data(r.envelope)['matches'] as unknown[]).length).toBe(2);
      const bad = await callToolLegacy(js, t.accessToken, 'search_code', { ...wsArgs(js), query: '(unclosed', mode: 'regex' });
      expect(errCode(bad.envelope)).toBe('INVALID_INPUT');
    } finally {
      await js.cleanup();
    }
  }, 60_000);

  it('apply_patch applies a multi-file unified diff (modify + create + delete) and refuses stale hunks', async () => {
    const patch = [
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,3 +1,3 @@',
      '-export const alpha = 1;',
      '+export const alpha = 10;',
      ' export const beta = 2;',
      ' // TODO: fix alpha',
      '--- /dev/null',
      '+++ b/src/new.ts',
      '@@ -0,0 +1,1 @@',
      '+export const created = true;',
      '--- a/notes.md',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-# notes',
      '-alpha beta gamma',
      '',
    ].join('\n');
    const dry = await call('apply_patch', { patch, dryRun: true });
    expect(dry.isError).toBe(false);
    expect(readFile('src/a.ts')).toContain('alpha = 1;'); // untouched
    const res = await call('apply_patch', { patch });
    expect(res.isError).toBe(false);
    expect(readFile('src/a.ts')).toContain('alpha = 10;');
    expect(readFile('src/new.ts')).toBe('export const created = true;\n');
    expect(fs.existsSync(path.join(ctx.fixtureDir, 'notes.md'))).toBe(false);
    // the same patch no longer applies → CONFLICT, nothing written
    const stale = await call('apply_patch', { patch });
    expect(errCode(stale.envelope)).toBe('CONFLICT');
  });

  it('replace_in_files: dryRun reports a plan; apply rewrites all matching files', async () => {
    const dry = await call('replace_in_files', { find: 'alpha', replace: 'ALPHA', fileGlob: '*.ts' });
    const dd = data(dry.envelope);
    expect(dd['dryRun']).toBe(true);
    expect((dd['files'] as Array<{ path: string }>).map((f) => f.path).sort()).toEqual(['src/a.ts', 'src/b.ts']);
    expect(readFile('src/b.ts')).toContain('alpha'); // untouched
    const applied = await call('replace_in_files', { find: 'alpha', replace: 'ALPHA', fileGlob: '*.ts', dryRun: false });
    expect(data(applied.envelope)['changesetId']).toBeTruthy();
    expect(readFile('src/b.ts')).toContain('ALPHA');
    expect(readFile('src/c.py')).toContain('alpha'); // not matched by *.ts
  });

  it('read_image returns an MCP image block; read_files numbered prefixes line numbers', async () => {
    const img = await call('read_image', { path: 'pixel.png' });
    expect(data(img.envelope)['mimeType']).toBe('image/png');
    const content = (img.raw as { result: { content: Array<{ type: string; mimeType?: string }> } }).result.content;
    expect(content.some((c) => c.type === 'image' && c.mimeType === 'image/png')).toBe(true);
    const numbered = await call('read_files', { files: [{ path: 'src/b.ts', numbered: true }] });
    const text = (data(numbered.envelope)['files'] as Array<{ content: string }>)[0]!.content;
    expect(text.split('\n')[0]).toMatch(/^\s*1\t/);
  });

  it('read_instructions gathers AGENTS.md + steering files, labeled untrusted', async () => {
    const res = await call('read_instructions', {});
    const files = (data(res.envelope)['files'] as Array<{ path: string; content: string }>);
    expect(files.map((f) => f.path)).toEqual(expect.arrayContaining(['AGENTS.md', '.kiro/steering/style.md']));
    expect(data(res.envelope)['note']).toMatch(/untrusted/);
  });

  it('todo_write / todo_read round-trip; environment_info reports toolchains', async () => {
    const w = await call('todo_write', { todos: [{ id: '1', content: 'fix alpha', status: 'in_progress', priority: 'high' }, { id: '2', content: 'run tests', status: 'pending' }] });
    expect(data(w.envelope)['count']).toBe(2);
    const r = await call('todo_read', {});
    expect((data(r.envelope)['todos'] as Array<{ id: string }>).map((t) => t.id)).toEqual(['1', '2']);
    const env = await call('environment_info', {});
    const tools = data(env.envelope)['tools'] as Record<string, string | null>;
    expect(tools['node']).toMatch(/^v?\d+/);
    expect(tools['git']).toMatch(/git version/);
  }, 30_000);

  it('project_overview discovers Makefile targets as recipes', async () => {
    const res = await callToolLegacy(ctx, tokens.accessToken, 'project_overview', {});
    const ids = (data(res.envelope)['tasks'] as Array<{ id: string }>).map((t) => t.id);
    expect(ids).toEqual(expect.arrayContaining(['make:build', 'make:test']));
  });

  it('fetch_url is disabled by default (NOT_SUPPORTED) and refuses private hosts when enabled', async () => {
    const off = await call('fetch_url', { url: 'https://example.com/' });
    expect(errCode(off.envelope)).toBe('NOT_SUPPORTED');
    const on = await launch({ toolSurface: 'full',  fixtureFiles: { 'x.txt': '1' }, trust: 'trusted', configPatch: { allowWebFetch: true } });
    try {
      const t = await obtainToken(on);
      for (const url of ['https://127.0.0.1/', 'https://localhost/x', 'https://10.0.0.1/', 'https://169.254.169.254/latest/meta-data/']) {
        const r = await callToolLegacy(on, t.accessToken, 'fetch_url', { ...wsArgs(on), url });
        expect(errCode(r.envelope), url).toBe('FORBIDDEN');
      }
      const http = await callToolLegacy(on, t.accessToken, 'fetch_url', { ...wsArgs(on), url: 'http://example.com/' });
      expect(errCode(http.envelope)).toBe('FORBIDDEN');
    } finally {
      await on.cleanup();
    }
  }, 60_000);
});
