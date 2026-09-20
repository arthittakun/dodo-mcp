// Public summaries are constructed from allowlisted scalars, never by deleting
// known secrets from a copy of a private report. Error/test text stays private.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

function requireValue(ok) { if (!ok) throw new Error('invalid gate evidence'); }
const integer = value => { requireValue(Number.isSafeInteger(value) && value >= 0); return value; };
const choice = (value, choices) => { requireValue(choices.includes(value)); return value; };
const formatted = (value, pattern) => { requireValue(typeof value === 'string' && pattern.test(value)); return value; };
const hash = value => formatted(value, /^sha256:[a-f0-9]{64}$/);

/** Code/test/gate inputs, including untracked candidate files. Excludes generated
 * dist/schemas, private docs/state and evidence. Independent of paths/OS modes. */
export function sourceFingerprint(root) {
  const entries = [];
  function visit(relative) {
    const absolute = path.join(root, relative), stat = fs.lstatSync(absolute);
    requireValue(!stat.isSymbolicLink());
    if (stat.isDirectory()) for (const name of fs.readdirSync(absolute).sort()) visit(`${relative}/${name}`);
    else {
      requireValue(stat.isFile());
      entries.push([relative, createHash('sha256').update(fs.readFileSync(absolute)).digest('hex')]);
    }
  }
  for (const entry of ['src', 'tests', 'scripts', 'native', 'benchmarks', 'docker', '.github',
    'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json', 'vitest.config.ts', 'eslint.config.js', '.gitattributes', '.gitignore', '.npmignore', '.dockerignore']) visit(entry);
  entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return `sha256:${createHash('sha256').update(JSON.stringify(entries)).digest('hex')}`;
}

export function testCounts(report) {
  requireValue(typeof report?.success === 'boolean' && Array.isArray(report.testResults));
  const counts = { files: report.testResults.length, total: 0, passed: 0, failed: 0, skipped: 0, todo: 0, failedFiles: 0, success: report.success };
  for (const file of report.testResults) {
    requireValue(Array.isArray(file.assertionResults));
    if (file.status === 'failed') counts.failedFiles++;
    for (const test of file.assertionResults) {
      const status = choice(test.status, ['passed', 'failed', 'pending', 'skipped', 'todo']);
      counts[status === 'pending' ? 'skipped' : status]++;
      counts.total++;
    }
  }
  for (const [field, reported] of [['total', 'numTotalTests'], ['passed', 'numPassedTests'], ['failed', 'numFailedTests'], ['skipped', 'numPendingTests'], ['todo', 'numTodoTests']]) {
    requireValue(counts[field] === integer(report[reported] ?? (field === 'todo' ? 0 : undefined)));
  }
  requireValue(!counts.success || (counts.failed === 0 && counts.failedFiles === 0));
  return counts;
}

// npm may exit 1 for reported vulnerabilities, but operational/launch failures
// must not be certified as a successful audit just because stdout has counts.
function auditCounts(value) {
  requireValue(value != null && typeof value === 'object' && !Array.isArray(value));
  const levels = ['info', 'low', 'moderate', 'high', 'critical'];
  const counts = Object.fromEntries([...levels, 'total'].map(key => [key, integer(value[key])]));
  requireValue(levels.reduce((sum, key) => sum + counts[key], 0) === counts.total);
  return counts;
}

export function readAuditEvidence(result) {
  requireValue(result != null && !result.error && !result.signal && [0, 1].includes(result.status));
  requireValue(typeof result.stdout === 'string');
  const body = JSON.parse(result.stdout);
  requireValue(body != null && typeof body === 'object' && !Array.isArray(body) && !Object.hasOwn(body, 'error'));
  const vulnerabilities = auditCounts(body.metadata?.vulnerabilities);
  requireValue(result.status === 0 || vulnerabilities.total > 0);
  return { dependencies: body.metadata.dependencies ?? null, vulnerabilities };
}

export function readTestCounts(directory) {
  const result = {};
  for (const suite of ['core', 'packaging']) {
    const file = path.join(directory, `${suite}-tests.json`);
    result[suite] = fs.existsSync(file) ? testCounts(JSON.parse(fs.readFileSync(file, 'utf8'))) : null;
  }
  return result;
}

/** Merge only evidence for the same clean candidate. Linux release evidence
 * must now come from native GitHub Actions, not a previous container run. */
export function matchPlatformEvidence(evidence, expected) {
  const summary = sanitizeGateReport(evidence);
  const platform = evidence.host?.platform;
  const origin = evidence.platformOrigins?.[platform];
  requireValue(expected.requiredPlatforms.includes(platform));
  requireValue(summary.status === 'AUTOMATED_PASS');
  requireValue(evidence.package.name === expected.name && evidence.package.version === expected.version);
  requireValue(evidence.source.revision === expected.revision && evidence.source.fingerprint === expected.fingerprint);
  requireValue(evidence.source.dependencyLockSha256 === expected.dependencyLockSha256);
  requireValue(evidence.source.dirty === false && evidence.source.provenance === 'local-git');
  requireValue(evidence.freshInstall?.status === 'PASS' && evidence.platforms?.[platform] === 'AUTOMATED_PASS');
  requireValue(typeof evidence.platformPolicy?.githubActionsUsed === 'boolean');
  requireValue(origin === 'local' || origin === 'github-actions-native');
  if (origin === 'github-actions-native') requireValue(evidence.platformPolicy.githubActionsUsed);
  if (platform === 'linux') requireValue(origin === 'github-actions-native');
  return { platform, origin };
}

/** Public diagnostics contain only existing test paths, assertion positions and
 * numeric source lines. Test titles, messages, values and stacks stay private. */
export function failureLocations(report, root) {
  const locations = [];
  let truncated = false;
  for (const file of report.testResults ?? []) {
    if (typeof file.name !== 'string') continue;
    const relative = path.relative(root, file.name).replaceAll('\\', '/');
    if (!/^tests\/(unit|integration|security|compatibility|packaging)\/[A-Za-z0-9_/-]+\.test\.ts$/.test(relative)
      || !fs.existsSync(path.join(root, relative))) continue;
    const failures = (file.assertionResults ?? []).flatMap((assertion, index) => assertion.status === 'failed' ? [{ assertion, index }] : []);
    if (!failures.length && file.status === 'failed') failures.push({ assertion: {}, index: null });
    for (const { assertion, index } of failures) {
      if (locations.length === 32) { truncated = true; continue; }
      const messages = (assertion.failureMessages ?? []).filter(message => typeof message === 'string').join('\n');
      const frames = messages.replaceAll('\\', '/').matchAll(/(tests\/(?:unit|integration|security|compatibility|packaging)\/[A-Za-z0-9_/-]+\.test\.ts):(\d+)(?::\d+)?/g);
      const lines = [...new Set([...frames].filter(frame => frame[1] === relative).map(frame => Number(frame[2])))]
        .filter(line => Number.isSafeInteger(line) && line > 0).slice(0, 4);
      const kind = index === null ? 'suite' : /timed out|timeout/i.test(messages) ? 'timeout'
        : /AssertionError|expected .+ to /s.test(messages) ? 'assertion' : 'exception';
      locations.push({ file: relative, assertionIndex: index, lines, kind });
    }
  }
  return { locations, truncated };
}

function publicCounts(counts) {
  if (counts == null) return null;
  const result = {};
  for (const key of ['files', 'total', 'passed', 'failed', 'skipped', 'todo', 'failedFiles']) result[key] = integer(counts[key]);
  requireValue(typeof counts.success === 'boolean'); result.success = counts.success;
  requireValue(result.total === result.passed + result.failed + result.skipped + result.todo);
  requireValue(!result.success || (result.failed === 0 && result.failedFiles === 0));
  return result;
}

export function sanitizeGateReport(report) {
  const status = choice(report.status, ['AUTOMATED_PASS', 'AUTOMATED_FAIL']);
  const steps = report.steps.map(step => ({
    id: ['source-check', 'build', 'typecheck', 'lint', 'test:all', 'benchmark', 'audit', 'pack', 'fresh-install'].includes(step.id) ? step.id : 'other',
    exitCode: integer(step.status), durationMs: integer(step.durationMs),
  }));
  const tests = { core: publicCounts(report.tests?.core), packaging: publicCounts(report.tests?.packaging) };
  const audit = report.audit ? auditCounts(report.audit.vulnerabilities) : null;
  if (status === 'AUTOMATED_PASS') {
    requireValue(audit?.high === 0 && audit?.critical === 0);
    requireValue(steps.filter(s => s.id === 'audit').every(s => s.exitCode !== 1 || audit.total > 0));
    requireValue(!report.failure && steps.every(s => s.exitCode === 0 || (s.id === 'audit' && s.exitCode === 1)));
    requireValue(['build', 'typecheck', 'lint', 'test:all', 'benchmark', 'audit', 'pack', 'fresh-install'].every(id => steps.some(s => s.id === id)));
    requireValue(Object.values(tests).every(t => t?.success && t.passed > 0));
    requireValue(report.freshInstall?.status === 'PASS' && report.packageArtifact && report.audit && report.benchmark?.status === 'PASS');
  }
  requireValue(typeof report.source.dirty === 'boolean' && typeof report.releaseReady === 'boolean');
  const artifact = report.packageArtifact;
  return {
    schemaVersion: 1,
    status,
    package: { name: choice(report.package.name, ['dodo-mcp']), version: formatted(report.package.version, /^\d+\.\d+\.\d+$/) },
    source: {
      revision: formatted(report.source.revision, /^[a-f0-9]{40}$/), dirty: report.source.dirty,
      dependencyLockSha256: hash(report.source.dependencyLockSha256), fingerprint: hash(report.source.fingerprint),
      provenance: choice(report.source.provenance, ['local-git', 'docker-host-git']),
    },
    host: { platform: choice(report.host.platform, ['darwin', 'linux', 'win32']), arch: choice(report.host.arch, ['arm64', 'x64']), node: formatted(report.host.node, /^v\d+\.\d+\.\d+$/) },
    steps, tests,
    audit,
    benchmark: report.benchmark ? {
      status: choice(report.benchmark.status, ['PASS', 'FAIL']),
      eligibleCases: integer(report.benchmark.aggregate.eligibleCases), passedCases: integer(report.benchmark.aggregate.passedCases),
    } : null,
    artifact: artifact ? {
      filename: formatted(artifact.filename, /^dodo-mcp-\d+\.\d+\.\d+\.tgz$/), bytes: integer(artifact.bytes), files: integer(artifact.files),
      sha256: formatted(artifact.sha256, /^[a-f0-9]{64}$/), integrity: formatted(artifact.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/),
    } : null,
    freshInstall: choice(report.freshInstall?.status ?? 'NOT_RUN', ['PASS', 'FAIL', 'NOT_RUN']),
    releaseReady: status === 'AUTOMATED_PASS' && !report.source.dirty && report.releaseReady,
    // This summary never promotes manual/external gates from arbitrary input.
    manual: 'MANUAL_NOT_RUN',
  };
}
