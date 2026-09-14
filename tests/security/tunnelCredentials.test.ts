import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GlobalConfigSchema } from '../../src/config/globalConfig.js';
import { TunnelConfigSchema, TunnelCredentialRefSchema } from '../../src/config/tunnelConfig.js';
import { envTunnelCredentialRef, fileTunnelCredentialRef, osTunnelCredentialRef, parseTemporaryTunnelToken, readTunnelCredential, validateTunnelToken } from '../../src/tunnel/credentials.js';
import { TunnelLog } from '../../src/tunnel/log.js';
import { buildChildEnv } from '../../src/security/env.js';
import { ensurePrivateDirectory } from '../../src/platform/privateFs.js';

const owned: string[] = [];
const token = 'test-cloudflare-tunnel-token-1234567890';
function fixture(): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dodo-tunnel-security-')));
  ensurePrivateDirectory(dir); owned.push(dir); return dir;
}
afterEach(() => { for (const dir of owned.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe('Cloudflare Tunnel credential boundaries', () => {
  it('stores only strict locators and never accepts a token field in global config', () => {
    expect(TunnelConfigSchema.parse({}).mode).toBe('external');
    expect(TunnelConfigSchema.parse({}).startWithDodo).toBe(true);
    expect(TunnelConfigSchema.parse({}).metricsPort).toBe(21732);
    expect(() => TunnelCredentialRefSchema.parse({ provider: 'env', name: 'TUNNEL_TOKEN', token })).toThrow();
    expect(() => GlobalConfigSchema.parse({ tunnel: { mode: 'managed', token } })).toThrow();
    const serialized = JSON.stringify(GlobalConfigSchema.parse({ tunnel: { mode: 'managed', credentialRef: { provider: 'env', name: 'MY_TUNNEL_TOKEN' } } }));
    expect(serialized).not.toContain(token);
  });

  it('accepts an empty temporary entry as local-only and validates non-empty tokens', () => {
    expect(parseTemporaryTunnelToken('')).toBeUndefined();
    expect(parseTemporaryTunnelToken('   ')).toBeUndefined();
    expect(parseTemporaryTunnelToken(token)).toBe(token);
    expect(() => parseTemporaryTunnelToken('short')).toThrow(/invalid format/);
  });

  it('validates environment and private-file references without copying the secret', async () => {
    const envRef = envTunnelCredentialRef('MY_TUNNEL_TOKEN', { MY_TUNNEL_TOKEN: token });
    expect(envRef).toEqual({ provider: 'env', name: 'MY_TUNNEL_TOKEN' });
    expect(await readTunnelCredential(envRef, { MY_TUNNEL_TOKEN: token })).toBe(token);
    const dir = fixture(), file = path.join(dir, 'tunnel-token');
    fs.writeFileSync(file, `${token}\n`, { mode: 0o600, flag: 'wx' });
    const ref = fileTunnelCredentialRef(file);
    expect(ref).toEqual({ provider: 'file', path: fs.realpathSync.native(file) });
    expect(await readTunnelCredential(ref)).toBe(token);
    expect(JSON.stringify(ref)).not.toContain(token);
  });

  it.skipIf(process.platform === 'win32')('refuses linked and non-private credential files', () => {
    const dir = fixture(), privateFile = path.join(dir, 'private'), link = path.join(dir, 'link'), publicFile = path.join(dir, 'public');
    fs.writeFileSync(privateFile, token, { mode: 0o600 }); fs.symlinkSync(privateFile, link);
    fs.writeFileSync(publicFile, token, { mode: 0o644 });
    expect(() => fileTunnelCredentialRef(link)).toThrow(/symbolic link/);
    expect(() => fileTunnelCredentialRef(publicFile)).toThrow(/private/);
  });

  it('uses a deterministic opaque OS credential key and validates bounded printable tokens', () => {
    const dir = fixture(), a = osTunnelCredentialRef(dir), b = osTunnelCredentialRef(dir);
    expect(a).toEqual(b); expect(a.provider).toBe('os');
    expect(JSON.stringify(a)).toMatch(/^[\s\S]*[a-f0-9]{24}[\s\S]*$/);
    expect(JSON.stringify(a)).not.toContain(dir);
    expect(validateTunnelToken(` ${token}\n`)).toBe(token);
    expect(() => validateTunnelToken('short')).toThrow(/invalid format/);
    expect(() => validateTunnelToken(`valid-length-token-${String.fromCharCode(10)}bad`)).toThrow(/invalid format/);
  });

  it('denies tunnel variables from every MCP job environment even if owner allowlists them', () => {
    const env = buildChildEnv({
      parentEnv: { PATH: '/usr/bin', TUNNEL_TOKEN: token, TUNNEL_TOKEN_FILE: '/private/token' },
      workspaceRoot: '/work', extraAllowlist: ['TUNNEL_TOKEN', 'TUNNEL_TOKEN_FILE'], platform: 'linux',
    });
    expect(env['TUNNEL_TOKEN']).toBeUndefined();
    expect(env['TUNNEL_TOKEN_FILE']).toBeUndefined();
  });

  it('redacts the exact tunnel credential before writing bounded private logs', () => {
    const dir = fixture(), log = new TunnelLog(dir, token);
    log.append('stderr', `cloudflared accidentally echoed ${token}`);
    const content = fs.readFileSync(log.file, 'utf8');
    expect(content).toContain('[REDACTED_TUNNEL_TOKEN]');
    expect(content).not.toContain(token);
    expect(log.read(20).lines).toHaveLength(1);
  });
});
