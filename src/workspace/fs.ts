import fs from 'node:fs';
import path from 'node:path';
import { DodoError } from '../errors.js';
import { IgnoreEngine } from './ignores.js';
import { sha256Bytes } from '../util/hash.js';
import { decodeUtf8Strict, looksBinary } from '../util/bytes.js';
import { assertWindowsSegment, isWithinPath } from '../platform/pathPolicy.js';

/**
 * WorkspaceFS — the single shared path policy (spec §10). EVERY filesystem
 * touch (read, list, search candidates, git scoping, TS language service,
 * diagnostics, change plans, artifacts) goes through this class.
 *
 * Public contract: workspace-relative POSIX paths; `.` is the root.
 *
 * Guarantees (with documented limits):
 *  - lexical validation: no absolute paths, drive/UNC forms, `..`, NUL, `\`
 *  - segment-aware containment (never plain startsWith)
 *  - no symlink traversal: every path component from the root down is lstat'd
 *  - hardlinked regular files (nlink > 1) are refused for direct file access
 *  - secret/protected paths are refused regardless of includeIgnored
 *
 * NOT an OS sandbox: pure-Node check-then-use has TOCTOU races against a
 * hostile concurrent local actor with the same OS user (documented in
 * SECURITY.md; no formal confinement is claimed).
 */

export type AccessMode = 'read' | 'write';

export interface ResolveOptions {
  /** Allow the final component to be missing (for creates/list of parents). */
  allowMissing?: boolean;
  /**
   * Semantic-provider access: node_modules etc. remain reachable (they are
   * inside the root), but secret/symlink/hardlink rules still apply.
   * Only affects *ordinary ignore* treatment by callers, not this check.
   */
  mode?: AccessMode;
}

export interface ResolvedPath {
  rel: string; // normalized, '.' for root
  abs: string;
  /** lstat of the final component; undefined when missing and allowMissing. */
  stat: fs.Stats | undefined;
}

const MAX_PATH_LENGTH = 1024;
const MAX_SEGMENTS = 64;

export class WorkspaceFS {
  readonly root: string;
  readonly ignores: IgnoreEngine;

  constructor(rootRealPath: string, ignores: IgnoreEngine) {
    // Windows may expose the same directory through an 8.3 path (notably
    // os.tmpdir() on service accounts) while realpathSync.native() returns
    // its long spelling.  Keep one canonical spelling inside the policy so
    // containment checks compare like with like.  Relative tool input is
    // still checked component-by-component below and aliases remain denied.
    this.root = process.platform === 'win32' ? fs.realpathSync.native(rootRealPath) : rootRealPath;
    this.ignores = ignores;
  }

  /**
   * Lexical validation only — no filesystem access. Rejects traversal,
   * absolute/drive/UNC forms, NUL, backslashes, oversize.
   */
  normalizeRel(input: string): string {
    if (typeof input !== 'string') throw new DodoError('PATH_DENIED', 'path must be a string');
    if (input.length === 0) throw new DodoError('PATH_DENIED', 'path must not be empty (use "." for the root)');
    if (input.length > MAX_PATH_LENGTH) throw new DodoError('PATH_DENIED', 'path too long');
    if (input.includes('\0')) throw new DodoError('PATH_DENIED', 'path contains NUL');
    if (input.includes('\\')) throw new DodoError('PATH_DENIED', 'use forward slashes; backslash paths are rejected');
    if (input.startsWith('/') || input.startsWith('~')) {
      throw new DodoError('PATH_DENIED', 'absolute and home paths are rejected; paths are workspace-relative');
    }
    if (/^[A-Za-z]:/.test(input)) throw new DodoError('PATH_DENIED', 'drive-letter paths are rejected');
    if (input === '.') return '.';
    const segments: string[] = [];
    for (const seg of input.split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') throw new DodoError('PATH_DENIED', 'path traversal ("..") is rejected');
      if (process.platform === 'win32') assertWindowsSegment(seg);
      segments.push(seg);
    }
    if (segments.length === 0) return '.';
    if (segments.length > MAX_SEGMENTS) throw new DodoError('PATH_DENIED', 'too many path segments');
    const rel = segments.join('/');
    // Defense in depth: segment-aware containment (never bare startsWith).
    const abs = path.resolve(this.root, rel);
    if (!isWithinPath(this.root, abs)) {
      throw new DodoError('PATH_DENIED', 'path escapes the workspace root');
    }
    return rel;
  }

  /** Canonicalize each existing Windows component and recheck secret policy.
   * This rejects junction escapes and aliases, including 8.3 spellings that
   * do not contain a recognizable tilde. No case-sensitive secret bypass. */
  private assertCanonicalComponent(abs: string): void {
    if (process.platform !== 'win32') return;
    const real = fs.realpathSync.native(abs);
    if (!isWithinPath(this.root, real)) throw new DodoError('PATH_DENIED', 'canonical path escapes the workspace');
    const rel = path.relative(this.root, real).split(path.sep).join('/') || '.';
    if (this.ignores.isSecret(rel)) throw new DodoError('SECRET_PATH_DENIED', 'canonical path is denied by secret policy');
    if (this.ignores.isProtected(rel)) throw new DodoError('PATH_DENIED', 'canonical path is protected');
    if (path.resolve(abs).toLowerCase() !== path.resolve(real).toLowerCase()) throw new DodoError('PATH_DENIED', 'Windows path aliases/reparse redirections are refused; use the original long filename');
  }

  absOf(rel: string): string {
    return rel === '.' ? this.root : path.join(this.root, rel);
  }

  /**
   * Validate a relative path against the full policy, walking every existing
   * component with lstat (no symlink traversal anywhere on the path).
   */
  resolve(input: string, opts: ResolveOptions = {}): ResolvedPath {
    const rel = this.normalizeRel(input);
    const rootStat = fs.lstatSync(this.root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new DodoError('PATH_DENIED', 'workspace root identity changed');
    this.assertCanonicalComponent(this.root);
    if (this.ignores.isSecret(rel)) {
      throw new DodoError('SECRET_PATH_DENIED', `path is denied by secret policy`, { detail: { path: rel } });
    }
    if (this.ignores.isProtected(rel)) {
      throw new DodoError('PATH_DENIED', 'path is protected', { detail: { path: rel } });
    }
    if (rel === '.') {
      const st = fs.lstatSync(this.root);
      return { rel, abs: this.root, stat: st };
    }
    const segments = rel.split('/');
    let cur = this.root;
    for (let i = 0; i < segments.length; i += 1) {
      cur = path.join(cur, segments[i] as string);
      let st: fs.Stats;
      try {
        st = fs.lstatSync(cur);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          if (opts.allowMissing) {
            // The missing suffix must not exist at all; the nearest existing
            // ancestor was already verified symlink-free above.
            return { rel, abs: path.join(this.root, rel), stat: undefined };
          }
          throw new DodoError('NOT_FOUND', `path not found`, { detail: { path: rel } });
        }
        throw new DodoError('PATH_DENIED', 'path is not accessible', { detail: { path: rel } });
      }
      if (st.isSymbolicLink()) {
        throw new DodoError('PATH_DENIED', 'symlinks are not followed', { detail: { path: segments.slice(0, i + 1).join('/') } });
      }
      this.assertCanonicalComponent(cur);
      const isFinal = i === segments.length - 1;
      if (!isFinal && !st.isDirectory()) {
        throw new DodoError('PATH_DENIED', 'path component is not a directory', { detail: { path: rel } });
      }
      if (isFinal) {
        return { rel, abs: cur, stat: st };
      }
    }
    /* istanbul ignore next -- unreachable */
    throw new DodoError('INTERNAL_ERROR', 'path resolution failed');
  }

  /** Direct-file-tool guard: regular file, not hardlinked (nlink > 1 refused). */
  assertRegularFileForDirectAccess(resolved: ResolvedPath): fs.Stats {
    const st = resolved.stat;
    if (!st) throw new DodoError('NOT_FOUND', 'file not found', { detail: { path: resolved.rel } });
    if (!st.isFile()) {
      throw new DodoError('PATH_DENIED', 'not a regular file', { detail: { path: resolved.rel } });
    }
    if (st.nlink > 1) {
      throw new DodoError('PATH_DENIED', 'hardlinked files are refused by policy', { detail: { path: resolved.rel } });
    }
    return st;
  }

  /**
   * Read a file's raw bytes under policy. `maxBytes` refuses larger files
   * with FILE_TOO_LARGE (typed, never a silent cut).
   */
  readFileBytes(input: string, maxBytes: number): { rel: string; abs: string; bytes: Buffer; stat: fs.Stats } {
    const resolved = this.resolve(input);
    const st = this.assertRegularFileForDirectAccess(resolved);
    if (st.size > maxBytes) {
      throw new DodoError('FILE_TOO_LARGE', `file exceeds ${maxBytes} bytes`, {
        detail: { path: resolved.rel, size: st.size, maxBytes },
      });
    }
    const bytes = fs.readFileSync(resolved.abs);
    return { rel: resolved.rel, abs: resolved.abs, bytes, stat: st };
  }

  /** Read + strict UTF-8 decode; binary/undecodable input is a typed error. */
  readTextFile(input: string, maxBytes: number): { rel: string; text: string; bytes: Buffer; hash: string; stat: fs.Stats } {
    const { rel, bytes, stat } = this.readFileBytes(input, maxBytes);
    if (looksBinary(bytes)) {
      throw new DodoError('UNSUPPORTED_ENCODING', 'file appears to be binary', { detail: { path: rel } });
    }
    const text = decodeUtf8Strict(bytes);
    if (text === undefined) {
      throw new DodoError('UNSUPPORTED_ENCODING', 'file is not valid UTF-8', { detail: { path: rel } });
    }
    return { rel, text, bytes, hash: sha256Bytes(bytes), stat };
  }

  /** List one directory (lstat entries, no follow). Callers apply ignore classes. */
  listDir(input: string): Array<{ name: string; rel: string; stat: fs.Stats }> {
    const resolved = this.resolve(input);
    const st = resolved.stat;
    if (!st?.isDirectory()) throw new DodoError('PATH_DENIED', 'not a directory', { detail: { path: resolved.rel } });
    const names = fs.readdirSync(resolved.abs);
    const out: Array<{ name: string; rel: string; stat: fs.Stats }> = [];
    for (const name of names) {
      if (name.includes('\0') || name.includes('/') || name.includes('\\')) continue;
      const rel = resolved.rel === '.' ? name : `${resolved.rel}/${name}`;
      let est: fs.Stats;
      try {
        est = fs.lstatSync(path.join(resolved.abs, name));
      } catch {
        continue;
      }
      out.push({ name, rel, stat: est });
    }
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out;
  }

  /**
   * Bounded workspace walk in deterministic order. Symlinks are never
   * followed; secret/protected paths are never yielded; ordinary ignores are
   * skipped unless includeIgnored.
   */
  *walk(opts: {
    startRel?: string;
    includeIgnored?: boolean;
    maxEntries?: number;
    maxDepth?: number;
  }): Generator<{ rel: string; stat: fs.Stats; depth: number; ignoredClass: 'ok' }> {
    const includeIgnored = opts.includeIgnored ?? false;
    const maxEntries = opts.maxEntries ?? 100_000;
    const maxDepth = opts.maxDepth ?? 32;
    const start = this.resolve(opts.startRel ?? '.');
    if (!start.stat?.isDirectory()) {
      throw new DodoError('PATH_DENIED', 'walk start is not a directory', { detail: { path: start.rel } });
    }
    let yielded = 0;
    const stack: Array<{ rel: string; depth: number }> = [{ rel: start.rel, depth: 0 }];
    while (stack.length > 0) {
      const cur = stack.pop() as { rel: string; depth: number };
      let entries: Array<{ name: string; rel: string; stat: fs.Stats }>;
      try {
        entries = this.listDir(cur.rel);
      } catch {
        continue;
      }
      // listDir sorts ascending; reverse-push so pop() visits ascending order.
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        const e = entries[i] as { name: string; rel: string; stat: fs.Stats };
        if (e.stat.isSymbolicLink()) continue;
        const isDir = e.stat.isDirectory();
        const cls = this.ignores.classify(e.rel, isDir, includeIgnored);
        if (cls !== 'ok') continue;
        if (isDir) {
          if (cur.depth + 1 < maxDepth) stack.push({ rel: e.rel, depth: cur.depth + 1 });
          continue;
        }
        if (!e.stat.isFile()) continue;
        yielded += 1;
        yield { rel: e.rel, stat: e.stat, depth: cur.depth + 1, ignoredClass: 'ok' };
        if (yielded >= maxEntries) return;
      }
    }
  }

  /**
   * Validate a target for file creation: final component must be missing,
   * every existing ancestor symlink-free; returns which parent dirs would
   * need creating (all inside the root).
   */
  resolveForCreate(input: string, createParents: boolean): { rel: string; abs: string; missingParents: string[] } {
    const rel = this.normalizeRel(input);
    this.resolve('.');
    if (rel === '.') throw new DodoError('PATH_DENIED', 'cannot create the workspace root');
    if (this.ignores.isSecret(rel)) throw new DodoError('SECRET_PATH_DENIED', 'target is denied by secret policy', { detail: { path: rel } });
    if (this.ignores.isProtected(rel)) throw new DodoError('PATH_DENIED', 'target is protected', { detail: { path: rel } });
    const segments = rel.split('/');
    let cur = this.root;
    const missingParents: string[] = [];
    for (let i = 0; i < segments.length; i += 1) {
      const isFinal = i === segments.length - 1;
      cur = path.join(cur, segments[i] as string);
      let st: fs.Stats | undefined;
      try {
        st = fs.lstatSync(cur);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new DodoError('PATH_DENIED', 'path is not accessible', { detail: { path: rel } });
        }
        st = undefined;
      }
      if (st) {
        if (st.isSymbolicLink()) throw new DodoError('PATH_DENIED', 'symlinks are not followed', { detail: { path: segments.slice(0, i + 1).join('/') } });
        this.assertCanonicalComponent(cur);
        if (isFinal) {
          throw new DodoError('CONFLICT', 'target already exists', { detail: { path: rel } });
        }
        if (!st.isDirectory()) throw new DodoError('PATH_DENIED', 'path component is not a directory', { detail: { path: rel } });
      } else {
        if (!isFinal) {
          if (!createParents) {
            throw new DodoError('NOT_FOUND', 'parent directory does not exist (createParents=false)', {
              detail: { path: segments.slice(0, i + 1).join('/') },
            });
          }
          missingParents.push(segments.slice(0, i + 1).join('/'));
        }
      }
    }
    return { rel, abs: path.join(this.root, rel), missingParents };
  }
}
