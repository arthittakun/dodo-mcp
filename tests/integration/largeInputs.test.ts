import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { launch, obtainToken, callToolLegacy, wsArgs, type TestContext, type TokenSet } from '../helpers/testServer.js';
import { sha256Bytes } from '../../src/util/hash.js';
import { sandboxAvailability } from '../../src/services/jobs/sandbox.js';
import { assertPrivatePath } from '../../src/platform/privateFs.js';

const CLI = fileURLToPath(new URL('../../dist/cli/main.js', import.meta.url));
const data = (env: Record<string, unknown>) => env['data'] as Record<string, unknown>;
const padding = '# ' + 'long source '.repeat(26000) + '\n';

describe('large coding inputs', () => {
  let ctx: TestContext;
  let tokens: TokenSet;
  beforeEach(async () => { ctx = await launch({ toolSurface: 'full',  trust: 'trusted' }); tokens = await obtainToken(ctx); }, 60_000);
  afterEach(async () => {
    vi.restoreAllMocks();
    await ctx?.cleanup();
    if (ctx) { fs.rmSync(ctx.fixtureDir, { recursive: true, force: true }); fs.rmSync(ctx.configDir, { recursive: true, force: true }); }
  });
  const call = (name: string, args: Record<string, unknown>) => callToolLegacy(ctx, tokens.accessToken, name, { ...wsArgs(ctx), ...args });
  const scriptFor = (jobId: string) => path.join(ctx.configDir, 'jobs', jobId, 'command.sh');

  it('LARGE-01: real 300+ KiB shell source, Unicode/heredoc/CWD, private source cleanup and idempotent retry', async () => {
    const css = '.card { color: red; } /* ภาษาไทย */\n'.repeat(5000);
    const command = `${padding}cat > 'หน้า เว็บ.css' <<'DODO_CSS'\n${css}DODO_CSS\nprintf 'done'\nprintf x >> count.txt\n`;
    const args = { command, idempotencyKey: 'large-shell-retry', waitMs: 30000 };
    const first = await call('run_command', args);
    expect(first.envelope['ok']).toBe(true);
    expect(data(first.envelope)['exitCode']).toBe(0);
    expect(data(first.envelope)['stdout']).toBe('done');
    expect(fs.readFileSync(path.join(ctx.fixtureDir, 'หน้า เว็บ.css'), 'utf8')).toBe(css);
    const jobId = data(first.envelope)['jobId'] as string;
    expect(fs.existsSync(scriptFor(jobId))).toBe(false);
    const second = await call('run_command', args);
    expect(data(second.envelope)['jobId']).toBe(jobId);
    expect(data(second.envelope)['replayed']).toBe(true);
    expect(fs.readFileSync(path.join(ctx.fixtureDir, 'count.txt'), 'utf8')).toBe('x');
  });

  it('LARGE-02: long parallel commands have distinct jobs and bounded command echoes', async () => {
    const result = await call('run_commands', { commands: [{ name: 'a', command: padding + 'printf A' }, { name: 'b', command: padding + 'printf B' }] });
    expect(data(result.envelope)['allSucceeded']).toBe(true);
    const jobs = data(result.envelope)['results'] as Array<{ jobId: string; stdout: string; command: string; commandTruncated: boolean }>;
    expect(jobs.map(j => j.stdout)).toEqual(['A', 'B']);
    expect(new Set(jobs.map(j => j.jobId)).size).toBe(2);
    for (const job of jobs) {
      expect(job.commandTruncated).toBe(true);
      expect(Buffer.byteLength(job.command)).toBeLessThanOrEqual(1024);
      expect(fs.existsSync(scriptFor(job.jobId))).toBe(false);
    }
    expect(result.envelope['truncated']).toBe(true);
    expect(JSON.stringify(result.envelope).length).toBeLessThan(12000);
  });

  it('LARGE-03: long scripts leave stdin available, use mode 0600, and clean up after cancel', async () => {
    const launched = await call('run_command', { command: padding + "read -r value; printf 'got:%s' \"$value\"; sleep 60", background: true });
    const jobId = data(launched.envelope)['jobId'] as string;
    const script = scriptFor(jobId);
    assertPrivatePath(script);
    assertPrivatePath(path.dirname(script), true);
    if (process.platform !== 'win32') {
      expect(fs.statSync(script).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(script)).mode & 0o777).toBe(0o700);
    }
    const input = await call('job_input', { jobId, data: 'hello\n' });
    expect(input.envelope['ok']).toBe(true);
    let output = '';
    for (let i = 0; i < 100 && !output.includes('got:hello'); i++) {
      output = data((await call('job_output', { jobId, stream: 'stdout', offset: 0 })).envelope)['content'] as string;
      if (!output.includes('got:hello')) await new Promise(resolve => setTimeout(resolve, 25));
    }
    expect(output).toContain('got:hello');
    expect((await call('job_cancel', { jobId })).envelope['ok']).toBe(true);
    await call('job_wait', { jobId, waitMs: 10000 });
    expect(fs.existsSync(script)).toBe(false);
  });

  it('LARGE-04: 3 MiB source write/edit/preview/stale-hash/rollback keep full bytes and bounded diffs', async () => {
    const content = '/* dashboard */\n' + 'x'.repeat(3 * 1024 * 1024);
    const created = await call('write_file', { path: 'big.css', content });
    expect(created.envelope['ok']).toBe(true);
    const hash = data(created.envelope)['hash'] as string;
    expect(hash).toBe(sha256Bytes(content));
    const preview = await call('edit_file', { path: 'big.css', expectedHash: hash, edits: [{ find: 'dashboard', replace: 'workspace' }], dryRun: true });
    expect(preview.envelope['ok']).toBe(true);
    expect(preview.envelope['truncated']).toBe(true);
    expect(fs.readFileSync(path.join(ctx.fixtureDir, 'big.css'), 'utf8')).toBe(content);
    const edited = await call('edit_file', { path: 'big.css', expectedHash: hash, edits: [{ find: 'dashboard', replace: 'workspace' }] });
    expect(edited.envelope['ok']).toBe(true);
    const after = content.replace('dashboard', 'workspace');
    expect(fs.readFileSync(path.join(ctx.fixtureDir, 'big.css'), 'utf8')).toBe(after);
    const stale = await call('write_file', { path: 'big.css', content: 'wrong', expectedHash: hash });
    expect((stale.envelope['error'] as { code: string }).code).toBe('FILE_CHANGED');
    const rollback = await call('rollback_changes', { changesetId: data(edited.envelope)['changesetId'], idempotencyKey: 'large-rollback-01' });
    expect(rollback.envelope['ok']).toBe(true);
    expect(fs.readFileSync(path.join(ctx.fixtureDir, 'big.css'), 'utf8')).toBe(content);
  }, 60_000);

  it('LARGE-05: explicit argv accepts source over the former 4096-character limit', async () => {
    const source = '/*' + 'x'.repeat(20000) + '*/console.log("large argv")';
    const started = await call('exec_command', { program: 'node', args: ['-e', source], idempotencyKey: 'large-argv-01' });
    expect(started.envelope['ok']).toBe(true);
    const jobId = data(started.envelope)['jobId'];
    const result = await call('job_wait', { jobId, waitMs: 30000 });
    expect(data(result.envelope)['exitCode']).toBe(0);
    expect(data(result.envelope)['stdout']).toContain('large argv');
  });

  it.skipIf(process.platform !== 'darwin')('LARGE-06: private script works inside the real macOS sandbox', async () => {
    expect(sandboxAvailability().available).toBe(true);
    const result = await call('run_command', { command: padding + 'printf sandboxed > proof.txt; cat proof.txt', sandbox: true, network: false });
    expect(result.envelope['ok']).toBe(true);
    expect(data(result.envelope)['exitCode']).toBe(0);
    expect(data(result.envelope)['sandboxed']).toBe('macos-seatbelt');
    expect(data(result.envelope)['stdout']).toBe('sandboxed');
  });

  it('LARGE-07: STDIO large profile handles an 11 MiB file and real long command through the SDK', async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dodo-large-stdio-'));
    const env = { ...process.env, DODO_CONFIG_DIR: configDir } as Record<string, string>;
    execFileSync(process.execPath, [CLI, 'limits', '--profile', 'large'], { env, stdio: 'pipe' });
    execFileSync(process.execPath, [CLI, 'trust', '--mode', 'trusted', '--yes'], { env, cwd: ctx.fixtureDir, stdio: 'pipe' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, 'stdio', '--root', ctx.fixtureDir], env, stderr: 'pipe' });
    const client = new Client({ name: 'large-stdio-fixture', version: '1' });
    try {
      await client.connect(transport);
      const ov = (await client.callTool({ name: 'project_overview', arguments: {} })).structuredContent as Record<string, unknown>;
      const d = data(ov);
      const ws = { workspaceId: d['workspaceId'], workspaceEpoch: d['workspaceEpoch'] };
      const policy = d['policy'] as { limits: { commandBytes: number; readFileBytes: number } };
      expect(policy.limits.commandBytes).toBe(8 * 1024 * 1024);
      expect(policy.limits.readFileBytes).toBe(16 * 1024 * 1024);
      const content = 'a'.repeat(11 * 1024 * 1024);
      const written = (await client.callTool({ name: 'write_file', arguments: { ...ws, path: 'stdio-large.txt', content } })).structuredContent as Record<string, unknown>;
      expect(written['ok']).toBe(true);
      expect(data(written)['hash']).toBe(sha256Bytes(content));
      expect(fs.readFileSync(path.join(ctx.fixtureDir, 'stdio-large.txt'), 'utf8')).toBe(content);
      const suffix = '\nprintf stdio-large';
      const command = '#' + 'x'.repeat(8 * 1024 * 1024 - suffix.length - 1) + suffix;
      expect(Buffer.byteLength(command)).toBe(8 * 1024 * 1024);
      const executed = (await client.callTool({ name: 'run_command', arguments: { ...ws, command } })).structuredContent as Record<string, unknown>;
      expect(data(executed)['exitCode']).toBe(0);
      expect(data(executed)['stdout']).toBe('stdio-large');
    } finally { await client.close(); fs.rmSync(configDir, { recursive: true, force: true }); }
  }, 60_000);

  it('LARGE-08: modern HTTP SDK dispatch handles long commands and large file content', async () => {
    const client = new Client({ name: 'large-modern-http-fixture', version: '1' });
    const transport = new StreamableHTTPClientTransport(new URL(`${ctx.baseUrl}/mcp`), { authProvider: { token: async () => tokens.accessToken } });
    try {
      await client.connect(transport);
      const result = (await client.callTool({ name: 'run_command', arguments: { ...wsArgs(ctx), command: padding + 'printf modern' } })).structuredContent as Record<string, unknown>;
      expect(data(result)['exitCode']).toBe(0);
      expect(data(result)['stdout']).toBe('modern');
      const content = 'x'.repeat(3 * 1024 * 1024);
      const written = (await client.callTool({ name: 'write_file', arguments: { ...wsArgs(ctx), path: 'modern.txt', content } })).structuredContent as Record<string, unknown>;
      expect(written['ok']).toBe(true);
      expect(data(written)['hash']).toBe(sha256Bytes(content));
      expect(fs.readFileSync(path.join(ctx.fixtureDir, 'modern.txt'), 'utf8')).toBe(content);
    } finally { await client.close(); }
  });

  it('LARGE-09: source cleanup also happens after spawn failure; state failure launches nothing', async () => {
    const shell = vi.spyOn(ctx.server.services.jobs, 'shellPath').mockReturnValue('/definitely-missing-dodo-shell');
    const result = await call('run_command', { command: padding + 'echo should-not-run' });
    expect(data(result.envelope)['status']).toBe('failed_to_start');
    const jobId = data(result.envelope)['jobId'] as string;
    expect(fs.existsSync(scriptFor(jobId))).toBe(false);
    shell.mockRestore();
    vi.spyOn(ctx.server.services.store, 'createJob').mockImplementation(() => { throw new Error('injected state failure'); });
    const failed = await call('run_command', { command: padding + 'touch untracked' });
    expect(failed.envelope['ok']).toBe(false);
    expect(ctx.server.services.jobs.runningCount()).toBe(0);
    expect(fs.existsSync(path.join(ctx.fixtureDir, 'untracked'))).toBe(false);
    const dirs = fs.readdirSync(path.join(ctx.configDir, 'jobs'));
    for (const dir of dirs) expect(fs.existsSync(path.join(ctx.configDir, 'jobs', dir, 'command.sh'))).toBe(false);
  });
});
