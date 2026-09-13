import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { launch, obtainToken, callToolLegacy, wsArgs, type TestContext, type TokenSet } from '../helpers/testServer.js';

/** F. Git (GIT-01..03) + Diagnostics (DIAG-01..02). */
describe('GIT + DIAG', () => {
  let ctx: TestContext;
  let tokens: TokenSet;

  beforeAll(async () => {
    ctx = await launch({ toolSurface: 'full', 
      fixtureFiles: {
        'tracked.ts': 'export const a = 1;\n',
        'sub/nested.ts': 'export const b = 2;\n',
        '.env': 'SECRET=x\n',
        'package.json': JSON.stringify({ name: 'fx', scripts: { fail: 'node -e "process.exit(3)"' } }),
      },
      trust: 'trusted',
    });
    // Init a real git repo AT the workspace root.
    const git = (args: string[]) => execFileSync('git', args, { cwd: ctx.fixtureDir, stdio: 'pipe' });
    git(['init', '-q']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test']);
    git(['add', 'tracked.ts', 'sub/nested.ts', 'package.json']);
    git(['commit', '-q', '-m', 'init']);
    // Now make the tree dirty.
    fs.writeFileSync(path.join(ctx.fixtureDir, 'tracked.ts'), 'export const a = 99;\n');
    fs.writeFileSync(path.join(ctx.fixtureDir, 'untracked.ts'), 'export const c = 3;\n');
    tokens = await obtainToken(ctx);
  }, 120_000);
  afterAll(async () => ctx?.cleanup());

  const data = (env: Record<string, unknown>) => env['data'] as Record<string, unknown>;

  it('GIT-01: status reports dirty + untracked scoped to the workspace', async () => {
    const res = await callToolLegacy(ctx, tokens.accessToken, 'git_status', { ...wsArgs(ctx) });
    const d = data(res.envelope);
    expect(d['isRepo']).toBe(true);
    const paths = (d['entries'] as Array<{ path: string }>).map((e) => e.path);
    expect(paths).toContain('tracked.ts');
    expect(paths).toContain('untracked.ts');
  });

  it('GIT-03: secret files never appear in status', async () => {
    const res = await callToolLegacy(ctx, tokens.accessToken, 'git_status', { ...wsArgs(ctx) });
    const paths = (data(res.envelope)['entries'] as Array<{ path: string }>).map((e) => e.path);
    expect(paths).not.toContain('.env');
  });

  it('GIT: diff shows working-tree changes and honors path scoping', async () => {
    const res = await callToolLegacy(ctx, tokens.accessToken, 'git_diff', { ...wsArgs(ctx), paths: ['tracked.ts'] });
    const diff = data(res.envelope)['diff'] as string;
    expect(diff).toContain('const a = 99');
    expect(diff).toContain('tracked.ts');
  });

  it('CLI-05/GIT: a non-git workspace returns isRepo=false, not an error', async () => {
    const plain = await launch({ toolSurface: 'full',  fixtureFiles: { 'x.txt': 'y' } });
    try {
      const t = await obtainToken(plain);
      const res = await callToolLegacy(plain, t.accessToken, 'git_status', { ...wsArgs(plain) });
      expect(res.isError).toBe(false);
      expect(data(res.envelope)['isRepo']).toBe(false);
    } finally {
      await plain.cleanup();
    }
  }, 60_000);

  it('DIAG-01: a nonzero test exit is reported as failed even with no parsed errors', async () => {
    const overview = await callToolLegacy(ctx, tokens.accessToken, 'project_overview', {});
    const tasks = data(overview.envelope)['tasks'] as Array<{ id: string; recipeDigest: string }>;
    const failTask = tasks.find((t) => t.id === 'npm:fail')!;
    const run = await callToolLegacy(ctx, tokens.accessToken, 'run_task', { ...wsArgs(ctx), taskId: 'npm:fail', recipeDigest: failTask.recipeDigest, idempotencyKey: 'k-diag-fail-1' });
    const jobId = data(run.envelope)['jobId'] as string;
    // wait for exit
    for (let i = 0; i < 200; i++) {
      const st = await callToolLegacy(ctx, tokens.accessToken, 'job_status', { ...wsArgs(ctx), jobId });
      if (data(st.envelope)['status'] !== 'running') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const diag = await callToolLegacy(ctx, tokens.accessToken, 'diagnostics', { ...wsArgs(ctx), source: 'tests' });
    const receipts = data(diag.envelope)['receipts'] as Array<{ jobId: string; passed: boolean; exitCode: number }>;
    const receipt = receipts.find((r) => r.jobId === jobId)!;
    expect(receipt.passed).toBe(false);
    expect(receipt.exitCode).toBe(3);
  });

  it('DIAG (typescript): reports semantic diagnostics with a freshness token', async () => {
    // introduce a type error
    const preview = await callToolLegacy(ctx, tokens.accessToken, 'preview_changes', {
      ...wsArgs(ctx),
      operations: [{ op: 'create', path: 'bad.ts', content: 'const n: number = "not a number";\n' }],
    });
    const d = data(preview.envelope);
    await callToolLegacy(ctx, tokens.accessToken, 'apply_changes', { ...wsArgs(ctx), planId: d['planId'], planHash: d['planHash'], idempotencyKey: 'k-diag-ts-1' });
    const diag = await callToolLegacy(ctx, tokens.accessToken, 'diagnostics', { ...wsArgs(ctx), source: 'typescript', files: ['bad.ts'] });
    const dd = data(diag.envelope);
    expect((dd['freshness'] as Record<string, unknown>)['programVersion']).toBeTruthy();
    const diags = dd['diagnostics'] as Array<{ path: string; category: string }>;
    expect(diags.some((x) => x.path === 'bad.ts' && x.category === 'error')).toBe(true);
  });
});
