#!/usr/bin/env node
/** Explicit local verification. No publication, git mutation, permission change or server restart. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolveTrustedExecutable } from '../dist/platform/execResolve.js';
import { batchInvocation } from '../dist/platform/shell.js';
import { WorkspaceFS } from '../dist/workspace/fs.js';
import { IgnoreEngine } from '../dist/workspace/ignores.js';

const root = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const out = path.join(root, 'release-evidence', pkg.version, 'continuation');
fs.mkdirSync(out, { recursive: true });
const wfs = new WorkspaceFS(root, new IgnoreEngine({ root }));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function fingerprint() {
  const files = new Set(['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json', 'vitest.config.ts', 'eslint.config.js']);
  for (const directory of ['src', 'tests', 'scripts', '.github']) {
    for (const entry of wfs.walk({ startRel: directory, maxEntries: 20000 })) files.add(entry.rel);
  }
  const hashes = [...files].sort().map(file => [file, 'sha256:' + sha(wfs.readFileBytes(file, 16 * 1024 * 1024).bytes)]);
  return { digest: sha(JSON.stringify(hashes)), files: hashes.length, hashes };
}
const npm = resolveTrustedExecutable('npm', root);
const startedAt = new Date().toISOString();
const before = fingerprint();
const gates = [];
function run(name, args) {
  const invocation = process.platform === 'win32' && /\.(cmd|bat)$/i.test(npm)
    ? batchInvocation(npm, args, root)
    : { program: npm, args, windowsVerbatimArguments: false };
  const started = Date.now();
  const result = spawnSync(invocation.program, invocation.args, {
    cwd: root, encoding: 'utf8', shell: false, windowsHide: true,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    timeout: 600000, maxBuffer: 32 * 1024 * 1024,
  });
  const log = `${name}.log`;
  fs.writeFileSync(path.join(out, log), `${result.stdout ?? ''}\n${result.stderr ?? ''}${result.error ? '\n' + result.error.message : ''}`);
  const gate = { name, command: ['npm', ...args], exitCode: result.status, signal: result.signal, durationMs: Date.now() - started, log, ...(result.error ? { error: result.error.message } : {}) };
  gates.push(gate);
  console.log(`${name}: exit ${result.status}${result.error ? ' (launch/timeout error)' : ''}`);
  return result.status === 0 && !result.error;
}
function tests(name, paths) {
  return run(name, ['exec', '--', 'vitest', 'run', ...paths, '--reporter=json', `--outputFile=${path.relative(root, path.join(out, name + '.json')).split(path.sep).join('/')}`]);
}
const staticOk = run('build', ['run', 'build']) && run('typecheck', ['run', 'typecheck']) && run('lint', ['run', 'lint']);
if (staticOk) {
  tests('core', ['tests/unit', 'tests/integration', 'tests/security', 'tests/compatibility']);
  tests('packaging', ['tests/packaging']);
  run('platform-contracts', ['run', 'test:windows', '--', '--reporter=json', `--outputFile=${path.relative(root, path.join(out, 'platform-contracts.json')).split(path.sep).join('/')}`]);
}
function resultOf(name) {
  if (!gates.some(gate => gate.name === name)) return { status: 'NOT_RUN' };
  try {
    const report = JSON.parse(fs.readFileSync(path.join(out, name + '.json'), 'utf8'));
    if (!['numTotalTests', 'numPassedTests', 'numFailedTests', 'numPendingTests'].every(key => Number.isInteger(report[key]))) throw new Error('unknown reporter summary');
    return { passed: report.numPassedTests, failed: report.numFailedTests, skipped: report.numPendingTests, total: report.numTotalTests, files: report.testResults.length, success: report.success };
  } catch (error) { return { status: 'UNVERIFIED_REPORT', reason: error.message }; }
}
const after = fingerprint();
const core = resultOf('core'), packaging = resultOf('packaging'), contracts = resultOf('platform-contracts');
const reportsVerified = [core, packaging, contracts].every(report => report.success === true && report.passed > 0 && report.failed === 0);
const passed = staticOk && gates.every(gate => gate.exitCode === 0 && !gate.error) && reportsVerified && before.digest === after.digest;
const report = {
  version: pkg.version, startedAt, completedAt: new Date().toISOString(),
  status: passed ? 'LOCAL_GATE_PASSED_WINDOWS_EXPERIMENTAL' : 'FAILED_OR_STALE',
  environment: { platform: process.platform, arch: process.arch, node: process.version, osRelease: os.release() },
  gates, tests: { core, packaging, platformContracts: contracts },
  source: { before: before.digest, after: after.digest, unchanged: before.digest === after.digest, fileCount: after.files, scope: 'guarded src/tests/scripts/.github and root manifests/config; docs and generated dist/schemas excluded' },
  nativeWindows: { executed: process.platform === 'win32', node22and24Matrix: 'NOT_COMPLETED_HERE', manualWindows11: 'NOT_RUN', supportStatus: 'EXPERIMENTAL' },
  publication: { npm: false, gitCommit: false, gitTag: false, globalInstallChanged: false, runningServerReplaced: false },
};
fs.writeFileSync(path.join(out, 'source-manifest.json'), JSON.stringify(after, null, 2) + '\n');
fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ status: report.status, tests: report.tests, sourceUnchanged: report.source.unchanged, evidence: out }, null, 2));
process.exitCode = passed ? 0 : 1;
