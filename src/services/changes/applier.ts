import fs from 'node:fs';
import path from 'node:path';
import { DodoError } from '../../errors.js';
import type { WorkspaceFS } from '../../workspace/fs.js';
import type { Limits } from '../../config/limits.js';
import type { Store, ChangesetRow, JournalStepRow } from '../../store/store.js';
import { sha256Bytes, newId } from '../../util/hash.js';
import type { StoredPlan, PlanFileChange, FileConflict } from './types.js';
import { renameWithRetry, retryWindowsFs } from '../../platform/fsRetry.js';

/**
 * apply_changes / rollback_changes commit engine (spec §12.2).
 *
 * Multi-file changes are NOT one atomic filesystem transaction. Each file is
 * written atomically (temp + fsync + rename in the same directory); a durable
 * journal (SQLite steps + on-disk backups) makes failures recoverable. When a
 * mid-apply failure cannot be safely reverted (because bytes on disk no
 * longer match what the journal recorded), the changeset is marked
 * PARTIAL_RECOVERY_REQUIRED with an actionable report — DODO never guesses,
 * never `git reset/clean/stash`es, and never overwrites bytes it cannot
 * account for.
 */
export interface ApplyOutcome {
  changesetId: string;
  files: Array<{ path: string; destPath?: string; action: string; afterHash: string | null }>;
  rollbackAvailable: boolean;
}

export class Applier {
  private mutationLocked = false;

  constructor(
    private readonly wfs: WorkspaceFS,
    private readonly limits: Limits,
    private readonly store: Store,
    private readonly backupsDir: string,
    private readonly workspaceId: string,
  ) {}

  /** true while an unresolved recovery blocks new mutations. */
  recoveryBlocked(): ChangesetRow | undefined {
    return this.store.listChangesetsByStatus('recovery_required').find(cs => cs.workspaceId === this.workspaceId);
  }

  private async withMutationLock<T>(fn: () => Promise<T>): Promise<T> {
    // Single-process serialization (one process per workspace by design).
    const start = Date.now();
    while (this.mutationLocked) {
      if (Date.now() - start > 30_000) throw new DodoError('TIMEOUT', 'workspace mutation lock timeout', { retryable: true });
      await new Promise((r) => setTimeout(r, 25));
    }
    this.mutationLocked = true;
    try {
      return await fn();
    } finally {
      this.mutationLocked = false;
    }
  }

  async apply(opts: { planId: string; planHash: string; workspaceId: string; epoch: string; principal: string }): Promise<ApplyOutcome> {
    return this.withMutationLock(async () => {
      const blocked = this.recoveryBlocked();
      if (blocked) {
        throw new DodoError('RECOVERY_REQUIRED', `a previous change (${blocked.id}) needs manual recovery before new mutations`, {
          recovery: 'run `dodo recover` on the server terminal',
          detail: { changesetId: blocked.id },
        });
      }
      const row = this.store.getPlan(opts.planId);
      if (!row) throw new DodoError('NOT_FOUND', 'unknown planId', { detail: { planId: opts.planId } });
      if (row.principal !== opts.principal) throw new DodoError('FORBIDDEN', 'plan belongs to a different principal');
      if (row.workspaceId !== opts.workspaceId) throw new DodoError('WORKSPACE_MISMATCH', 'plan belongs to a different workspace');
      if (row.epoch !== opts.epoch) {
        throw new DodoError('PLAN_EXPIRED', 'plan was created before a server restart or workspace switch; preview again', { detail: { planId: opts.planId } });
      }
      if (row.invalidatedAt !== null) throw new DodoError('PLAN_EXPIRED', 'plan was already applied or invalidated; preview again');
      if (row.expiresAt < Date.now()) throw new DodoError('PLAN_EXPIRED', 'plan expired; preview again');
      if (row.planHash !== opts.planHash) {
        throw new DodoError('PLAN_HASH_MISMATCH', 'planHash does not match the stored immutable plan');
      }
      const plan = JSON.parse(row.payload) as StoredPlan;

      // Recheck EVERY path and expected raw-byte hash before touching anything.
      const conflicts: FileConflict[] = [];
      for (const f of plan.files) {
        const conflict = this.verifyPreState(f);
        if (conflict) conflicts.push(conflict);
      }
      if (conflicts.length > 0) {
        throw new DodoError('FILE_CHANGED', 'workspace changed since preview; preview again', {
          detail: { conflicts: conflicts.slice(0, 20) },
          recovery: 'read the affected files and create a fresh plan',
        });
      }

      const changesetId = newId('cs');
      const csBackupDir = path.join(this.backupsDir, changesetId);
      fs.mkdirSync(csBackupDir, { recursive: true, mode: 0o700 });
      const tx = this.store.db.transaction(() => {
        this.store.createChangeset({
          id: changesetId,
          workspaceId: opts.workspaceId,
          epoch: opts.epoch,
          planId: opts.planId,
          principal: opts.principal,
          kind: 'apply',
          summary: plan.summary,
        });
        plan.files.forEach((f, seq) => {
          this.store.addJournalStep({
            changesetId,
            seq,
            op: f.action,
            path: f.path,
            destPath: f.destPath ?? null,
            beforeHash: f.beforeHash,
            afterHash: f.afterHash,
            backupPath: f.beforeHash !== null ? path.join(csBackupDir, `${seq}.bin`) : null,
            state: 'pending',
          });
        });
      });
      tx();

      // Phase 1: durable backups of every pre-existing file.
      try {
        for (let seq = 0; seq < plan.files.length; seq += 1) {
          const f = plan.files[seq] as PlanFileChange;
          if (f.beforeHash !== null) {
            const src = this.wfs.absOf(f.path);
            const backupPath = path.join(csBackupDir, `${seq}.bin`);
            copyFileSyncDurable(src, backupPath);
          }
          this.store.setJournalStepState(changesetId, seq, 'backed_up');
        }
      } catch (err) {
        this.store.setChangesetStatus(changesetId, 'failed', `backup failed: ${(err as Error).message}`);
        throw new DodoError('RESOURCE_LIMIT', 'could not persist backups; nothing was changed', {
          recovery: 'check disk space and permissions for the DODO state directory',
        });
      }

      // Phase 2: apply each file with per-file atomic rename where possible.
      const applied: number[] = [];
      for (let seq = 0; seq < plan.files.length; seq += 1) {
        const f = plan.files[seq] as PlanFileChange;
        try {
          this.applyOne(f);
          this.store.setJournalStepState(changesetId, seq, 'written');
          applied.push(seq);
        } catch (err) {
          const revert = this.revertSteps(plan, applied, changesetId);
          if (revert.conflicts.length === 0) {
            this.store.setChangesetStatus(changesetId, 'failed', `apply failed at ${f.path}: ${(err as Error).message}`);
            throw err instanceof DodoError
              ? err
              : new DodoError('INTERNAL_ERROR', `apply failed at ${f.path}`, { detail: { path: f.path } });
          }
          this.store.setChangesetStatus(changesetId, 'recovery_required', `apply failed at ${f.path}; revert incomplete`);
          throw new DodoError('PARTIAL_RECOVERY_REQUIRED', 'apply failed and automatic revert could not restore every file', {
            detail: { changesetId, unrecovered: revert.conflicts.slice(0, 20) },
            recovery: 'run `dodo recover` on the server terminal; backups are in the DODO state directory',
          });
        }
      }

      const done = this.store.db.transaction(() => {
        for (let seq = 0; seq < plan.files.length; seq += 1) this.store.setJournalStepState(changesetId, seq, 'done');
        this.store.setChangesetStatus(changesetId, 'committed');
        this.store.invalidatePlan(opts.planId);
      });
      done();

      return {
        changesetId,
        files: plan.files.map((f) => {
          const out: ApplyOutcome['files'][number] = { path: f.path, action: f.action, afterHash: f.afterHash };
          if (f.destPath !== undefined) out.destPath = f.destPath;
          return out;
        }),
        rollbackAvailable: true,
      };
    });
  }

  private verifyPreState(f: PlanFileChange): FileConflict | undefined {
    try {
      if (f.action === 'create') {
        const { missingParents } = this.wfs.resolveForCreate(f.path, (f.createParents?.length ?? 0) > 0);
        const expected = new Set(f.createParents ?? []);
        for (const p of missingParents) {
          if (!expected.has(p)) return { path: f.path, reason: `parent ${p} no longer exists` };
        }
        return undefined;
      }
      const current = this.wfs.readFileBytes(f.path, this.limits.readFileBytes * 2);
      const hash = sha256Bytes(current.bytes);
      if (hash !== f.beforeHash) return { path: f.path, reason: 'content changed since preview' };
      if (f.action === 'move' && f.destPath) {
        this.wfs.resolveForCreate(f.destPath, false); // throws if dest exists now
      }
      return undefined;
    } catch (err) {
      return { path: f.path, reason: err instanceof DodoError ? err.message : 'not accessible' };
    }
  }

  private applyOne(f: PlanFileChange): void {
    const abs = this.wfs.absOf(f.path);
    switch (f.action) {
      case 'create': {
        for (const dir of f.createParents ?? []) {
          const parent = this.wfs.resolve(dir, { allowMissing: true });
          if (parent.stat) {
            if (!parent.stat.isDirectory()) throw new DodoError('PATH_DENIED', 'planned parent is not a directory');
          } else fs.mkdirSync(parent.abs, { mode: 0o755 });
        }
        writeFileAtomic(abs, Buffer.from(f.afterContentB64 ?? '', 'base64'), 0o644, { mustNotExist: true });
        break;
      }
      case 'modify': {
        writeFileAtomic(abs, Buffer.from(f.afterContentB64 ?? '', 'base64'), f.mode ?? 0o644, { mustNotExist: false });
        break;
      }
      case 'delete': {
        retryWindowsFs(() => fs.unlinkSync(abs));
        fsyncDir(path.dirname(abs));
        break;
      }
      case 'move': {
        const dest = this.wfs.absOf(f.destPath as string);
        renameWithRetry(abs, dest);
        fsyncDir(path.dirname(abs));
        if (path.dirname(dest) !== path.dirname(abs)) fsyncDir(path.dirname(dest));
        break;
      }
    }
  }

  /** Best-effort revert of already-written steps (reverse order). */
  private revertSteps(plan: StoredPlan, appliedSeqs: number[], changesetId: string): { conflicts: FileConflict[] } {
    const conflicts: FileConflict[] = [];
    for (const seq of [...appliedSeqs].reverse()) {
      const f = plan.files[seq] as PlanFileChange;
      const abs = this.wfs.absOf(f.path);
      const backupPath = path.join(this.backupsDir, changesetId, `${seq}.bin`);
      try {
        this.assertGuardedFile(f.path);
        if (f.destPath) this.assertGuardedFile(f.destPath);
        switch (f.action) {
          case 'create': {
            if (hashFileAt(abs) === f.afterHash) {
              retryWindowsFs(() => fs.unlinkSync(abs));
              for (const dir of [...(f.createParents ?? [])].reverse()) {
                try {
                  fs.rmdirSync(this.wfs.absOf(dir));
                } catch {
                  /* non-empty: someone added files — leave it */
                }
              }
            } else {
              conflicts.push({ path: f.path, reason: 'created file changed before revert' });
            }
            break;
          }
          case 'modify': {
            if (hashFileAt(abs) === f.afterHash) {
              copyFileSyncDurable(backupPath, abs, f.mode);
            } else {
              conflicts.push({ path: f.path, reason: 'file changed before revert' });
            }
            break;
          }
          case 'delete': {
            if (hashFileAt(abs) === null) {
              copyFileSyncDurable(backupPath, abs, f.mode);
            } else {
              conflicts.push({ path: f.path, reason: 'a new file appeared at the deleted path' });
            }
            break;
          }
          case 'move': {
            const dest = this.wfs.absOf(f.destPath as string);
            if (hashFileAt(dest) === f.afterHash && hashFileAt(abs) === null) {
              renameWithRetry(dest, abs);
            } else {
              conflicts.push({ path: f.path, reason: 'moved file changed before revert' });
            }
            break;
          }
        }
        this.store.setJournalStepState(changesetId, seq, 'reverted');
      } catch (err) {
        conflicts.push({ path: f.path, reason: `revert failed: ${(err as Error).message}` });
      }
    }
    return { conflicts };
  }

  /**
   * rollback_changes (spec §12.2): verify FIRST that every affected file
   * still has the changeset's after-state; any human edit since apply refuses
   * the whole rollback with per-file conflicts. The restore itself is a new
   * journaled changeset.
   */
  async rollback(opts: { changesetId: string; workspaceId: string; epoch: string; principal: string }): Promise<{ changesetId: string; restored: string[] }> {
    return this.withMutationLock(async () => {
      const blocked = this.recoveryBlocked();
      if (blocked) {
        throw new DodoError('RECOVERY_REQUIRED', `a previous change (${blocked.id}) needs manual recovery before new mutations`, {
          recovery: 'run `dodo recover` on the server terminal',
        });
      }
      const cs = this.store.getChangeset(opts.changesetId);
      if (!cs || cs.workspaceId !== opts.workspaceId) throw new DodoError('NOT_FOUND', 'unknown changesetId');
      if (cs.kind !== 'apply') throw new DodoError('INVALID_INPUT', 'only apply changesets can be rolled back');
      if (cs.status !== 'committed') {
        throw new DodoError('CONFLICT', `changeset is ${cs.status}, not committed`, { detail: { changesetId: cs.id } });
      }
      const steps = this.store.listJournalSteps(cs.id);
      // Verify phase — refuse on any conflict, preserve human work (CHG-11).
      const conflicts: FileConflict[] = [];
      for (const s of steps) {
        const conflict = this.verifyRollbackable(s);
        if (conflict) conflicts.push(conflict);
      }
      if (conflicts.length > 0) {
        throw new DodoError('CONFLICT', 'files changed after this changeset; rollback refused to protect newer edits', {
          detail: { conflicts: conflicts.slice(0, 20) },
          recovery: 'inspect the conflicting files; roll back manually or create a new plan',
        });
      }
      const rbId = newId('cs');
      this.store.createChangeset({
        id: rbId,
        workspaceId: opts.workspaceId,
        epoch: opts.epoch,
        planId: null,
        principal: opts.principal,
        kind: 'rollback',
        summary: `rollback of ${cs.id}`,
      });
      const restored: string[] = [];
      try {
        for (const s of [...steps].reverse()) {
          const abs = this.wfs.absOf(s.path);
          this.store.addJournalStep({ ...s, changesetId: rbId, state: 'pending' });
          switch (s.op) {
            case 'create':
              retryWindowsFs(() => fs.unlinkSync(abs));
              break;
            case 'modify':
              copyFileSyncDurable(s.backupPath as string, abs, statMode(abs) ?? 0o644);
              break;
            case 'delete':
              copyFileSyncDurable(s.backupPath as string, abs, 0o644);
              break;
            case 'move': {
              renameWithRetry(this.wfs.absOf(s.destPath as string), abs);
              break;
            }
          }
          this.store.setJournalStepState(rbId, s.seq, 'done');
          restored.push(s.path);
        }
      } catch (err) {
        this.store.setChangesetStatus(rbId, 'recovery_required', `rollback interrupted: ${(err as Error).message}`);
        throw new DodoError('PARTIAL_RECOVERY_REQUIRED', 'rollback failed part-way; manual recovery required', {
          detail: { changesetId: rbId, restored },
          recovery: 'run `dodo recover` on the server terminal',
        });
      }
      const tx = this.store.db.transaction(() => {
        this.store.setChangesetStatus(rbId, 'committed');
        this.store.setChangesetStatus(cs.id, 'rolled_back');
      });
      tx();
      return { changesetId: rbId, restored };
    });
  }

  /** A saved journal is not permission to follow a newly introduced link,
   * junction, hardlink or NTFS alias. Revalidate before reading rollback hashes. */
  private assertGuardedFile(rel: string): void {
    const resolved = this.wfs.resolve(rel, { allowMissing: true });
    if (resolved.stat) this.wfs.assertRegularFileForDirectAccess(resolved);
  }

  private verifyRollbackable(s: JournalStepRow): FileConflict | undefined {
    try {
      this.assertGuardedFile(s.path);
      if (s.destPath) this.assertGuardedFile(s.destPath);
    } catch {
      return { path: s.path, reason: 'path policy changed after apply; rollback refused' };
    }
    const abs = this.wfs.absOf(s.path);
    switch (s.op) {
      case 'create':
        return hashFileAt(abs) === s.afterHash ? undefined : { path: s.path, reason: 'file changed after creation' };
      case 'modify':
        if (hashFileAt(abs) !== s.afterHash) return { path: s.path, reason: 'file changed after apply' };
        if (!s.backupPath || hashFileAt(s.backupPath) !== s.beforeHash) return { path: s.path, reason: 'backup missing or damaged' };
        return undefined;
      case 'delete':
        if (hashFileAt(abs) !== null) return { path: s.path, reason: 'a new file exists at the deleted path' };
        if (!s.backupPath || hashFileAt(s.backupPath) !== s.beforeHash) return { path: s.path, reason: 'backup missing or damaged' };
        return undefined;
      case 'move': {
        const dest = this.wfs.absOf(s.destPath as string);
        if (hashFileAt(dest) !== s.afterHash) return { path: s.destPath as string, reason: 'moved file changed after apply' };
        if (hashFileAt(abs) !== null) return { path: s.path, reason: 'a new file exists at the original path' };
        return undefined;
      }
      default:
        return { path: s.path, reason: `unknown op ${s.op}` };
    }
  }

  /**
   * Boot reconciliation (spec §12.3): runs BEFORE any new mutation is
   * accepted. Bookkeeping-only transitions are automatic; anything ambiguous
   * becomes recovery_required and blocks mutations until `dodo recover`.
   * Files are never rewritten here.
   */
  reconcileOnBoot(): { failed: string[]; committed: string[]; recoveryRequired: string[] } {
    const out = { failed: [] as string[], committed: [] as string[], recoveryRequired: [] as string[] };
    for (const cs of this.store.listChangesetsByStatus('committing').filter(cs => cs.workspaceId === this.workspaceId)) {
      const steps = this.store.listJournalSteps(cs.id);
      const written = steps.filter((s) => s.state === 'written' || s.state === 'done');
      if (written.length === 0) {
        this.store.setChangesetStatus(cs.id, 'failed', 'interrupted before any write');
        out.failed.push(cs.id);
        continue;
      }
      const allWrittenVerify = steps.every((s) => {
        if (s.state !== 'written' && s.state !== 'done') return false;
        const rel = s.op === 'move' ? s.destPath as string : s.path;
        try { this.assertGuardedFile(rel); }
        catch { return false; }
        return hashFileAt(this.wfs.absOf(rel)) === s.afterHash;
      });
      if (allWrittenVerify) {
        this.store.setChangesetStatus(cs.id, 'committed');
        out.committed.push(cs.id);
      } else {
        this.store.setChangesetStatus(cs.id, 'recovery_required', 'interrupted mid-apply; on-disk state is mixed');
        out.recoveryRequired.push(cs.id);
      }
    }
    return out;
  }
}

function statMode(abs: string): number | undefined {
  try {
    return fs.statSync(abs).mode & 0o777;
  } catch {
    return undefined;
  }
}

export function hashFileAt(abs: string): string | null {
  try {
    const st = fs.lstatSync(abs);
    if (!st.isFile()) return null;
    return sha256Bytes(fs.readFileSync(abs));
  } catch {
    return null;
  }
}

function writeFileAtomic(abs: string, bytes: Buffer, mode: number, opts: { mustNotExist: boolean }): void {
  if (opts.mustNotExist && fs.existsSync(abs)) {
    throw new DodoError('CONFLICT', 'target appeared before write', { detail: { path: abs } });
  }
  const dir = path.dirname(abs);
  const tmp = path.join(dir, `.dodo-tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`);
  const fd = fs.openSync(tmp, 'wx', mode);
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    renameWithRetry(tmp, abs);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
  fsyncDir(dir);
}

function copyFileSyncDurable(src: string, dest: string, mode?: number): void {
  const bytes = fs.readFileSync(src);
  const dir = path.dirname(dest);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.dodo-tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`);
  const fd = fs.openSync(tmp, 'wx', mode ?? 0o600);
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  renameWithRetry(tmp, dest);
  fsyncDir(dir);
}

function fsyncDir(dir: string): void {
  // Windows does not expose POSIX directory fsync through this Node adapter.
  if (process.platform === 'win32') return;
  // Directory fsync is a platform capability, not a guarantee (spec §12.2).
  try {
    const fd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    /* best effort */
  }
}
