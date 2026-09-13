#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
fs.mkdirSync(outputDir, { recursive: true });
const logFile = path.join(outputDir, 'gate.log');
const reportFile = path.join(outputDir, 'gate-report.json');
const steps = [];
let failure;

function append(value) { fs.appendFileSync(logFile, value, { mode: 0o600 }); }
function command(program, args, { allowFailure = false, timeout = 20 * 60 * 1000, env = {} } = {}) {
  const label = `${program} ${args.join(' ')}`;
  append(`\n[${new Date().toISOString()}] ${label}\n`);
  const started = Date.now();
  const result = spawnSync(program, args, { cwd: root, encoding: 'utf8', stdio: 'pipe', timeout, maxBuffer: 64 * 1024 * 1024, windowsHide: true, env: { ...process.env, ...env } });
  append(result.stdout ?? ''); append(result.stderr ?? '');
  const status = result.status ?? (result.error ? 1 : 0);
  steps.push({ command: label, status, durationMs: Date.now() - started });
  if (result.error) throw result.error;
  if (status !== 0 && !allowFailure) throw new Error(`${label} failed with exit ${status}`);
  return result;
}
function sha(algorithm, file) { return createHash(algorithm).update(fs.readFileSync(file)).digest('hex'); }
function git(args) { return command('git', args).stdout.trim(); }

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
if (dirty && !options.allowDirty) failure = 'source changes are present; commit/review them or use --allow-dirty for a candidate gate';

let auditSummary = null;
let pack = null;
let artifact = null;
let smoke = null;
let bench = null;
try {
  if (failure) throw new Error(failure);
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  command(npm, ['run', 'build']);
  command(npm, ['run', 'typecheck']);
  command(npm, ['run', 'lint']);
  command(npm, ['run', 'test:all'], { timeout: 30 * 60 * 1000 });

  const benchFile = path.join(outputDir, 'dodobench.json');
  command(process.execPath, ['scripts/dodo-bench.mjs', '--output', benchFile], {
    timeout: 10 * 60 * 1000,
    env: source.provenance === 'docker-host-git'
      ? { DODO_BENCH_SOURCE_REVISION: revision, DODO_BENCH_SOURCE_DIRTY: String(dirty) }
      : {},
  });
  bench = JSON.parse(fs.readFileSync(benchFile, 'utf8'));
  if (bench.status !== 'PASS') throw new Error('DodoBench regression gate failed');

  const audit = command(npm, ['audit', '--omit=dev', '--json'], { allowFailure: true, timeout: 5 * 60 * 1000 });
  const auditJson = JSON.parse(audit.stdout || '{}');
  const vulnerabilities = auditJson.metadata?.vulnerabilities ?? {};
  auditSummary = { dependencies: auditJson.metadata?.dependencies ?? null, vulnerabilities };
  fs.writeFileSync(path.join(outputDir, 'dependency-audit.json'), `${JSON.stringify(auditSummary, null, 2)}\n`, { mode: 0o600 });
  if ((vulnerabilities.high ?? 0) > 0 || (vulnerabilities.critical ?? 0) > 0) throw new Error('production dependency audit has high or critical vulnerabilities');

  const artifactDir = path.join(outputDir, 'artifact'); fs.mkdirSync(artifactDir, { recursive: true });
  const packed = command(npm, ['pack', '--json', '--pack-destination', artifactDir], { timeout: 5 * 60 * 1000 });
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
  command(process.execPath, ['scripts/release-smoke.mjs', '--tarball', tarball, '--output', smokeFile], { timeout: 10 * 60 * 1000 });
  smoke = JSON.parse(fs.readFileSync(smokeFile, 'utf8'));
  if (smoke.status !== 'PASS') throw new Error('fresh tarball smoke failed');
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
  append(`\n[GATE FAILURE] ${failure}\n`);
}

const requiredPlatforms = ['darwin', 'linux'];
const deferredPlatforms = ['win32'];
const platforms = { darwin: 'NOT_RUN', linux: 'NOT_RUN', win32: 'DEFERRED_MANUAL_NOT_RUN' };
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
    const platform = evidence.platform ?? evidence.host?.platform;
    const evidenceRevision = evidence.revision ?? evidence.source?.revision;
    const evidenceLock = evidence.dependencyLockSha256 ?? evidence.source?.dependencyLockSha256;
    const expectedProvenance = platform === 'linux' ? 'docker-host-git' : 'local-git';
    if (
      requiredPlatforms.includes(platform) &&
      evidence.status === 'AUTOMATED_PASS' &&
      evidence.package?.name === pkg.name &&
      evidence.package?.version === pkg.version &&
      evidenceRevision === revision &&
      evidenceLock === `sha256:${sha('sha256', path.join(root, 'package-lock.json'))}` &&
      evidence.source?.dirty === false &&
      evidence.source?.provenance === expectedProvenance &&
      typeof evidence.platformPolicy?.githubActionsUsed === 'boolean' &&
      evidence.freshInstall?.status === 'PASS'
    ) {
      platforms[platform] = 'AUTOMATED_PASS';
      platformOrigins[platform] = evidence.platformOrigins?.[platform]
        ?? (evidence.platformPolicy.githubActionsUsed ? 'github-actions' : 'local');
    }
    else throw new Error('platform evidence does not match package/revision/lock/clean-source/provenance/status');
  } catch (error) { failure ??= `invalid platform evidence ${file}: ${error instanceof Error ? error.message : String(error)}`; }
}
const platformComplete = requiredPlatforms.every((platform) => platforms[platform] === 'AUTOMATED_PASS');
const report = {
  schemaVersion: 1, generatedAt: new Date().toISOString(), package: { name: pkg.name, version: pkg.version },
  source: { revision, dirty, provenance: source.provenance, dependencyLockSha256: `sha256:${sha('sha256', path.join(root, 'package-lock.json'))}` },
  mode: options.release ? 'release' : 'candidate', status: failure ? 'AUTOMATED_FAIL' : 'AUTOMATED_PASS', failure: failure ?? null,
  steps, benchmark: bench ? { status: bench.status, dataset: bench.dataset, aggregate: bench.aggregate } : null,
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
console.log(`[release-gate] evidence=${outputDir}`);
if (report.failure) console.error(`[release-gate] ${report.failure}`);
if (report.status !== 'AUTOMATED_PASS') process.exit(1);
