import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { ensurePrivateDirectory, assertPrivatePath } from '../platform/privateFs.js';
import { renameWithRetry } from '../platform/fsRetry.js';
import { logLine } from '../security/redact.js';

const LOG_BYTES = 512 * 1024;
/** Bounded coalescing window for the on-disk tail. */
const FLUSH_INTERVAL_MS = 750;

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
  private flushTimer: NodeJS.Timeout | undefined;
  private pendingFlush = false;

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

  /**
   * Credential removal and the bounded in-memory tail happen synchronously, so
   * `read()` and the owner IPC are always current. The DISK write is coalesced:
   * rewriting the whole 512 KiB tail for every cloudflared line blocked the
   * event loop (on Windows `renameWithRetry` parks it with `Atomics.wait`),
   * which starved the readiness probe and made the tunnel status flap.
   */
  append(source: 'dodo' | 'stdout' | 'stderr', value: string): void {
    const withoutCredential = this.credential ? value.split(this.credential).join('[REDACTED_TUNNEL_TOKEN]') : value;
    const line = `${new Date().toISOString()} ${source} ${logLine(withoutCredential)}\n`;
    this.bytes = tailUtf8(Buffer.concat([this.bytes, Buffer.from(line, 'utf8')]), LOG_BYTES);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    this.pendingFlush = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => { this.flushTimer = undefined; this.flush(); }, FLUSH_INTERVAL_MS);
    this.flushTimer.unref?.();
  }

  /** Persist the bounded tail now. Safe to call repeatedly; used on shutdown. */
  flush(): void {
    if (!this.pendingFlush) return;
    this.pendingFlush = false;
    writePrivateAtomic(this.file, this.bytes);
  }

  close(): void {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = undefined; }
    this.flush();
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
