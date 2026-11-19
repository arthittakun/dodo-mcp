import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../../src/store/db.js';
import { Store } from '../../src/store/store.js';
import { AISettings } from '../../src/services/ai/settings.js';
import { ensurePrivateDirectory } from '../../src/platform/privateFs.js';
import { removeWithRetry } from '../../src/platform/fsRetry.js';

describe('durable credential metadata and Env binding', () => {
  let directory: string, settings: AISettings;
  beforeEach(() => {
    directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dodo-binding-')));
    ensurePrivateDirectory(directory);
    settings = new AISettings(new Store(openDatabase(path.join(directory, 'state.db'))), []);
  });
  afterEach(() => {
    vi.restoreAllMocks(); settings.credentials.close(); settings.store.db.close();
    if (path.dirname(directory) === fs.realpathSync.native(os.tmpdir()) && path.basename(directory).startsWith('dodo-binding-')) removeWithRetry(directory, true);
  });
  const input = { name: 'Binding fixture', provider: 'custom', protocol: 'responses', baseUrl: 'https://initial.example/v1', credentialStorage: 'env' };
  const file = (id: string) => path.join(directory, 'credentials', 'ai', `${id}.env`);

  it('retains blank-key credentials through a cosmetic edit without exposing keys or fingerprints in state', async () => {
    const connection = await settings.saveConnection(input, 'synthetic-binding-original');
    const changed = await settings.saveConnection({ ...connection, name: 'Renamed provider' });
    expect(await settings.credential(changed)).toBe('synthetic-binding-original');
    expect(settings.state().connections[0]).toMatchObject({ credentialPresent: true, credentialNeedsReentry: false });
    expect(JSON.stringify(settings.state())).not.toContain('synthetic-binding-original');
    expect(JSON.stringify(settings.state())).not.toContain('fingerprint');
    expect(JSON.stringify(settings.store.db.prepare('SELECT payload FROM ai_settings').all())).not.toContain('synthetic-binding-original');
  });

  it('fails closed when overlapping instances leave file bytes belonging to a different committed endpoint', async () => {
    const initial = await settings.saveConnection(input, 'synthetic-initial');
    const other = new AISettings(new Store(openDatabase(path.join(directory, 'state.db'))), []);
    let resume!: () => void, written!: () => void;
    const paused = new Promise<void>(resolve => { resume = resolve; });
    const ready = new Promise<void>(resolve => { written = resolve; });
    const set = settings.credentials.set.bind(settings.credentials);
    vi.spyOn(settings.credentials, 'set').mockImplementationOnce(async (...args) => { await set(...args); written(); await paused; });
    const first = settings.saveConnection({ ...initial, baseUrl: 'https://first.example/v1' }, 'synthetic-first-key');
    try {
      await ready;
      await other.saveConnection({ ...initial, baseUrl: 'https://second.example/v1' }, 'synthetic-second-key');
      resume(); await first;
      const current = settings.connection(initial.id);
      expect(current.baseUrl).toBe('https://first.example/v1');
      expect(settings.state().connections[0]).toMatchObject({ credentialPresent: false, credentialNeedsReentry: true });
      await expect(settings.credential(current)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
      await expect(other.models(initial.id)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
      const repaired = await settings.saveConnection(current, 'synthetic-confirmed-key');
      expect(await other.credential(repaired)).toBe('synthetic-confirmed-key');
    } finally { resume(); await first; other.credentials.close(); other.store.db.close(); }
  });

  it('rolls back connection and fingerprint metadata together when binding persistence fails', async () => {
    const original = await settings.saveConnection(input, 'synthetic-old-key');
    settings.store.db.exec("CREATE TRIGGER fail_binding BEFORE INSERT ON ai_settings WHEN NEW.kind='credential-binding' BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
    await expect(settings.saveConnection({ ...original, baseUrl: 'https://replacement.example/v1' }, 'synthetic-new-key')).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(settings.get('connection', original.id)).toMatchObject({ baseUrl: original.baseUrl });
    expect(() => settings.connection(original.id)).toThrow();
    settings.store.db.exec('DROP TRIGGER fail_binding');
    const repaired = await settings.saveConnection({ ...original, baseUrl: 'https://replacement.example/v1' }, 'synthetic-repaired-key');
    expect(await settings.credential(repaired)).toBe('synthetic-repaired-key');
  });

  it('removes an owned Env file after a failed variable rename without requiring a repair key', async () => {
    const original = await settings.saveConnection({ ...input, credentialEnvVar: 'DODO_AI_ORIGINAL_BINDING' }, 'synthetic-old-key');
    settings.store.db.exec("CREATE TRIGGER fail_connection BEFORE INSERT ON ai_settings WHEN NEW.kind='connection' BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
    await expect(settings.saveConnection({ ...original, credentialEnvVar: 'DODO_AI_REPLACEMENT_BINDING' }, 'synthetic-new-key')).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(fs.existsSync(file(original.id))).toBe(true);
    await settings.remove('connection', original.id);
    expect(fs.existsSync(file(original.id))).toBe(false);
    expect(settings.get('credential-update', original.id)).toBeUndefined();
    expect(settings.get('credential-binding', original.id)).toBeUndefined();
  });

  it('permits explicit removal of corrupt owned data while keeping normal reads blocked', async () => {
    const connection = await settings.saveConnection(input, 'synthetic-corrupt-fixture');
    fs.writeFileSync(file(connection.id), 'corrupt credential content');
    expect(settings.state().connections[0]).toMatchObject({ credentialPresent: false, credentialNeedsReentry: true });
    await expect(settings.credential(connection)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    await settings.remove('connection', connection.id);
    expect(fs.existsSync(file(connection.id))).toBe(false);
  });

  it('allows disabling broken Env connections while requiring a valid binding before enabling or sending', async () => {
    const connection = await settings.saveConnection(input, 'synthetic-disable-fixture');
    fs.writeFileSync(file(connection.id), 'corrupt fixture');
    const disabled = await settings.saveConnection({ ...connection, enabled: false });
    expect(disabled.enabled).toBe(false);
    await expect(settings.saveConnection({ ...disabled, enabled: true })).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    const repaired = await settings.saveConnection({ ...disabled, enabled: true }, 'synthetic-binding-repaired');
    settings.store.db.prepare("DELETE FROM ai_settings WHERE kind='credential-binding' AND id=?").run(repaired.id);
    expect(settings.state().connections[0]).toMatchObject({ credentialPresent: false, credentialNeedsReentry: true });
    await expect(settings.credential(repaired)).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    const draft = await settings.saveConnection({ ...input, id: 'ai_disabled_draft01', enabled: false });
    expect(draft.enabled).toBe(false);
    await expect(settings.saveConnection({ ...draft, enabled: true })).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });
});
