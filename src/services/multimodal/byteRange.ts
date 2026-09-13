/** A single bounded HTTP byte range over an already policy-checked immutable buffer. */
export function staticResponse(bytes: Buffer, contentType: string, range?: string): {
  status: number; body: Buffer; headers: Record<string, string>;
} {
  const headers: Record<string, string> = { 'content-type': contentType, 'cache-control': 'no-store', 'accept-ranges': 'bytes' };
  if (range === undefined) return { status: 200, body: bytes, headers: { ...headers, 'content-length': String(bytes.length) } };
  const invalid = () => ({ status: 416, body: Buffer.alloc(0), headers: { ...headers, 'content-range': `bytes */${bytes.length}`, 'content-length': '0' } });
  // Multi-range responses are deliberately unsupported; never allocate based on request lengths.
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match || (!match[1] && !match[2]) || bytes.length === 0) return invalid();
  const first = match[1] ? Number(match[1]) : undefined;
  const last = match[2] ? Number(match[2]) : undefined;
  if ((first !== undefined && !Number.isSafeInteger(first)) || (last !== undefined && !Number.isSafeInteger(last))) return invalid();
  let start: number, end: number;
  if (first === undefined) {
    if (last === undefined || last <= 0) return invalid();
    start = Math.max(0, bytes.length - last); end = bytes.length - 1;
  } else {
    start = first; end = Math.min(last ?? bytes.length - 1, bytes.length - 1);
    if (start >= bytes.length || end < start) return invalid();
  }
  const body = bytes.subarray(start, end + 1);
  return { status: 206, body, headers: { ...headers, 'content-range': `bytes ${start}-${end}/${bytes.length}`, 'content-length': String(body.length) } };
}
