#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
let output = path.join(root, 'release-evidence', pkg.version, `dodobench-${stamp}.json`);
for (let i = 2; i < process.argv.length; i += 1) {
  if (process.argv[i] === '--output' && process.argv[i + 1]) output = path.resolve(process.argv[++i]);
  else throw new Error(`unknown argument: ${process.argv[i]}`);
}
fs.mkdirSync(path.dirname(output), { recursive: true });
const vitest = path.join(root, 'node_modules', 'vitest', 'vitest.mjs');
const run = spawnSync(process.execPath, [vitest, 'run', 'tests/evaluation/dodoBench.test.ts'], {
  cwd: root, stdio: 'inherit', env: { ...process.env, DODO_BENCH_OUTPUT: output }, timeout: 10 * 60 * 1000,
});
if (run.error) throw run.error;
if (run.status !== 0) process.exit(run.status ?? 1);
const { DodoBenchReport } = await import('../dist/evaluation/contracts.js');
const report = DodoBenchReport.parse(JSON.parse(fs.readFileSync(output, 'utf8')));
console.log(`[dodo-bench] ${report.status} | cases=${report.aggregate.passedCases}/${report.aggregate.eligibleCases} | calls=${report.aggregate.toolCalls} | p95=${report.aggregate.latencyMs.p95}ms | modelTokens=null`);
console.log(`[dodo-bench] report=${output}`);
if (report.status !== 'PASS') process.exit(1);
