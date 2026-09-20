import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const { partialTestProgress } = await import(pathToFileURL(path.resolve('scripts/gate-progress.mjs')).href) as {
  partialTestProgress: (log: string, root: string) => { complete: boolean; files: Record<string, unknown>[]; truncated: boolean };
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
});
