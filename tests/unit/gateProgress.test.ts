import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const { partialTestProgress, focusedFailureDetails, freshInstallFailureDetails } = await import(pathToFileURL(path.resolve('scripts/gate-progress.mjs')).href) as {
  partialTestProgress: (log: string, root: string) => { complete: boolean; files: Record<string, unknown>[]; truncated: boolean };
  focusedFailureDetails: (report: unknown, root: string) => { locations: Record<string, unknown>[] };
  freshInstallFailureDetails: (log: string, root: string) => unknown;
};
const file = 'tests/unit/gateProgress.test.ts';
describe('bounded partial gate diagnostics', () => {
  it('retains only known file paths and numeric progress; never certifies a pass', () => {
    const log = `\u001b[32m ✓ ${file} (4 tests | 1 failed | 1 skipped) 12345ms\u001b[0m\nSecret error: SYNTHETIC_SECRET\n × private/SYNTHETIC_SECRET.test.ts (1 test) 1ms\n ✓ tests/unit/missing.test.ts (1 test) 1ms`;
    const result = partialTestProgress(log, process.cwd());
    expect(result).toEqual({ complete: false, files: [{ file, total: 4, failed: 1, skipped: 1, todo: 0, durationMs: 12345 }], truncated: false });
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC_SECRET');
  });
  it('rejects invalid totals, suffixes and traversal; bounds diagnostic rows', () => {
    expect(partialTestProgress(` ✓ ${file} (1 test | 2 failed) 1ms\n ✓ ${file} (1 test) 1ms SECRET\n ✓ tests/unit/../../private.test.ts (1 test) 1ms`, process.cwd()).files).toEqual([]);
    const result = partialTestProgress(Array(201).fill(` ✓ ${file} (1 test) 1ms`).join('\n'), process.cwd());
    expect(result.files).toHaveLength(200);
    expect(result.truncated).toBe(true);
  });
  it('publishes only declared error codes and existing repository frames', () => {
    const output = focusedFailureDetails({ testResults: [{ name: path.resolve(file), assertionResults: [{ status: 'failed',
      failureMessages: [`Error: RECOVERY_REQUIRED SYNTHETIC_SECRET EPERM\n at ${path.resolve('src/services/recovery/storage.ts')}:22:3\n at /private/SYNTHETIC_SECRET:12:3`] }] }] }, process.cwd());
    expect(output.locations[0]).toMatchObject({ errorCodes: ['RECOVERY_REQUIRED', 'EPERM'], frames: [{ file: 'src/services/recovery/storage.ts', line: 22 }] });
    expect(JSON.stringify(output)).not.toContain('SYNTHETIC_SECRET');
    expect(JSON.stringify(output)).not.toContain(process.cwd());
  });
  it('classifies installed-package failures without exporting private diagnostics',()=>{
    const log='earlier MCP tool failed: FORBIDDEN\nnode scripts/release-smoke.mjs --tarball /private/SECRET.tgz\nTypeError: fetch failed\n at /private/SECRET/scripts/release-smoke-worker.mjs:185:3\n cause: UND_ERR_SOCKET private-token-value\n';
    const result=freshInstallFailureDetails(log,process.cwd());
    expect(result).toEqual({labels:['connection'],codes:['UND_ERR_SOCKET'],workerLines:[185]});
    expect(JSON.stringify(result)).not.toMatch(/SECRET|private|token/);
    expect(freshInstallFailureDetails('no smoke invocation',process.cwd())).toBeNull();
    expect(freshInstallFailureDetails(log+'\n[GATE FAILURE] scripts/release-smoke.mjs --tarball /private/SECRET.tgz failed',process.cwd())).toEqual(result);
  });
});
