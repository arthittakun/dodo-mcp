import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
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
