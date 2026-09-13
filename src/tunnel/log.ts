import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { ensurePrivateDirectory, assertPrivatePath } from '../platform/privateFs.js';
import { renameWithRetry } from '../platform/fsRetry.js';
import { logLine } from '../security/redact.js';

const LOG_BYTES = 512 * 1024;

function tailUtf8(input: Buffer, limit: number): Buffer {
  if (input.length <= limit) return input;
  let start = input.length - limit;
  while (start < input.length && (input[start]! & 0xc0) === 0x80) start++;
  return input.subarray(start);
}

function writePrivateAtomic(file: string, bytes: Buffer<ArrayBufferLike>): void {
  try { assertPrivatePath(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const temporary = path.join(path.dirname(file), `.tunnel-log-${randomBytes(12).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx' });
    renameWithRetry(temporary, file);
    if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
  } finally { try { fs.unlinkSync(temporary); } catch { /* renamed or absent */ } }
}

/** Private bounded tunnel diagnostics. Exact credential removal happens before
 * generic redaction and before any byte reaches disk or the owner terminal. */
export class TunnelLog {
  readonly file: string;
  private bytes: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  constructor(directory: string, private readonly credential?: string) {
    ensurePrivateDirectory(directory);
    this.file = path.join(directory, 'cloudflared.log');
    try {
      assertPrivatePath(this.file);
      this.bytes = tailUtf8(fs.readFileSync(this.file), LOG_BYTES);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  append(source: 'dodo' | 'stdout' | 'stderr', value: string): void {
    const withoutCredential = this.credential ? value.split(this.credential).join('[REDACTED_TUNNEL_TOKEN]') : value;
    const line = `${new Date().toISOString()} ${source} ${logLine(withoutCredential)}\n`;
    this.bytes = tailUtf8(Buffer.concat([this.bytes, Buffer.from(line, 'utf8')]), LOG_BYTES);
    writePrivateAtomic(this.file, this.bytes);
  }

  read(lineLimit = 200): { lines: string[]; truncated: boolean } {
    const all = this.bytes.toString('utf8').split(/\r?\n/).filter(Boolean);
    const limit = Math.max(1, Math.min(500, Math.trunc(lineLimit)));
    return { lines: all.slice(-limit), truncated: all.length > limit || this.bytes.length >= LOG_BYTES };
  }
}

export function readTunnelLog(directory: string, lineLimit = 200): { lines: string[]; truncated: boolean } {
  const file = path.join(directory, 'cloudflared.log');
  try {
    assertPrivatePath(file);
    const bytes = tailUtf8(fs.readFileSync(file), LOG_BYTES);
    const all = bytes.toString('utf8').split(/\r?\n/).filter(Boolean);
    const limit = Math.max(1, Math.min(500, Math.trunc(lineLimit)));
    return { lines: all.slice(-limit), truncated: all.length > limit || bytes.length >= LOG_BYTES };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { lines: [], truncated: false };
    throw error;
  }
}
