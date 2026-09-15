import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DodoError } from '../../src/errors.js';
import { importState, planStateImport, STATE_IMPORT_CONFIG_FIELDS } from '../../src/config/stateImport.js';
import { ensurePrivateDirectory } from '../../src/platform/privateFs.js';

const owned: string[] = [];
function fixture() {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dodo-state-import-')));
  ensurePrivateDirectory(base);
  owned.push(base);
  return { base, source: path.join(base, 'dodo-existing'), target: path.join(base, 'dodo') };
}

afterEach(() => {
  for (const directory of owned.splice(0)) fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
});

function writePrivate(file: string, content: string): void {
  fs.writeFileSync(file, content, { flag: 'wx', mode: 0o600 });
}

function authorityConfig(): Record<string, unknown> {
  return {
    version: 1,
    port: 21800,
    configPort: 21801,
    searchBackend: 'js',
    logRetentionDays: 14,
    toolSurface: 'hybrid',
    publicUrl: 'https://private.example.test',
    allowedHosts: ['private.example.test'],
    allowedOrigins: ['private.example.test'],
    secretAllow: ['.env'],
    commandSandbox: 'require',
    sandboxWritablePaths: ['/private/cache'],
    allowWebFetch: true,
    lsp: { fixture: { command: '/private/lsp', args: ['--stdio'], extensions: ['.fixture'] } },
    envAllowlist: ['PRIVATE_TOKEN'],
    tunnel: { mode: 'managed', credentialRef: { provider: 'env', name: 'PRIVATE_TUNNEL_TOKEN' }, executable: '/private/cloudflared', metricsPort: 31111, maxRestarts: 5 },
    dangerouslyAllowInsecurePublicUrl: false,
  };
}

describe('security-scoped Dodo state import', () => {
  it('plans read-only and lists exactly the preference allowlist', () => {
    const f = fixture();
    ensurePrivateDirectory(f.source);
    writePrivate(path.join(f.source, 'config.json'), JSON.stringify(authorityConfig()));
    writePrivate(path.join(f.source, 'state.db'), 'token-bearing database fixture');
    ensurePrivateDirectory(path.join(f.source, 'keys'));
    writePrivate(path.join(f.source, 'keys', 'jwks.json'), '{"keys":["private"]}\n');

    const plan = planStateImport(f.target, [f.source]);

    expect(plan.state).toBe('available');
    expect(plan.entries).toEqual(['config.json']);
    expect(plan.ignoredEntries).toEqual(['keys', 'state.db']);
    expect(plan.importedConfigFields).toEqual(['configPort', 'logRetentionDays', 'port', 'searchBackend', 'toolSurface', 'version']);
    expect(plan.importedConfigFields.every(field => (STATE_IMPORT_CONFIG_FIELDS as readonly string[]).includes(field))).toBe(true);
    expect(plan.resetSecurity).toContain('config.allowWebFetch');
    expect(plan.resetSecurity.some(item => item.includes('tunnel credential'))).toBe(true);
    expect(plan.configSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(fs.existsSync(f.target)).toBe(false);
  });

  it('creates a fresh config without copying credentials, ACLs or permission-bearing fields', () => {
    const f = fixture();
    ensurePrivateDirectory(f.source);
    writePrivate(path.join(f.source, 'config.json'), JSON.stringify(authorityConfig()));
    writePrivate(path.join(f.source, 'state.db'), 'token-bearing database fixture');
    ensurePrivateDirectory(path.join(f.source, 'keys'));
    writePrivate(path.join(f.source, 'keys', 'jwks.json'), '{"keys":["private"]}\n');
    const sourceConfig = fs.readFileSync(path.join(f.source, 'config.json'));

    const plan = planStateImport(f.target, [f.source]);
    const result = importState(plan);
    const saved = JSON.parse(fs.readFileSync(path.join(f.target, 'config.json'), 'utf8'));

    expect(saved.port).toBe(21800);
    expect(saved.configPort).toBe(21801);
    expect(saved.searchBackend).toBe('js');
    expect(saved.logRetentionDays).toBe(14);
    expect(saved.toolSurface).toBe('hybrid');
    expect(saved.publicUrl).toBeUndefined();
    expect(saved.allowedHosts).toEqual([]);
    expect(saved.allowedOrigins).toEqual([]);
    expect(saved.secretAllow).toEqual([]);
    expect(saved.allowWebFetch).toBe(false);
    expect(saved.lsp).toEqual({});
    expect(saved.envAllowlist).toEqual([]);
    expect(saved.tunnel).toEqual({ connectionMode: 'local', metricsPort: 21732, maxRestarts: 2 });
    expect(fs.existsSync(path.join(f.target, 'state.db'))).toBe(false);
    expect(fs.existsSync(path.join(f.target, 'keys'))).toBe(false);
    expect(fs.readFileSync(path.join(f.source, 'config.json'))).toEqual(sourceConfig);
    expect(fs.existsSync(path.join(f.source, 'state.db'))).toBe(true);
    expect(result.sourcePreserved).toBe(true);
    expect(result.configSha256).toBe(plan.configSha256);
    expect(JSON.parse(fs.readFileSync(result.receipt, 'utf8'))).toMatchObject({
      schemaVersion: 1,
      kind: 'dodo-state-import',
      sourcePreserved: true,
      importedConfigFields: plan.importedConfigFields,
    });
    expect(fs.existsSync(`${f.target}.migration.lock`)).toBe(false);
  });

  it('detects source changes after planning and leaves the target absent', () => {
    const f = fixture();
    ensurePrivateDirectory(f.source);
    writePrivate(path.join(f.source, 'config.json'), '{"version":1,"port":21730}\n');
    const plan = planStateImport(f.target, [f.source]);
    fs.writeFileSync(path.join(f.source, 'config.json'), '{"version":1,"port":21731}\n');

    expect(() => importState(plan)).toThrow(/changed after planning/);
    expect(fs.existsSync(f.target)).toBe(false);
    expect(fs.existsSync(path.join(f.source, 'config.json'))).toBe(true);
  });

  it('is idempotent at the plan boundary and never merges into an existing target', () => {
    const f = fixture();
    ensurePrivateDirectory(f.source);
    writePrivate(path.join(f.source, 'config.json'), '{"version":1}\n');
    importState(planStateImport(f.target, [f.source]));

    const again = planStateImport(f.target, [f.source]);
    expect(again.state).toBe('not-needed');
    expect(again.reason).toMatch(/already exists/);
    expect(() => importState(again)).toThrow(/automatic merge|importable/);
  });

  it.skipIf(process.platform === 'win32')('accepts an owner-controlled 0755 config parent but rejects a writable parent', () => {
    const safe = fixture();
    ensurePrivateDirectory(safe.source);
    writePrivate(path.join(safe.source, 'config.json'), '{"version":1}\n');
    fs.chmodSync(safe.base, 0o755);
    expect(() => importState(planStateImport(safe.target, [safe.source]))).not.toThrow();

    const writable = fixture();
    ensurePrivateDirectory(writable.source);
    writePrivate(path.join(writable.source, 'config.json'), '{"version":1}\n');
    const plan = planStateImport(writable.target, [writable.source]);
    fs.chmodSync(writable.base, 0o777);
    expect(() => importState(plan)).toThrow(/not writable by group or others/);
    expect(fs.existsSync(writable.target)).toBe(false);
  });

  it('requires local review for malformed or unknown config fields', () => {
    for (const content of ['not json', '{"version":1,"unknownAuthority":true}']) {
      const f = fixture();
      ensurePrivateDirectory(f.source);
      writePrivate(path.join(f.source, 'config.json'), content);
      const plan = planStateImport(f.target, [f.source]);
      expect(plan.state).toBe('blocked');
      try {
        importState(plan);
        throw new Error('expected import to fail');
      } catch (error) {
        expect(error).toBeInstanceOf(DodoError);
        expect((error as DodoError).code).toBe('MIGRATION_REVIEW_REQUIRED');
      }
      expect(fs.existsSync(f.target)).toBe(false);
    }
  });

  it('fails closed while the existing runtime has IPC markers', () => {
    const f = fixture();
    ensurePrivateDirectory(f.source);
    writePrivate(path.join(f.source, 'config.json'), '{"version":1}\n');
    ensurePrivateDirectory(path.join(f.source, 'ipc'));
    writePrivate(path.join(f.source, 'ipc', 'active.marker'), 'runtime');

    const plan = planStateImport(f.target, [f.source]);

    expect(plan.state).toBe('blocked');
    expect(plan.reason).toMatch(/IPC runtime markers/);
    expect(fs.existsSync(f.target)).toBe(false);
  });

  it('fails closed when the source or config is linked', () => {
    const linkedRoot = fixture();
    ensurePrivateDirectory(path.join(linkedRoot.base, 'outside'));
    fs.symlinkSync(path.join(linkedRoot.base, 'outside'), linkedRoot.source, process.platform === 'win32' ? 'junction' : 'dir');
    expect(planStateImport(linkedRoot.target, [linkedRoot.source]).state).toBe('blocked');

    const linkedConfig = fixture();
    ensurePrivateDirectory(linkedConfig.source);
    const outside = path.join(linkedConfig.base, 'outside.json');
    writePrivate(outside, '{"version":1}\n');
    fs.symlinkSync(outside, path.join(linkedConfig.source, 'config.json'), 'file');
    expect(planStateImport(linkedConfig.target, [linkedConfig.source]).state).toBe('blocked');
  });
});
