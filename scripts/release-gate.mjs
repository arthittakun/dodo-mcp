#!/usr/bin/env node
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { npmInvocation } from './npm-process.mjs';
import { sourceFingerprint, readTestCounts, readAuditEvidence, matchPlatformEvidence } from './gate-evidence.mjs';
import { privateCommand } from './gate-command.mjs';

let initializedLog;
function main() {
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const options = { allowDirty: false, release: false, outputDir: '', platformEvidence: [] };
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg === '--allow-dirty') options.allowDirty = true;
  else if (arg === '--release') options.release = true;
  else if (arg === '--output-dir' && process.argv[i + 1]) options.outputDir = path.resolve(process.argv[++i]);
  else if (arg === '--platform-evidence' && process.argv[i + 1]) options.platformEvidence.push(path.resolve(process.argv[++i]));
  else throw new Error(`unknown argument: ${arg}`);
}
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outputDir = options.outputDir || path.join(root, 'release-evidence', pkg.version, `phase-10-${stamp}`);
fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
const logFile = path.join(outputDir, 'gate.log');
const reportFile = path.join(outputDir, 'gate-report.json');
for (const name of ['gate-report.json', 'core-tests.json', 'packaging-tests.json', 'public-summary.json']) {
  if (fs.existsSync(path.join(outputDir, name))) throw new Error('use a new evidence directory; existing reports are immutable');
}
fs.writeFileSync(logFile, '', { flag: 'wx', mode: 0o600 });
initializedLog = logFile;
const steps = [];
let failure;

function append(value) { fs.appendFileSync(logFile, value, { mode: 0o600 }); }
function command(program, args, { allowFailure = false, timeout = 20 * 60 * 1000, env = {}, id = 'source-check' } = {}) {
  const label = `${program} ${args.join(' ')}`;
  const result = privateCommand(program, args, { cwd: root, env: { ...process.env, ...env }, timeout, logFile });
  const status = result.status;
  steps.push({ id, command: label, status, durationMs: result.durationMs });
  if (result.error) throw result.error;
  if (status !== 0 && !allowFailure) {
    // stdout/stderr and command paths may contain secrets or host identities.
    // Retain them only in private gate.log, including every failure path.
    throw new Error(`${label} failed with exit ${status}`);
  }
  return result;
}
function sha(algorithm, file) { return createHash(algorithm).update(fs.readFileSync(file)).digest('hex'); }
function git(args) { return command('git', args).stdout.trim(); }
function npm(args, options) {
  const invocation = npmInvocation(args);
  return command(invocation.program, invocation.args, { id: args[0] === 'run' ? args[1] : args[0], ...options });
}

function sourceState() {
  const assertedRevision = process.env['DODO_RELEASE_GATE_SOURCE_REVISION'];
  const assertedDirty = process.env['DODO_RELEASE_GATE_SOURCE_DIRTY'];
  if (assertedRevision === undefined && assertedDirty === undefined) {
    const revision = git(['rev-parse', 'HEAD']);
    const githubActionsUsed = process.env['GITHUB_ACTIONS'] === 'true';
    if (githubActionsUsed && process.env['GITHUB_SHA'] !== revision) throw new Error('GitHub Actions checkout does not match GITHUB_SHA');
    return { revision, dirty: git(['status', '--porcelain']).length > 0, provenance: 'local-git', githubActionsUsed };
  }
  if (process.platform !== 'linux' || !fs.existsSync('/.dockerenv')) throw new Error('source attestation variables are accepted only inside a Linux Docker container');
  if (!/^[0-9a-f]{40}$/i.test(assertedRevision ?? '')) throw new Error('invalid Docker source revision attestation');
  if (!['true', 'false'].includes(assertedDirty ?? '')) throw new Error('invalid Docker dirty-state attestation');
  const assertedActions = process.env['DODO_RELEASE_GATE_GITHUB_ACTIONS'] ?? 'false';
  if (!['true', 'false'].includes(assertedActions)) throw new Error('invalid Docker GitHub Actions attestation');
  return { revision: assertedRevision, dirty: assertedDirty === 'true', provenance: 'docker-host-git', githubActionsUsed: assertedActions === 'true' };
}

const source = sourceState();
const { revision, dirty } = source;
const fingerprint = sourceFingerprint(root);
if (process.env['DODO_RELEASE_GATE_SOURCE_FINGERPRINT'] && process.env['DODO_RELEASE_GATE_SOURCE_FINGERPRINT'] !== fingerprint) {
  failure = 'Docker source fingerprint does not match the copied candidate';
}
if (dirty && !options.allowDirty) failure = 'source changes are present; commit/review them or use --allow-dirty for a candidate gate';

let auditSummary = null;
let pack = null;
let artifact = null;
let smoke = null;
let bench = null;
try {
  if (failure) throw new Error(failure);
  npm(['run', 'build']);
  npm(['run', 'typecheck']);
  npm(['run', 'lint']);
  // Native NTFS ACL checks launch PowerShell and the expanded Recovery suite
  // exceeded the old aggregate budget. Keep individual test deadlines and all
  // assertions intact; allow the complete Windows report to be produced.
  npm(['run', 'test:all'], { timeout: (process.platform === 'win32' ? 60 : 30) * 60 * 1000, env: { DODO_TEST_REPORT_DIR: outputDir } });
  const testEvidence = readTestCounts(outputDir);
  if (!Object.values(testEvidence).every(t => t?.success && t.passed > 0 && t.failed === 0)) throw new Error('missing, inconsistent or failed test evidence');

  const benchFile = path.join(outputDir, 'dodobench.json');
  command(process.execPath, ['scripts/dodo-bench.mjs', '--output', benchFile], {
    id: 'benchmark',
    timeout: 10 * 60 * 1000,
    env: source.provenance === 'docker-host-git'
      ? { DODO_BENCH_SOURCE_REVISION: revision, DODO_BENCH_SOURCE_DIRTY: String(dirty) }
      : {},
  });
  bench = JSON.parse(fs.readFileSync(benchFile, 'utf8'));
  if (bench.status !== 'PASS') throw new Error('DodoBench regression gate failed');

  const audit = npm(['audit', '--omit=dev', '--json'], { allowFailure: true, timeout: 5 * 60 * 1000 });
  auditSummary = readAuditEvidence(audit);
  const { vulnerabilities } = auditSummary;
  fs.writeFileSync(path.join(outputDir, 'dependency-audit.json'), `${JSON.stringify(auditSummary, null, 2)}\n`, { mode: 0o600 });
  if ((vulnerabilities.high ?? 0) > 0 || (vulnerabilities.critical ?? 0) > 0) throw new Error('production dependency audit has high or critical vulnerabilities');

  const artifactDir = path.join(outputDir, 'artifact'); fs.mkdirSync(artifactDir, { recursive: true });
  const packed = npm(['pack', '--json', '--pack-destination', artifactDir], { timeout: 5 * 60 * 1000 });
  const entries = JSON.parse(packed.stdout); pack = entries[0];
  if (!pack?.filename || !Array.isArray(pack.files)) throw new Error('npm pack returned invalid metadata');
  fs.writeFileSync(path.join(outputDir, 'npm-pack.json'), `${JSON.stringify(pack, null, 2)}\n`, { mode: 0o600 });
  const files = pack.files.map((entry) => entry.path);
  const required = ['package.json', 'README.md', 'dist/cli/main.js', 'dist/evaluation/contracts.js', 'dist/evaluation/dodoBench.js', 'schemas/tools.json', 'schemas/tools.compact.json', 'docs/EVALUATION.md', 'docs/SECURITY.md'];
  for (const item of required) if (!files.includes(item)) throw new Error(`tarball is missing required file: ${item}`);
  const forbidden = [/(^|\/)\.env($|\.)/i, /state\.db/i, /release-evidence/i, /docs\/development/i, /DEVELOPMENT_ROADMAP/i, /WINDOWS_(PLAN|DEV_PROPOSAL)/i, /ggml-.*\.bin$/i, /(^|\/)(\.npmrc|auth\.json|cookies\.json|jwks\.json|id_rsa)(\/|$)/i, /\.(pem|key|mp4|wav|aiff)$/i];
  for (const file of files) if (forbidden.some((pattern) => pattern.test(file))) throw new Error(`forbidden release artifact path: ${file}`);
  const tarball = path.join(artifactDir, pack.filename);
  artifact = { filename: pack.filename, bytes: fs.statSync(tarball).size, files: files.length, unpackedSize: pack.unpackedSize,
    sha1: sha('sha1', tarball), sha256: sha('sha256', tarball), sha512: sha('sha512', tarball), integrity: pack.integrity, shasum: pack.shasum };
  fs.writeFileSync(path.join(outputDir, 'artifact.json'), `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });
  const smokeFile = path.join(outputDir, 'fresh-install.json');
  command(process.execPath, ['scripts/release-smoke.mjs', '--tarball', tarball, '--output', smokeFile], { id: 'fresh-install', timeout: 10 * 60 * 1000 });
  smoke = JSON.parse(fs.readFileSync(smokeFile, 'utf8'));
  if (smoke.status !== 'PASS') throw new Error('fresh tarball smoke failed');
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
  append(`\n[GATE FAILURE] ${failure}\n`);
}

let tests = null;
try {
  tests = readTestCounts(outputDir);
  if (sourceFingerprint(root) !== fingerprint) failure ??= 'source changed while the gate was running';
} catch (error) {
  failure ??= 'test evidence or source fingerprint validation failed';
  append(`\n[EVIDENCE FAILURE] ${error instanceof Error ? error.message : String(error)}\n`);
}
const requiredPlatforms = ['darwin', 'linux', 'win32'];
const deferredPlatforms = [];
const platforms = { darwin: 'NOT_RUN', linux: 'NOT_RUN', win32: 'NOT_RUN' };
const platformOrigins = { darwin: null, linux: null, win32: null };
if (!failure && Object.hasOwn(platforms, process.platform)) {
  platforms[process.platform] = 'AUTOMATED_PASS';
  platformOrigins[process.platform] = source.githubActionsUsed
    ? (source.provenance === 'docker-host-git' ? 'github-actions-docker' : 'github-actions-native')
    : (source.provenance === 'docker-host-git' ? 'local-docker' : 'local');
}
for (const file of options.platformEvidence) {
  try {
    const evidence = JSON.parse(fs.readFileSync(file, 'utf8'));
    const { platform, origin } = matchPlatformEvidence(evidence, {
      requiredPlatforms, name: pkg.name, version: pkg.version, revision, fingerprint,
      dependencyLockSha256: `sha256:${sha('sha256', path.join(root, 'package-lock.json'))}`,
    });
    platforms[platform] = 'AUTOMATED_PASS';
    platformOrigins[platform] = origin;
  } catch (error) { failure ??= `invalid platform evidence ${file}: ${error instanceof Error ? error.message : String(error)}`; }
}
const platformComplete = requiredPlatforms.every((platform) => platforms[platform] === 'AUTOMATED_PASS')
  && platformOrigins.linux === 'github-actions-native'
  && platformOrigins.win32 === 'github-actions-native';
const report = {
  schemaVersion: 1, generatedAt: new Date().toISOString(), package: { name: pkg.name, version: pkg.version },
  source: { revision, dirty, fingerprint, provenance: source.provenance, dependencyLockSha256: `sha256:${sha('sha256', path.join(root, 'package-lock.json'))}` },
  mode: options.release ? 'release' : 'candidate', status: failure ? 'AUTOMATED_FAIL' : 'AUTOMATED_PASS', failure: failure ?? null,
  steps, tests, benchmark: bench ? { status: bench.status, dataset: bench.dataset, aggregate: bench.aggregate } : null,
  audit: auditSummary, packageArtifact: artifact, freshInstall: smoke,
  platformPolicy: { required: requiredPlatforms, deferred: deferredPlatforms, githubActionsUsed: Object.values(platformOrigins).some(value => value?.startsWith('github-actions')) },
  platforms, platformOrigins, manual: { status: 'MANUAL_NOT_RUN', externalAi: 'MANUAL_NOT_RUN', realOwnerWorkspace: 'MANUAL_NOT_RUN', windows11: 'MANUAL_NOT_RUN' },
  registry: { status: 'NOT_APPLICABLE_BEFORE_PUBLISH' },
  releaseReady: !failure && !dirty && platformComplete,
  releaseReadyReason: failure ? failure : dirty ? 'source tree is dirty' : !platformComplete ? 'supported-platform evidence is incomplete' : 'automated release evidence is complete; manual gates remain separately reported',
  host: { platform: process.platform, arch: process.arch, release: os.release(), node: process.version },
};
if (options.release && !report.releaseReady && !failure) { report.status = 'AUTOMATED_FAIL'; report.failure = report.releaseReadyReason; }
fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.log(`[release-gate] ${report.status} | revision=${revision.slice(0, 12)} | dirty=${dirty} | releaseReady=${report.releaseReady}`);
console.log('[release-gate] detailed evidence retained privately');
if (report.failure) console.error('[release-gate] failure details withheld from public output; inspect private gate.log');
if (report.status !== 'AUTOMATED_PASS') process.exit(1);
}

try { main(); } catch (error) {
  if (initializedLog) try {
    fs.appendFileSync(initializedLog, `\n[INITIALIZATION/EVIDENCE FAILURE] ${error instanceof Error ? error.message : String(error)}\n`);
  } catch { /* Keep log I/O errors private too. */ }
  console.error('[release-gate] initialization/evidence failure; no private diagnostics published');
  process.exitCode = 1;
}
