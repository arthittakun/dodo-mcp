import { createHash, randomBytes } from 'node:crypto';

/** SHA-256 of raw bytes, formatted as `sha256:<hex>` (spec §10.3: no newline normalization). */
export function sha256Bytes(data: Uint8Array | string): string {
  const h = createHash('sha256');
  h.update(typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
  return `sha256:${h.digest('hex')}`;
}

/**
 * Canonical JSON: object keys sorted recursively, no whitespace. Used for
 * idempotency payload hashes and approval action digests so logically equal
 * payloads hash equal.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortValue(v);
    }
    return out;
  }
  return value;
}

export function digestOf(value: unknown): string {
  return sha256Bytes(canonicalJson(value));
}

const ID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'; // Crockford-ish, lowercase, unambiguous

export function newId(prefix: string, bytes = 10): string {
  const raw = randomBytes(bytes);
  let out = '';
  for (const b of raw) out += ID_ALPHABET[b % 32];
  return `${prefix}_${out}`;
}

/** Three human-checkable words derived from an id, for OAuth consent phrase matching. */
export function phraseFor(id: string): string {
  const WORDS = [
    'amber', 'bison', 'cedar', 'delta', 'ember', 'fjord', 'gecko', 'harbor',
    'igloo', 'jade', 'kelp', 'lotus', 'mango', 'nova', 'onyx', 'pine',
    'quartz', 'raven', 'sage', 'tiger', 'umber', 'violet', 'willow', 'xenon',
    'yarrow', 'zephyr', 'basil', 'coral', 'dune', 'elm', 'fern', 'grove',
  ];
  const digest = createHash('sha256').update(id).digest();
  const pick = (i: number) => WORDS[(digest[i] ?? 0) % WORDS.length];
  return `${pick(0)}-${pick(1)}-${pick(2)}`;
}
