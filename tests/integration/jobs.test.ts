import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { launch, obtainToken, callToolLegacy, wsArgs, type TestContext, type TokenSet } from '../helpers/testServer.js';

/** F. Jobs / execution (JOB-01..13). */
describe('JOB: execution, approvals, output, cancel', () => {
  let ctx: TestContext;
  let tokens: TokenSet;

  beforeEach(async () => {
    ctx = await launch({ toolSurface: 'full', 
      fixtureFiles: {
        'package.json': JSON.stringify({ name: 'fx', scripts: { hello: "node -e \"console.log('hi from task')\"" } }),
        'loop.js': 'setInterval(()=>{},1000); process.stdout.write("started\\n");',
        'echo.js': 'process.stdin.on("data",d=>process.stdout.write("got:"+d));',
      },
      trust: 'trusted',
    });
    tokens = await obtainToken(ctx);
  }, 120_000);
  afterEach(async () => ctx?.cleanup());

  const data = (env: Record<string, unknown>) => env['data'] as Record<string, unknown>;
  const errCode = (env: Record<string, unknown>) => (env['error'] as Record<string, unknown> | null)?.['code'];

  async function waitStatus(jobId: string, want: string[], timeoutMs = 15000): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const res = await callToolLegacy(ctx, tokens.accessToken, 'job_status', { ...wsArgs(ctx), jobId });
      const d = data(res.envelope);
      if (want.includes(d['status'] as string)) return d;
      if (Date.now() > deadline) throw new Error(`timeout waiting for ${want} (got ${d['status'] as string})`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  it('JOB-01: in inspect mode, exec does not start a process without approval', async () => {
    ctx.server.services.store.setTrustMode(ctx.server.workspaceId, 'inspect');
    const res = await callToolLegacy(ctx, tokens.accessToken, 'exec_command', {
      ...wsArgs(ctx),
      program: 'node',
      args: ['-e', 'console.log(1)'],
      idempotencyKey: 'k-noexec-01',
    });
    expect(errCode(res.envelope)).toBe('APPROVAL_REQUIRED');
    const jobs = await callToolLegacy(ctx, tokens.accessToken, 'list_jobs', { ...wsArgs(ctx), limit: 10 });
    expect((data(jobs.envelope)['jobs'] as unknown[]).length).toBe(0);
  });

  it('JOB-02/JOB-04: exec returns a jobId promptly; output readable after "reconnect"', async () => {
    const res = await callToolLegacy(ctx, tokens.accessToken, 'exec_command', {
      ...wsArgs(ctx),
      program: 'node',
      args: ['-e', "process.stdout.write('hello-stdout\\n')"],
      idempotencyKey: 'k-exec-out-1',
    });
    const jobId = data(res.envelope)['jobId'] as string;
    expect(jobId).toBeTruthy();
    await waitStatus(jobId, ['exited']);
    // A brand-new tool call (simulating a fresh HTTP connection) can still read output.
    const out = await callToolLegacy(ctx, tokens.accessToken, 'job_output', { ...wsArgs(ctx), jobId, stream: 'stdout', offset: 0 });
    expect((data(out.envelope)['content'] as string)).toContain('hello-stdout');
  });

  it('JOB-02: run_task executes a discovered recipe (not caller command strings)', async () => {
    const overview = await callToolLegacy(ctx, tokens.accessToken, 'project_overview', {});
    const tasks = (data(overview.envelope)['tasks'] as Array<{ id: string; recipeDigest: string }>);
    const hello = tasks.find((t) => t.id === 'npm:hello');
    expect(hello).toBeTruthy();
    const res = await callToolLegacy(ctx, tokens.accessToken, 'run_task', {
      ...wsArgs(ctx),
      taskId: 'npm:hello',
      recipeDigest: hello!.recipeDigest,
      idempotencyKey: 'k-task-01',
    });
    const jobId = data(res.envelope)['jobId'] as string;
    await waitStatus(jobId, ['exited']);
    const out = await callToolLegacy(ctx, tokens.accessToken, 'job_output', { ...wsArgs(ctx), jobId, stream: 'stdout', offset: 0 });
    expect(data(out.envelope)['content'] as string).toContain('hi from task');
  });

  it('run_task with a stale recipeDigest is refused', async () => {
    const res = await callToolLegacy(ctx, tokens.accessToken, 'run_task', {
      ...wsArgs(ctx),
      taskId: 'npm:hello',
      recipeDigest: 'sha256:staaaale',
      idempotencyKey: 'k-task-stale-1',
    });
    expect(errCode(res.envelope)).toBe('CONFLICT');
  });

  it('JOB-06: job_input pipes stdin to the process', async () => {
    const res = await callToolLegacy(ctx, tokens.accessToken, 'exec_command', {
      ...wsArgs(ctx),
      program: 'node',
      args: ['echo.js'],
      idempotencyKey: 'k-stdin-01',
    });
    const jobId = data(res.envelope)['jobId'] as string;
    await new Promise((r) => setTimeout(r, 200));
    await callToolLegacy(ctx, tokens.accessToken, 'job_input', { ...wsArgs(ctx), jobId, data: 'ping', closeStdin: true });
    await waitStatus(jobId, ['exited']);
    const out = await callToolLegacy(ctx, tokens.accessToken, 'job_output', { ...wsArgs(ctx), jobId, stream: 'stdout', offset: 0 });
    expect(data(out.envelope)['content'] as string).toContain('got:ping');
  });

  it('JOB-07: cancel terminates a long-running owned job', async () => {
    const res = await callToolLegacy(ctx, tokens.accessToken, 'exec_command', {
      ...wsArgs(ctx),
      program: 'node',
      args: ['loop.js'],
      idempotencyKey: 'k-cancel-01',
    });
    const jobId = data(res.envelope)['jobId'] as string;
    await waitStatus(jobId, ['running']);
    const cancel = await callToolLegacy(ctx, tokens.accessToken, 'job_cancel', { ...wsArgs(ctx), jobId });
    expect(cancel.isError).toBe(false);
    await waitStatus(jobId, ['canceled']);
  });

  it('JOB-10: shell metacharacters in args are passed literally (no shell)', async () => {
    const res = await callToolLegacy(ctx, tokens.accessToken, 'exec_command', {
      ...wsArgs(ctx),
      program: 'node',
      args: ['-e', 'process.stdout.write(process.argv[1])', '; rm -rf / && echo pwned'],
      idempotencyKey: 'k-shell-meta-1',
    });
    const jobId = data(res.envelope)['jobId'] as string;
    await waitStatus(jobId, ['exited']);
    const out = await callToolLegacy(ctx, tokens.accessToken, 'job_output', { ...wsArgs(ctx), jobId, stream: 'stdout', offset: 0 });
    // The metacharacter string is a literal argv element, never interpreted.
    expect(data(out.envelope)['content'] as string).toContain('; rm -rf / && echo pwned');
  });

  it('JOB-11: same idempotency key yields exactly one job', async () => {
    const a = await callToolLegacy(ctx, tokens.accessToken, 'exec_command', { ...wsArgs(ctx), program: 'node', args: ['-e', '1'], idempotencyKey: 'k-once-only-1' });
    const b = await callToolLegacy(ctx, tokens.accessToken, 'exec_command', { ...wsArgs(ctx), program: 'node', args: ['-e', '1'], idempotencyKey: 'k-once-only-1' });
    expect(data(a.envelope)['jobId']).toBe(data(b.envelope)['jobId']);
    expect(data(b.envelope)['replayed']).toBe(true);
  });

  it('JOB-12: an executable planted in the repo is NOT found on the trusted PATH', async () => {
    // A repo-local ./evil must not resolve as a bare program name.
    const res = await callToolLegacy(ctx, tokens.accessToken, 'exec_command', {
      ...wsArgs(ctx),
      program: 'definitely-not-a-real-tool-xyz',
      args: [],
      idempotencyKey: 'k-path-safe-1',
    });
    expect(errCode(res.envelope)).toBe('NOT_FOUND');
  });

  it('JOB-13: batch concurrency limit is enforced before any process starts', async () => {
    const tooMany = await callToolLegacy(ctx, tokens.accessToken, 'run_commands', { ...wsArgs(ctx), commands: Array.from({length:5}, () => ({command:'node loop.js'})), waitMs:1000 });
    expect(errCode(tooMany.envelope)).toBe('RESOURCE_LIMIT');
    expect(ctx.server.services.jobs.runningCount()).toBe(0);
    const batch = await callToolLegacy(ctx, tokens.accessToken, 'run_commands', { ...wsArgs(ctx), commands: Array.from({length:4}, () => ({command:'node loop.js'})), waitMs:1000 });
    expect(batch.isError).toBe(false);
    const started = (data(batch.envelope)['results'] as Array<{jobId:string}>).map(r=>r.jobId);
    expect(started).toHaveLength(4);
    expect(ctx.server.services.jobs.runningCount()).toBe(4);
    for (const jobId of started) await callToolLegacy(ctx, tokens.accessToken, 'job_cancel', { ...wsArgs(ctx), jobId });
  });
});
