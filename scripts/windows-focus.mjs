#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { privateCommand } from './gate-command.mjs';
import { npmInvocation } from './npm-process.mjs';
import { testCounts } from './gate-evidence.mjs';
import { focusedFailureDetails } from './gate-progress.mjs';

let phase = 'initialization';
let privateLog;
try {
  if (process.platform !== 'win32' || !process.env.DODO_CI_EVIDENCE) throw new Error('native Windows evidence directory required');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const directory = path.resolve(process.env.DODO_CI_EVIDENCE);
  fs.mkdirSync(directory, { recursive: true });
  const logFile = path.join(directory, 'focus.log');
  fs.writeFileSync(logFile, '', { flag: 'wx', mode: 0o600 });
  privateLog = logFile;
  const run = (args, timeout) => {
    const call = npmInvocation(args);
    return privateCommand(call.program, call.args, { cwd: root, timeout, logFile, env: { ...process.env, DODO_TEST_REPORT_DIR: directory } });
  };
  phase = 'build';
  const build = run(['run', 'build'], 5 * 60_000);
  if (build.status !== 0) throw new Error('build failed');
  phase = 'focused-tests';
  const result = run(['exec', '--no', '--', 'vitest', 'run', 'tests/security/recoveryBackups.test.ts', 'tests/integration/directTools.test.ts', 'tests/security/windowsAclOwner.test.ts', '--maxWorkers=1'], 10 * 60_000);
  phase = 'report';
  const report = JSON.parse(fs.readFileSync(path.join(directory, 'core-tests.json'), 'utf8'));
  const summary = { scope: 'focused_diagnostics_only', exitCode: result.status, durationMs: result.durationMs,
    tests: testCounts(report), failures: focusedFailureDetails(report, root) };
  fs.writeFileSync(path.join(directory, 'focus-summary.json'), JSON.stringify(summary, null, 2), { flag: 'wx', mode: 0o600 });
  console.log('DODO_FOCUS_BEGIN');
  console.log(JSON.stringify(summary, null, 2));
  console.log('DODO_FOCUS_END');
  process.exitCode = result.status;
} catch (error) {
  if (privateLog) try { fs.appendFileSync(privateLog, `\n[focus failure] ${String(error)}\n`); } catch { /* stay private */ }
  console.error(`[windows-focus] failed during ${phase}; private diagnostics withheld`);
  process.exitCode = 1;
}
