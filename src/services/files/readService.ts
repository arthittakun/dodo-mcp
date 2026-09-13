import { DodoError } from '../../errors.js';
import type { WorkspaceFS } from '../../workspace/fs.js';
import type { Limits } from '../../config/limits.js';
import { truncateUtf8 } from '../../util/bytes.js';

/**
 * read_files / list_files service (spec §10.3): raw-byte SHA-256, 1-based
 * lines, explicit truncation, typed binary/encoding errors, batch and output
 * budgets.
 */
export interface ReadItemRequest {
  path: string;
  startLine?: number | undefined;
  endLine?: number | undefined;
  /** Prefix each line with its 1-based number (`cat -n` style) for precise references. */
  numbered?: boolean | undefined;
}

export interface ReadItemResult {
  path: string;
  content: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  partial: boolean;
  truncated: boolean;
  hash: string; // sha256 of the WHOLE file's raw bytes
  size: number;
  encoding: 'utf-8';
}

export interface ReadItemError {
  path: string;
  error: { code: string; message: string };
}

export class ReadService {
  constructor(
    private readonly wfs: WorkspaceFS,
    private readonly limits: Limits,
  ) {}

  readBatch(items: ReadItemRequest[]): { files: ReadItemResult[]; errors: ReadItemError[]; truncated: boolean } {
    if (items.length > this.limits.readBatchMax) {
      throw new DodoError('RESOURCE_LIMIT', `read batch exceeds ${this.limits.readBatchMax} items`);
    }
    const files: ReadItemResult[] = [];
    const errors: ReadItemError[] = [];
    let budget = Math.max(8 * 1024, this.limits.toolContentBytes - 8 * 1024); // envelope overhead reserve
    let truncatedAny = false;
    for (const item of items) {
      try {
        const { rel, text, hash, stat } = this.wfs.readTextFile(item.path, this.limits.readFileBytes);
        const lines = text.split('\n');
        const totalLines = lines.length;
        const start = Math.max(1, item.startLine ?? 1);
        const end = Math.min(totalLines, item.endLine ?? totalLines);
        if (start > totalLines || end < start) {
          errors.push({ path: rel, error: { code: 'INVALID_INPUT', message: `line range ${start}-${item.endLine ?? end} out of bounds (file has ${totalLines} lines)` } });
          continue;
        }
        const picked = lines.slice(start - 1, end);
        const slice = item.numbered ? picked.map((l, i) => `${String(start + i).padStart(6, ' ')}\t${l}`).join('\n') : picked.join('\n');
        const perItemCap = Math.min(budget, this.limits.toolContentBytes);
        const { text: content, truncated } = truncateUtf8(slice, perItemCap);
        // Recompute the actual end line delivered when truncated.
        let deliveredEnd = end;
        if (truncated) {
          deliveredEnd = start + (content.split('\n').length - 1);
          truncatedAny = true;
        }
        budget -= Buffer.byteLength(content, 'utf8');
        files.push({
          path: rel,
          content,
          startLine: start,
          endLine: deliveredEnd,
          totalLines,
          partial: start > 1 || deliveredEnd < totalLines,
          truncated,
          hash,
          size: stat.size,
          encoding: 'utf-8',
        });
        if (budget <= 0) {
          truncatedAny = true;
          const remaining = items.slice(items.indexOf(item) + 1);
          for (const r of remaining) {
            errors.push({ path: safeRel(this.wfs, r.path), error: { code: 'RESOURCE_LIMIT', message: 'output budget exhausted; request this file separately' } });
          }
          break;
        }
      } catch (err) {
        const je = err instanceof DodoError ? err : new DodoError('INTERNAL_ERROR', 'read failed');
        errors.push({ path: safeRel(this.wfs, item.path), error: { code: je.code, message: je.message } });
      }
    }
    return { files, errors, truncated: truncatedAny };
  }
}

function safeRel(wfs: WorkspaceFS, p: string): string {
  try {
    return wfs.normalizeRel(p);
  } catch {
    return typeof p === 'string' ? p.slice(0, 200) : '<invalid>';
  }
}

export interface TreeEntry {
  path: string;
  type: 'file' | 'dir';
  size?: number;
  children?: TreeEntry[];
  truncated?: boolean;
}

export class ListService {
  constructor(
    private readonly wfs: WorkspaceFS,
    private readonly limits: Limits,
  ) {}

  /** Bounded tree listing. Depth/entry caps are explicit in the result. */
  tree(startPath: string, opts: { depth?: number; includeIgnored?: boolean; maxEntries?: number }): { root: TreeEntry; entryCount: number; truncated: boolean } {
    const depth = Math.min(opts.depth ?? this.limits.treeDepthDefault, 10);
    const maxEntries = Math.min(opts.maxEntries ?? this.limits.treeEntriesMax, this.limits.treeEntriesMax);
    const includeIgnored = opts.includeIgnored ?? false;
    const start = this.wfs.resolve(startPath);
    if (!start.stat?.isDirectory()) throw new DodoError('PATH_DENIED', 'not a directory', { detail: { path: start.rel } });
    let count = 0;
    let truncated = false;
    const build = (rel: string, level: number): TreeEntry[] => {
      if (level >= depth) return [];
      const out: TreeEntry[] = [];
      let entries;
      try {
        entries = this.wfs.listDir(rel);
      } catch {
        return out;
      }
      for (const e of entries) {
        if (e.stat.isSymbolicLink()) continue;
        const isDir = e.stat.isDirectory();
        if (!isDir && !e.stat.isFile()) continue;
        const cls = this.wfs.ignores.classify(e.rel, isDir, includeIgnored);
        if (cls !== 'ok') continue;
        if (count >= maxEntries) {
          truncated = true;
          return out;
        }
        count += 1;
        if (isDir) {
          const entry: TreeEntry = { path: e.rel, type: 'dir' };
          const children = build(e.rel, level + 1);
          if (children.length > 0) entry.children = children;
          out.push(entry);
        } else {
          out.push({ path: e.rel, type: 'file', size: e.stat.size });
        }
      }
      return out;
    };
    const rootEntry: TreeEntry = { path: start.rel, type: 'dir', children: build(start.rel, 0) };
    return { root: rootEntry, entryCount: count, truncated };
  }
}
