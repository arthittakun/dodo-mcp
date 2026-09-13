import { describe, it, expect } from 'vitest';
import { sha256Bytes, canonicalJson, digestOf, phraseFor, newId } from '../../src/util/hash.js';
import { utf8SafeSlice, truncateUtf8, decodeUtf8Strict, looksBinary } from '../../src/util/bytes.js';
import { buildChildEnv, trustedPath } from '../../src/security/env.js';
import { redact } from '../../src/security/redact.js';

describe('hash utils', () => {
  it('FS-06: SHA-256 is over raw bytes with no newline normalization', () => {
    // CRLF vs LF must hash differently.
    expect(sha256Bytes('a\r\nb')).not.toBe(sha256Bytes('a\nb'));
    expect(sha256Bytes('')).toBe('sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('canonicalJson sorts keys recursively so logically equal payloads match', () => {
    expect(canonicalJson({ b: 1, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":1}');
    expect(digestOf({ x: 1, y: 2 })).toBe(digestOf({ y: 2, x: 1 }));
  });

  it('phraseFor is deterministic and three words', () => {
    const p = phraseFor('abc');
    expect(p).toBe(phraseFor('abc'));
    expect(p.split('-')).toHaveLength(3);
  });

  it('newId is prefixed and unique', () => {
    const a = newId('job');
    const b = newId('job');
    expect(a.startsWith('job_')).toBe(true);
    expect(a).not.toBe(b);
  });
});

describe('byte utils', () => {
  it('FS-06: multi-byte UTF-8 is not split by truncation', () => {
    const s = 'ก'.repeat(100); // each is 3 bytes
    const { text, truncated } = truncateUtf8(s, 10);
    expect(truncated).toBe(true);
    expect(decodeUtf8Strict(Buffer.from(text, 'utf8'))).toBe(text); // valid UTF-8, no replacement chars
    expect(text.length).toBe(3); // 9 bytes <= 10
  });

  it('utf8SafeSlice respects character boundaries', () => {
    const buf = Buffer.from('aก b', 'utf8'); // a(1) ก(3) space(1) b(1)
    const { bytes } = utf8SafeSlice(buf, 0, 2); // would cut mid-ก
    expect(bytes.toString('utf8')).toBe('a');
  });

  it('FS-07: detects binary via NUL byte, rejects invalid UTF-8', () => {
    expect(looksBinary(Buffer.from([0x41, 0x00, 0x42]))).toBe(true);
    expect(looksBinary(Buffer.from('plain text'))).toBe(false);
    expect(decodeUtf8Strict(Buffer.from([0xff, 0xfe, 0xfd]))).toBeUndefined();
  });
});

describe('child env whitelist (JOB-12, AUTH-17)', () => {
  it('never inherits OAuth/DODO secrets or dangerous loaders', () => {
    const env = buildChildEnv({
      parentEnv: {
        HOME: '/home/u',
        DODO_CONFIG_DIR: '/secret/state',
        NODE_OPTIONS: '--require evil',
        LD_PRELOAD: '/evil.so',
        SOME_TOKEN: 'sekret',
        PATH: '/usr/bin',
      },
      workspaceRoot: '/work',
      extraAllowlist: [],
    });
    expect(env['HOME']).toBe('/home/u');
    expect(env['DODO_CONFIG_DIR']).toBeUndefined();
    expect(env['NODE_OPTIONS']).toBeUndefined();
    expect(env['LD_PRELOAD']).toBeUndefined();
    expect(env['SOME_TOKEN']).toBeUndefined();
  });

  it('JOB-12: trustedPath drops entries inside the workspace root and relative entries', () => {
    const p = trustedPath('/work/node_modules/.bin:/usr/bin:relative/bin:/usr/local/bin', '/work');
    const parts = p.split(':');
    expect(parts).toContain('/usr/bin');
    expect(parts).toContain('/usr/local/bin');
    expect(parts).not.toContain('/work/node_modules/.bin');
    expect(parts).not.toContain('relative/bin');
  });
});

describe('redaction', () => {
  it('redacts bearer tokens, JWTs and key-like strings', () => {
    expect(redact('Authorization: Bearer abc123def456ghi')).toContain('[REDACTED]');
    expect(redact('token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIx')).toContain('[REDACTED_JWT]');
    expect(redact('client_secret=supersecretvalue123')).toContain('[REDACTED]');
  });
});
