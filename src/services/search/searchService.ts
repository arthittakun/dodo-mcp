import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import picomatch from 'picomatch';
import { DodoError } from '../../errors.js';
import type { WorkspaceFS } from '../../workspace/fs.js';
import type { Limits } from '../../config/limits.js';
import { decodeUtf8Strict, looksBinary } from '../../util/bytes.js';
import { digestOf, newId } from '../../util/hash.js';
import { buildChildEnv } from '../../security/env.js';
import { resolveTrustedExecutable } from '../../platform/execResolve.js';
import { assertWindowsArgv } from '../../platform/shell.js';
import { signalOwnedProcess } from '../../platform/processTree.js';

/**
 * search_code (spec §10.3), Claude-Code-Grep-class:
 * - literal (default) or regex; case-insensitive option; file glob filter;
 *   context lines before/after; output modes content | files | count.
 * - ripgrep (finite-automaton, linear-time) is used when available on the
 *   trusted PATH; otherwise literal runs in-process and regex runs in a
 *   worker thread that is TERMINATED on timeout (no event-loop hang).
 * - the pattern is passed via argv (`-e PATTERN`), never through a shell.
 * - pagination cursors are opaque, server-minted, bound to query digest,
 *   principal and epoch, with expiry; deterministic candidate order makes a
 *   skip-based continuation exact.
 */
export interface SearchMatch {
  path: string;
  line: number; // 1-based
  column: number; // 1-based UTF-16 code units
  lineText: string;
  before?: string[];
  after?: string[];
}

export interface SearchResult {
  matches: SearchMatch[];
  files: Array<{ path: string; matches: number }>;
  totalMatches: number;
  backend: 'ripgrep' | 'js';
  filesScanned: number;
  truncated: boolean;
  nextCursor?: string;
}

interface CursorEntry {
  queryDigest: string;
  principal: string;
  epoch: string;
  skipMatches: number;
  expiresAt: number;
}

const CURSOR_TTL_MS = 5 * 60 * 1000;
const MAX_PATTERN_LENGTH = 512;
const MAX_LINE_SNIPPET = 500;
// A tool path is at most 1024 characters; 16 paths fit Windows native argv.
const RG_BATCH = process.platform === 'win32' ? 16 : 200;
const MAX_CANDIDATES = 20000;

export interface SearchQuery {
  query: string;
  mode: 'literal' | 'regex';
  caseSensitive: boolean;
  paths?: string[];
  fileGlob?: string;
  includeIgnored: boolean;
  maxResults: number;
  contextBefore: number;
  contextAfter: number;
  outputMode: 'content' | 'files' | 'count';
}

interface RawMatch extends SearchMatch {
  before: string[];
  after: string[];
}

export class SearchService {
  private cursors = new Map<string, CursorEntry>();
  private rgAvailableCache: boolean | undefined;

  constructor(
    private readonly wfs: WorkspaceFS,
    private readonly limits: Limits,
    private readonly backendConfig: 'auto' | 'js',
  ) {}

  /** ripgrep resolved from the trusted PATH only — never from the repo. */
  rgAvailable(): boolean {
    if (this.rgAvailableCache !== undefined) return this.rgAvailableCache;
    if (this.backendConfig === 'js') {
      this.rgAvailableCache = false;
      return false;
    }
    const env = buildChildEnv({ parentEnv: process.env, workspaceRoot: this.wfs.root, extraAllowlist: [] });
    try {
      const executable = resolveTrustedExecutable('rg', this.wfs.root, { allowBatch: false });
      const probe = spawnSync(executable, ['--version'], { env, shell: false, windowsHide: true, timeout: 3000 });
      this.rgAvailableCache = probe.status === 0;
    } catch { this.rgAvailableCache = false; }
    return this.rgAvailableCache;
  }

  /** Regex without ripgrep runs in a worker; available when the compiled worker exists. */
  private workerPath(): string | undefined {
    for (const url of [new URL('./searchWorker.js', import.meta.url), new URL('../../../dist/services/search/searchWorker.js', import.meta.url)]) {
      try {
        const p = fileURLToPath(url);
        if (fs.existsSync(p)) return p;
      } catch {
        /* next */
      }
    }
    return undefined;
  }

  async search(q: SearchQuery, ctx: { principal: string; epoch: string; cursor?: string }): Promise<SearchResult> {
    if (q.query.length === 0) throw new DodoError('INVALID_INPUT', 'query must not be empty');
    if (q.query.length > MAX_PATTERN_LENGTH) throw new DodoError('INVALID_INPUT', `query exceeds ${MAX_PATTERN_LENGTH} chars`);
    const maxResults = Math.min(q.maxResults, this.limits.searchResultsMax);
    const queryDigest = digestOf({
      q: q.query,
      mode: q.mode,
      cs: q.caseSensitive,
      paths: q.paths ?? null,
      glob: q.fileGlob ?? null,
      ii: q.includeIgnored,
      cb: q.contextBefore,
      ca: q.contextAfter,
      om: q.outputMode,
    });

    let skip = 0;
    if (ctx.cursor !== undefined) {
      const entry = this.cursors.get(ctx.cursor);
      this.cursors.delete(ctx.cursor); // single-use
      if (!entry || entry.expiresAt < Date.now()) {
        throw new DodoError('NOT_FOUND', 'cursor expired or unknown; rerun the search', { retryable: true });
      }
      if (entry.queryDigest !== queryDigest || entry.principal !== ctx.principal || entry.epoch !== ctx.epoch) {
        throw new DodoError('FORBIDDEN', 'cursor does not belong to this query/principal');
      }
      skip = entry.skipMatches;
    }

    const useRg = this.rgAvailable();
    const workerPath = q.mode === 'regex' && !useRg ? this.workerPath() : undefined;
    if (q.mode === 'regex' && !useRg && workerPath === undefined) {
      throw new DodoError('NOT_SUPPORTED', 'regex search needs ripgrep or the compiled search worker; neither is available on this install', {
        recovery: 'install ripgrep (rg), run `npm run build`, or use literal mode',
      });
    }

    // Policy-validated candidate list (deterministic order), optionally glob-filtered.
    let globMatch: ((p: string) => boolean) | undefined;
    let globBasename = false;
    if (q.fileGlob !== undefined) {
      try {
        globMatch = picomatch(q.fileGlob, { dot: true });
      } catch {
        throw new DodoError('INVALID_INPUT', 'invalid fileGlob pattern');
      }
      globBasename = !q.fileGlob.includes('/');
    }
    const startRels = (q.paths?.length ? q.paths : ['.']).map((p) => this.wfs.normalizeRel(p));
    const candidates: string[] = [];
    const seen = new Set<string>();
    const accept = (rel: string): boolean => {
      if (seen.has(rel)) return false;
      if (globMatch && !(globBasename ? globMatch(path.posix.basename(rel)) || globMatch(rel) : globMatch(rel))) return false;
      seen.add(rel);
      return true;
    };
    for (const startRel of startRels) {
      const resolved = this.wfs.resolve(startRel);
      if (resolved.stat?.isFile()) {
        const cls = this.wfs.ignores.classify(resolved.rel, false, q.includeIgnored);
        if (cls === 'ok' && accept(resolved.rel)) candidates.push(resolved.rel);
        continue;
      }
      for (const f of this.wfs.walk({ startRel, includeIgnored: q.includeIgnored, maxEntries: MAX_CANDIDATES })) {
        if (f.stat.size > this.limits.readFileBytes) continue;
        if (accept(f.rel)) candidates.push(f.rel);
        if (candidates.length >= MAX_CANDIDATES) break;
      }
    }

    const deadline = Date.now() + this.limits.searchTimeoutMs;
    const collected: RawMatch[] = [];
    let filesScanned = 0;
    let truncated = false;
    let matchIndex = 0;
    // files/count modes need every match counted, so they collect more cheaply.
    const collectAll = q.outputMode !== 'content';
    const hardCap = collectAll ? Math.max(maxResults, 5000) : maxResults;
    const record = (m: RawMatch): boolean => {
      matchIndex += 1;
      if (matchIndex <= skip) return true;
      if (collected.length < hardCap) {
        collected.push(m);
        return true;
      }
      truncated = true;
      return false;
    };

    if (useRg) {
      outer: for (let i = 0; i < candidates.length; i += RG_BATCH) {
        if (Date.now() > deadline) {
          truncated = true;
          break;
        }
        const batch = candidates.slice(i, i + RG_BATCH);
        filesScanned += batch.length;
        const matches = await this.runRipgrep(q, batch, Math.max(deadline - Date.now(), 500));
        for (const m of matches) if (!record(m)) break outer;
      }
    } else if (q.mode === 'regex') {
      const res = await this.runRegexWorker(workerPath as string, q, candidates, skip, hardCap, Math.max(deadline - Date.now(), 500));
      filesScanned = res.filesScanned;
      truncated = res.truncated;
      for (const m of res.matches) collected.push(m);
      matchIndex = skip + collected.length + (res.truncated ? 1 : 0);
    } else {
      const needle = q.caseSensitive ? q.query : q.query.toLowerCase();
      let sinceYield = 0;
      outer2: for (const rel of candidates) {
        if (Date.now() > deadline) {
          truncated = true;
          break;
        }
        sinceYield += 1;
        if (sinceYield >= 20) {
          sinceYield = 0;
          await new Promise((r) => setImmediate(r)); // keep the event loop responsive
        }
        filesScanned += 1;
        let text: string | undefined;
        try {
          const { bytes } = this.wfs.readFileBytes(rel, this.limits.readFileBytes);
          if (looksBinary(bytes)) continue;
          text = decodeUtf8Strict(bytes);
        } catch {
          continue;
        }
        if (text === undefined) continue;
        const lines = text.split('\n');
        for (let ln = 0; ln < lines.length; ln += 1) {
          const line = lines[ln] as string;
          const hay = q.caseSensitive ? line : line.toLowerCase();
          let col = hay.indexOf(needle);
          while (col !== -1) {
            const ok = record({
              path: rel,
              line: ln + 1,
              column: col + 1,
              lineText: cutLine(line),
              before: lines.slice(Math.max(0, ln - q.contextBefore), ln).map(cutLine),
              after: lines.slice(ln + 1, ln + 1 + q.contextAfter).map(cutLine),
            });
            if (!ok) break outer2;
            col = hay.indexOf(needle, col + Math.max(needle.length, 1));
          }
        }
      }
    }

    const perFile = new Map<string, number>();
    for (const m of collected) perFile.set(m.path, (perFile.get(m.path) ?? 0) + 1);
    const files = [...perFile.entries()].map(([p, n]) => ({ path: p, matches: n }));
    const contentMatches: SearchMatch[] =
      q.outputMode === 'content'
        ? collected.map((m) => {
            const out: SearchMatch = { path: m.path, line: m.line, column: m.column, lineText: m.lineText };
            if (q.contextBefore > 0) out.before = m.before;
            if (q.contextAfter > 0) out.after = m.after;
            return out;
          })
        : [];

    const result: SearchResult = {
      matches: contentMatches,
      files,
      totalMatches: collected.length,
      backend: useRg ? 'ripgrep' : 'js',
      filesScanned,
      truncated,
    };
    if (truncated && q.outputMode === 'content') {
      const cursorId = newId('cur');
      this.cursors.set(cursorId, {
        queryDigest,
        principal: ctx.principal,
        epoch: ctx.epoch,
        skipMatches: skip + collected.length,
        expiresAt: Date.now() + CURSOR_TTL_MS,
      });
      this.sweepCursors();
      result.nextCursor = cursorId;
    }
    return result;
  }

  private runRegexWorker(
    workerPath: string,
    q: SearchQuery,
    candidates: string[],
    skip: number,
    maxResults: number,
    timeoutMs: number,
  ): Promise<{ matches: RawMatch[]; filesScanned: number; truncated: boolean }> {
    const files = candidates.map((rel) => ({ rel, abs: this.wfs.absOf(rel) }));
    return new Promise((resolve, reject) => {
      const worker = new Worker(workerPath, {
        workerData: {
          files,
          pattern: q.query,
          flags: q.caseSensitive ? '' : 'i',
          skip,
          maxResults,
          contextBefore: q.contextBefore,
          contextAfter: q.contextAfter,
          maxFileBytes: this.limits.readFileBytes,
          maxLineChars: MAX_LINE_SNIPPET,
        },
      });
      const timer = setTimeout(() => {
        void worker.terminate();
        reject(new DodoError('TIMEOUT', `regex search exceeded ${timeoutMs} ms and was terminated (pattern too expensive?)`, { retryable: true }));
      }, timeoutMs);
      timer.unref();
      worker.once('message', (msg: { error?: string; matches?: RawMatch[]; filesScanned?: number; truncated?: boolean }) => {
        clearTimeout(timer);
        void worker.terminate();
        if (msg.error) {
          reject(new DodoError('INVALID_INPUT', msg.error));
          return;
        }
        resolve({ matches: msg.matches ?? [], filesScanned: msg.filesScanned ?? 0, truncated: msg.truncated ?? false });
      });
      worker.once('error', (err) => {
        clearTimeout(timer);
        reject(new DodoError('INTERNAL_ERROR', `search worker failed: ${err.message}`));
      });
    });
  }

  private runRipgrep(q: SearchQuery, files: string[], timeoutMs: number): Promise<RawMatch[]> {
    const env = buildChildEnv({ parentEnv: process.env, workspaceRoot: this.wfs.root, extraAllowlist: [] });
    const args = ['--json', '--no-config', '--no-ignore', '--max-columns', '4096', '--max-filesize', `${this.limits.readFileBytes}`, '--sort', 'path'];
    if (q.mode === 'literal') args.push('--fixed-strings');
    if (!q.caseSensitive) args.push('--ignore-case');
    if (q.contextBefore > 0) args.push('-B', String(q.contextBefore));
    if (q.contextAfter > 0) args.push('-A', String(q.contextAfter));
    args.push('-e', q.query, '--', ...files);
    const executable = resolveTrustedExecutable('rg', this.wfs.root, { allowBatch: false });
    if (process.platform === 'win32') assertWindowsArgv(executable, args);
    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, { cwd: this.wfs.root, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stderr.resume();
      const chunks: Buffer[] = [];
      let bytes = 0;
      const timer = setTimeout(() => {
        try { signalOwnedProcess(child, 'SIGKILL'); } catch { /* timeout remains a failure */ }
        reject(new DodoError('TIMEOUT', 'search timed out', { retryable: true }));
      }, timeoutMs);
      timer.unref();
      child.stdout.on('data', (c: Buffer) => {
        bytes += c.length;
        if (bytes <= 32 * 1024 * 1024) chunks.push(c);
      });
      child.on('error', () => {
        clearTimeout(timer);
        reject(new DodoError('INTERNAL_ERROR', 'ripgrep failed to start'));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 2 && q.mode === 'regex') {
          reject(new DodoError('INVALID_INPUT', 'invalid regex pattern'));
          return;
        }
        resolve(this.parseRgOutput(Buffer.concat(chunks).toString('utf8'), q));
      });
    });
  }

  private parseRgOutput(stdout: string, q: SearchQuery): RawMatch[] {
    const matches: RawMatch[] = [];
    // rg --json emits per-file: begin, (context|match)*, end. Context lines
    // before a match accumulate in `pending`; after a match they attach to it.
    let pending: string[] = [];
    let last: RawMatch | undefined;
    let currentFile = '';
    for (const lineRaw of stdout.split('\n')) {
      if (lineRaw === '') continue;
      let evt: Record<string, unknown>;
      try {
        evt = JSON.parse(lineRaw) as Record<string, unknown>;
      } catch {
        continue;
      }
      const type = evt['type'];
      if (type === 'begin' || type === 'end') {
        pending = [];
        last = undefined;
        currentFile = '';
        continue;
      }
      if (type !== 'match' && type !== 'context') continue;
      const data = evt['data'] as {
        path?: { text?: string };
        lines?: { text?: string };
        line_number?: number;
        submatches?: Array<{ start: number }>;
      };
      const p = process.platform === 'win32' ? data.path?.text?.replace(/\\/g, '/') : data.path?.text;
      const lineText = cutLine((data.lines?.text ?? '').replace(/\n$/, ''));
      const lineNo = data.line_number ?? 0;
      if (!p || lineNo <= 0) continue;
      if (p !== currentFile) {
        currentFile = p;
        pending = [];
        last = undefined;
      }
      if (type === 'context') {
        if (last && last.after.length < q.contextAfter && lineNo > last.line) {
          last.after.push(lineText);
        } else {
          pending.push(lineText);
          if (pending.length > q.contextBefore) pending.shift();
        }
        continue;
      }
      const byteStart = data.submatches?.[0]?.start ?? 0;
      // rg reports byte offsets; the public contract is 1-based UTF-16 columns.
      const lineBuf = Buffer.from(lineText, 'utf8');
      const column = lineBuf.subarray(0, Math.min(byteStart, lineBuf.length)).toString('utf8').length + 1;
      // Defense in depth: candidates were policy-validated, but re-check.
      let rel: string;
      try {
        rel = this.wfs.normalizeRel(p);
        if (this.wfs.ignores.isSecret(rel) || this.wfs.ignores.isProtected(rel)) continue;
      } catch {
        continue;
      }
      last = { path: rel, line: lineNo, column, lineText, before: pending.slice(-q.contextBefore || 0), after: [] };
      if (q.contextBefore === 0) last.before = [];
      pending = [];
      matches.push(last);
    }
    return matches;
  }

  private sweepCursors(): void {
    const now = Date.now();
    for (const [k, v] of this.cursors) {
      if (v.expiresAt < now) this.cursors.delete(k);
    }
    while (this.cursors.size > 200) {
      const first = this.cursors.keys().next().value as string | undefined;
      if (first === undefined) break;
      this.cursors.delete(first);
    }
  }
}

function cutLine(s: string): string {
  return s.length > MAX_LINE_SNIPPET ? s.slice(0, MAX_LINE_SNIPPET) : s;
}
