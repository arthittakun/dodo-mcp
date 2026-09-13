import { DodoError } from '../errors.js';

/** Safe legacy integers stay unchanged. Larger NTFS IDs use non-numeric text
 * so JSON and SQLite INTEGER affinity cannot round them to doubles. */
export type FileIdentity = number | `u64:${string}`;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_U64 = (1n << 64n) - 1n;

export function encodeFileIdentity(value: bigint): FileIdentity {
  if (value < 0n || value > MAX_U64) throw new DodoError('NOT_SUPPORTED', 'filesystem identity is outside the unsigned 64-bit range');
  return value <= MAX_SAFE ? Number(value) : `u64:${value}`;
}

export function parseFileIdentity(value: unknown): FileIdentity | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value !== 'string' || !/^u64:[1-9][0-9]{0,19}$/.test(value)) return undefined;
  const integer = BigInt(value.slice(4));
  return integer > MAX_SAFE && integer <= MAX_U64 ? value as FileIdentity : undefined;
}

export function requireFileIdentity(value: unknown): FileIdentity {
  const identity = parseFileIdentity(value);
  if (identity === undefined) throw new DodoError('INTERNAL_ERROR', 'stored filesystem identity is invalid; owner review required');
  return identity;
}

export function fileIdentityBigInt(value: FileIdentity): bigint {
  return typeof value === 'number' ? BigInt(value) : BigInt(value.slice(4));
}
