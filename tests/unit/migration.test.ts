import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { importLegacyState, planLegacyMigration } from '../../src/config/migration.js';
import { ensurePrivateDirectory } from '../../src/platform/privateFs.js';

const owned: string[] = [];
function fixture() {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dodo-migration-')));
  owned.push(base);
  return { base, source: path.join(base, 'dodo-existing'), target: path.join(base, 'dodo') };
}

afterEach(() => {
  for (const directory of owned.splice(0)) fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
});

function writePrivate(file: string, content: string): void {
  fs.writeFileSync(file, content, { flag: 'wx', mode: 0o600 });
}

describe('Dodo to Dodo state migration', () => {
  it('plans without creating the destination and ignores unlisted entries', () => {
    const f = fixture();
    ensurePrivateDirectory(f.source);
    writePrivate(path.join(f.source, 'config.json'), '{"version":1}\n');
    ensurePrivateDirectory(path.join(f.source, 'models'));
    writePrivate(path.join(f.source, 'models', 'local.bin'), 'managed tool data');

    const plan = planLegacyMigration(f.target, [f.source]);

    expect(plan.state).toBe('available');
    expect(plan.sourceDir).toBe(f.source);
    expect(plan.entries).toContain('config.json');
    expect(plan.ignoredEntries).toContain('models');
    expect(plan.bytes).toBeGreaterThan(0);
    expect(fs.existsSync(f.target)).toBe(false);
  });

  it('imports durable state atomically and preserves the legacy source', () => {
    const f = fixture();
    ensurePrivateDirectory(f.source);
    writePrivate(path.join(f.source, 'config.json'), '{"version":1}\n');
    writePrivate(path.join(f.source, 'state.db'), 'fixture state');
    ensurePrivateDirectory(path.join(f.source, 'keys'));
    writePrivate(path.join(f.source, 'keys', 'jwks.json'), '{"keys":[]}\n');

    const plan = planLegacyMigration(f.target, [f.source]);
    const result = importLegacyState(plan);

    expect(result.sourcePreserved).toBe(true);
    expect(fs.readFileSync(path.join(f.source, 'config.json'), 'utf8')).toBe('{"version":1}\n');
    expect(fs.readFileSync(path.join(f.target, 'config.json'), 'utf8')).toBe('{"version":1}\n');
    expect(fs.readFileSync(path.join(f.target, 'state.db'), 'utf8')).toBe('fixture state');
    expect(JSON.parse(fs.readFileSync(result.receipt, 'utf8'))).toMatchObject({ kind: 'dodo-state-import', sourcePreserved: true });
    expect(fs.existsSync(`${f.target}.migration.lock`)).toBe(false);
  });

  it('does not merge into an existing Dodo state directory', () => {
    const f = fixture();
    ensurePrivateDirectory(f.source);
    writePrivate(path.join(f.source, 'config.json'), '{"version":1}\n');
    ensurePrivateDirectory(f.target);

    const plan = planLegacyMigration(f.target, [f.source]);

    expect(plan.state).toBe('not-needed');
    expect(plan.reason).toMatch(/already exists/);
    expect(() => importLegacyState(plan)).toThrow(/automatic merge|importable/);
  });

  it('fails closed when the legacy runtime still has IPC markers', () => {
    const f = fixture();
    ensurePrivateDirectory(f.source);
    writePrivate(path.join(f.source, 'config.json'), '{"version":1}\n');
    ensurePrivateDirectory(path.join(f.source, 'ipc'));
    writePrivate(path.join(f.source, 'ipc', 'active.marker'), 'runtime');

    const plan = planLegacyMigration(f.target, [f.source]);

    expect(plan.state).toBe('blocked');
    expect(plan.reason).toMatch(/IPC runtime markers/);
    expect(fs.existsSync(f.target)).toBe(false);
  });

  it('fails closed when a candidate is a symbolic link', () => {
    const f = fixture();
    ensurePrivateDirectory(f.base);
    fs.symlinkSync(path.join(f.base, 'outside'), f.source, 'dir');

    const plan = planLegacyMigration(f.target, [f.source]);

    expect(plan.state).toBe('blocked');
    expect(plan.reason).toMatch(/symbolic link/);
    expect(fs.existsSync(f.target)).toBe(false);
  });
});
