import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { launch, obtainToken, callToolLegacy, wsArgs, type TestContext, type TokenSet } from '../helpers/testServer.js';

/**
 * Direct coding-agent tools (v1.1): write_file, edit_file, delete_path,
 * move_path, make_directory, glob_files, run_command, git_log, git_commit.
 * Same policy + journal as the reviewed flow; one call instead of two.
 */
describe('DIRECT: coding-agent tools', () => {
  let ctx: TestContext;
  let tokens: TokenSet;

  beforeAll(async () => {
    ctx = await launch({ toolSurface: 'full', 
      trust: 'trusted',
      fixtureFiles: {
        'package.json': JSON.stringify({ name: 'fx', version: '1.0.0', scripts: { test: 'node test.js' } }),
        'test.js': 'const assert = require("node:assert"); const { add } = require("./src/math.js"); assert.strictEqual(add(2, 3), 5); console.log("1 passing");',
        'src/math.js': 'function add(a, b) {\n  return a - b; // BUG\n}\nmodule.exports = { add };\n',
        'src/util.ts': 'export const x = 1;\n',
        'src/deep/inner.ts': 'export const y = 2;\n',
        'README.md': '# fx\n',
        '.env': 'SECRET=1\n',
      },
    });
    tokens = await obtainToken(ctx);
  }, 120_000);
  afterAll(async () => ctx?.cleanup());

  const data = (env: Record<string, unknown>) => env['data'] as Record<string, unknown>;
  const errCode = (env: Record<string, unknown>) => (env['error'] as Record<string, unknown> | null)?.['code'];
  const call = (name: string, args: Record<string, unknown>) => callToolLegacy(ctx, tokens.accessToken, name, { ...wsArgs(ctx), ...args });
  const readFile = (rel: string) => fs.readFileSync(path.join(ctx.fixtureDir, rel), 'utf8');

  it('glob_files finds files by pattern (basename and path modes) and never lists secrets', async () => {
    const ts = await call('glob_files', { pattern: '**/*.ts' });
    const files = (data(ts.envelope)['files'] as Array<{ path: string }>).map((f) => f.path);
    expect(files).toEqual(expect.arrayContaining(['src/util.ts', 'src/deep/inner.ts']));
    const base = await call('glob_files', { pattern: '*.md' });
    expect((data(base.envelope)['files'] as Array<{ path: string }>).map((f) => f.path)).toEqual(['README.md']);
    const all = await call('glob_files', { pattern: '**/*', includeIgnored: true });
    expect(JSON.stringify(data(all.envelope))).not.toContain('.env');
  });

  it('run_command: the everyday loop — run the failing test, see the failure inline', async () => {
    const res = await call('run_command', { command: 'npm test 2>&1', waitMs: 60_000 });
    expect(res.isError).toBe(false);
    const d = data(res.envelope);
    expect(d['status']).toBe('exited');
    expect(d['exitCode']).not.toBe(0); // the bug makes the assertion fail
    expect(`${d['stdout']}${d['stderr']}`).toMatch(/AssertionError|assert/i);
  });

  it('edit_file fixes the bug in one call (hash-verified, journaled, diff returned)', async () => {
    const before = await call('read_files', { files: [{ path: 'src/math.js' }] });
    const hash = (data(before.envelope)['files'] as Array<{ hash: string }>)[0]!.hash;
    const res = await call('edit_file', {
      path: 'src/math.js',
      expectedHash: hash,
      edits: [{ find: 'return a - b; // BUG', replace: 'return a + b;' }],
    });
    expect(res.isError).toBe(false);
    const d = data(res.envelope);
    expect(d['changesetId']).toBeTruthy();
    expect(d['diff'] as string).toContain('+  return a + b;');
    expect(readFile('src/math.js')).toContain('return a + b;');
    // The edit shows up in change_history like any other change.
    const hist = await call('change_history', { limit: 5 });
    expect((data(hist.envelope)['changesets'] as Array<{ changesetId: string }>).some((c) => c.changesetId === d['changesetId'])).toBe(true);
  });

  it('run_command: tests pass after the fix; shell features (pipes, &&) work', async () => {
    const res = await call('run_command', { command: 'npm test 2>&1 | tail -n 1 && echo DONE', waitMs: 60_000 });
    const d = data(res.envelope);
    expect(d['exitCode']).toBe(0);
    expect(d['stdout'] as string).toContain('1 passing');
    expect(d['stdout'] as string).toContain('DONE');
  });

  it('edit_file refuses ambiguous or missing targets without writing (AMBIGUOUS_EDIT)', async () => {
    const before = readFile('src/math.js');
    const missing = await call('edit_file', { path: 'src/math.js', edits: [{ find: 'not in file', replace: 'x' }] });
    expect(errCode(missing.envelope)).toBe('AMBIGUOUS_EDIT');
    const multi = await call('edit_file', { path: 'src/math.js', edits: [{ find: 'a', replace: 'z' }] }); // 'a' occurs many times
    expect(errCode(multi.envelope)).toBe('AMBIGUOUS_EDIT');
    expect(readFile('src/math.js')).toBe(before);
    // replaceAll makes the multi-occurrence case explicit and allowed.
    await call('write_file', { path: 'src/rep.ts', content: 'tok1 tok1 tok1\n' });
    const ok = await call('edit_file', { path: 'src/rep.ts', edits: [{ find: 'tok1', replace: 'tok2', replaceAll: true }] });
    expect(ok.isError).toBe(false);
    expect(readFile('src/rep.ts')).toBe('tok2 tok2 tok2\n');
  });

  it('edit_file with a stale expectedHash is FILE_CHANGED', async () => {
    const res = await call('edit_file', { path: 'src/util.ts', expectedHash: 'sha256:stale', edits: [{ find: 'x = 1', replace: 'x = 2' }] });
    expect(errCode(res.envelope)).toBe('FILE_CHANGED');
  });

  it('write_file creates (with parents) and overwrites; make_directory / move_path / delete_path round-trip', async () => {
    const created = await call('write_file', { path: 'src/new/feature.ts', content: 'export const f = 1;\n' });
    expect(data(created.envelope)['created']).toBe(true);
    expect(readFile('src/new/feature.ts')).toBe('export const f = 1;\n');
    const over = await call('write_file', { path: 'src/new/feature.ts', content: 'export const f = 2;\n' });
    expect(data(over.envelope)['created']).toBe(false);
    expect(readFile('src/new/feature.ts')).toBe('export const f = 2;\n');

    const mk = await call('make_directory', { path: 'src/moved' });
    expect(data(mk.envelope)['created']).toBe(true);
    const again = await call('make_directory', { path: 'src/moved' });
    expect(data(again.envelope)['created']).toBe(false);

    const mv = await call('move_path', { path: 'src/new/feature.ts', destPath: 'src/moved/feature.ts' });
    expect(mv.isError).toBe(false);
    expect(fs.existsSync(path.join(ctx.fixtureDir, 'src/new/feature.ts'))).toBe(false);
    expect(readFile('src/moved/feature.ts')).toBe('export const f = 2;\n');

    const del = await call('delete_path', { path: 'src/moved/feature.ts' });
    expect(del.isError).toBe(false);
    expect(fs.existsSync(path.join(ctx.fixtureDir, 'src/moved/feature.ts'))).toBe(false);
    // and it is reversible
    const rb = await call('rollback_changes', { changesetId: data(del.envelope)['changesetId'], idempotencyKey: 'k-direct-rb-01' });
    expect(rb.isError).toBe(false);
    expect(readFile('src/moved/feature.ts')).toBe('export const f = 2;\n');
  });

  it('direct writes still obey path policy and secret denies', async () => {
    const trav = await call('write_file', { path: '../escape.txt', content: 'x' });
    expect(errCode(trav.envelope)).toBe('PATH_DENIED');
    const secret = await call('write_file', { path: '.env.local', content: 'x' });
    expect(errCode(secret.envelope)).toBe('SECRET_PATH_DENIED');
    const editSecret = await call('edit_file', { path: '.env', edits: [{ find: 'SECRET', replace: 'X' }] });
    expect(errCode(editSecret.envelope)).toBe('SECRET_PATH_DENIED');
  });

  it('run_command: a long-running command hands back a running jobId; job_cancel stops it', async () => {
    const res = await call('run_command', { command: 'sleep 30; echo late', waitMs: 1500 });
    const d = data(res.envelope);
    expect(d['status']).toBe('running');
    expect(d['jobId']).toBeTruthy();
    expect((res.envelope['warnings'] as string[]).join(' ')).toMatch(/still running/);
    const cancel = await call('job_cancel', { jobId: d['jobId'] });
    expect(cancel.isError).toBe(false);
  });

  it('run_command: install a package for real (npm install from the local registry cache is not assumed — uses a local tarball-free path)', async () => {
    // Verify the ergonomic install path works end-to-end without network:
    // create a tiny local package and `npm install ./pkg` it.
    fs.mkdirSync(path.join(ctx.fixtureDir, 'localpkg'), { recursive: true });
    fs.writeFileSync(path.join(ctx.fixtureDir, 'localpkg', 'package.json'), JSON.stringify({ name: 'localpkg', version: '1.0.0', main: 'index.js' }));
    fs.writeFileSync(path.join(ctx.fixtureDir, 'localpkg', 'index.js'), 'module.exports = () => "installed";');
    const res = await call('run_command', { command: 'npm install ./localpkg --no-audit --no-fund --silent && node -e "console.log(require(\'localpkg\')())"', waitMs: 120_000 });
    const d = data(res.envelope);
    expect(d['exitCode']).toBe(0);
    expect(d['stdout'] as string).toContain('installed');
  }, 150_000);

  it('run_command: inspect mode requires approval and starts nothing', async () => {
    ctx.server.services.store.setTrustMode(ctx.server.workspaceId, 'inspect');
    try {
      const res = await call('run_command', { command: 'echo should-not-run > src/nope.txt' });
      expect(errCode(res.envelope)).toBe('APPROVAL_REQUIRED');
      expect(fs.existsSync(path.join(ctx.fixtureDir, 'src/nope.txt'))).toBe(false);
      const w = await call('write_file', { path: 'src/nope.txt', content: 'x' });
      expect(errCode(w.envelope)).toBe('APPROVAL_REQUIRED');
      expect(fs.existsSync(path.join(ctx.fixtureDir, 'src/nope.txt'))).toBe(false);
    } finally {
      ctx.server.services.store.setTrustMode(ctx.server.workspaceId, 'trusted');
    }
  });

  it('git_commit stages via the secret-filtered status and git_log shows it', async () => {
    const git = (args: string[]) => execFileSync('git', args, { cwd: ctx.fixtureDir, stdio: 'pipe' });
    git(['init', '-q']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test']);
    const first = await call('git_commit', { message: 'initial import', all: true });
    expect(first.isError, JSON.stringify(first.envelope.error)).toBe(false);
    const d = data(first.envelope);
    expect(d['commit']).toMatch(/^[0-9a-f]{40}$/);
    expect((d['stagedPaths'] as string[])).not.toContain('.env'); // secret never staged
    // .env is still untracked after an `all: true` commit.
    const tracked = git(['ls-files']).toString('utf8');
    expect(tracked).not.toContain('.env');
    expect(tracked).toContain('src/math.js');

    const nothing = await call('git_commit', { message: 'again', all: true });
    expect(errCode(nothing.envelope)).toBe('CONFLICT');

    const log = await call('git_log', { limit: 5 });
    const commits = data(log.envelope)['commits'] as Array<{ subject: string; sha: string }>;
    expect(commits[0]?.subject).toBe('initial import');
    expect(commits[0]?.sha).toBe(d['commit']);
  });

  it('git_commit refuses to stage a secret path explicitly', async () => {
    const res = await call('git_commit', { message: 'leak', paths: ['.env'] });
    expect(errCode(res.envelope)).toBe('SECRET_PATH_DENIED');
  });
});
