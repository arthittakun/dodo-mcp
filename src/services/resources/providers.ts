import fs from 'node:fs';
import { DodoError } from '../../errors.js';
import { decodeUtf8Strict } from '../../util/bytes.js';
import { loadSharpBackend } from '../multimodal/sharpBackend.js';
import type { ResourceMetadataData } from './contracts.js';

const MAX_IMAGE_PIXELS = 64 * 1024 * 1024;

export async function inspectResourceFile(file: string, mimeType: string): Promise<ResourceMetadataData> {
  if (['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mimeType)) {
    try {
      const sharp = await loadSharpBackend();
      const meta = await sharp(file, { limitInputPixels: MAX_IMAGE_PIXELS, sequentialRead: true, failOn: 'error' }).metadata();
      if (!meta.width || !meta.height) throw new Error('missing dimensions');
      return { width: meta.width, height: meta.height, ...(meta.format ? { format: meta.format } : {}) };
    } catch (error) {
      if (error instanceof DodoError) throw error;
      throw new DodoError('INVALID_INPUT', 'image decoder rejected corrupt or oversized image metadata');
    }
  }
  if (mimeType === 'application/zip') {
    return { entries: readZipEntries(file, 1).totalEntries, format: 'zip' };
  }
  if (mimeType === 'application/pdf') {
    const header = Buffer.alloc(16);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, header, 0, header.length, 0); } finally { fs.closeSync(fd); }
    const version = /^%PDF-(\d\.\d)/.exec(header.toString('ascii'))?.[1];
    if (!version) throw new DodoError('INVALID_INPUT', 'PDF header is corrupt');
    return { format: `pdf-${version}` };
  }
  if (mimeType === 'application/wasm') return { format: 'wasm' };
  return {};
}
export async function imagePreview(file: string, maxEdge: number): Promise<{ bytes: Buffer; mimeType: 'image/jpeg'; width: number; height: number }> {
  try {
    const sharp = await loadSharpBackend();
    const converted = await sharp(file, { limitInputPixels: MAX_IMAGE_PIXELS, sequentialRead: true, failOn: 'error' })
      .rotate()
      .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    if (converted.data.length > 6 * 1024 * 1024) throw new DodoError('RESOURCE_LIMIT', 'image preview exceeds the 6 MiB MCP block limit');
    return { bytes: converted.data, mimeType: 'image/jpeg', width: converted.info.width, height: converted.info.height };
  } catch (error) {
    if (error instanceof DodoError) throw error;
    throw new DodoError('INVALID_INPUT', 'image decoder rejected corrupt or oversized image content');
  }
}

export function readTextFile(file: string, bytes: number, maxBytes: number): { text: string; truncated: boolean } {
  if (bytes > maxBytes) throw new DodoError('FILE_TOO_LARGE', `text extraction is limited to ${maxBytes} bytes; use resource_read_range for bounded chunks`);
  const data = fs.readFileSync(file);
  const text = decodeUtf8Strict(data);
  if (text === undefined) throw new DodoError('UNSUPPORTED_ENCODING', 'resource is not valid UTF-8');
  return { text, truncated: false };
}

export interface ZipEntry {
  name: string;
  compressedBytes: number;
  uncompressedBytes: number;
  directory: boolean;
}

/** Parse ZIP central-directory metadata only. No entry is inflated or executed. */
export function readZipEntries(file: string, limit = 512): { entries: ZipEntry[]; totalEntries: number; truncated: boolean } {
  const stat = fs.statSync(file);
  const tailBytes = Math.min(stat.size, 65_557);
  const tail = Buffer.alloc(tailBytes);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, tail, 0, tail.length, stat.size - tail.length);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i -= 1) {
      if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0 || eocd + 22 > tail.length) throw new DodoError('INVALID_INPUT', 'ZIP central directory is missing or corrupt');
    const totalEntries = tail.readUInt16LE(eocd + 10);
    const centralBytes = tail.readUInt32LE(eocd + 12);
    const centralOffset = tail.readUInt32LE(eocd + 16);
    if (centralBytes > 4 * 1024 * 1024 || centralOffset + centralBytes > stat.size) throw new DodoError('RESOURCE_LIMIT', 'ZIP central directory exceeds the 4 MiB metadata limit');
    const central = Buffer.alloc(centralBytes);
    fs.readSync(fd, central, 0, central.length, centralOffset);
    const entries: ZipEntry[] = [];
    let offset = 0;
    for (let index = 0; index < totalEntries; index += 1) {
      if (offset + 46 > central.length || central.readUInt32LE(offset) !== 0x02014b50) throw new DodoError('INVALID_INPUT', 'ZIP central directory entry is corrupt');
      const compressedBytes = central.readUInt32LE(offset + 20);
      const uncompressedBytes = central.readUInt32LE(offset + 24);
      const nameBytes = central.readUInt16LE(offset + 28);
      const extraBytes = central.readUInt16LE(offset + 30);
      const commentBytes = central.readUInt16LE(offset + 32);
      const end = offset + 46 + nameBytes + extraBytes + commentBytes;
      if (end > central.length) throw new DodoError('INVALID_INPUT', 'ZIP central directory name is corrupt');
      if (entries.length < limit) {
        const rawName = central.subarray(offset + 46, offset + 46 + nameBytes);
        const name = decodeUtf8Strict(rawName);
        entries.push({
          name: name === undefined || name.includes('\0') ? '[non-UTF8 entry name]' : name.slice(0, 1024),
          compressedBytes,
          uncompressedBytes,
          directory: rawName.length > 0 && rawName[rawName.length - 1] === 0x2f,
        });
      }
      offset = end;
    }
    return { entries, totalEntries, truncated: totalEntries > entries.length };
  } finally { fs.closeSync(fd); }
}
