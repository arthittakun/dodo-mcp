#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
let nodeVersion = '22';
let outputDir = '';
for (let index = 2; index < process.argv.length; index += 1) {
  const arg = process.argv[index];
  if (arg === '--node' && process.argv[index + 1]) nodeVersion = process.argv[++index];
  else if (arg === '--output-dir' && process.argv[index + 1]) outputDir = path.resolve(process.argv[++index]);
  else throw new Error(`unknown argument: ${arg}`);
}
if (!['22', '24'].includes(nodeVersion)) throw new Error('--node must be 22 or 24');

function run(program, args, options = {}) {
  const result = spawnSync(program, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
    timeout: options.timeout ?? 45 * 60 * 1000,
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${program} ${args.join(' ')} failed with exit ${result.status}`);
  return result.stdout?.trim() ?? '';
}

run('docker', ['info'], { capture: true, timeout: 30_000 });
const revision = run('git', ['rev-parse', 'HEAD'], { capture: true, timeout: 30_000 });
const dirty = run('git', ['status', '--porcelain'], { capture: true, timeout: 30_000 }).length > 0;
const githubActionsUsed = process.env['GITHUB_ACTIONS'] === 'true';
if (githubActionsUsed && process.env['GITHUB_SHA'] !== revision) throw new Error('GitHub Actions checkout does not match GITHUB_SHA');
const lockDigest = `sha256:${createHash('sha256').update(fs.readFileSync(path.join(root, 'package-lock.json'))).digest('hex')}`;
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
outputDir ||= path.join(root, 'release-evidence', pkg.version, `linux-docker-node${nodeVersion}-${stamp}`);
fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });

const image = `dodo-mcp-linux-gate:node${nodeVersion}`;
console.log(`[linux-docker] building ${image} from revision ${revision.slice(0, 12)} (dirty=${dirty})`);
run('docker', [
  'build', '--file', 'docker/linux-test.Dockerfile',
  '--build-arg', `NODE_VERSION=${nodeVersion}`,
  '--label', `org.opencontainers.image.revision=${revision}`,
  '--tag', image, '.',
]);

console.log('[linux-docker] running Linux release gate with Playwright Chromium');
run('docker', [
  'run', '--rm', '--init', '--ipc=host',
  '--security-opt', `seccomp=${path.join(root, 'docker', 'chromium-seccomp.json')}`,
  '--mount', `type=bind,source=${outputDir},target=/evidence`,
  '--env', `DODO_RELEASE_GATE_SOURCE_REVISION=${revision}`,
  '--env', `DODO_RELEASE_GATE_SOURCE_DIRTY=${dirty}`,
  '--env', `DODO_RELEASE_GATE_GITHUB_ACTIONS=${githubActionsUsed}`,
  image,
]);

const reportFile = path.join(outputDir, 'gate-report.json');
const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
if (report.status !== 'AUTOMATED_PASS') throw new Error(`Linux gate status is ${report.status}`);
if (report.host?.platform !== 'linux') throw new Error(`expected Linux evidence, received ${report.host?.platform ?? 'unknown'}`);
if (report.source?.revision !== revision || report.source?.dependencyLockSha256 !== lockDigest) {
  throw new Error('Linux evidence does not match the host revision/package lock');
}
if (report.source?.dirty !== dirty || report.source?.provenance !== 'docker-host-git') {
  throw new Error('Linux evidence source attestation is invalid');
}
if (report.platformPolicy?.githubActionsUsed !== githubActionsUsed) throw new Error('Linux evidence runner origin is invalid');
if (report.freshInstall?.status !== 'PASS') throw new Error('Linux fresh-tarball smoke did not pass');

const verification = {
  schemaVersion: 1,
  status: 'AUTOMATED_PASS',
  environment: 'linux-docker',
  nodeMajor: Number(nodeVersion),
  source: report.source,
  host: report.host,
  releaseEligible: report.source?.dirty === false,
  runnerOrigin: githubActionsUsed ? 'github-actions-self-hosted' : 'local',
  browserCase: report.benchmark?.aggregate?.eligibleCases === 7 ? 'AUTOMATED_PASS' : 'NOT_RUN',
  gateReport: path.basename(reportFile),
  generatedAt: new Date().toISOString(),
};
fs.writeFileSync(path.join(outputDir, 'docker-verification.json'), `${JSON.stringify(verification, null, 2)}\n`, { mode: 0o600 });
console.log(`[linux-docker] AUTOMATED_PASS | node=${report.host.node} | arch=${report.host.arch} | browser=${verification.browserCase}`);
console.log(`[linux-docker] evidence=${outputDir}`);
