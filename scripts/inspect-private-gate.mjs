#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { partialTestProgress, freshInstallFailureDetails } from './gate-progress.mjs';
import { sanitizeGateReport, failureLocations } from './gate-evidence.mjs';

try {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const run = process.env.DODO_INSPECT_RUN;
  const platform = process.platform === 'win32' ? 'windows' : process.platform === 'linux' ? 'linux' : null;
  if (!platform) throw new Error('native CI platform required');
  if (!/^\d+-\d+$/.test(run ?? '')) throw new Error('invalid run');
  for (const major of [22, 24]) {
    const directory = path.resolve(root, '../.dodo-ci-evidence', run, `${platform}-node-${major}`);
    const report = path.join(directory, 'gate-report.json');
    if (!fs.existsSync(report)) { console.log(JSON.stringify({ nodeMajor: major, reportAvailable: false })); continue; }
    const summary = sanitizeGateReport(JSON.parse(fs.readFileSync(report, 'utf8')));
    const log = path.join(directory, 'gate.log');
    const partial = fs.existsSync(log) && fs.statSync(log).size <= 80 * 1024 * 1024
      ? partialTestProgress(fs.readFileSync(log, 'utf8'), root) : null;
    const failures = {};
    for (const suite of ['core', 'packaging']) {
      const file = path.join(directory, `${suite}-tests.json`);
      if (fs.existsSync(file)) failures[suite] = failureLocations(JSON.parse(fs.readFileSync(file, 'utf8')), root);
    }
    console.log('DODO_DIAGNOSTICS_BEGIN');
    const freshInstall = fs.existsSync(log) && fs.statSync(log).size <= 80 * 1024 * 1024 ? freshInstallFailureDetails(fs.readFileSync(log,'utf8'),root) : null;
    console.log(JSON.stringify({ nodeMajor: major, summary, partial, failures, freshInstall }, null, 2));
    console.log('DODO_DIAGNOSTICS_END');
  }
} catch {
  console.error('[gate-diagnostics] evidence unavailable or invalid; private diagnostics withheld');
  process.exitCode = 1;
}
