import fs from 'node:fs';
import { generateKeyPairSync, randomBytes, createPrivateKey, createPublicKey } from 'node:crypto';
import { DodoError } from '../errors.js';

/**
 * Persistent signing/cookie key material (spec §5): generated once, stored
 * 0600 in the keys dir. Encryption at rest does not protect against same-OS-
 * user processes — documented in SECURITY.md.
 */
export interface JwksFile {
  keys: Array<Record<string, unknown>>; // private JWKs
}

export function loadOrCreateJwks(jwksFile: string): JwksFile {
  try {
    const raw = fs.readFileSync(jwksFile, 'utf8');
    const parsed = JSON.parse(raw) as JwksFile;
    if (!Array.isArray(parsed.keys) || parsed.keys.length === 0) throw new Error('empty');
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new DodoError('INTERNAL_ERROR', 'signing key store is corrupt; refusing to regenerate silently', {
        recovery: `inspect ${jwksFile}; deleting it invalidates all issued tokens`,
      });
    }
  }
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = privateKey.export({ format: 'jwk' }) as Record<string, unknown>;
  jwk['kid'] = `dodo-${randomBytes(6).toString('hex')}`;
  jwk['alg'] = 'ES256';
  jwk['use'] = 'sig';
  const out: JwksFile = { keys: [jwk] };
  fs.writeFileSync(jwksFile, JSON.stringify(out, null, 2), { mode: 0o600 });
  return out;
}

/** Public JWKS derived from the private file (for local verification). */
export function publicJwks(jwks: JwksFile): { keys: Array<Record<string, unknown>> } {
  return {
    keys: jwks.keys.map((priv) => {
      const key = createPrivateKey({ key: priv as unknown as import('node:crypto').JsonWebKey, format: 'jwk' });
      const pub = createPublicKey(key).export({ format: 'jwk' }) as Record<string, unknown>;
      pub['kid'] = priv['kid'];
      pub['alg'] = priv['alg'];
      pub['use'] = 'sig';
      return pub;
    }),
  };
}

export function loadOrCreateCookieKeys(cookieKeysFile: string): string[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(cookieKeysFile, 'utf8')) as { keys: string[] };
    if (Array.isArray(parsed.keys) && parsed.keys.length > 0) return parsed.keys;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new DodoError('INTERNAL_ERROR', 'cookie key store is corrupt', { recovery: `inspect ${cookieKeysFile}` });
    }
  }
  const keys = [randomBytes(32).toString('hex'), randomBytes(32).toString('hex')];
  fs.writeFileSync(cookieKeysFile, JSON.stringify({ keys }, null, 2), { mode: 0o600 });
  return keys;
}
