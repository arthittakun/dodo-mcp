import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { launch, obtainToken, callToolLegacy, wsArgs, mkTmpDir, type TestContext, type TokenSet } from '../helpers/testServer.js';
import { ContextSchema, ImpactSchema, SymbolSchema } from '../../src/services/assistance/contracts.js';
import { VerificationSchema } from '../../src/services/assistance/verification.js';
import { TOOL_CATALOG } from '../../src/tools/catalog.js';

const report = (passed: number, failed = 0) => JSON.stringify({ numTotalTests: passed + failed, numPassedTests: passed, numFailedTests: failed, numPendingTests: 0, testResults: [] });

describe('assistance tools over real MCP/OAuth', () => {
  let ctx: TestContext, tokens: TokenSet;
  beforeAll(async () => {
    ctx = await launch({ toolSurface: 'full',  trust: 'trusted', fixtureFiles: {
      'package.json': JSON.stringify({ name: 'assist-fixture', version: '1', scripts: { test: 'node ok.cjs', 'test:fail': 'node fail.cjs', 'test:empty': 'node empty.cjs', 'test:slow': 'node slow.cjs', build: 'node ok.cjs', typecheck: 'node ok.cjs' } }),
      'ok.cjs': `console.log(${JSON.stringify(report(2))});`,
      'fail.cjs': `console.log(${JSON.stringify(report(1, 1))});process.exit(1);`,
      'empty.cjs': `console.log(${JSON.stringify(report(0))});`,
      'slow.cjs': `setTimeout(() => console.log(${JSON.stringify(report(1))}), 1200);`,
      'src/math.ts': '// สวัสดี 🌏\nexport function add(a: number, b: number) {\n  return a + b;\n}\nexport const untouched = 9;\n',
      'src/main.ts': 'import { add } from "./math.js"; export const result = add(1,2);',
      'tests/math.test.ts': 'import { add } from "../src/math.js"; export const tested = add(2,3);',
      'docs/math.md': '# add math\nAddition helper.',
    } });
    tokens = await obtainToken(ctx);
  });
  afterAll(async () => ctx?.cleanup());
  const call = (name: string, args: Record<string, unknown>) => callToolLegacy(ctx, tokens.accessToken, name, { ...wsArgs(ctx), ...args });
  const data = (result: Awaited<ReturnType<typeof call>>) => { expect(result.isError, JSON.stringify(result.envelope.error)).toBe(false); return result.envelope.data; };
  const plan = async () => VerificationSchema.parse(data(await call('verify_changes', { mode: 'plan', files: ['src/math.ts'] })));
  async function run(id: string, key: string, waitMs = 10000) {
    const p = await plan();
    const task = p.recommendedTasks.find(t => t.taskId === id)!;
    expect(task).toBeDefined();
    const args = { mode: 'run', files: ['src/math.ts'], tasks: [{ taskId: task.taskId, recipeDigest: task.recipeDigest }], sourceDigest: p.freshness.baselineDigest, idempotencyKey: key, waitMs };
    return { args, result: VerificationSchema.parse(data(await call('verify_changes', args))) };
  }
  it('returns typed cited task context and static impact through the actual worker and wire', async () => {
    const context = ContextSchema.parse(data(await call('context_for_task', { goal: 'แก้ add math', terms: ['add'], files: ['src/math.ts'] })));
    expect(context.files[0]?.path).toBe('src/math.ts');
    expect(context.files.some(f => f.category === 'docs')).toBe(true);
    const impact = ImpactSchema.parse(data(await call('analyze_impact', { files: ['src/math.ts'] })));
    expect(impact.relatedTests).toContain('tests/math.test.ts');
    expect(impact.impacted.some(f => f.path === 'src/main.ts')).toBe(true);
  });
  it('previews, applies and rolls back one symbol body with the existing journal', async () => {
    const file = path.join(ctx.fixtureDir, 'src/math.ts'), before = fs.readFileSync(file, 'utf8');
    const read = SymbolSchema.parse(data(await call('read_symbol', { file: 'src/math.ts', symbol: 'add' })));
    expect(read.content).not.toContain('untouched');
    const preview = data(await call('preview_refactor', { file: 'src/math.ts', symbol: 'add', expectedHash: read.hash, body: '\n  return a - b;\n' })) as { planId: string; planHash: string };
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    const applied = data(await call('apply_changes', { planId: preview.planId, planHash: preview.planHash, idempotencyKey: 'assist-apply-body-01' })) as { changesetId: string };
    expect(fs.readFileSync(file, 'utf8')).toBe(before.replace('a + b', 'a - b'));
    data(await call('rollback_changes', { changesetId: applied.changesetId, idempotencyKey: 'assist-rollback-body-01' }));
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });
  it('refuses to apply an AST plan when a human edits the file after preview', async () => {
    const file = path.join(ctx.fixtureDir, 'src/math.ts'), before = fs.readFileSync(file, 'utf8');
    const read = SymbolSchema.parse(data(await call('read_symbol', { file: 'src/math.ts', symbol: 'add' })));
    const p = data(await call('preview_refactor', { file: 'src/math.ts', symbol: 'add', expectedHash: read.hash, body: 'return 0;' })) as { planId: string; planHash: string };
    fs.appendFileSync(file, '// human edit\n');
    try {
      const result = await call('apply_changes', { planId: p.planId, planHash: p.planHash, idempotencyKey: 'assist-stale-apply-01' });
      expect(result.isError).toBe(true); expect(fs.readFileSync(file, 'utf8')).toContain('// human edit');
    } finally { fs.writeFileSync(file, before); }
  });
  it('verification plan performs no execution and reports tasks not run', async () => {
    const before = ctx.server.services.jobs.list(ctx.server.workspaceId, 100).length;
    const p = await plan();
    expect(p.status).toBe('not_run'); expect(p.verificationId).toBeNull();
    expect(p.notRun).toContain('npm:test');
    expect(ctx.server.services.jobs.list(ctx.server.workspaceId, 100)).toHaveLength(before);
  });
  it('runs selected recipes, parses real job output and replays without duplicate jobs', async () => {
    const { args, result } = await run('npm:test', 'assist-verify-pass-01');
    expect(result.status).toBe('passed'); expect(result.checks[0]?.tests).toMatchObject({ total: 2, passed: 2, source: 'json' });
    expect(result.notRun).toContain('npm:build');
    const replay = VerificationSchema.parse(data(await call('verify_changes', args)));
    expect(replay.replayed).toBe(true); expect(replay.verificationId).toBe(result.verificationId); expect(replay.checks[0]?.jobId).toBe(result.checks[0]?.jobId);
  });
  it('does not pass a failed command or a successful command with zero tests', async () => {
    expect((await run('npm:test:fail', 'assist-verify-fail-01')).result.status).toBe('failed');
    const empty = (await run('npm:test:empty', 'assist-verify-empty-01')).result;
    expect(empty.status).toBe('incomplete'); expect(empty.checks[0]?.commandPassed).toBe(true); expect(empty.checks[0]?.tests.total).toBe(0);
  });
  it('reports source changes as stale evidence and does not forget observed drift after restoration', async () => {
    const { result } = await run('npm:test', 'assist-verify-freshness-01');
    const file = path.join(ctx.fixtureDir, 'src/math.ts'), before = fs.readFileSync(file, 'utf8');
    fs.appendFileSync(file, '// after test\n');
    try {
      const updated = VerificationSchema.parse(data(await call('verify_changes', { mode: 'report', verificationId: result.verificationId })));
      expect(updated.status).toBe('stale'); expect(updated.freshness.changedPaths).toContain('src/math.ts');
    } finally { fs.writeFileSync(file, before); }
    expect(VerificationSchema.parse(data(await call('verify_changes', { mode: 'report', verificationId: result.verificationId }))).status).toBe('stale');
  });
  it('returns running job IDs and later reports completion without starting work in report mode', async () => {
    const { result } = await run('npm:test:slow', 'assist-verify-poll-01', 0);
    expect(result.status).toBe('running');
    await ctx.server.services.jobs.waitForExit(result.checks[0]!.jobId!, 10000);
    const completed = VerificationSchema.parse(data(await call('verify_changes', { mode: 'report', verificationId: result.verificationId })));
    expect(completed.status).toBe('passed'); expect(completed.checks[0]?.jobId).toBe(result.checks[0]?.jobId);
  });
  it('rejects an entire stale recipe/source batch before launching any job', async () => {
    const p = await plan(), task = p.recommendedTasks.find(t => t.taskId === 'npm:test')!;
    const count = ctx.server.services.jobs.list(ctx.server.workspaceId, 100).length;
    const request = { mode: 'run', files: ['src/math.ts'], tasks: [{ taskId: task.taskId, recipeDigest: 'sha256:' + '0'.repeat(64) }], sourceDigest: p.freshness.baselineDigest, idempotencyKey: 'assist-invalid-recipe-01' };
    expect((await call('verify_changes', request)).envelope.error).toMatchObject({ code: 'CONFLICT' });
    expect((await call('verify_changes', { ...request, tasks: [{ taskId: task.taskId, recipeDigest: task.recipeDigest }], sourceDigest: 'sha256:' + '0'.repeat(64), idempotencyKey: 'assist-invalid-source-01' })).envelope.error).toMatchObject({ code: 'FILE_CHANGED' });
    expect(ctx.server.services.jobs.list(ctx.server.workspaceId, 100)).toHaveLength(count);
  });
  it('new tools have explicit output schemas and preserve all original catalog entries', () => {
    expect(TOOL_CATALOG.length).toBeGreaterThanOrEqual(54);
    expect(TOOL_CATALOG.slice(49, 54).map(t => t.name)).toEqual(['context_for_task', 'analyze_impact', 'read_symbol', 'preview_refactor', 'verify_changes']);
    for (const tool of TOOL_CATALOG.slice(49, 54)) expect(Object.keys(zodShape(tool.output)).length).toBeGreaterThan(1);
  });
});

function zodShape(schema: unknown): Record<string, unknown> { return (schema as { shape: Record<string, unknown> }).shape; }

it('modern STDIO client discovers and invokes the added tools from a Thai/spaced workspace', async () => {
  const parent = mkTmpDir('dodo-assist-stdio-'), root = path.join(parent, 'โปรเจกต์ ใหม่'); fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'math.ts'), 'export function add(a: number,b: number) { return a + b; }');
  const configDir = mkTmpDir('dodo-assist-stdio-cfg-');
  const client = new Client({ name: 'assist-test', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve('dist/cli/main.js'), 'stdio'], cwd: root,
    env: { ...process.env, DODO_CONFIG_DIR: configDir } as Record<string, string>, stderr: 'pipe' }));
  try {
    expect((await client.listTools()).tools.map(t => t.name)).toContain('context_for_task');
    const overview = (await client.callTool({ name: 'project_overview', arguments: {} })).structuredContent as { workspaceId: string; workspaceEpoch: string };
    const result = await client.callTool({ name: 'read_symbol', arguments: { workspaceId: overview.workspaceId, workspaceEpoch: overview.workspaceEpoch, file: 'math.ts', symbol: 'add' } });
    const envelope = result.structuredContent as { ok: boolean; data: unknown };
    expect(envelope.ok).toBe(true); expect(SymbolSchema.parse(envelope.data).content).toContain('a + b');
  } finally { await client.close(); fs.rmSync(parent, { recursive: true, force: true }); fs.rmSync(configDir, { recursive: true, force: true }); }
});
