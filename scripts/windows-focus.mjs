#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
    return privateCommand(call.program, call.args, { cwd: root, timeout, logFile, env: { ...process.env, DODO_TEST_REPORT_DIR: directory, DODO_TEST_REQUIRE_NATIVE_ACL: '1' } });
  };
  phase = 'build';
  const build = run(['run', 'build'], 5 * 60_000);
  if (build.status !== 0) throw new Error('build failed');
  phase = 'native-acl-preflight';
  process.env.DODO_TEST_REQUIRE_NATIVE_ACL = '1';
  const { ensurePrivateDirectory, assertPrivatePath } = await import(pathToFileURL(path.join(root,'dist/platform/privateFs.js')).href);
  const { windowsPrivateAclDiagnostics } = await import(pathToFileURL(path.join(root,'dist/platform/windowsPrivateAcl.js')).href);
  const probe = path.join(directory,'acl-preflight');
  try {
    ensurePrivateDirectory(probe);
    const start = Date.now();for(let i=0;i<20;i++)assertPrivatePath(probe,true);
    console.log('DODO_ACL_BACKEND_BEGIN');
    console.log(JSON.stringify({...windowsPrivateAclDiagnostics(),checks:20,elapsedMs:Date.now()-start}));
    console.log('DODO_ACL_BACKEND_END');
  } catch(error) {
    console.log('DODO_ACL_BACKEND_BEGIN');console.log(JSON.stringify(windowsPrivateAclDiagnostics()));console.log('DODO_ACL_BACKEND_END');throw error;
  }
  phase = 'focused-tests';
  const result = run(['exec', '--no', '--', 'vitest', 'run', 'tests/security/recoveryGit.test.ts', 'tests/security/recoveryRestore.test.ts', 'tests/integration/recoveryDriftHttp.test.ts', '--maxWorkers=1'], 20 * 60_000);
  phase = 'report';
  const report = JSON.parse(fs.readFileSync(path.join(directory, 'core-tests.json'), 'utf8'));
  const browserFile = path.join(directory, 'recovery-browser-diagnostics.json');
  const browser = fs.existsSync(browserFile) ? JSON.parse(fs.readFileSync(browserFile, 'utf8')) : null;
  const allowedPhases = new Set(['navigate','projects','select','scan-click','scan-result','screenshots','acknowledge','verify']);
  const browserDiagnostics = browser ? {
    phase: allowedPhases.has(browser.phase) ? browser.phase : null,
    phases: (browser.phases || []).filter(p => allowedPhases.has(p.phase) && Number.isSafeInteger(p.elapsedMs)).slice(0,20).map(p=>({phase:p.phase,elapsedMs:p.elapsedMs})),
    responses: (browser.responses || []).filter(r=>['recovery.status','recovery.drift.scan','recovery.evidence.list','recovery.restore_list'].includes(r.operation) && Number.isSafeInteger(r.status)).slice(0,30).map(r=>({operation:r.operation,status:r.status})),
    state: browser.state ? Object.fromEntries(['loading','selected','error','recoveryError'].map(k=>[k,browser.state[k]===true])) : null,
  } : null;
  const summary = { scope: 'focused_diagnostics_only', exitCode: result.status, durationMs: result.durationMs,
    browserDiagnostics, tests: testCounts(report), failures: focusedFailureDetails(report, root) };
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
