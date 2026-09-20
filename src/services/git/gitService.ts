import fs from 'node:fs';
import path from 'node:path';
import { sha256Bytes } from '../../util/hash.js';
import { renameWithRetry, removeWithRetry } from '../../platform/fsRetry.js';
import { spawn } from 'node:child_process';
import { DodoError } from '../../errors.js';
import type { WorkspaceFS } from '../../workspace/fs.js';
import type { Limits } from '../../config/limits.js';
import { buildChildEnv } from '../../security/env.js';
import { truncateUtf8 } from '../../util/bytes.js';
import { resolveTrustedExecutable } from '../../platform/execResolve.js';
import { assertWindowsArgv } from '../../platform/shell.js';
import { signalOwnedProcess } from '../../platform/processTree.js';

/**
 * Git services (spec §14): argv subprocess, no shell, output scoped to the
 * selected root even when the repository lives above it, secret-denied paths
 * filtered from listings, diffs and staging.
 *
 * Read-only operations (status/diff/log) additionally disable helpers and
 * executable config (`--no-ext-diff --no-textconv`, fsmonitor off, global and
 * system config ignored) and never touch the network.
 *
 * `commit` is a WRITE that legitimately runs the repository's commit hooks and
 * needs the user's identity from their global config, so it runs with
 * `userConfig: true` and is gated by the exec policy (same tier as running a
 * command), never by the read tier.
 */
export interface GitStatusResult {
  isRepo: boolean;
  branch?: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
  entries: Array<{ path: string; status: string }>;
  truncated: boolean;
  filteredSecretPaths: number;
}

export interface GitCommitResult {
  commit: string;
  subject: string;
  filesChanged: number;
  stagedPaths: string[];
}

export interface GitLogEntry {
  sha: string;
  author: string;
  date: string;
  subject: string;
}

const GIT_TIMEOUT_MS = 15_000;
const COMMIT_TIMEOUT_MS = 120_000; // hooks may run tests/linters
const MAX_STATUS_ENTRIES = 500;

interface RunOptions {
  /** Allow the user's global/system git config (identity, hooks path) — writes only. */
  userConfig?: boolean;
  timeoutMs?: number;
  stdin?: Buffer;
  /** Internal candidate index; never supplied by MCP callers. */
  indexFile?: string;
}

export class GitService {
  constructor(
    private readonly wfs: WorkspaceFS,
    private readonly limits: Limits,
  ) {}

  /** Sanitized recovery evidence only; no working index/tree mutation or remote URL. */
  async recoveryMetadata(){
    if(!(await this.isRepo()))return {isRepo:false};
    const head=await this.run(['rev-parse','--verify','HEAD']);
    const branch=await this.run(['symbolic-ref','--quiet','--short','HEAD']);
    const index=await this.run(['rev-parse','--git-path','index']);let indexFingerprint:string|null=null;
    if(index.code===0){const p=path.resolve(this.wfs.root,index.stdout.toString().trim());try{const st=fs.lstatSync(p);if(st.isFile()&&!st.isSymbolicLink()&&st.nlink===1&&st.size<32*1024*1024)indexFingerprint=sha256Bytes(fs.readFileSync(p));}catch{/* unborn */}}
    return {isRepo:true,head:head.code===0&&/^[a-f0-9]{40,64}$/.test(head.stdout.toString().trim())?head.stdout.toString().trim():null,branch:branch.code===0?branch.stdout.toString().trim().slice(0,256):null,indexFingerprint};
  }

  private async run(args: string[], opts: RunOptions = {}): Promise<{ code: number; stdout: Buffer; stderr: string }> {
    const env = buildChildEnv({ parentEnv: process.env, workspaceRoot: this.wfs.root, extraAllowlist: [] });
    env['GIT_TERMINAL_PROMPT'] = '0';
    env['GIT_OPTIONAL_LOCKS'] = '0';
    env['GIT_PAGER'] = 'cat';
    env['GIT_LITERAL_PATHSPECS'] = '1';
    if (opts.indexFile) env['GIT_INDEX_FILE'] = opts.indexFile;
    const executable = resolveTrustedExecutable('git', this.wfs.root, { allowBatch: false });
    if (!opts.userConfig) {
      env['GIT_CONFIG_NOSYSTEM'] = '1';
      env['GIT_CONFIG_GLOBAL'] = process.platform === 'win32' ? 'NUL' : '/dev/null';
    }
    const fullArgs = [
      '-C',
      this.wfs.root,
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.untrackedCache=false',
      '-c',
      'diff.external=',
      '-c',
      'protocol.allow=never',
      '-c', 'core.quotepath=false',
      ...(process.platform === 'win32' ? ['-c', 'core.longpaths=true'] : []),
      ...args,
    ];
    if (process.platform === 'win32') assertWindowsArgv(executable, fullArgs);
    const timeoutMs = opts.timeoutMs ?? GIT_TIMEOUT_MS;
    return await new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(executable, fullArgs, { cwd: this.wfs.root, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        child.stdin.on('error', () => undefined);
        child.stdin.end(opts.stdin);
      } catch (err) {
        reject(new DodoError('INTERNAL_ERROR', `git spawn failed: ${(err as Error).message}`));
        return;
      }
      const out: Buffer[] = [];
      const errChunks: Buffer[] = [];
      let outBytes = 0;
      const timer = setTimeout(() => {
        try { signalOwnedProcess(child, 'SIGKILL'); } catch { /* report the timeout; no success claim */ }
        reject(new DodoError('TIMEOUT', 'git command timed out; check for unfinished hook processes'));
      }, timeoutMs);
      timer.unref();
      child.stdout.on('data', (c: Buffer) => {
        outBytes += c.length;
        if (outBytes <= 8 * 1024 * 1024) out.push(c);
      });
      child.stderr.on('data', (c: Buffer) => {
        if (errChunks.reduce((a, b) => a + b.length, 0) < 16 * 1024) errChunks.push(c);
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(new DodoError('NOT_FOUND', `git is not available: ${err.message}`));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (outBytes > 8 * 1024 * 1024) { reject(new DodoError('RESOURCE_LIMIT', 'git output exceeded inspection limit')); return; }
        resolve({ code: code ?? -1, stdout: Buffer.concat(out), stderr: Buffer.concat(errChunks).toString('utf8') });
      });
    });
  }

  /** A path from git output is included only if policy would show it. */
  private visible(relFromRoot: string): boolean {
    try {
      const rel = this.wfs.normalizeRel(relFromRoot);
      if (this.wfs.ignores.isSecret(rel) || this.wfs.ignores.isProtected(rel)) return false;
      this.wfs.resolve(rel, { allowMissing: true });
      return true;
    } catch {
      return false;
    }
  }

  private async isRepo(): Promise<boolean> {
    const probe = await this.run(['rev-parse', '--is-inside-work-tree']);
    return probe.code === 0 && probe.stdout.toString('utf8').trim() === 'true';
  }

  async status(): Promise<GitStatusResult> {
    if (!(await this.isRepo())) {
      return { isRepo: false, entries: [], truncated: false, filteredSecretPaths: 0 };
    }
    // Enumerate leaves: an untracked directory may contain a denied secret or
    // symlink. Treating that directory as one safe path would stage both.
    const res = await this.run(['status', '--porcelain=v2', '--branch', '--untracked-files=all', '-z', '--', '.']);
    if (res.code !== 0) {
      throw new DodoError('INTERNAL_ERROR', 'git status failed', { detail: { stderr: res.stderr.slice(0, 500) } });
    }
    const records = res.stdout.toString('utf8').split('\0').filter((r) => r.length > 0);
    const result: GitStatusResult = { isRepo: true, entries: [], truncated: false, filteredSecretPaths: 0 };
    // Paths in porcelain output are relative to the REPO root, which may be
    // above the workspace root — re-scope them.
    const prefix = await this.repoPrefix();
    let skipNext = false;
    for (const rec of records) {
      if (skipNext) {
        skipNext = false;
        continue; // rename records carry the original path as a separate NUL field
      }
      if (rec.startsWith('# branch.head ')) {
        result.branch = rec.slice('# branch.head '.length);
        continue;
      }
      if (rec.startsWith('# branch.upstream ')) {
        result.upstream = rec.slice('# branch.upstream '.length);
        continue;
      }
      if (rec.startsWith('# branch.ab ')) {
        const m = /\+(\d+) -(\d+)/.exec(rec);
        if (m) {
          result.ahead = Number(m[1]);
          result.behind = Number(m[2]);
        }
        continue;
      }
      if (rec.startsWith('#')) continue;
      let status = '';
      let p = '';
      if (rec.startsWith('1 ') || rec.startsWith('2 ')) {
        const parts = rec.split(' ');
        status = parts[1] ?? '';
        p = rec.startsWith('1 ') ? parts.slice(8).join(' ') : parts.slice(9).join(' ');
        if (rec.startsWith('2 ')) skipNext = true;
      } else if (rec.startsWith('? ')) {
        status = '??';
        p = rec.slice(2);
      } else if (rec.startsWith('u ')) {
        const parts = rec.split(' ');
        status = `u:${parts[1] ?? ''}`;
        p = parts.slice(10).join(' ');
      } else {
        continue;
      }
      const scoped = this.scopeToRoot(p, prefix);
      if (scoped === undefined) continue;
      if (!this.visible(scoped)) {
        result.filteredSecretPaths += 1;
        continue;
      }
      if (result.entries.length >= MAX_STATUS_ENTRIES) {
        result.truncated = true;
        break;
      }
      result.entries.push({ path: scoped, status });
    }
    return result;
  }

  private async repoPrefix(): Promise<string> {
    const res = await this.run(['rev-parse', '--show-prefix']);
    if (res.code !== 0) throw new DodoError('CONFLICT', 'cannot resolve repository scope');
    // Repository boundaries can change while DODO is running (init/worktree
    // operations outside this service). Never reuse a previous scope prefix.
    return res.stdout.toString('utf8').replace(/\r?\n$/, '');
  }

  /** Convert a repo-root-relative path to workspace-relative; undefined if outside. */
  private scopeToRoot(repoRelative: string, prefix: string): string | undefined {
    if (prefix === '') return repoRelative;
    if (!repoRelative.startsWith(prefix)) return undefined;
    const rel = repoRelative.slice(prefix.length);
    return rel === '' ? undefined : rel;
  }

  /** Validate caller paths → git pathspecs relative to the workspace root. */
  private toPathspecs(paths: string[]): { pathspecs: string[]; filtered: number } {
    let filtered = 0;
    const pathspecs: string[] = [];
    for (const p of paths) {
      const rel = this.wfs.normalizeRel(p); // throws PATH_DENIED on escape attempts
      if (this.wfs.ignores.isSecret(rel) || this.wfs.ignores.isProtected(rel)) {
        filtered += 1;
        continue;
      }
      this.wfs.resolve(rel, { allowMissing: true });
      pathspecs.push(rel === '.' ? '.' : `./${rel}`);
    }
    return { pathspecs, filtered };
  }

  async diff(opts: { paths?: string[]; staged?: boolean; contextLines?: number }): Promise<{ isRepo: boolean; diff: string; truncated: boolean; filteredSecretPaths: number }> {
    if (!(await this.isRepo())) {
      return { isRepo: false, diff: '', truncated: false, filteredSecretPaths: 0 };
    }
    let filtered = 0;
    let pathspecs: string[] = ['.'];
    if (opts.paths && opts.paths.length > 0) {
      const r = this.toPathspecs(opts.paths);
      filtered = r.filtered;
      pathspecs = r.pathspecs;
      if (pathspecs.length === 0) {
        return { isRepo: true, diff: '', truncated: false, filteredSecretPaths: filtered };
      }
    }
    const args = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', `-U${Math.min(opts.contextLines ?? 3, 20)}`];
    if (opts.staged) args.push('--cached');
    args.push('--', ...pathspecs);
    const res = await this.run(args);
    if (res.code !== 0 && res.code !== 1) {
      throw new DodoError('INTERNAL_ERROR', 'git diff failed', { detail: { stderr: res.stderr.slice(0, 500) } });
    }
    const raw = res.stdout.toString('utf8');
    const { kept, dropped } = this.filterDiffSections(raw);
    const { text, truncated } = truncateUtf8(kept, this.limits.toolContentBytes - 4 * 1024);
    return { isRepo: true, diff: text, truncated, filteredSecretPaths: filtered + dropped };
  }

  /** Drop diff sections whose file path is secret/protected (tracked secrets stay filtered). */
  private filterDiffSections(diffText: string): { kept: string; dropped: number } {
    if (diffText === '') return { kept: '', dropped: 0 };
    const sections = diffText.split(/^(?=diff --git )/m);
    let dropped = 0;
    const keep: string[] = [];
    for (const section of sections) {
      if (!section.startsWith('diff --git ')) {
        keep.push(section);
        continue;
      }
      const m = /^diff --git a\/(.+?) b\//.exec(section);
      const p = m?.[1];
      if (p !== undefined && !this.visible(p)) {
        dropped += 1;
        continue;
      }
      keep.push(section);
    }
    return { kept: keep.join(''), dropped };
  }

  /** Recent commits touching the workspace root (or one path inside it). */
  async log(opts: { limit: number; path?: string }): Promise<{ isRepo: boolean; commits: GitLogEntry[] }> {
    if (!(await this.isRepo())) return { isRepo: false, commits: [] };
    let pathspec = '.';
    if (opts.path !== undefined) {
      const r = this.toPathspecs([opts.path]);
      if (r.pathspecs.length === 0) throw new DodoError('SECRET_PATH_DENIED', 'path is denied by secret policy');
      pathspec = r.pathspecs[0] as string;
    }
    const limit = Math.max(1, Math.min(opts.limit, 200));
    const res = await this.run(['log', `-n${limit}`, '--format=%H%x1f%an%x1f%aI%x1f%s', '--', pathspec]);
    if (res.code !== 0) {
      // A repo with no commits yet reports an error on `log`; that is not a failure.
      if (/does not have any commits|bad default revision/i.test(res.stderr)) return { isRepo: true, commits: [] };
      throw new DodoError('INTERNAL_ERROR', 'git log failed', { detail: { stderr: res.stderr.slice(0, 500) } });
    }
    const commits: GitLogEntry[] = [];
    for (const line of res.stdout.toString('utf8').split('\n')) {
      if (line === '') continue;
      const [sha, author, date, subject] = line.split('\x1f');
      if (!sha) continue;
      commits.push({ sha, author: author ?? '', date: date ?? '', subject: (subject ?? '').slice(0, 300) });
    }
    return { isRepo: true, commits };
  }

  /**
   * Stage and commit inside the workspace scope. `all` stages every changed
   * path the scoped, secret-filtered status reports (never `git add -A .`,
   * which would stage a stray .env). Hooks run — the caller gates this as an
   * exec-class action.
   */
  async commit(opts: { message: string; paths?: string[]; all?: boolean; noVerify?: boolean }): Promise<GitCommitResult> {
    if (!(await this.isRepo())) throw new DodoError('NOT_FOUND', 'not a git repository');
    const message = opts.message.trim();
    if (message.length === 0) throw new DodoError('INVALID_INPUT', 'commit message must not be empty');
    let stagedPaths: string[] = [];
    if (opts.paths && opts.paths.length > 0) {
      const r = this.toPathspecs(opts.paths);
      if (r.filtered > 0) {
        throw new DodoError('SECRET_PATH_DENIED', `${r.filtered} path(s) are denied by secret policy and cannot be staged`);
      }
      stagedPaths = r.pathspecs;
    } else if (opts.all) {
      const st = await this.status();
      if (st.truncated) throw new DodoError('RESOURCE_LIMIT', 'status is truncated; select explicit paths');
      stagedPaths = st.entries.map((e) => `./${e.path}`);
      if (stagedPaths.length === 0) throw new DodoError('CONFLICT', 'nothing to commit (working tree clean within the workspace)');
    }
    const indexResult = await this.run(['rev-parse', '--path-format=absolute', '--git-path', 'index']);
    const indexPath = indexResult.stdout.toString('utf8').trim();
    if (indexResult.code !== 0 || !path.isAbsolute(indexPath)) throw new DodoError('CONFLICT', 'cannot locate Git index safely');
    const lockPath = `${indexPath}.lock`;
    let lockFd: number;
    try { lockFd = fs.openSync(lockPath, 'wx', 0o600); }
    catch { throw new DodoError('CONFLICT', 'Git index is busy or not writable; no index changes made'); }
    let tempDir: string | undefined;
    let published = false;
    let commitStarted = false;
    let uncertain = false;
    try {
      const original = this.indexBytes(indexPath);
      const originalHash = original ? sha256Bytes(original) : null;
      tempDir = fs.mkdtempSync(path.join(path.dirname(indexPath), '.dodo-index-'));
      const candidate = path.join(tempDir, 'index');
      if (original) fs.writeFileSync(candidate, original, { mode: 0o600, flag: 'wx' });
      await this.validateIndex(candidate);
      if (stagedPaths.length > 0) {
        const add = await this.run(['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], { indexFile: candidate, userConfig: true, stdin: Buffer.from(stagedPaths.join('\0') + '\0', 'utf8') });
        if (add.code !== 0) throw new DodoError('CONFLICT', 'git add failed; original index preserved');
      }
      await this.validateIndex(candidate);
      const commitArgs = ['commit', '-m', message];
      if (opts.noVerify) commitArgs.push('--no-verify');
      const beforeHead = (await this.run(['rev-parse', '--verify', 'HEAD'])).stdout.toString('utf8').trim();
      commitStarted = true;
      const res = await this.run(commitArgs, { indexFile: candidate, userConfig: true, timeoutMs: COMMIT_TIMEOUT_MS });
      if (res.code !== 0) {
        const afterHead = (await this.run(['rev-parse', '--verify', 'HEAD'])).stdout.toString('utf8').trim();
        if (beforeHead !== afterHead) throw new DodoError('RECOVERY_REQUIRED', 'HEAD changed during a failed commit; inspect Git before retrying');
        commitStarted = false;
        const text = `${res.stdout.toString('utf8')}\n${res.stderr}`;
        if (/nothing to commit|no changes added to commit|nothing added to commit/i.test(text)) throw new DodoError('CONFLICT', 'nothing to commit; original index preserved');
        if (/Please tell me who you are|unable to auto-detect email/i.test(text)) throw new DodoError('INVALID_INPUT', 'git identity is not configured; original index preserved');
        throw new DodoError('CONFLICT', 'git commit or hook failed; original index preserved');
      }
      const current = this.indexBytes(indexPath);
      if ((current ? sha256Bytes(current) : null) !== originalHash) throw new DodoError('RECOVERY_REQUIRED', 'commit created but index changed externally; inspect before retrying');
      const finalIndex = this.indexBytes(candidate);
      if (!finalIndex) throw new DodoError('RECOVERY_REQUIRED', 'commit created but candidate index is unavailable');
      fs.writeFileSync(lockFd, finalIndex);
      fs.fsyncSync(lockFd);
      fs.closeSync(lockFd); lockFd = -1;
      renameWithRetry(lockPath, indexPath);
      published = true;
      const sha = (await this.run(['rev-parse', 'HEAD'])).stdout.toString('utf8').trim();
      const subject = (await this.run(['log', '-1', '--format=%s'])).stdout.toString('utf8').trim();
      const files = (await this.run(['diff-tree', '--root', '--no-commit-id', '--name-only', '-z', '-r', 'HEAD'])).stdout.toString('utf8').split('\0').filter(Boolean);
      return { commit: sha, subject, filesChanged: files.length, stagedPaths: stagedPaths.map(p => p.replace(/^\.\//, '')) };
    } catch (err) {
      if (commitStarted) {
        uncertain = true;
        throw new DodoError('RECOVERY_REQUIRED', 'Git commit outcome or index publication is uncertain; inspect HEAD/index before any retry');
      }
      throw err;
    } finally {
      if (lockFd >= 0) fs.closeSync(lockFd);
      if (!published) { try { fs.unlinkSync(lockPath); } catch { /* only our acquired lock */ } }
      // Keep the candidate for owner inspection if a commit may have occurred.
      if (tempDir && !uncertain) removeWithRetry(tempDir, true);
    }
  }

  private indexBytes(file: string): Buffer | null {
    let st: fs.Stats;
    try { st = fs.lstatSync(file); }
    catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null; throw err; }
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size > 128 * 1024 * 1024) throw new DodoError('PATH_DENIED', 'Git index is not a bounded regular file');
    return fs.readFileSync(file);
  }

  /** Inspect the entire staged diff, including paths staged before this call. */
  private async validateIndex(indexFile: string): Promise<void> {
    const result = await this.run(['diff', '--cached', '--no-relative', '--name-only', '--no-renames', '--no-ext-diff', '--no-textconv', '-z'], { indexFile });
    if (result.code !== 0) throw new DodoError('CONFLICT', 'cannot inspect staged index');
    const prefix = await this.repoPrefix();
    for (const repoPath of result.stdout.toString('utf8').split('\0').filter(Boolean)) {
      const rel = this.scopeToRoot(repoPath, prefix);
      if (rel === undefined) throw new DodoError('PATH_DENIED', 'staged index contains paths outside this workspace; index preserved');
      if (!this.visible(rel)) throw new DodoError('SECRET_PATH_DENIED', 'staged index contains denied paths; index preserved');
      const resolved = this.wfs.resolve(rel, { allowMissing: true });
      if (resolved.stat?.isFile()) this.wfs.assertRegularFileForDirectAccess(resolved);
    }
  }

  /** Small summary for project_overview: branch + dirty counts only. */
  async summary(): Promise<{ isRepo: boolean; branch?: string; dirtyFiles?: number; untrackedFiles?: number }> {
    try {
      const st = await this.status();
      if (!st.isRepo) return { isRepo: false };
      const out: { isRepo: boolean; branch?: string; dirtyFiles?: number; untrackedFiles?: number } = {
        isRepo: true,
        dirtyFiles: st.entries.filter((e) => e.status !== '??').length,
        untrackedFiles: st.entries.filter((e) => e.status === '??').length,
      };
      if (st.branch !== undefined) out.branch = st.branch;
      return out;
    } catch {
      return { isRepo: false };
    }
  }
}
