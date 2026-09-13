import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { encodeFileIdentity, parseFileIdentity, fileIdentityBigInt } from '../../src/platform/fileIdentity.js';
import { resolveWorkspaceRoot } from '../../src/workspace/root.js';
import { openDatabase } from '../../src/store/db.js';
import { Store } from '../../src/store/store.js';
import { ProjectRegistry } from '../../src/projects/registry.js';

describe('lossless filesystem identity', () => {
  it('keeps legacy safe integers and distinguishes adjacent IDs that Number rounds together', () => {
    expect(encodeFileIdentity(42n)).toBe(42);
    const a = 9007199254740992n;
    const b = a + 1n;
    expect(Number(a)).toBe(Number(b));
    expect(encodeFileIdentity(a)).not.toBe(encodeFileIdentity(b));
    for (const value of [0n, BigInt(Number.MAX_SAFE_INTEGER), a, b, (1n << 64n) - 1n]) {
      const encoded = encodeFileIdentity(value);
      expect(fileIdentityBigInt(parseFileIdentity(JSON.parse(JSON.stringify(encoded)))!)).toBe(value);
    }
  });

  it('rejects rounded numbers and noncanonical or oversized tagged identities', () => {
    for (const value of [Number.MAX_SAFE_INTEGER + 1, -1, 0.5, '9007199254740993', 'u64:42', 'u64:09007199254740993', 'u64:18446744073709551616', 'u64:-1']) {
      expect(parseFileIdentity(value)).toBeUndefined();
    }
    expect(() => encodeFileIdentity(-1n)).toThrow();
    expect(() => encodeFileIdentity(1n << 64n)).toThrow();
  });

  it('round-trips large NTFS IDs through real SQLite and rejects a replaced registry root', () => {
    const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dodo-identity-')));
    const root = path.join(base, 'project');
    fs.mkdirSync(root);
    fs.mkdirSync(path.join(base, 'config'));
    const db = openDatabase(path.join(base, 'config', 'state.db'));
    const store = new Store(db);
    const registry = new ProjectRegistry(store);
    const stat = fs.statSync;
    let ino = 9007199254740992n;
    const spy = vi.spyOn(fs, 'statSync').mockImplementation(((...args: Parameters<typeof fs.statSync>) => {
      const result = stat(...args);
      if (args[0] === root && args[1]?.bigint) {
        return { ...result, dev: 123n, ino, isDirectory: () => true };
      }
      return result;
    }) as typeof fs.statSync);
    try {
      const resolved = resolveWorkspaceRoot(root);
      const first = registry.add(root);
      expect(first.project.available).toBe(true);
      expect(registry.add(root).changed).toBe(false);
      store.upsertWorkspace({ id: first.project.workspaceId, ...resolved, epoch: 'first' });
      expect(store.getWorkspace(first.project.workspaceId)?.ino).toBe('u64:9007199254740992');
      expect(db.prepare('SELECT typeof(ino) AS kind FROM workspaces').get()).toEqual({ kind: 'text' });
      expect(db.prepare('SELECT typeof(root_ino) AS kind FROM project_registry').get()).toEqual({ kind: 'text' });
      ino += 1n;
      expect(registry.get(first.project.projectId).availability).toBe('replaced');
      expect(() => registry.add(root)).toThrow(/another directory identity/);
      expect(store.getWorkspace(first.project.workspaceId)?.ino).toBe('u64:9007199254740992');
    } finally {
      spy.mockRestore();
      db.close();
      fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});
