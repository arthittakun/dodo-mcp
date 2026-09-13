/** Byte-oriented text helpers. All truncation is explicit — never silent. */

/**
 * Truncate a UTF-8 buffer at or before `maxBytes` without splitting a
 * multi-byte sequence. Returns the sliced buffer and whether truncation happened.
 */
export function utf8SafeSlice(buf: Buffer, start: number, maxBytes: number): { bytes: Buffer; end: number } {
  const from = clampContinuationForward(buf, Math.max(0, Math.min(start, buf.length)));
  let end = Math.min(buf.length, from + Math.max(0, maxBytes));
  end = clampContinuationBackward(buf, end);
  if (end < from) end = from;
  return { bytes: buf.subarray(from, end), end };
}

function isContinuation(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

/** Move forward past continuation bytes so we start on a character boundary. */
function clampContinuationForward(buf: Buffer, pos: number): number {
  let p = pos;
  while (p < buf.length && isContinuation(buf[p] ?? 0)) p += 1;
  return p;
}

/** Move backward so we do not end mid-character. */
function clampContinuationBackward(buf: Buffer, pos: number): number {
  let p = pos;
  while (p > 0 && p < buf.length && isContinuation(buf[p] ?? 0)) p -= 1;
  return p;
}

/** Truncate a string to at most maxBytes of UTF-8, appending a marker when cut. */
export function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return { text, truncated: false };
  const { bytes } = utf8SafeSlice(buf, 0, maxBytes);
  return { text: bytes.toString('utf8'), truncated: true };
}

/** Strict UTF-8 decode: returns undefined if the bytes are not valid UTF-8. */
export function decodeUtf8Strict(buf: Buffer): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf);
  } catch {
    return undefined;
  }
}

/** Heuristic binary detection: NUL byte in the first 8 KiB. */
export function looksBinary(buf: Buffer): boolean {
  const probe = buf.subarray(0, 8192);
  return probe.includes(0);
}
