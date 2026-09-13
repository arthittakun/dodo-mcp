import { DodoError } from '../../errors.js';

/** Refuse multiplicative find/replace expansion BEFORE building the string. */
export function checkReplacementSize(text: string, find: string, replace: string, count: number, maxBytes: number, rel: string): void {
  const size = Buffer.byteLength(text, 'utf8') + count * (Buffer.byteLength(replace, 'utf8') - Buffer.byteLength(find, 'utf8'));
  if (size > maxBytes) throw new DodoError('FILE_TOO_LARGE', `replacement would exceed ${maxBytes} UTF-8 bytes`, {
    detail: { path: rel, bytes: size, maxBytes },
    recovery: 'Use a more specific match or split the change into smaller files; no file was written.',
  });
}
