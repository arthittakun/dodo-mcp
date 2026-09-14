import { defineConfig } from 'vitest/config';
import path from 'node:path';

// Separate machine reports for the two Vitest invocations in test:all.
// The release gate supplies a fresh private directory, never a public log path.
const reportDir = process.env['DODO_TEST_REPORT_DIR'];
const packaging = process.argv.some(arg => arg.replaceAll('\\', '/').includes('tests/packaging'));

export default defineConfig({
  test: {
    ...(reportDir ? {
      reporters: ['default', 'json'] as const,
      outputFile: { json: path.join(reportDir, packaging ? 'packaging-tests.json' : 'core-tests.json') },
    } : {}),
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/helpers/globalSetup.ts'],
    // Integration/security suites boot real HTTP servers and real child
    // processes; generous but bounded timeouts.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: 'forks',
    // Suites share no global state (each test creates its own DODO_CONFIG_DIR),
    // but job/exec tests are sensitive to CPU contention on CI runners.
    maxConcurrency: 4,
    // maxConcurrency bounds test.concurrent, not file workers. Native ACL
    // probes start PowerShell; bound file workers to avoid starving IPC/CLI.
    maxWorkers: process.platform === 'win32' ? 2 : undefined,
  },
});
