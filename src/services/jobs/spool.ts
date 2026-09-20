import fs from 'node:fs';
import path from 'node:path';
import { utf8SafeSlice } from '../../util/bytes.js';

/**
 * Bounded on-disk output spool (spec §13): segmented rolling window. Logical
 * byte offsets grow monotonically; when the cap is exceeded the OLDEST
 * segment is dropped and `truncatedBeforeOffset` reports the first retained
 * logical byte. No unbounded RAM, no silent loss.
 */
const SEGMENT_BYTES = 1024 * 1024;

export class SegmentedSpool {
  private segments: Array<{ index: number; startOffset: number; bytes: number }> = [];
  private nextIndex = 0;
  private writtenTotal = 0;
  private closed = false;

  constructor(
    private readonly dir: string,
    private readonly stream: 'stdout' | 'stderr',
    private readonly maxBytes: number,
  ) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  private segPath(index: number): string {
    return path.join(this.dir, `${this.stream}.${index}.log`);
  }

  write(chunk: Buffer): void {
    if (this.closed || chunk.length === 0) return;
    let cur = this.segments[this.segments.length - 1];
    if (!cur || cur.bytes >= SEGMENT_BYTES) {
      cur = { index: this.nextIndex, startOffset: this.writtenTotal, bytes: 0 };
      this.nextIndex += 1;
      this.segments.push(cur);
      fs.writeFileSync(this.segPath(cur.index), Buffer.alloc(0), { mode: 0o600 });
    }
    fs.appendFileSync(this.segPath(cur.index), chunk);
    cur.bytes += chunk.length;
    this.writtenTotal += chunk.length;
    // Enforce the cap by dropping oldest whole segments (never the newest).
    while (this.retainedBytes() > this.maxBytes && this.segments.length > 1) {
      const oldest = this.segments.shift() as { index: number };
      try {
        fs.unlinkSync(this.segPath(oldest.index));
      } catch {
        /* ignore */
      }
    }
  }

  private retainedBytes(): number {
    return this.segments.reduce((acc, s) => acc + s.bytes, 0);
  }

  get totalWritten(): number {
    return this.writtenTotal;
  }

  get truncatedBeforeOffset(): number {
    return this.segments.length > 0 ? (this.segments[0] as { startOffset: number }).startOffset : this.writtenTotal;
  }

  /** Read up to maxBytes starting at a logical offset, UTF-8 safe. */
  read(offset: number, maxBytes: number): { content: string; nextOffset: number; truncatedBeforeOffset: number; endOfStream: boolean } {
    const raw = this.readBytes(offset, maxBytes);
    const { bytes, end } = utf8SafeSlice(raw.bytes, 0, raw.bytes.length);
    const nextOffset = raw.nextOffset - raw.bytes.length + end;
    return { content: bytes.toString('utf8'), nextOffset, truncatedBeforeOffset: raw.truncatedBeforeOffset, endOfStream: this.closed && nextOffset >= this.writtenTotal };
  }

  /** Internal binary consumers must reject truncation before interpreting a tar or digest result. */
  readBytes(offset: number, maxBytes: number): { bytes: Buffer; nextOffset: number; truncatedBeforeOffset: number; endOfStream: boolean } {
    const from = Math.max(offset, this.truncatedBeforeOffset);
    const chunks: Buffer[] = [];
    let collected = 0;
    for (const seg of this.segments) {
      const segEnd = seg.startOffset + seg.bytes;
      if (segEnd <= from) continue;
      const segFrom = Math.max(from + collected, seg.startOffset) - seg.startOffset;
      const want = Math.min(seg.bytes - segFrom, maxBytes - collected);
      if (want <= 0) break;
      const fd = fs.openSync(this.segPath(seg.index), 'r');
      try {
        const buf = Buffer.alloc(want);
        const got = fs.readSync(fd, buf, 0, want, segFrom);
        chunks.push(buf.subarray(0, got));
        collected += got;
      } finally {
        fs.closeSync(fd);
      }
      if (collected >= maxBytes) break;
    }
    const raw = Buffer.concat(chunks);
    const nextOffset = from + raw.length;
    return {
      bytes: raw,
      nextOffset,
      truncatedBeforeOffset: this.truncatedBeforeOffset,
      endOfStream: this.closed && nextOffset >= this.writtenTotal,
    };
  }

  close(): void {
    this.closed = true;
  }

  removeFiles(): void {
    for (const seg of this.segments) {
      try {
        fs.unlinkSync(this.segPath(seg.index));
      } catch {
        /* ignore */
      }
    }
    this.segments = [];
  }
}
