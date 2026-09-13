import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { platformFixture } from '../helpers/platform.js';
import { sha256Bytes } from '../../src/util/hash.js';
import { shellSpec } from '../../src/platform/shell.js';

// These are REAL services/child processes on each host, not process.platform
// mocks. On Windows they exercise CreateProcess, cmd/Git Bash and NTFS.
describe('native runtime contracts in a Thai/spaced workspace', () => {
  let f: ReturnType<typeof platformFixture>;
  beforeAll(() => { f = platformFixture(); }, 120000);
  afterAll(async () => { if (f) await f.close(); }, 120000);

  it('round-trips BOM, CRLF and Unicode through read/edit with hash protection', async () => {
    const file = 'เอกสาร space.txt', original = '\uFEFFfirst ไทย\r\nsecond\r\n';
    await f.call('write_file', { path: file, content: original });
    const read = await f.call('read_files', { files: [{ path: file }] });
    const entry = (read['files'] as Array<{ content: string; hash: string }>)[0]!;
    expect(entry.content).toBe(original);
    await f.call('edit_file', { path: file, expectedHash: entry.hash, edits: [{ find: 'second', replace: 'changed' }] });
    expect(fs.readFileSync(path.join(f.root, file))).toEqual(Buffer.from(original.replace('second', 'changed')));
    await expect(f.call('edit_file', { path: file, expectedHash: entry.hash, edits: [{ find: 'changed', replace: 'stale' }] })).rejects.toThrow('FILE_CHANGED');
  });

  it('previews, applies and rolls back without losing BOM or CRLF bytes', async () => {
    const file = 'rollback.txt', before = '\uFEFFbefore\r\n';
    fs.writeFileSync(path.join(f.root, file), before);
    const plan = await f.call('preview_changes', { operations: [{ op: 'replace_file', path: file, content: '\uFEFFafter\r\n', expectedHash: sha256Bytes(Buffer.from(before)) }] });
    expect(fs.readFileSync(path.join(f.root, file), 'utf8')).toBe(before);
    const applied = await f.call('apply_changes', { planId: plan['planId'], planHash: plan['planHash'], idempotencyKey: f.key() });
    expect(fs.readFileSync(path.join(f.root, file), 'utf8')).toBe('\uFEFFafter\r\n');
    await f.call('rollback_changes', { changesetId: applied['changesetId'], idempotencyKey: f.key() });
    expect(fs.readFileSync(path.join(f.root, file))).toEqual(Buffer.from(before));
  });

  it('preserves native argv containing Unicode, quotes and trailing backslashes', async () => {
    const value = 'ไทย 😀 "literal" C:\\space dir\\';
    const result = await f.run('node', ['-e', 'process.stdout.write(process.argv[1])', value]);
    expect(result.row.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toBe(value);
  });

  it('executes the selected platform shell, with a bounded private large script', async () => {
    const spec = shellSpec(f.root);
    const comment = spec.kind === 'cmd' ? 'rem large input\r\n' : '# large input\n';
    const command = comment.repeat(5000) + 'node -e "process.stdout.write(\'shell-ok\')"';
    const result = await f.run(command, [], true);
    expect(result.row.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain('shell-ok');
    const commandFile = path.join(f.ws.paths.jobsDir, result.jobId, `command${spec.extension}`);
    expect(fs.existsSync(commandFile)).toBe(false);
  });

  it('runs an npm task through the native executable/batch adapter', async () => {
    fs.writeFileSync(path.join(f.root, 'package.json'), JSON.stringify({ private: true, scripts: { probe: 'node -e "process.stdout.write(\'npm-ok\')"' } }));
    const result = await f.run('npm', ['run', 'probe', '--silent']);
    expect(result.row.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain('npm-ok');
  });

  it('cancels a live owned job and reclaims its concurrency slot', async () => {
    const { jobId } = f.ws.services.jobs.start({ ...f.context, kind: 'exec', program: 'node', args: ['-e', 'process.stdout.write("ready");setInterval(()=>{},1000)'], cwdRel: '.', timeoutMs: 15000 });
    const deadline = Date.now() + 10000;
    while (!f.ws.services.jobs.inlineOutput(jobId, f.ws.workspaceId, 'stdout', 100).content.includes('ready') && Date.now() < deadline) await new Promise(r => setTimeout(r, 25));
    expect(f.ws.services.jobs.inlineOutput(jobId, f.ws.workspaceId, 'stdout', 100).content).toContain('ready');
    f.ws.services.jobs.cancel(jobId, f.ws.workspaceId, 100);
    expect(await f.ws.services.jobs.waitForExit(jobId, 10000)).toBe(true);
    expect(f.ws.store.getJob(jobId)?.status).toBe('canceled');
    expect(f.ws.services.jobs.runningCount()).toBe(0);
  });

  it('applies wall timeouts without leaving a running job slot', async () => {
    const { jobId } = f.ws.services.jobs.start({ ...f.context, kind: 'exec', program: 'node', args: ['-e', 'setInterval(()=>{},1000)'], cwdRel: '.', timeoutMs: 500 });
    expect(await f.ws.services.jobs.waitForExit(jobId, 12000)).toBe(true);
    expect(f.ws.store.getJob(jobId)?.status).toBe('timed_out');
    expect(f.ws.services.jobs.runningCount()).toBe(0);
  });

  it.skipIf(process.platform !== 'win32')('executes explicit batch files with safe arguments and refuses metacharacters', async () => {
    fs.writeFileSync(path.join(f.root, 'probe.cmd'), '@echo off\r\nchcp 65001 >nul\r\necho %~1 %~2\r\n');
    const result = await f.run('./probe.cmd', ['plain', 'ไทย space']);
    expect(result.row.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain('plain ไทย space');
    for (const argument of ['%PATH%', 'a&b', '!VAR!', '"quoted"', 'a\nb']) {
      expect(() => f.ws.services.jobs.start({ ...f.context, kind: 'exec', program: './probe.cmd', args: [argument], cwdRel: '.' })).toThrow();
    }
    expect(f.ws.services.jobs.runningCount()).toBe(0);
  });

  it.skipIf(process.platform !== 'win32')('fails closed for an explicitly required OS sandbox', () => {
    expect(() => f.ws.services.jobs.start({ ...f.context, kind: 'exec', program: 'node', args: ['-e', 'process.exit(0)'], cwdRel: '.', sandbox: true })).toThrow(/sandbox.*unavailable/i);
    expect(f.ws.services.jobs.runningCount()).toBe(0);
  });
});
