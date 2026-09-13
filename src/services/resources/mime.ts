import path from 'node:path';
import { decodeUtf8Strict, looksBinary } from '../../util/bytes.js';

const TEXT_EXTENSIONS: Record<string, string> = {
  '.txt': 'text/plain', '.md': 'text/markdown', '.html': 'text/html', '.htm': 'text/html',
  '.css': 'text/css', '.csv': 'text/csv', '.ts': 'text/typescript', '.tsx': 'text/typescript',
  '.js': 'text/javascript', '.jsx': 'text/javascript', '.mjs': 'text/javascript', '.cjs': 'text/javascript',
  '.py': 'text/x-python', '.rs': 'text/x-rust', '.go': 'text/x-go', '.java': 'text/x-java',
  '.yaml': 'application/yaml', '.yml': 'application/yaml', '.toml': 'application/toml',
};

export interface SniffedType {
  mimeType: string;
  family: 'text' | 'image' | 'audio' | 'video' | 'pdf' | 'archive' | 'wasm' | 'binary';
}

function starts(bytes: Buffer, signature: number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

/** Content-first MIME detection. An extension may refine valid UTF-8 text only. */
export function sniffType(bytes: Buffer, sourceLabel = ''): SniffedType {
  if (starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { mimeType: 'image/png', family: 'image' };
  if (starts(bytes, [0xff, 0xd8, 0xff])) return { mimeType: 'image/jpeg', family: 'image' };
  if (bytes.subarray(0, 6).toString('ascii') === 'GIF87a' || bytes.subarray(0, 6).toString('ascii') === 'GIF89a') return { mimeType: 'image/gif', family: 'image' };
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return { mimeType: 'image/webp', family: 'image' };
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WAVE') return { mimeType: 'audio/wav', family: 'audio' };
  if (bytes.subarray(0, 3).toString('ascii') === 'ID3' || (bytes.length > 1 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0)) return { mimeType: 'audio/mpeg', family: 'audio' };
  if (bytes.subarray(0, 4).toString('ascii') === '%PDF') return { mimeType: 'application/pdf', family: 'pdf' };
  if (starts(bytes, [0x50, 0x4b, 0x03, 0x04]) || starts(bytes, [0x50, 0x4b, 0x05, 0x06]) || starts(bytes, [0x50, 0x4b, 0x07, 0x08])) return { mimeType: 'application/zip', family: 'archive' };
  if (starts(bytes, [0x00, 0x61, 0x73, 0x6d])) return { mimeType: 'application/wasm', family: 'wasm' };
  if (starts(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return { mimeType: 'video/webm', family: 'video' };
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString('ascii') === 'ftyp') return { mimeType: 'video/mp4', family: 'video' };

  if (!looksBinary(bytes)) {
    const text = decodeUtf8Strict(bytes);
    if (text !== undefined) {
      const trimmed = text.replace(/^\uFEFF/, '').trimStart();
      if (/^<svg(?:\s|>)/i.test(trimmed) || /^<\?xml[\s\S]{0,300}<svg(?:\s|>)/i.test(trimmed)) return { mimeType: 'image/svg+xml', family: 'text' };
      if ((trimmed.startsWith('{') || trimmed.startsWith('['))) {
        try { JSON.parse(trimmed); return { mimeType: 'application/json', family: 'text' }; } catch { /* plain text */ }
      }
      if (/^<\?xml(?:\s|>)/i.test(trimmed)) return { mimeType: 'application/xml', family: 'text' };
      return { mimeType: TEXT_EXTENSIONS[path.extname(sourceLabel).toLowerCase()] ?? 'text/plain', family: 'text' };
    }
  }
  return { mimeType: 'application/octet-stream', family: 'binary' };
}

export function isTextMime(mimeType: string): boolean {
  return mimeType.startsWith('text/') || ['application/json', 'application/xml', 'application/yaml', 'application/toml', 'image/svg+xml'].includes(mimeType);
}

export function resourceFamily(mimeType: string): SniffedType['family'] {
  if (isTextMime(mimeType)) return 'text';
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType === 'application/pdf') return 'pdf';
  if (mimeType === 'application/zip') return 'archive';
  if (mimeType === 'application/wasm') return 'wasm';
  return 'binary';
}
