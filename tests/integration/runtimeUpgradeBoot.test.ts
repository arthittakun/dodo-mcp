import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { listStateCheckpoints, recordedRuntimeVersion } from '../../src/config/stateCheckpoint.js';
import { startServer, type RunningServer } from '../../src/server/appServer.js';
import { DODO_VERSION } from '../../src/server/version.js';
import { openDatabase } from '../../src/store/db.js';

it('boots an existing installation before publishing its own runtime lease', async () => {
  const tempRoot = fs.realpathSync.native(os.tmpdir());
  const configDir = fs.mkdtempSync(path.join(tempRoot, 'dodo-upgrade-boot-'));
  const leaseDir = path.join(configDir, 'runtime-leases');
  const previousVersion = '1.11.1';
  let server: RunningServer | undefined;
  try {
    const db = openDatabase(path.join(configDir, 'state.db'));
    try {
      db.prepare("UPDATE meta SET value=? WHERE key='dodo-runtime-version'").run(previousVersion);
    } finally { db.close(); }
    expect(fs.existsSync(leaseDir)).toBe(false);
    vi.stubEnv('DODO_CONFIG_DIR', configDir);

    // Model the filesystem error in the report on the lease just created by
    // this startup. No foreign or stale runtime exists in this fixture.
    const open = fs.openSync;
    const readFlags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
    vi.spyOn(fs, 'openSync').mockImplementation((name, flags, mode) => {
      if (typeof name === 'string' && path.dirname(name) === leaseDir && flags === readFlags) {
        throw Object.assign(new Error('synthetic unreadable runtime lease'), { code: 'EACCES' });
      }
      return open(name, flags, mode);
    });

    server = await startServer({ invokedCwd: tempRoot, deferWorkspace: true, portOverride: 0 });
    const health = await fetch(`http://127.0.0.1:${server.port}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ serverVersion: DODO_VERSION });
    expect(listStateCheckpoints(configDir)).toEqual([expect.objectContaining({
      reason: 'before-version-open', previousRuntimeVersion: previousVersion,
    })]);
    expect(recordedRuntimeVersion(configDir, server.services.store.db)).toBe(DODO_VERSION);
    expect(fs.readdirSync(leaseDir)).toHaveLength(1);
    await server.close();
    expect(fs.readdirSync(leaseDir)).toEqual([]);
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await server?.close();
    if (path.dirname(configDir) !== tempRoot || !path.basename(configDir).startsWith('dodo-upgrade-boot-')) throw new Error('unsafe fixture cleanup');
    fs.rmSync(configDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
