import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveTrustedExecutable } from '../../src/platform/execResolve.js';
import { AnimationWorkerSpec } from '../../src/services/multimodal/animationContracts.js';
import { launch, type TestContext } from '../helpers/testServer.js';

let python: string | undefined;
for (const name of ['python', 'python3']) { try { python = resolveTrustedExecutable(name, process.cwd(), { allowBatch: false }); break; } catch { /* the next trusted interpreter may exist */ } }
const worker = fileURLToPath(new URL('../../dist/services/multimodal/animationWorker.js', import.meta.url));
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    // Container PID1 can retain already-dead grandchildren as zombies.
    if (process.platform === 'linux' && /^State:\s+Z/m.test(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))) return false;
    return true;
  } catch { return false; }
}
async function until(check: () => boolean, timeout: number): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check()) { if (Date.now() >= deadline) throw new Error('owned animation process did not reach the required state'); await delay(25); }
}

describe.skipIf(!python)('owned animation worker process tree', () => {
  let ctx: TestContext;
  beforeAll(async () => { ctx = await launch({ trust: 'trusted' }); });
  afterAll(async () => { await ctx?.cleanup(); });

  async function start(timeoutMs: number) {
    const storage = ctx.server.services.multimodal!.storage, directory = storage.directory();
    const bridge = path.join(directory, 'test-bridge.py'), specFile = path.join(directory, 'spec.json');
    fs.writeFileSync(bridge, [
      'import json, os, pathlib, subprocess, sys, time',
      'assert os.environ.get("GIFT_CAPTION_ENGINE") == "harfbuzz", "DODO captions must not select a browser renderer"',
      'directory = pathlib.Path(sys.argv[1]).parent',
      'child = subprocess.Popen([sys.executable, "-I", "-B", "-c", "import time; time.sleep(60)"])',
      '(directory / "pids.json").write_text(json.dumps([os.getpid(), child.pid]))',
      'while True: time.sleep(0.1)',
    ].join('\n'), { mode: 0o600 });
    fs.writeFileSync(specFile, JSON.stringify(AnimationWorkerSpec.parse({ version: 1, operation: 'image', directory, python: python!, bridge, ffmpeg: null, params: {} })), { mode: 0o600 });
    const s = ctx.server.services;
    const job = await s.jobs.startProtected({ workspaceId: s.workspaceId, epoch: s.epoch, principal: 'local-stdio', kind: 'exec', program: 'node', args: [worker, specFile], cwdRel: '.', timeoutMs, stdin: false, network: false, sandbox: false });
    let pids: number[] = [];
    await until(() => { try { const value = JSON.parse(fs.readFileSync(path.join(directory, 'pids.json'), 'utf8')) as unknown; if (Array.isArray(value) && value.length === 2 && value.every(pid => Number.isInteger(pid) && pid > 0)) { pids = value; return true; } } catch { /* publication is not complete yet */ } return false; }, 2500);
    expect(pids).toHaveLength(2); expect(pids.every(alive)).toBe(true);
    return { jobId: job.jobId, pids, directory };
  }

  it('wall timeout terminates Python and its encoder-like grandchild together', async () => {
    const started = await start(3500), jobs = ctx.server.services.jobs;
    await until(() => jobs.getJobChecked(started.jobId, ctx.server.workspaceId).status === 'timed_out', 7000);
    await until(() => started.pids.every(pid => !alive(pid)), 7000);
    ctx.server.services.multimodal!.storage.removeDirectory(started.directory);
  });

  it('explicit job cancellation terminates the same owned tree', async () => {
    const started = await start(15000), jobs = ctx.server.services.jobs;
    jobs.cancel(started.jobId, ctx.server.workspaceId, 100);
    await until(() => started.pids.every(pid => !alive(pid)), 7000);
    expect(jobs.getJobChecked(started.jobId, ctx.server.workspaceId).status).toBe('canceled');
    ctx.server.services.multimodal!.storage.removeDirectory(started.directory);
  });
});
