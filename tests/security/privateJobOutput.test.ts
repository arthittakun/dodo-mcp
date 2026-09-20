import { afterEach, describe, expect, it } from 'vitest';
import { platformFixture } from '../helpers/platform.js';

describe('private adapter job output and binary stdin', () => {
  let f: ReturnType<typeof platformFixture>;
  afterEach(async () => { await f?.close(); });
  it('preserves binary bytes via a real child and denies generic output/foreign callers/input mutation', async () => {
    f = platformFixture();
    const data = Buffer.from([0, 255, 128, 13, 10, 65]);
    const s = f.ws.services;
    const job = await s.jobs.startProtected({ ...f.context, kind: 'exec', program: process.platform === 'win32' ? 'node.exe' : 'node',
      args: ['-e', 'process.stdin.pipe(process.stdout)'], cwdRel: '.', timeoutMs: 5000, inputBytes: data, privateOutput: true });
    expect(() => s.jobs.writeInput(job.jobId, s.workspaceId, 'extra', true)).toThrow();
    expect(await s.jobs.waitForExit(job.jobId, 10000)).toBe(true);
    expect(s.jobs.binaryOutput(job.jobId, s.workspaceId, f.context.principal, 100)).toEqual(data);
    expect(() => s.jobs.binaryOutput(job.jobId, s.workspaceId, 'foreign', 100)).toThrow('another caller');
    expect(() => s.jobs.binaryOutput(job.jobId, s.workspaceId, f.context.principal, 2)).toThrow('budget');
    expect(() => s.jobs.output(job.jobId, s.workspaceId, 'stdout', 0, 100)).toThrow('private adapter');
    expect(() => s.jobs.inlineOutput(job.jobId, s.workspaceId, 'stderr', 100)).toThrow('private adapter');
    await expect(f.call('job_output', { jobId: job.jobId })).rejects.toThrow('FORBIDDEN');
    expect(JSON.stringify(s.store.getJob(job.jobId))).not.toContain(data.toString('base64'));
  });
  it('refuses invalid input before creating a phantom running job', () => {
    f = platformFixture();
    const s = f.ws.services;
    const before = s.store.db.prepare('SELECT COUNT(*) AS n FROM jobs').get();
    expect(() => s.jobs.start({ ...f.context, kind: 'exec', program: 'node', args: [], cwdRel: '.', stdin: false, inputBytes: Buffer.from('x') })).toThrow('budget');
    expect(s.store.db.prepare('SELECT COUNT(*) AS n FROM jobs').get()).toEqual(before);
  });
  it('awaits the final asynchronous source/authority guard after backup and refuses spawn on failure', async () => {
    f = platformFixture(); const s = f.ws.services;
    let inspected = false;
    const before = s.store.db.prepare('SELECT COUNT(*) AS n FROM jobs').get();
    await expect(s.jobs.startProtected({ ...f.context, kind: 'exec', program: 'node', args: [], cwdRel: '.' }, async () => {
      await new Promise(resolve => setImmediate(resolve)); inspected = true; throw Error('source changed after backup');
    })).rejects.toThrow('source changed after backup');
    expect(inspected).toBe(true); expect(s.store.db.prepare('SELECT COUNT(*) AS n FROM jobs').get()).toEqual(before);
  });
});
