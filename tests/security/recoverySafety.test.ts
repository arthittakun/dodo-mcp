import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { platformFixture } from '../helpers/platform.js';

describe('R00 verified backups and durable write intent', () => {
  let f: ReturnType<typeof platformFixture>;
  beforeEach(() => { f = platformFixture(); fs.writeFileSync(path.join(f.root, 'a.txt'), 'A'); fs.writeFileSync(path.join(f.root, 'b.txt'), 'B'); });
  afterEach(async () => { vi.restoreAllMocks(); await f?.close(); });
  const read = (p: string) => fs.readFileSync(path.join(f.root, p), 'utf8');
  async function plan() {
    return f.call('preview_changes', { operations: [{ op: 'replace_file', path: 'a.txt', content: 'A2' }, { op: 'replace_file', path: 'b.txt', content: 'B2' }] });
  }
  async function apply(p: Record<string, unknown>) { return f.call('apply_changes', { planId: p.planId, planHash: p.planHash, idempotencyKey: f.key() }); }

  it('detects corrupted backup before the first source write', async () => {
    const p = await plan(); const set = f.ws.store.setJournalStepState.bind(f.ws.store);
    vi.spyOn(f.ws.store, 'setJournalStepState').mockImplementation((id, seq, state) => {
      set(id, seq, state);
      if (state === 'backed_up' && seq === 0) fs.writeFileSync(f.ws.store.listJournalSteps(id)[0]!.backupPath!, 'corrupted');
    });
    await expect(apply(p)).rejects.toThrow('CONFLICT');
    expect(read('a.txt')).toBe('A'); expect(read('b.txt')).toBe('B');
  });

  it('rechecks all sources after backup and preserves an external edit', async () => {
    const p = await plan(); const set = f.ws.store.setJournalStepState.bind(f.ws.store);
    vi.spyOn(f.ws.store, 'setJournalStepState').mockImplementation((id, seq, state) => {
      set(id, seq, state);
      if (state === 'backed_up' && seq === 1) fs.writeFileSync(path.join(f.root, 'b.txt'), 'human');
    });
    await expect(apply(p)).rejects.toThrow('FILE_CHANGED');
    expect(read('a.txt')).toBe('A'); expect(read('b.txt')).toBe('human');
  });

  it('fails closed on disk-full backup preparation', async () => {
    const p = await plan(); const open = fs.openSync;
    vi.spyOn(fs, 'openSync').mockImplementation((file, flags, mode) => {
      if (typeof file === 'string' && file.includes(`${path.sep}backups${path.sep}`) && flags === 'wx') throw Object.assign(new Error('fixture disk full'), { code: 'ENOSPC' });
      return open(file, flags, mode);
    });
    await expect(apply(p)).rejects.toThrow('RESOURCE_LIMIT');
    expect(read('a.txt')).toBe('A'); expect(read('b.txt')).toBe('B');
  });

  it.skipIf(process.platform === 'win32')('directory flush IO failure cannot be reported as a durable backup', async () => {
    const p = await plan(); const sync = fs.fsyncSync;
    vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => {
      if (fs.fstatSync(fd).isDirectory()) throw Object.assign(new Error('fixture IO failure'), { code: 'EIO' });
      sync(fd);
    });
    await expect(apply(p)).rejects.toThrow('RESOURCE_LIMIT');
    expect(read('a.txt')).toBe('A'); expect(read('b.txt')).toBe('B');
  });

  it('compensates a successful syscall even if the verified-state update fails', async () => {
    const p = await plan(); const set = f.ws.store.setJournalStepState.bind(f.ws.store); let injected = false;
    vi.spyOn(f.ws.store, 'setJournalStepState').mockImplementation((id, seq, state) => {
      if (!injected && state === 'done') { injected = true; expect(read('a.txt')).toBe('A2'); throw new Error('fixture journal write failure'); }
      set(id, seq, state);
    });
    await expect(apply(p)).rejects.toThrow('INTERNAL_ERROR');
    expect(injected).toBe(true); expect(read('a.txt')).toBe('A'); expect(read('b.txt')).toBe('B');
    expect(f.ws.store.listChangesets(f.ws.workspaceId, 1)[0]?.status).toBe('failed');
  });

  it('does not claim committed if another file changes before final verification', async () => {
    const p = await plan(); const set = f.ws.store.setJournalStepState.bind(f.ws.store);
    vi.spyOn(f.ws.store, 'setJournalStepState').mockImplementation((id, seq, state) => {
      set(id, seq, state);
      if (state === 'done' && seq === 1) fs.writeFileSync(path.join(f.root, 'a.txt'), 'human');
    });
    await expect(apply(p)).rejects.toThrow('PARTIAL_RECOVERY_REQUIRED');
    expect(read('a.txt')).toBe('human'); expect(f.ws.services.applier.recoveryBlocked()).toBeTruthy();
  });

  it('never replaces a file that appears during create publication', async () => {
    const link = fs.linkSync;
    vi.spyOn(fs, 'linkSync').mockImplementation((source, dest) => {
      if (dest === path.join(f.root, 'new.txt')) fs.writeFileSync(dest, 'human', { flag: 'wx' });
      return link(source, dest);
    });
    await expect(f.call('write_file', { path: 'new.txt', content: 'AI' })).rejects.toThrow('PARTIAL_RECOVERY_REQUIRED');
    expect(read('new.txt')).toBe('human');
  });

  it('verifies every rollback backup before touching any source and rejects hardlinked backup', async () => {
    const result = await apply(await plan()); const id = result.changesetId as string;
    fs.linkSync(f.ws.store.listJournalSteps(id)[0]!.backupPath!, path.join(f.base, 'linked-backup'));
    await expect(f.call('rollback_changes', { changesetId: id, idempotencyKey: f.key() })).rejects.toThrow('CONFLICT');
    expect(read('a.txt')).toBe('A2'); expect(read('b.txt')).toBe('B2');
  });

  it('stores actual inverse operations and preserves executable mode during rollback', async () => {
    fs.chmodSync(path.join(f.root, 'a.txt'), 0o755);
    const result = await apply(await plan()); const id = result.changesetId as string;
    const rb = await f.call('rollback_changes', { changesetId: id, idempotencyKey: f.key() });
    const forward = f.ws.store.listJournalSteps(id), inverse = f.ws.store.listJournalSteps(rb.changesetId as string);
    expect(inverse.map(s => s.path)).toEqual(['b.txt', 'a.txt']);
    expect(inverse[0]!.beforeHash).toBe(forward[1]!.afterHash); expect(inverse[0]!.afterHash).toBe(forward[1]!.beforeHash);
    expect(inverse[0]!.backupPath).not.toBe(forward[1]!.backupPath);
    expect(fs.readFileSync(inverse[0]!.backupPath!, 'utf8')).toBe('B2');
    expect(read('a.txt')).toBe('A'); expect(read('b.txt')).toBe('B');
    if (process.platform !== 'win32') expect(fs.statSync(path.join(f.root, 'a.txt')).mode & 0o777).toBe(0o755);
  });

  it('treats legacy rollback journals as ambiguous, never as completed forward work', async () => {
    const result = await apply(await plan()), id = result.changesetId as string;
    f.ws.store.createChangeset({ id: 'cs_legacy', workspaceId: f.ws.workspaceId, epoch: f.ws.epoch, planId: null, principal: f.context.principal, kind: 'rollback', summary: 'legacy fixture' });
    for (const s of f.ws.store.listJournalSteps(id)) f.ws.store.addJournalStep({ ...s, changesetId: 'cs_legacy', state: 'done' });
    expect(f.ws.services.applier.reconcileOnBoot().recoveryRequired).toContain('cs_legacy');
    expect(read('a.txt')).toBe('A2');
  });
});
