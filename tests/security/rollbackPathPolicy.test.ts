import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { platformFixture } from '../helpers/platform.js';

/** Real filesystem regression tests. Only disposable test-owned paths change. */
describe('journal recovery revalidates current filesystem boundaries', () => {
  let f: ReturnType<typeof platformFixture>;
  beforeEach(() => { f = platformFixture(); }, 120000);
  afterEach(async () => { if (f) await f.close(); }, 120000);

  async function changedFile() {
    await f.call('write_file', { path: 'docs/note.txt', content: 'before\r\n' });
    return f.call('edit_file', { path: 'docs/note.txt', edits: [{ find: 'before', replace: 'after' }] });
  }

  function redirectParent() {
    const outside = path.join(f.base, 'outside');
    fs.mkdirSync(outside);
    // Identical bytes defeat a hash-only check, but must not authorize access.
    fs.writeFileSync(path.join(outside, 'note.txt'), 'after\r\n');
    fs.renameSync(path.join(f.root, 'docs'), path.join(f.root, 'docs-original'));
    fs.symlinkSync(outside, path.join(f.root, 'docs'), process.platform === 'win32' ? 'junction' : 'dir');
    return outside;
  }

  it('refuses rollback through a replaced ancestor despite an identical content hash', async () => {
    const edited = await changedFile();
    const outside = redirectParent();
    await expect(f.call('rollback_changes', { changesetId: edited['changesetId'], idempotencyKey: f.key() })).rejects.toThrow('CONFLICT');
    expect(fs.readFileSync(path.join(outside, 'note.txt'), 'utf8')).toBe('after\r\n');
    expect(fs.readFileSync(path.join(f.root, 'docs-original/note.txt'), 'utf8')).toBe('after\r\n');
  });

  it('refuses rollback when the final file acquires a hardlink after apply', async () => {
    const edited = await changedFile();
    const sibling = path.join(f.base, 'linked-outside.txt');
    fs.linkSync(path.join(f.root, 'docs/note.txt'), sibling);
    await expect(f.call('rollback_changes', { changesetId: edited['changesetId'], idempotencyKey: f.key() })).rejects.toThrow('CONFLICT');
    expect(fs.readFileSync(sibling, 'utf8')).toBe('after\r\n');
    expect(fs.readFileSync(path.join(f.root, 'docs/note.txt'), 'utf8')).toBe('after\r\n');
  });

  it('marks interrupted recovery for owner review rather than accepting an aliased after-state', async () => {
    const edited = await changedFile();
    const id = edited['changesetId'] as string;
    const outside = redirectParent();
    f.ws.store.setChangesetStatus(id, 'committing');
    const result = f.ws.services.applier.reconcileOnBoot();
    expect(result.recoveryRequired).toContain(id);
    expect(result.committed).not.toContain(id);
    expect(fs.readFileSync(path.join(outside, 'note.txt'), 'utf8')).toBe('after\r\n');
    expect(f.ws.services.applier.recoveryBlocked()?.id).toBe(id);
  });
});
