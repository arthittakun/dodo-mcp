import { createTwoFilesPatch } from 'diff';
import { DodoError } from '../../errors.js';
import type { WorkspaceFS } from '../../workspace/fs.js';
import type { Limits } from '../../config/limits.js';
import type { Store, TrustMode } from '../../store/store.js';
import { sha256Bytes, digestOf, newId } from '../../util/hash.js';
import { truncateUtf8, decodeUtf8Strict, looksBinary } from '../../util/bytes.js';
import type { AnyPlanOp, PlanFileChange, PlanPreviewResult, StoredPlan } from './types.js';
import { checkReplacementSize } from './contentBudget.js';

/**
 * preview_changes / preview_rename plan builder (spec §12.1): validates every
 * path/size/encoding through the shared policy, computes raw-byte before
 * hashes and full after content, produces a bounded unified diff, and stores
 * an immutable plan. The workspace is NEVER modified here.
 */
export class Planner {
  constructor(
    private readonly wfs: WorkspaceFS,
    private readonly limits: Limits,
    private readonly store: Store,
  ) {}

  preview(opts: {
    ops: AnyPlanOp[];
    workspaceId: string;
    epoch: string;
    principal: string;
    trustMode: TrustMode;
    source: StoredPlan['source'];
  }): PlanPreviewResult {
    const { ops } = opts;
    if (ops.length === 0) throw new DodoError('INVALID_INPUT', 'plan has no operations');
    if (ops.length > this.limits.previewFilesMax) {
      throw new DodoError('RESOURCE_LIMIT', `plan exceeds ${this.limits.previewFilesMax} operations`);
    }
    const touched = new Set<string>();
    const claim = (rel: string) => {
      const key = process.platform === 'win32' ? rel.toLowerCase() : rel;
      if (touched.has(key)) throw new DodoError('CONFLICT', `multiple operations touch the same path`, { detail: { path: rel } });
      touched.add(key);
    };

    const files: PlanFileChange[] = [];
    let aggregate = 0;
    for (const op of ops) {
      const change = this.buildChange(op);
      claim(change.path);
      if (change.destPath) claim(change.destPath);
      aggregate += change.bytesAfter;
      if (aggregate > this.limits.previewAggregateBytes) {
        throw new DodoError('RESOURCE_LIMIT', `plan content exceeds ${this.limits.previewAggregateBytes} bytes aggregate; split into multiple changesets`);
      }
      files.push(change);
    }

    const creates = files.filter((f) => f.action === 'create').length;
    const deletes = files.filter((f) => f.action === 'delete').length;
    const modifies = files.length - creates - deletes;
    const summary = `${creates} create, ${modifies} modify/move, ${deletes} delete`;
    const risk: PlanPreviewResult['risk'] = deletes > 0 ? 'high' : modifies > 0 ? 'medium' : 'low';

    const stored: StoredPlan = {
      version: 1,
      workspaceId: opts.workspaceId,
      epoch: opts.epoch,
      principal: opts.principal,
      source: opts.source,
      files,
      summary,
    };
    const payload = JSON.stringify(stored);
    const planId = newId('plan');
    const planHash = digestOf({ planId, payload });
    this.store.putPlan({
      id: planId,
      workspaceId: opts.workspaceId,
      epoch: opts.epoch,
      principal: opts.principal,
      planHash,
      payload,
      ttlMs: this.limits.planExpiryMs,
    });
    return {
      planId,
      planHash,
      expiresAt: Date.now() + this.limits.planExpiryMs,
      summary,
      risk,
      requiresApproval: opts.trustMode === 'inspect',
      files: files.map((f) => {
        const out: PlanPreviewResult['files'][number] = {
          path: f.path,
          action: f.action,
          beforeHash: f.beforeHash,
          afterHash: f.afterHash,
          diff: f.diff,
          diffTruncated: f.diffTruncated,
          bytesBefore: f.bytesBefore,
          bytesAfter: f.bytesAfter,
        };
        if (f.destPath !== undefined) out.destPath = f.destPath;
        return out;
      }),
    };
  }

  private buildChange(op: AnyPlanOp): PlanFileChange {
    switch (op.op) {
      case 'create': {
        const createParents = op.createParents === true;
        const { rel, missingParents } = this.wfs.resolveForCreate(op.path, createParents);
        const bytes = Buffer.from(op.content, 'utf8');
        this.checkContentSize(rel, bytes.length);
        const change: PlanFileChange = {
          path: rel,
          action: 'create',
          beforeHash: null,
          afterHash: sha256Bytes(bytes),
          afterContentB64: bytes.toString('base64'),
          ...this.boundedDiff(rel, '', op.content),
          bytesBefore: 0,
          bytesAfter: bytes.length,
        };
        if (missingParents.length > 0) change.createParents = missingParents;
        return change;
      }
      case 'replace_file': {
        const current = this.readCurrent(op.path, op.expectedHash);
        const bytes = Buffer.from(op.content, 'utf8');
        this.checkContentSize(current.rel, bytes.length);
        return {
          path: current.rel,
          action: 'modify',
          beforeHash: current.hash,
          afterHash: sha256Bytes(bytes),
          afterContentB64: bytes.toString('base64'),
          mode: current.mode,
          ...this.boundedDiff(current.rel, current.text ?? '<binary>', op.content),
          bytesBefore: current.size,
          bytesAfter: bytes.length,
        };
      }
      case 'replace_exact': {
        const current = this.readCurrent(op.path, op.expectedHash);
        if (current.text === undefined) {
          throw new DodoError('UNSUPPORTED_ENCODING', 'replace_exact requires a UTF-8 text file', { detail: { path: current.rel } });
        }
        if (op.find.length === 0) throw new DodoError('INVALID_INPUT', 'find must not be empty');
        const expected = op.expectedCount ?? 1;
        const count = countOccurrences(current.text, op.find);
        if (count !== expected) {
          throw new DodoError('AMBIGUOUS_EDIT', `expected ${expected} occurrence(s) of the target text, found ${count}`, {
            detail: { path: current.rel, expected, found: count },
            recovery: 'read the file again and provide a more specific target or the correct expectedCount',
          });
        }
        checkReplacementSize(current.text, op.find, op.replace, count, this.limits.readFileBytes, current.rel);
        const next = current.text.replaceAll(op.find, () => op.replace);
        const bytes = Buffer.from(next, 'utf8');
        this.checkContentSize(current.rel, bytes.length);
        return {
          path: current.rel,
          action: 'modify',
          beforeHash: current.hash,
          afterHash: sha256Bytes(bytes),
          afterContentB64: bytes.toString('base64'),
          mode: current.mode,
          ...this.boundedDiff(current.rel, current.text, next),
          bytesBefore: current.size,
          bytesAfter: bytes.length,
        };
      }
      case 'span_edit': {
        const current = this.readCurrent(op.path, undefined);
        if (current.text === undefined) {
          throw new DodoError('UNSUPPORTED_ENCODING', 'span edits require a UTF-8 text file', { detail: { path: current.rel } });
        }
        const buf = Buffer.from(current.text, 'utf8');
        const sorted = [...op.edits].sort((a, b) => a.start - b.start);
        for (let i = 1; i < sorted.length; i += 1) {
          if ((sorted[i] as { start: number }).start < (sorted[i - 1] as { end: number }).end) {
            throw new DodoError('CONFLICT', 'overlapping edit spans', { detail: { path: current.rel } });
          }
        }
        let out = '';
        let cursor = 0;
        for (const e of sorted) {
          if (e.start < 0 || e.end > buf.length || e.end < e.start) {
            throw new DodoError('INVALID_INPUT', 'edit span out of bounds', { detail: { path: current.rel } });
          }
          out += buf.subarray(cursor, e.start).toString('utf8') + e.newText;
          cursor = e.end;
        }
        out += buf.subarray(cursor).toString('utf8');
        const bytes = Buffer.from(out, 'utf8');
        this.checkContentSize(current.rel, bytes.length);
        return {
          path: current.rel,
          action: 'modify',
          beforeHash: current.hash,
          afterHash: sha256Bytes(bytes),
          afterContentB64: bytes.toString('base64'),
          mode: current.mode,
          ...this.boundedDiff(current.rel, current.text, out),
          bytesBefore: current.size,
          bytesAfter: bytes.length,
        };
      }
      case 'delete': {
        const current = this.readCurrent(op.path, op.expectedHash);
        return {
          path: current.rel,
          action: 'delete',
          beforeHash: current.hash,
          afterHash: null,
          mode: current.mode,
          ...this.boundedDiff(current.rel, current.text ?? '<binary>', ''),
          bytesBefore: current.size,
          bytesAfter: 0,
        };
      }
      case 'move': {
        const current = this.readCurrent(op.path, op.expectedHash);
        const dest = this.wfs.resolveForCreate(op.destPath, false);
        return {
          path: current.rel,
          destPath: dest.rel,
          action: 'move',
          beforeHash: current.hash,
          afterHash: current.hash,
          mode: current.mode,
          diff: `rename ${current.rel} -> ${dest.rel}`,
          diffTruncated: false,
          bytesBefore: current.size,
          bytesAfter: current.size,
        };
      }
    }
  }

  private readCurrent(path: string, expectedHash: string | undefined): { rel: string; hash: string; text: string | undefined; size: number; mode: number } {
    const { rel, bytes, stat } = this.wfs.readFileBytes(path, this.limits.readFileBytes);
    const hash = sha256Bytes(bytes);
    if (expectedHash !== undefined && expectedHash !== hash) {
      throw new DodoError('FILE_CHANGED', 'file content does not match expectedHash', {
        detail: { path: rel, expectedHash, actualHash: hash },
        recovery: 'read the file again to get its current content and hash',
      });
    }
    const text = looksBinary(bytes) ? undefined : decodeUtf8Strict(bytes);
    return { rel, hash, text, size: stat.size, mode: stat.mode & 0o777 };
  }

  private checkContentSize(rel: string, size: number): void {
    if (size > this.limits.readFileBytes) {
      throw new DodoError('FILE_TOO_LARGE', `resulting file would exceed ${this.limits.readFileBytes} bytes`, {
        detail: { path: rel, bytes: size, maxBytes: this.limits.readFileBytes },
        recovery: 'Split the source into smaller files. The local owner can run dodo limits --profile large and restart DODO.',
      });
    }
  }

  private boundedDiff(rel: string, before: string, after: string): { diff: string; diffTruncated: boolean } {
    // A capped output string alone does not bound the cost of building a diff.
    // Large content still gets full hashes/backups, without an unbounded diff.
    if (Buffer.byteLength(before, 'utf8') + Buffer.byteLength(after, 'utf8') > 2 * 1024 * 1024) {
      return { diff: '<diff omitted for large content; review bounded file ranges and before/after hashes>', diffTruncated: true };
    }
    let patch: string | undefined;
    try {
      patch = createTwoFilesPatch(`a/${rel}`, `b/${rel}`, before, after, undefined, undefined, { context: 3, timeout: 250, maxEditLength: 10000 });
    } catch {
      return { diff: '<diff unavailable>', diffTruncated: true };
    }
    if (patch === undefined) return { diff: '<diff exceeded computation budget; review bounded file ranges and before/after hashes>', diffTruncated: true };
    const budget = Math.min(16 * 1024, this.limits.toolContentBytes);
    const { text, truncated } = truncateUtf8(patch, budget);
    return { diff: text, diffTruncated: truncated };
  }
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let idx = 0;
  for (;;) {
    idx = haystack.indexOf(needle, idx);
    if (idx === -1) return count;
    count += 1;
    idx += needle.length;
  }
}
