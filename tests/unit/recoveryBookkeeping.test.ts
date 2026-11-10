import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DodoError } from '../../src/errors.js';
import { RecoveryHistory } from '../../src/services/recovery/history.js';
import { RecoveryDrift } from '../../src/services/recovery/drift.js';
import type { RecoveryService } from '../../src/services/recovery/recoveryService.js';
import { rootIdentity } from '../../src/services/recovery/storage.js';
import { openDatabase } from '../../src/store/db.js';
import { Store } from '../../src/store/store.js';
import { MutationQueue } from '../../src/security/mutationQueue.js';
import type { AppServices } from '../../src/tools/context.js';
import type { PlanFileChange } from '../../src/services/changes/types.js';
import { WorkspaceFS } from '../../src/workspace/fs.js';
import { IgnoreEngine } from '../../src/workspace/ignores.js';
import { sha256Bytes } from '../../src/util/hash.js';

const fixtures: Array<ReturnType<typeof fixture>> = [];
function fixture() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dodo-recovery-bookkeeping-')));
  const db = openDatabase(':memory:');
  const services = { store: new Store(db), mutations: new MutationQueue(), wfs: new WorkspaceFS(root, new IgnoreEngine({ root })), workspaceId: 'ws-bookkeeping', epoch: 'boot-bookkeeping' } as unknown as AppServices;
  const recovery = {
    assertProject: vi.fn(),
    status: vi.fn(() => ({ registered: true })),
    policy: vi.fn(() => ({ enabled: true, strictEnforcement: true })),
    checkpoint: vi.fn(async () => 'snap-optional'),
    reportAutomaticFailure: vi.fn((error: unknown) => {
      if(error instanceof DodoError&&['FORBIDDEN','AUTH_REQUIRED'].includes(error.code))throw error;
    }),
    reportBookkeepingFailure: vi.fn<(error: unknown) => void>(),
  } as unknown as RecoveryService;
  return { root, db, services, recovery, history: new RecoveryHistory(services, recovery), drift: new RecoveryDrift(services, recovery) };
}
function setup() { const f = fixture(); fixtures.push(f); return f; }
afterEach(() => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) {
    f.db.close();
    // Every removal targets only the canonical directory returned by mkdtemp above.
    fs.rmSync(f.root, { recursive: true, force: true, maxRetries: 3 });
  }
});

describe('optional Recovery bookkeeping', () => {
  it('keeps a successful operation result when closing its implicit history session fails', async () => {
    const f = setup();
    f.db.exec("CREATE TRIGGER fail_history_close BEFORE UPDATE ON recovery_sessions BEGIN SELECT RAISE(ABORT, 'fixture history close failed'); END");
    let effects = 0;
    const result = await f.history.around('owner', undefined, async () => {
      f.history.sessionForCapture('owner');
      effects += 1;
      return { jobId: 'job-finished' };
    });
    expect(result).toEqual({ jobId: 'job-finished' });
    expect(effects).toBe(1);
    expect(f.recovery.reportBookkeepingFailure).toHaveBeenCalledWith(expect.objectContaining({ message: 'fixture history close failed' }));
  });

  it('preserves an operation error instead of replacing it with failed implicit-session cleanup', async () => {
    const f = setup();
    f.db.exec("CREATE TRIGGER fail_history_close BEFORE UPDATE ON recovery_sessions BEGIN SELECT RAISE(ABORT, 'fixture history close failed'); END");
    const original = new DodoError('FILE_CHANGED', 'source changed before the requested edit');
    let calls = 0;
    await expect(f.history.around('owner', undefined, async () => {
      f.history.sessionForCapture('owner');
      calls += 1;
      throw original;
    })).rejects.toBe(original);
    expect(calls).toBe(1);
    expect(f.recovery.reportBookkeepingFailure).toHaveBeenCalledOnce();
  });

  it('reports event-write failure without hiding or repeating the completed effect', async () => {
    const f = setup();
    f.db.exec("CREATE TRIGGER fail_history_event BEFORE INSERT ON recovery_events BEGIN SELECT RAISE(ABORT, 'fixture history event failed'); END");
    let effects = 0;
    await expect(f.history.around('owner', undefined, async () => {
      f.history.sessionForCapture('owner');
      effects += 1;
      f.history.record('job', 'job-created-once');
      return 'started';
    })).resolves.toBe('started');
    expect(effects).toBe(1);
    expect(f.recovery.reportBookkeepingFailure).toHaveBeenCalledWith(expect.objectContaining({ message: 'fixture history event failed' }));
    expect(f.db.prepare('SELECT state FROM recovery_sessions').get()).toEqual({ state: 'closed' });
  });

  it.each(['actor', 'epoch', 'closed'] as const)('still rejects an explicit session with a mismatched %s before calling the operation', async reason => {
    const f = setup();
    const id = f.history.sessionForCapture('owner');
    if (reason === 'epoch') f.db.prepare('UPDATE recovery_sessions SET epoch=? WHERE id=?').run('boot-old', id);
    if (reason === 'closed') f.db.prepare("UPDATE recovery_sessions SET state='closed' WHERE id=?").run(id);
    const run = vi.fn(async () => 'must not execute');
    await expect(f.history.around(reason === 'actor' ? 'other' : 'owner', id, run)).rejects.toMatchObject({ code: reason === 'actor' ? 'NOT_FOUND' : 'CONFLICT' });
    expect(run).not.toHaveBeenCalled();
    expect(f.recovery.reportAutomaticFailure).not.toHaveBeenCalled();
    expect(f.recovery.reportBookkeepingFailure).not.toHaveBeenCalled();
  });

  it('still rejects a nested explicit session override before calling the nested operation', async () => {
    const f = setup();
    const nested = vi.fn(async () => 'must not execute');
    await f.history.around('owner', undefined, async () => {
      f.history.sessionForCapture('owner');
      await expect(f.history.around('owner', 'another-session', nested)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    });
    expect(nested).not.toHaveBeenCalled();
  });

  it('allows the journal transaction to commit when optional drift persistence fails under a legacy strict policy', () => {
    const f = setup();
    const file = path.join(f.root, 'a.txt');
    fs.writeFileSync(file, 'after');
    const entry = { path: 'a.txt', kind: 'file', hash: sha256Bytes('before').slice('sha256:'.length), bytes: 6, mode: 0o600 };
    const previous = JSON.stringify({ rootIdentity: rootIdentity(f.root), entries: [entry], revision: 0 });
    f.db.prepare("INSERT INTO recovery_snapshots (id,workspace_id,project_id,state,scope,created_at) VALUES (?,?,?,'READY','source',?)").run('snap-fixture', f.services.workspaceId, 'project-fixture', Date.now());
    f.db.prepare('INSERT INTO recovery_drift VALUES (?,?,?)').run(f.services.workspaceId, previous, 'snap-fixture');
    f.db.exec("CREATE TRIGGER fail_drift_update BEFORE UPDATE ON recovery_drift BEGIN SELECT RAISE(ABORT, 'fixture drift update failed'); END");
    const changed: PlanFileChange = { path: 'a.txt', action: 'modify', beforeHash: sha256Bytes('before'), afterHash: sha256Bytes('after'), bytesBefore: 6, bytesAfter: 5, diff: '', diffTruncated: false };
    f.db.transaction(() => {
      f.db.prepare('INSERT INTO meta (key,value) VALUES (?,?)').run('fixture-journal-state', 'committing');
      f.drift.committed([changed]);
      f.db.prepare('UPDATE meta SET value=? WHERE key=?').run('committed', 'fixture-journal-state');
    })();
    expect(f.db.prepare('SELECT value FROM meta WHERE key=?').get('fixture-journal-state')).toEqual({ value: 'committed' });
    expect(f.db.prepare('SELECT payload FROM recovery_drift').get()).toEqual({ payload: previous });
    expect(fs.readFileSync(file, 'utf8')).toBe('after');
    expect(f.drift.status()).toMatchObject({ state: 'unavailable', errorCode: 'BACKUP_IO_ERROR' });
    expect(f.recovery.reportBookkeepingFailure).toHaveBeenCalledWith(expect.objectContaining({ message: 'fixture drift update failed' }));
    expect(f.recovery.policy).not.toHaveBeenCalled();
  });

  it('allows an agent action to proceed once when automatic session backup and completion bookkeeping fail', async () => {
    const f = setup();
    const backupError = new DodoError('RECOVERY_REQUIRED', 'fixture optional agent backup failed');
    vi.mocked(f.recovery.checkpoint).mockImplementation(async trigger => {
      if(trigger === 'owner-checkpoint')throw backupError;
      return undefined;
    });
    const effects = vi.fn(async () => 'action completed');
    const sessionId = await f.history.forAgent('agent-run', 'owner');
    expect(sessionId).toBeUndefined();
    const result = await effects();
    vi.spyOn(f.services.store, 'getMeta').mockImplementationOnce(() => { throw new DodoError('AUTH_REQUIRED', 'fixture completion bookkeeping failed'); });
    expect(() => f.history.finishAgent('agent-run', 'owner')).not.toThrow();
    expect(result).toBe('action completed');
    expect(effects).toHaveBeenCalledOnce();
    expect(f.recovery.reportAutomaticFailure).toHaveBeenCalledWith(backupError);
    expect(f.recovery.reportBookkeepingFailure).toHaveBeenCalledWith(expect.objectContaining({ code: 'AUTH_REQUIRED' }));
    expect(f.db.prepare('SELECT state FROM recovery_sessions').get()).toEqual({ state: 'interrupted' });
  });

  it.each(['FORBIDDEN', 'AUTH_REQUIRED'] as const)('preserves %s during automatic agent backup preparation', async code => {
    const f = setup();
    const error = new DodoError(code, 'fixture live authority changed');
    vi.mocked(f.recovery.checkpoint).mockRejectedValueOnce(error);
    await expect(f.history.forAgent('agent-run', 'owner')).rejects.toBe(error);
    expect(f.db.prepare('SELECT COUNT(*) AS count FROM recovery_sessions').get()).toEqual({ count: 0 });
    expect(f.recovery.reportBookkeepingFailure).not.toHaveBeenCalled();
  });

  it('shows corrupt drift metadata as unavailable without weakening an explicit scan', async () => {
    const f = setup();
    f.db.prepare("INSERT INTO recovery_snapshots (id,workspace_id,project_id,state,scope,created_at) VALUES (?,?,?,'READY','source',?)").run('snap-corrupt-fixture', f.services.workspaceId, 'project-fixture', Date.now());
    f.db.prepare('INSERT INTO recovery_drift VALUES (?,?,?)').run(f.services.workspaceId, '{invalid JSON', 'snap-corrupt-fixture');
    let status: ReturnType<RecoveryDrift['status']> | undefined;
    expect(() => { status = f.drift.status(); }).not.toThrow();
    expect(status).toMatchObject({ state: 'unavailable', errorCode: 'BACKUP_IO_ERROR' });
    expect(f.recovery.reportBookkeepingFailure).toHaveBeenCalledWith(expect.any(SyntaxError));
    await expect(f.drift.scan()).rejects.toBeInstanceOf(SyntaxError);
  });
});
