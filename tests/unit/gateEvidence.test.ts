import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

// The gate runs before build; its source is dependency-free ESM, not dist code.
const moduleUrl = pathToFileURL(path.resolve('scripts/gate-evidence.mjs')).href;
const { sourceFingerprint, testCounts, sanitizeGateReport, readAuditEvidence, matchPlatformEvidence, failureLocations } = await import(moduleUrl) as {
  sourceFingerprint: (root: string) => string;
  testCounts: (value: unknown) => unknown;
  sanitizeGateReport: (value: unknown) => Record<string, unknown>;
  readAuditEvidence: (value: unknown) => { vulnerabilities: Record<string, number> };
  matchPlatformEvidence: (value: unknown, expected: Record<string, unknown>) => { platform: string; origin: string };
  failureLocations: (value: unknown, root: string) => { locations: Record<string, unknown>[]; truncated: boolean };
};
const owned: string[] = [];
function directory() { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'dodo-gate-evidence-')); owned.push(p); return p; }
afterEach(() => { for (const p of owned.splice(0)) fs.rmSync(p, { recursive: true, force: true }); });
const poison = 'SYNTHETIC_SECRET_DO_NOT_PUBLISH';
const counts = { files: 1, total: 2, passed: 1, failed: 0, skipped: 1, todo: 0, failedFiles: 0, success: true };
function report() {
  return {
    status: 'AUTOMATED_PASS', failure: null, releaseReady: false,
    package: { name: 'dodo-mcp', version: '1.0.0', secret: poison },
    source: { revision: 'a'.repeat(40), fingerprint: `sha256:${'b'.repeat(64)}`, dependencyLockSha256: `sha256:${'c'.repeat(64)}`, dirty: true, provenance: 'local-git', root: `/Users/${poison}` },
    host: { platform: 'linux', arch: 'arm64', node: 'v22.23.2', hostname: poison, username: poison },
    steps: ['build', 'typecheck', 'lint', 'test:all', 'benchmark', 'audit', 'pack', 'fresh-install'].map(id => ({ id, status: 0, durationMs: 1, command: poison })),
    tests: { core: { ...counts, diagnostics: poison }, packaging: counts },
    audit: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 }, body: poison },
    benchmark: { status: 'PASS', aggregate: { eligibleCases: 7, passedCases: 7, notes: poison } },
    packageArtifact: { filename: 'dodo-mcp-1.0.0.tgz', bytes: 1, files: 1, sha256: 'd'.repeat(64), integrity: `sha512-${'A'.repeat(86)}==`, path: poison },
    freshInstall: { status: 'PASS', token: poison }, manual: { status: 'MANUAL_PASS', key: poison },
  };
}

describe('allowlisted release evidence', () => {
  it('fingerprints copied gate inputs and untracked code, excluding private documentation', () => {
    const dir = directory();
    const inputs = ['src', 'tests', 'scripts', 'native', 'benchmarks', 'docker', '.github',
      'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json', 'vitest.config.ts', 'eslint.config.js', '.gitattributes', '.gitignore', '.npmignore', '.dockerignore'];
    for (const input of inputs) fs.cpSync(path.resolve(input), path.join(dir, input), { recursive: true });
    const original = sourceFingerprint(dir);
    expect(original).toBe(sourceFingerprint(process.cwd()));
    fs.mkdirSync(path.join(dir, 'docs'));
    fs.writeFileSync(path.join(dir, 'docs', 'private.md'), poison);
    expect(sourceFingerprint(dir)).toBe(original);
    fs.writeFileSync(path.join(dir, 'src', 'untracked.ts'), '// candidate change');
    expect(sourceFingerprint(dir)).not.toBe(original);
    fs.rmSync(path.join(dir, '.github'), { recursive: true });
    expect(() => sourceFingerprint(dir)).toThrow();
  });

  it('counts assertions, validates reporter totals, and excludes messages/names', () => {
    const input = { success: true, numTotalTests: 2, numPassedTests: 1, numFailedTests: 0, numPendingTests: 1,
      testResults: [{ name: poison, status: 'passed', message: poison, assertionResults: [{ status: 'passed', fullName: poison }, { status: 'pending' }] }] };
    expect(testCounts(input)).toEqual(counts);
    expect(() => testCounts({ ...input, numPassedTests: 2 })).toThrow('invalid gate evidence');
    expect(() => testCounts({ ...input, testResults: [{ ...input.testResults[0], status: 'failed' }] })).toThrow();
    expect(testCounts({ ...input, success: false })).toMatchObject({ success: false });
  });

  it('strips unknown fields at every level and never promotes manual gates', () => {
    const output = sanitizeGateReport(report());
    expect(JSON.stringify(output)).not.toContain(poison);
    expect(output).toMatchObject({ source: { dirty: true }, releaseReady: false, manual: 'MANUAL_NOT_RUN', tests: { core: counts } });
  });

  it('keeps a failure a failure without publishing its diagnostics', () => {
    const input = { ...report(), status: 'AUTOMATED_FAIL', failure: poison, releaseReady: true, tests: { core: { ...counts, success: false }, packaging: null } };
    const output = sanitizeGateReport(input);
    expect(output).toMatchObject({ status: 'AUTOMATED_FAIL', releaseReady: false, tests: { packaging: null } });
    expect(JSON.stringify(output)).not.toContain(poison);
  });

  it('rejects forged passes, missing suites and secret-bearing scalar fields', () => {
    expect(() => sanitizeGateReport({ ...report(), failure: poison })).toThrow();
    expect(() => sanitizeGateReport({ ...report(), tests: {} })).toThrow();
    expect(() => sanitizeGateReport({ ...report(), steps: [] })).toThrow();
    expect(() => sanitizeGateReport({ ...report(), host: { ...report().host, node: poison } })).toThrow();
    expect(() => sanitizeGateReport({ ...report(), source: { ...report().source, revision: poison } })).toThrow();
  });

  it('rejects audit severity counts whose sum disagrees with the reported total', () => {
    const input = report();
    input.audit.vulnerabilities.low = 1;
    // A malformed zero total must never turn a vulnerability into a clean audit.
    expect(() => sanitizeGateReport(input)).toThrow('invalid gate evidence');
  });

  it('reports an allowed low-severity audit exit honestly and rejects high severity', () => {
    const input = report();
    input.steps.find(s => s.id === 'audit')!.status = 1;
    input.audit.vulnerabilities.low = 1; input.audit.vulnerabilities.total = 1;
    expect(sanitizeGateReport(input)).toMatchObject({ audit: { low: 1 }, steps: expect.arrayContaining([{ id: 'audit', exitCode: 1, durationMs: 1 }]) });
    input.audit.vulnerabilities.high = 1;
    expect(() => sanitizeGateReport(input)).toThrow();
  });

  it('accepts completed audit evidence without weakening the high/critical policy', () => {
    const clean = report().audit;
    expect(readAuditEvidence({ status: 0, stdout: JSON.stringify({ metadata: clean }) }).vulnerabilities.total).toBe(0);
    const low = { ...clean.vulnerabilities, low: 1, total: 1 };
    for (const status of [0, 1]) {
      // audit-level configuration may allow lower severities with exit 0.
      expect(readAuditEvidence({ status, stdout: JSON.stringify({ metadata: { vulnerabilities: low } }) }).vulnerabilities.low).toBe(1);
    }
    const high = report(); high.audit.vulnerabilities.high = 1; high.audit.vulnerabilities.total = 1;
    expect(readAuditEvidence({ status: 1, stdout: JSON.stringify({ metadata: high.audit }) }).vulnerabilities.high).toBe(1);
    expect(() => sanitizeGateReport(high)).toThrow();
  });

  it.each([
    ['operational exit', { status: 2 }],
    ['signal termination', { status: null, signal: 'SIGTERM' }],
    ['launch failure', { error: new Error(poison) }],
    ['error response with valid-looking counts', { stdout: JSON.stringify({ error: { code: poison }, metadata: report().audit }) }],
    ['missing metadata', { stdout: '{}' }],
    ['invalid JSON', { stdout: poison }],
    ['failure exit with zero findings', { status: 1 }],
    ['inconsistent totals', { stdout: JSON.stringify({ metadata: { vulnerabilities: { ...report().audit.vulnerabilities, low: 1 } } }) }],
  ])('rejects incomplete audit evidence: %s', (_name, overrides) => {
    const result = { status: 0, signal: null, stdout: JSON.stringify({ metadata: report().audit }), ...overrides };
    expect(() => readAuditEvidence(result)).toThrow();
  });

  it('rejects a public pass claiming audit failure with zero findings', () => {
    const input = report(); input.steps.find(s => s.id === 'audit')!.status = 1;
    expect(() => sanitizeGateReport(input)).toThrow();
  });

  function platformReport(platform = 'linux', origin = 'github-actions-native') {
    const input = report();
    return { ...input, source: { ...input.source, dirty: false },
      host: { ...input.host, platform }, platforms: { [platform]: 'AUTOMATED_PASS' },
      platformOrigins: { [platform]: origin }, platformPolicy: { githubActionsUsed: origin === 'github-actions-native' } };
  }
  function expectedCandidate() {
    const input = report();
    return { requiredPlatforms: ['darwin', 'linux'], name: input.package.name, version: input.package.version,
      revision: input.source.revision, fingerprint: input.source.fingerprint, dependencyLockSha256: input.source.dependencyLockSha256 };
  }

  it('accepts native Linux CI and macOS evidence for exactly the same clean source', () => {
    expect(matchPlatformEvidence(platformReport(), expectedCandidate())).toEqual({ platform: 'linux', origin: 'github-actions-native' });
    expect(matchPlatformEvidence(platformReport('darwin', 'local'), expectedCandidate())).toEqual({ platform: 'darwin', origin: 'local' });
  });
  it('accepts allowlisted native CI summaries without exporting private logs; Windows requires native CI too', () => {
    const expected = {...expectedCandidate(),requiredPlatforms:['darwin','linux','win32']};
    for(const platform of ['linux','win32']){
      const publicSummary=sanitizeGateReport(platformReport(platform));
      expect(JSON.stringify(publicSummary)).not.toContain(poison);
      expect(matchPlatformEvidence(publicSummary,expected)).toEqual({platform,origin:'github-actions-native'});
      const missing=structuredClone(publicSummary);missing.freshInstall='NOT_RUN';
      expect(()=>matchPlatformEvidence(missing,expected)).toThrow();
      const altered=structuredClone(publicSummary);(altered.source as Record<string,unknown>).fingerprint='sha256:'+'e'.repeat(64);
      expect(()=>matchPlatformEvidence(altered,expected)).toThrow();
      const forged=structuredClone(publicSummary);(forged.platformPolicy as Record<string,unknown>).githubActionsUsed=false;
      expect(()=>matchPlatformEvidence(forged,expected)).toThrow();
    }
    expect(()=>matchPlatformEvidence(platformReport('win32','local'),expected)).toThrow();
  });

  it('rejects Docker and local Linux reports instead of treating them as native CI', () => {
    for (const origin of ['local', 'local-docker', 'github-actions-docker']) {
      expect(() => matchPlatformEvidence(platformReport('linux', origin), expectedCandidate())).toThrow('invalid gate evidence');
    }
    const input = platformReport(); input.source.provenance = 'docker-host-git';
    expect(() => matchPlatformEvidence(input, expectedCandidate())).toThrow();
    input.source.provenance = 'local-git'; input.platformPolicy.githubActionsUsed = false;
    expect(() => matchPlatformEvidence(input, expectedCandidate())).toThrow();
  });

  it('rejects a different fingerprint, revision, lock or dirty candidate', () => {
    for (const key of ['revision', 'fingerprint', 'dependencyLockSha256'] as const) {
      const input = platformReport(); input.source[key] = key === 'revision' ? 'f'.repeat(40) : `sha256:${'f'.repeat(64)}`;
      expect(() => matchPlatformEvidence(input, expectedCandidate())).toThrow();
    }
    const input = platformReport(); input.source.dirty = true;
    expect(() => matchPlatformEvidence(input, expectedCandidate())).toThrow();
  });

  it('rejects false platform passes, missing fresh installs and failed test evidence', () => {
    const noInstall = platformReport(); noInstall.freshInstall.status = 'NOT_RUN';
    expect(() => matchPlatformEvidence(noInstall, expectedCandidate())).toThrow();
    const failed = platformReport(); failed.tests.core.success = false;
    expect(() => matchPlatformEvidence(failed, expectedCandidate())).toThrow();
    const noPlatform = platformReport(); noPlatform.platforms.linux = 'NOT_RUN';
    expect(() => matchPlatformEvidence(noPlatform, expectedCandidate())).toThrow();
    expect(() => matchPlatformEvidence(platformReport('win32'), expectedCandidate())).toThrow();
  });

  it('reports failure locations without publishing titles, expected values or host paths', () => {
    const filename = path.resolve('tests/unit/gateEvidence.test.ts');
    const failed = { status: 'failed', fullName: poison, failureMessages: [`AssertionError: ${poison}\n at ${filename}:12:3`] };
    const output = failureLocations({ testResults: [{ name: filename, status: 'failed', assertionResults: [{ status: 'passed' }, failed] },
      { name: `/private/${poison}/secret.test.ts`, status: 'failed', assertionResults: [failed] }] }, process.cwd());
    expect(output).toEqual({ locations: [{ file: 'tests/unit/gateEvidence.test.ts', assertionIndex: 1, lines: [12], kind: 'assertion' }], truncated: false });
    expect(JSON.stringify(output)).not.toContain(poison);
    expect(JSON.stringify(output)).not.toContain(process.cwd());
  });

  it('bounds failure diagnostics and reports suite failures and timeouts distinctly', () => {
    const filename = path.resolve('tests/unit/gateEvidence.test.ts');
    const timeout = { status: 'failed', failureMessages: [`Test timed out: ${poison}`] };
    const suite = failureLocations({ testResults: [{ name: filename, status: 'failed', assertionResults: [] }] }, process.cwd());
    expect(suite.locations[0]).toMatchObject({ assertionIndex: null, kind: 'suite' });
    const output = failureLocations({ testResults: [{ name: filename, assertionResults: Array.from({ length: 40 }, () => timeout) }] }, process.cwd());
    expect(output.locations).toHaveLength(32);
    expect(output.truncated).toBe(true);
    expect(output.locations[0]).toMatchObject({ kind: 'timeout' });
    expect(JSON.stringify(output)).not.toContain(poison);
  });

  it('CLI publishes only the summary and refuses to overwrite old evidence', () => {
    const dir = directory();
    fs.writeFileSync(path.join(dir, 'gate-report.json'), JSON.stringify(report()));
    const args = ['scripts/gate-summary.mjs', '--input-dir', dir];
    const first = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 10000 });
    expect(first.status).toBe(0);
    expect(first.stdout + first.stderr).not.toContain(poison);
    const saved = fs.readFileSync(path.join(dir, 'public-summary.json'), 'utf8');
    expect(saved).not.toContain(poison);
    const again = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 10000 });
    expect(again.status).toBe(1);
    expect(again.stdout + again.stderr).not.toContain(dir);
    expect(fs.readFileSync(path.join(dir, 'public-summary.json'), 'utf8')).toBe(saved);
  });

  it('captures failing child output privately and treats signals as failure', () => {
    const dir = directory(), log = path.join(dir, 'gate.log');
    const helper = pathToFileURL(path.resolve('scripts/gate-command.mjs')).href;
    const script = `import { privateCommand } from ${JSON.stringify(helper)};
      const r = privateCommand(process.execPath, ['-e', 'console.log(process.env.DODO_TEST_SECRET); console.error(process.env.DODO_TEST_SECRET); process.exit(7)'], {cwd:process.cwd(),env:process.env,timeout:5000,logFile:process.argv[1]}); process.exitCode=r.status;`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, log], { env: { ...process.env, DODO_TEST_SECRET: poison }, encoding: 'utf8', timeout: 10000 });
    expect(result.status).toBe(7);
    expect(result.stdout + result.stderr).toBe('');
    expect(fs.readFileSync(log, 'utf8')).toContain(poison);
    const signalScript = `import { privateCommand } from ${JSON.stringify(helper)};
      const r = privateCommand(process.execPath, ['-e', 'process.kill(process.pid, "SIGTERM")'], {cwd:process.cwd(),env:process.env,timeout:5000,logFile:process.argv[1]}); console.log(r.status === 0);`;
    const signaled = spawnSync(process.execPath, ['--input-type=module', '-e', signalScript, log], { encoding: 'utf8', timeout: 10000 });
    expect(signaled.status).toBe(0); expect(signaled.stdout.trim()).toBe('false');
  });
});
