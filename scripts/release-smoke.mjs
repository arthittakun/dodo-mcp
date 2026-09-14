#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const options = {};
for (let i = 2; i < process.argv.length; i += 1) {
  if (process.argv[i] === '--tarball' && process.argv[i + 1]) options.tarball = path.resolve(process.argv[++i]);
  else if (process.argv[i] === '--output' && process.argv[i + 1]) options.output = path.resolve(process.argv[++i]);
  else throw new Error(`unknown argument: ${process.argv[i]}`);
}
if (!options.tarball || !options.output) throw new Error('usage: release-smoke.mjs --tarball FILE --output FILE');
// A failed rerun must not leave the previous run's PASS report at this path.
fs.rmSync(options.output, { force: true });

// Windows cannot unlink a loaded .node/DLL. Keep the installed package entirely
// in a child process, and reap that process before removing its fresh prefix.
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dodo-release-smoke-'));
const workerOutput = path.join(fixtureDir, 'worker-result.json');
let report;
try {
  const worker = spawnSync(process.execPath, [
    fileURLToPath(new URL('./release-smoke-worker.mjs', import.meta.url)),
    '--tarball', options.tarball, '--output', workerOutput, '--fixture-dir', fixtureDir,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 9 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 });
  if (worker.error || worker.status !== 0) {
    if (worker.stderr) console.error(worker.stderr.slice(-16_384));
    throw new Error(`installed-package smoke worker failed: ${worker.error?.message ?? worker.status ?? worker.signal}`);
  }
  report = JSON.parse(fs.readFileSync(workerOutput, 'utf8'));
  if (report.status !== 'PASS' || report.stdio?.toolCount !== 125 || report.http?.toolCount !== 19 || report.http?.writeEditReadBack !== true) {
    throw new Error('installed-package smoke worker returned an invalid result');
  }
} finally {
  fs.rmSync(fixtureDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

// Publish evidence only after verification AND cleanup both succeed.
report.cleanup = { status: 'PASS', installedNativeModulesIsolated: true };
fs.mkdirSync(path.dirname(options.output), { recursive: true });
fs.writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.log(`[release-smoke] PASS | cli=${report.cliVersion} | full=${report.stdio.toolCount} | compact=${report.http.toolCount} | cleanup=PASS`);
