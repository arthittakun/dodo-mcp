import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AICredentials, defaultEnvVariable, validateEnvVariable } from '../../src/services/ai/credentials.js';
import { EnvCredentials } from '../../src/services/ai/envCredentials.js';
import { buildChildEnv } from '../../src/security/env.js';
import { assertPrivatePath } from '../../src/platform/privateFs.js';
import { removeWithRetry } from '../../src/platform/fsRetry.js';
import { sha256Bytes } from '../../src/util/hash.js';

const ID = 'ai_envfixture001';
const NAME = 'DODO_AI_ENV_UNIT_FIXTURE';
const SECRET = 'synthetic-local-env-credential';

describe('persistent installation Env credentials', () => {
  let directory: string;
  let sequence = 0;
  beforeAll(() => { directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dodo-env-unit-'))); });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  afterAll(() => {
    if (directory && path.dirname(directory) === fs.realpathSync.native(os.tmpdir()) && path.basename(directory).startsWith('dodo-env-unit-')) removeWithRetry(directory, true);
  });
  const fixture = () => {
    const local = path.join(directory, `credentials-${sequence++}`);
    return { local, store: new AICredentials(local), file: path.join(local, `${ID}.env`) };
  };

  it('persists and rotates a key across fresh instances without adding it to process.env', async () => {
    const f = fixture();
    vi.stubEnv(NAME, undefined);
    await f.store.set(ID, 'env', SECRET, NAME);
    expect(process.env[NAME]).toBeUndefined();
    f.store.close();
    const restarted = new AICredentials(f.local);
    expect(restarted.hasEnv(ID, NAME)).toBe(true);
    expect(restarted.hasEnv(ID, NAME, sha256Bytes(SECRET))).toBe(true);
    expect(restarted.hasEnv(ID, NAME, sha256Bytes('synthetic-stale-binding'))).toBe(false);
    expect(restarted.hasEnv(ID, NAME, 'malformed-fingerprint')).toBe(false);
    expect(await restarted.get(ID, 'env', NAME)).toBe(SECRET);
    await restarted.set(ID, 'env', 'synthetic-rotated-credential', NAME);
    expect(await new AICredentials(f.local).get(ID, 'env', NAME)).toBe('synthetic-rotated-credential');
    expect(fs.readdirSync(f.local)).toEqual([`${ID}.env`]);
  });

  it('keeps different connection IDs and separate installations independent', async () => {
    const f = fixture(), second = 'ai_envfixture002';
    await f.store.set(ID, 'env', SECRET);
    await f.store.set(second, 'env', 'synthetic-other-connection');
    expect(await f.store.get(ID, 'env')).toBe(SECRET);
    expect(await f.store.get(second, 'env')).toBe('synthetic-other-connection');
    expect(await fixture().store.get(ID, 'env')).toBe('');
    expect(defaultEnvVariable('ai_abcdef-ghijk')).not.toBe(defaultEnvVariable('ai_abcdef_ghijk'));
  });

  it('reads an explicitly named inherited variable without creating files or changing its value', async () => {
    const f = fixture();
    vi.stubEnv(NAME, SECRET);
    expect(await f.store.get(ID, 'env', NAME)).toBe(SECRET);
    expect(f.store.hasEnv(ID, NAME)).toBe(true);
    expect(fs.existsSync(f.local)).toBe(false);
    expect(await new AICredentials().get(ID, 'env', NAME)).toBe(SECRET);
    await f.store.delete(ID, 'env', NAME);
    expect(process.env[NAME]).toBe(SECRET);
  });

  it('prefers an owned saved key to a stale inherited value and deletes only the owned copy', async () => {
    const f = fixture();
    vi.stubEnv(NAME, 'synthetic-inherited-old');
    await f.store.set(ID, 'env', SECRET, NAME);
    expect(await f.store.get(ID, 'env', NAME)).toBe(SECRET);
    await f.store.delete(ID, 'env', NAME);
    expect(fs.existsSync(f.file)).toBe(false);
    expect(process.env[NAME]).toBe('synthetic-inherited-old');
    expect(await f.store.get(ID, 'env', NAME)).toBe('synthetic-inherited-old');
  });

  it('fails closed instead of using inherited values for an owned file with a different binding', async () => {
    const f = fixture();
    vi.stubEnv('DODO_AI_ENV_OTHER_FIXTURE', 'synthetic-inherited-different');
    await f.store.set(ID, 'env', SECRET, NAME);
    await expect(f.store.get(ID, 'env', 'DODO_AI_ENV_OTHER_FIXTURE')).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(f.store.hasEnv(ID, 'DODO_AI_ENV_OTHER_FIXTURE')).toBe(false);
    await expect(f.store.delete(ID, 'env', 'DODO_AI_ENV_OTHER_FIXTURE')).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(await f.store.get(ID, 'env', NAME)).toBe(SECRET);
  });

  it('replaces the saved variable binding only when saving an explicit replacement key', async () => {
    const f = fixture();
    await f.store.set(ID, 'env', SECRET, NAME);
    await f.store.set(ID, 'env', 'synthetic-rebound-key', 'DODO_AI_ENV_OTHER_FIXTURE');
    expect(await f.store.get(ID, 'env', 'DODO_AI_ENV_OTHER_FIXTURE')).toBe('synthetic-rebound-key');
    await expect(f.store.get(ID, 'env', NAME)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });

  it('removes only the owned private file after an interrupted binding change or corrupt payload', async () => {
    const f = fixture(); vi.stubEnv(NAME, 'synthetic-external-value-retained');
    await f.store.set(ID, 'env', SECRET, NAME);
    await expect(f.store.delete(ID, 'env', 'DODO_AI_ENV_OTHER_FIXTURE')).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    f.store.deleteOwnedEnv(ID);
    expect(fs.existsSync(f.file)).toBe(false); expect(process.env[NAME]).toBe('synthetic-external-value-retained');
    await f.store.set(ID, 'env', SECRET, NAME);
    fs.writeFileSync(f.file, 'corrupt interrupted payload');
    f.store.deleteOwnedEnv(ID);
    expect(fs.existsSync(f.file)).toBe(false); expect(process.env[NAME]).toBe('synthetic-external-value-retained');
    f.store.deleteOwnedEnv(ID);
  });

  it('uses private files and directories, and retains existing session semantics', async () => {
    const f = fixture();
    await f.store.set(ID, 'session', 'synthetic-session-only');
    expect(fs.existsSync(f.local)).toBe(false);
    await f.store.set(ID, 'env', SECRET, NAME);
    expect(assertPrivatePath(f.local, true).isDirectory()).toBe(true);
    expect(assertPrivatePath(f.file).isFile()).toBe(true);
    if (process.platform !== 'win32') {
      expect(fs.statSync(f.local).mode & 0o777).toBe(0o700);
      expect(fs.statSync(f.file).mode & 0o777).toBe(0o600);
    }
    f.store.close();
    expect(await f.store.get(ID, 'session')).toBe('');
    expect(await f.store.get(ID, 'env', NAME)).toBe(SECRET);
  });

  it('keeps secret characters as data and never interpolates commands or additional Env assignments', async () => {
    const f = fixture();
    const key = 'synthetic-$(NO_EXEC)-`NO_EXEC`-$HOME-"quoted"-\\path-#tail';
    await f.store.set(ID, 'env', key, NAME);
    expect(await new AICredentials(f.local).get(ID, 'env', NAME)).toBe(key);
    expect(fs.readdirSync(f.local)).toEqual([`${ID}.env`]);
    vi.stubEnv(NAME, SECRET);
    fs.appendFileSync(f.file, 'DODO_AI_INJECTED="synthetic-other"\n');
    await expect(f.store.get(ID, 'env', NAME)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });

  it('does not return or fall back from corrupted, oversized or noncanonical UTF-8 files', async () => {
    const f = fixture();
    await f.store.set(ID, 'env', SECRET, NAME);
    vi.stubEnv(NAME, 'synthetic-fallback-must-not-win');
    for (const value of [Buffer.from('not-an-env-file'), Buffer.alloc(33 * 1024, 65), Buffer.from([0xff, 0xfe, 0x41])]) {
      fs.writeFileSync(f.file, value);
      await expect(f.store.get(ID, 'env', NAME)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
      expect(f.store.hasEnv(ID, NAME)).toBe(false);
    }
    await f.store.set(ID, 'env', 'synthetic-repaired-file', NAME);
    expect(await f.store.get(ID, 'env', NAME)).toBe('synthetic-repaired-file');
  });

  it('rejects hardlinked credential files without changing their other path', async () => {
    const f = fixture();
    await f.store.set(ID, 'env', SECRET, NAME);
    const alias = path.join(f.local, 'hardlink.env'); fs.linkSync(f.file, alias);
    await expect(f.store.get(ID, 'env', NAME)).rejects.toMatchObject({ code: 'PATH_DENIED' });
    await expect(f.store.set(ID, 'env', 'synthetic-do-not-overwrite', NAME)).rejects.toMatchObject({ code: 'PATH_DENIED' });
    await expect(f.store.delete(ID, 'env', NAME)).rejects.toMatchObject({ code: 'PATH_DENIED' });
    expect(() => f.store.deleteOwnedEnv(ID)).toThrow();
    expect(fs.readFileSync(alias, 'utf8')).toContain(SECRET);
  });

  it('retains the committed key after a failed rename and cleans private staging data', async () => {
    const f = fixture();
    await f.store.set(ID, 'env', SECRET, NAME);
    vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw Object.assign(new Error('synthetic rename failure'), { code: 'EIO' }); });
    await expect(f.store.set(ID, 'env', 'synthetic-uncommitted-replacement', NAME)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(await new AICredentials(f.local).get(ID, 'env', NAME)).toBe(SECRET);
    expect(fs.readdirSync(f.local)).toEqual([`${ID}.env`]);
  });

  it('refuses an aliased parent before creating or changing anything under its target', async () => {
    const realParent = path.join(directory, `external-${sequence++}`), alias = path.join(directory, `alias-${sequence++}`);
    fs.mkdirSync(realParent);
    const existingLeaf = path.join(realParent, 'existing'); fs.mkdirSync(existingLeaf, { mode: 0o755 });
    fs.symlinkSync(realParent, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const before = fs.statSync(existingLeaf).mode;
    for (const leaf of ['missing', 'existing']) {
      const credentials = new AICredentials(path.join(alias, leaf));
      await expect(credentials.set(ID, 'env', SECRET, NAME)).rejects.toMatchObject({ code: 'PATH_DENIED' });
    }
    expect(fs.existsSync(path.join(realParent, 'missing'))).toBe(false);
    expect(fs.readdirSync(existingLeaf)).toEqual([]);
    expect(fs.statSync(existingLeaf).mode).toBe(before);
  });

  it('does not replace a committed key when flushing the staged replacement fails', async () => {
    const f = fixture();
    await f.store.set(ID, 'env', SECRET, NAME);
    vi.spyOn(fs, 'fsyncSync').mockImplementationOnce(() => { throw new Error('synthetic fsync failure'); });
    await expect(f.store.set(ID, 'env', 'synthetic-unflushed-replacement', NAME)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(await f.store.get(ID, 'env', NAME)).toBe(SECRET);
    expect(fs.readdirSync(f.local)).toEqual([`${ID}.env`]);
  });

  it('validates Env names, IDs and missing storage before writing any file', async () => {
    const f = fixture();
    for (const name of ['PATH', 'HOME', 'NODE_OPTIONS', 'LD_PRELOAD', 'DODO_CONFIG_DIR', 'lowercase_key', 'A', 'KEY=INJECT', 'KEY\nINJECT']) expect(() => validateEnvVariable(name)).toThrow();
    for (const id of ['../other', 'ai_short', 'ai_abcd/efgh', 'ai_abcdefgh\\other']) await expect(f.store.set(id, 'env', SECRET, NAME)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    for (const key of ['', 'has whitespace', 'line\nbreak', 'a'.repeat(4097)]) await expect(f.store.set(ID, 'env', key, NAME)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(new AICredentials().set(ID, 'env', SECRET, NAME)).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
    expect(fs.existsSync(f.local)).toBe(false);
  });

  it('keeps stored and DODO-prefixed inherited keys out of ordinary child job environments', async () => {
    const f = fixture();
    vi.stubEnv(NAME, undefined);
    await f.store.set(ID, 'env', SECRET, NAME);
    const child = buildChildEnv({ parentEnv: process.env, workspaceRoot: directory, extraAllowlist: [NAME] });
    expect(JSON.stringify(child)).not.toContain(SECRET); expect(child[NAME]).toBeUndefined();
    vi.stubEnv(NAME, 'synthetic-inherited-isolated');
    expect(buildChildEnv({ parentEnv: process.env, workspaceRoot: directory, extraAllowlist: [NAME] })[NAME]).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')('fails closed on permissive POSIX credential permissions', async () => {
    const f = fixture(); await f.store.set(ID, 'env', SECRET, NAME);
    fs.chmodSync(f.file, 0o644);
    await expect(f.store.get(ID, 'env', NAME)).rejects.toMatchObject({ code: 'PATH_DENIED' });
    await expect(f.store.set(ID, 'env', 'synthetic-no-permission-repair', NAME)).rejects.toMatchObject({ code: 'PATH_DENIED' });
    fs.chmodSync(f.file, 0o600);
  });

  it('does not leak inherited malformed credential values through error messages', async () => {
    const inherited = 'synthetic-secret\nDO_NOT_ECHO'; vi.stubEnv(NAME, inherited);
    try { new EnvCredentials().get(ID, NAME); throw new Error('expected invalid credential rejection'); }
    catch (error) { expect(String(error)).not.toContain(inherited); expect(error).toMatchObject({ code: 'AUTH_REQUIRED' }); }
  });
});
