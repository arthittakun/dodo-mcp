#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { sanitizeGateReport } from './gate-evidence.mjs';

try {
  let directory, githubSummary = false;
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '--input-dir' && process.argv[i + 1]) directory = path.resolve(process.argv[++i]);
    else if (process.argv[i] === '--github-summary') githubSummary = true;
    else throw new Error('invalid option');
  }
  if (!directory) throw new Error('input directory required');
  const report = JSON.parse(fs.readFileSync(path.join(directory, 'gate-report.json'), 'utf8'));
  const summary = sanitizeGateReport(report);
  fs.writeFileSync(path.join(directory, 'public-summary.json'), `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  if (githubSummary && process.env['GITHUB_STEP_SUMMARY']) {
    fs.appendFileSync(process.env['GITHUB_STEP_SUMMARY'], `### ${summary.host.platform} ${summary.host.node}\n\n- Status: ${summary.status}\n- Revision: ${summary.source.revision}\n- Fresh install: ${summary.freshInstall}\n- Manual: ${summary.manual}\n`);
  }
  console.log('[gate-summary] allowlisted summary written');
} catch {
  console.error('[gate-summary] could not validate/write evidence; no private diagnostics published');
  process.exitCode = 1;
}
