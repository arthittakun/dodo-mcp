#!/usr/bin/env node
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceFingerprint } from './gate-evidence.mjs';
import { privateCommand } from './gate-command.mjs';

let initializedLog;
function main() {
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
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
outputDir ||= path.join(root, 'release-evidence', pkg.version, `linux-docker-node${nodeVersion}-${stamp}`);
fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
for (const file of ['gate-report.json', 'docker-verification.json', 'linux-driver.log']) {
  if (fs.existsSync(path.join(outputDir, file))) throw new Error('use a fresh evidence directory');
}
const driverLog = path.join(outputDir, 'linux-driver.log');
fs.writeFileSync(driverLog, '', { flag: 'wx', mode: 0o600 });
initializedLog = driverLog;

function run(program, args, options = {}) {
  const result = privateCommand(program, args, {
    cwd: root, logFile: driverLog,
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
// The dedicated runner's Docker bridge has no working DNS route. The source
// revision is trusted main and remains copied into the image; host networking
// is used only to give build/audit traffic the runner host's working resolver.
const networkArgs = githubActionsUsed ? ['--network', 'host'] : [];
const lockDigest = `sha256:${createHash('sha256').update(fs.readFileSync(path.join(root, 'package-lock.json'))).digest('hex')}`;
const fingerprint = sourceFingerprint(root);

const image = `dodo-mcp-linux-gate:node${nodeVersion}`;
const container = `dodo-mcp-linux-gate-node${nodeVersion}-${process.pid}-${Date.now()}`;
console.log(`[linux-docker] building ${image} from revision ${revision.slice(0, 12)} (dirty=${dirty})`);
run('docker', [
  'build', ...networkArgs, '--file', 'docker/linux-test.Dockerfile',
  '--build-arg', `NODE_VERSION=${nodeVersion}`,
  '--label', `org.opencontainers.image.revision=${revision}`,
  '--tag', image, '.',
]);

console.log('[linux-docker] running Linux release gate with Playwright Chromium');
let gateError;
try {
  run('docker', [
    'run', '--name', container, '--init', '--ipc=host', ...networkArgs,
    '--security-opt', `seccomp=${path.join(root, 'docker', 'chromium-seccomp.json')}`,
    '--env', `DODO_RELEASE_GATE_SOURCE_REVISION=${revision}`,
    '--env', `DODO_RELEASE_GATE_SOURCE_DIRTY=${dirty}`,
    '--env', `DODO_RELEASE_GATE_GITHUB_ACTIONS=${githubActionsUsed}`,
    '--env', `DODO_RELEASE_GATE_SOURCE_FINGERPRINT=${fingerprint}`,
    image,
  ]);
} catch (error) {
  gateError = error;
} finally {
  let copyError;
  try {
    run('docker', ['cp', `${container}:/evidence/.`, outputDir], { timeout: 60_000 });
  } catch (error) {
    copyError = error;
  }
  try {
    run('docker', ['rm', '--force', container], { capture: true, timeout: 30_000 });
  } catch (error) {
    if (!gateError && !copyError) throw error;
  }
  if (!gateError && copyError) throw copyError;
}
if (gateError) throw gateError;

const reportFile = path.join(outputDir, 'gate-report.json');
const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
if (report.status !== 'AUTOMATED_PASS') throw new Error(`Linux gate status is ${report.status}`);
if (report.host?.platform !== 'linux') throw new Error(`expected Linux evidence, received ${report.host?.platform ?? 'unknown'}`);
if (report.source?.revision !== revision || report.source?.dependencyLockSha256 !== lockDigest) {
  throw new Error('Linux evidence does not match the host revision/package lock');
}
if (sourceFingerprint(root) !== fingerprint || report.source?.fingerprint !== fingerprint) throw new Error('candidate source changed or Docker copy differs');
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
console.log('[linux-docker] detailed evidence retained privately');
}

try { main(); } catch (error) {
  if (initializedLog) try {
    fs.appendFileSync(initializedLog, `\n[DRIVER FAILURE] ${error instanceof Error ? error.message : String(error)}\n`);
  } catch { /* Keep log I/O errors private too. */ }
  console.error('[linux-docker] failed; inspect private linux-driver.log and gate.log; diagnostics withheld');
  process.exitCode = 1;
}
