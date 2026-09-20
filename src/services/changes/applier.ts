import { rootIdentity } from '../recovery/storage.js';
import fs from 'node:fs';
import path from 'node:path';
import { DodoError } from '../../errors.js';
import type { WorkspaceFS } from '../../workspace/fs.js';
import type { Limits } from '../../config/limits.js';
import type { Store, ChangesetRow, JournalStepRow } from '../../store/store.js';
import { sha256Bytes, newId, digestOf } from '../../util/hash.js';
import type { StoredPlan, PlanFileChange, FileConflict } from './types.js';
import { retryWindowsFs } from '../../platform/fsRetry.js';
import { assertPrivatePath, ensurePrivateDirectory } from '../../platform/privateFs.js';

interface ApplyInput { planId: string; planHash: string; workspaceId: string; epoch: string; principal: string }

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
  beforeMutation?: (opts: ApplyInput, files: PlanFileChange[]) => Promise<void>;
  /** Invoked in the journal transaction, BEFORE a source write can happen. */
  onChangeset?: (changesetId: string) => void;
  onCommitted?: (files: PlanFileChange[]) => void;

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

  async apply(opts: ApplyInput): Promise<ApplyOutcome> {
    return this.withMutationLock(() => this.applyLocked(opts));
  }

  async applyRecovery(opts: ApplyInput): Promise<ApplyOutcome> {
    return this.withMutationLock(() => this.applyLocked(opts, undefined, true));
  }

  private async applyLocked(opts: ApplyInput, rollbackOf?: string, recovery = false): Promise<ApplyOutcome> {
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
    if (row.planHash !== opts.planHash || digestOf({planId: row.id, payload: row.payload}) !== row.planHash) {
      throw new DodoError('PLAN_HASH_MISMATCH', 'planHash does not match the stored immutable plan');
    }
    const plan = JSON.parse(row.payload) as StoredPlan;
    if (plan.source === 'restore' && !recovery) throw new DodoError('FORBIDDEN', 'use restore_apply for a reviewed recovery plan');

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

    await this.beforeMutation?.(opts, plan.files);
    // Capture is asynchronous; hashes must still match before creating the journal.
    if (plan.files.some(f => this.verifyPreState(f))) throw new DodoError('FILE_CHANGED', 'workspace changed while backing up; preview again');
    const changesetId = newId('cs');
    const csBackupDir = path.join(this.backupsDir, changesetId);
    ensurePrivateDirectory(this.backupsDir);
    ensurePrivateDirectory(csBackupDir);
    const tx = this.store.db.transaction(() => {
      this.store.createChangeset({
        id: changesetId,
        workspaceId: opts.workspaceId,
        epoch: opts.epoch,
        planId: opts.planId,
        principal: opts.principal,
        kind: rollbackOf ? 'rollback' : 'apply',
        summary: plan.summary,
      });
      this.store.setMeta(`journal-v2:${changesetId}`, rollbackOf ?? 'apply');
      this.onChangeset?.(changesetId);
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
        if (f.beforeHash !== null && f.action!=='rmdir') {
          const backupPath = path.join(csBackupDir, `${seq}.bin`);
          const current = this.readGuarded(f.path);
          if (sha256Bytes(current) !== f.beforeHash) throw new DodoError('FILE_CHANGED', 'file changed while preparing backup');
          writeFileAtomic(backupPath, current, 0o600, { mustNotExist: true });
          this.readBackup(this.store.listJournalSteps(changesetId)[seq]!, f.beforeHash);
        }
        this.store.setJournalStepState(changesetId, seq, 'backed_up');
      }
      for (const step of this.store.listJournalSteps(changesetId)) {
        if (step.beforeHash !== null && step.op!=='rmdir') this.readBackup(step, step.beforeHash);
      }
    } catch (err) {
      this.store.setChangesetStatus(changesetId, 'failed', 'backup preparation failed; no source writes started');
      if (err instanceof DodoError) throw err;
      throw new DodoError('RESOURCE_LIMIT', 'could not persist backups; nothing was changed', {
        recovery: 'check disk space and permissions for the DODO state directory',
      });
    }

    // Phase 2: apply each file with per-file atomic rename where possible.
    const applied: number[] = [];
    // Do not write the first file if any later file drifted during backup.
    if (plan.files.some(f => this.verifyPreState(f))) {
      this.store.setChangesetStatus(changesetId, 'failed', 'source changed during backup');
      throw new DodoError('FILE_CHANGED', 'source changed during backup; preview again');
    }
    for (let seq = 0; seq < plan.files.length; seq += 1) {
      const f = plan.files[seq] as PlanFileChange;
      try {
        const conflict = this.verifyPreState(f);
        if (conflict) throw new DodoError('FILE_CHANGED', 'source changed before write', { detail: { path: f.path } });
        if (f.beforeHash !== null && f.action!=='rmdir') this.readBackup(this.store.listJournalSteps(changesetId)[seq]!, f.beforeHash);
        // The persisted written state denotes write INTENT; done verifies bytes.
        // Reuse existing states so older readers fail closed on incomplete IO.
        // Durable intent precedes the syscall: a crash can occur after rename
        // but before the following SQLite update, including on the first file.
        this.store.setJournalStepState(changesetId, seq, 'written');
        applied.push(seq);
        this.applyOne(f);
        if(f.action==='mkdir')this.store.setMeta(`journal-directory:${changesetId}:${seq}`,f.createdDirectoryIdentity!);
        if (!this.matchesState(f, false)) throw new DodoError('FILE_CHANGED', 'post-write verification failed');
        this.store.setJournalStepState(changesetId, seq, 'done');
      } catch (err) {
        const revert = this.revertSteps(plan, applied, changesetId);
        if (revert.conflicts.length === 0) {
          this.store.setChangesetStatus(changesetId, 'failed', 'apply failed; attempted changes reverted');
          throw err instanceof DodoError
            ? err
            : new DodoError('INTERNAL_ERROR', `apply failed at ${f.path}`, { detail: { path: f.path }, cause: err });
        }
        this.store.setChangesetStatus(changesetId, 'recovery_required', `apply failed at ${f.path}; revert incomplete`);
        throw new DodoError('PARTIAL_RECOVERY_REQUIRED', 'apply failed and automatic revert could not restore every file', {
          detail: { changesetId, unrecovered: revert.conflicts.slice(0, 20) },
          recovery: 'run `dodo recover` on the server terminal; backups are in the DODO state directory',
        });
      }
    }

    if (plan.files.some(f => !this.matchesState(f, false))) {
      this.store.setChangesetStatus(changesetId, 'recovery_required', 'source changed before final verification');
      throw new DodoError('PARTIAL_RECOVERY_REQUIRED', 'final verification failed; preserve newer edits and inspect recovery');
    }

    const done = this.store.db.transaction(() => {
      for (let seq = 0; seq < plan.files.length; seq += 1) this.store.setJournalStepState(changesetId, seq, 'done');
      this.onCommitted?.(plan.files);
      this.store.setChangesetStatus(changesetId, 'committed');
      this.store.invalidatePlan(opts.planId);
      if (rollbackOf) this.store.setChangesetStatus(rollbackOf, 'rolled_back');
    });
    try{done();}catch{
      try{this.store.setChangesetStatus(changesetId,'recovery_required','final journal/expected-state transaction could not be confirmed');}catch{/* a committing row also blocks further writes until reconciliation */}
      throw new DodoError('PARTIAL_RECOVERY_REQUIRED','source writes occurred but final journal persistence failed; inspect recovery before retrying',{detail:{changesetId}});
    }

    return {
      changesetId,
      files: plan.files.map((f) => {
        const out: ApplyOutcome['files'][number] = { path: f.path, action: f.action, afterHash: f.afterHash };
        if (f.destPath !== undefined) out.destPath = f.destPath;
        return out;
      }),
      rollbackAvailable: true,
    };
  }

  /** Stable, bounded read; final path and open descriptor must still agree. */
  private readGuarded(rel: string): Buffer {
    const resolved = this.wfs.resolve(rel);
    const before = this.wfs.assertRegularFileForDirectAccess(resolved);
    const fd = fs.openSync(resolved.abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const opened = fs.fstatSync(fd);
      if (!sameFile(before, opened) || !opened.isFile() || opened.nlink !== 1) throw new DodoError('FILE_CHANGED', 'file identity changed while opening');
      if (opened.size > this.limits.readFileBytes * 2) throw new DodoError('FILE_TOO_LARGE', 'recovery file exceeds byte limit');
      const bytes = fs.readFileSync(fd);
      const after = this.wfs.assertRegularFileForDirectAccess(this.wfs.resolve(rel));
      if (!sameFile(opened, fs.fstatSync(fd)) || !sameFile(opened, after)) throw new DodoError('FILE_CHANGED', 'file changed while reading');
      return bytes;
    } finally { fs.closeSync(fd); }
  }

  private guardedHash(rel: string): string | null {
    const resolved = this.wfs.resolve(rel, { allowMissing: true });
    if (!resolved.stat) return null;
    return sha256Bytes(this.readGuarded(rel));
  }

  private readBackup(step: JournalStepRow, expected: string): Buffer {
    if (!/^[\w-]+$/.test(step.changesetId)) throw new DodoError('CONFLICT', 'invalid backup identity');
    const dir = path.join(this.backupsDir, step.changesetId);
    const file = path.join(dir, `${step.seq}.bin`);
    if (step.backupPath !== file) throw new DodoError('CONFLICT', 'backup path does not match journal');
    assertPrivatePath(this.backupsDir, true);
    assertPrivatePath(dir, true);
    const st = assertPrivatePath(file);
    if (st.size > this.limits.readFileBytes * 2) throw new DodoError('CONFLICT', 'backup exceeds byte limit');
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      if (!sameFile(st, fs.fstatSync(fd))) throw new DodoError('CONFLICT', 'backup identity changed');
      const bytes = fs.readFileSync(fd);
      if (!sameFile(st, fs.fstatSync(fd)) || !sameFile(st, assertPrivatePath(file)) || sha256Bytes(bytes) !== expected) {
        throw new DodoError('CONFLICT', 'backup missing, changed or damaged');
      }
      return bytes;
    } finally { fs.closeSync(fd); }
  }

  private matchesState(f: Pick<PlanFileChange, 'path' | 'destPath' | 'action' | 'beforeHash' | 'afterHash' | 'mode' | 'beforeMode' | 'directoryIdentity' | 'createdDirectoryIdentity'>, before: boolean): boolean {
    try {
      if(f.action==='mkdir'||f.action==='rmdir'){
        const r=this.wfs.resolve(f.path,{allowMissing:true});
        const absent=before?f.action==='mkdir':f.action==='rmdir';
        if(absent)return !r.stat;
        const identity=f.action==='mkdir'?f.createdDirectoryIdentity:f.directoryIdentity;
        return !!r.stat?.isDirectory()&&!!identity&&rootIdentity(r.abs)===identity&&(process.platform==='win32'||f.mode===undefined||(r.stat.mode&0o777)===(before?(f.beforeMode??f.mode):f.mode));
      }
      if (f.action === 'move') return this.guardedHash(f.path) === (before ? f.beforeHash : null)
        && this.guardedHash(f.destPath!) === (before ? null : f.afterHash);
      const mode=before?f.beforeMode:f.mode;
      if(mode!==undefined && process.platform!=='win32' && (before?f.beforeHash:f.afterHash)!==null && (this.wfs.resolve(f.path).stat!.mode&0o777)!==mode)return false;
      return this.guardedHash(f.path) === (before ? f.beforeHash : f.afterHash);
    } catch { return false; }
  }

  private verifyPreState(f: PlanFileChange): FileConflict | undefined {
    try {
      if (f.action === 'create' || f.action === 'mkdir') {
        const { missingParents } = this.wfs.resolveForCreate(f.path, (f.createParents?.length ?? 0) > 0);
        const expected = new Set(f.createParents ?? []);
        for (const p of missingParents) {
          if (!expected.has(p)) return { path: f.path, reason: `parent ${p} no longer exists` };
        }
        return undefined;
      }
      if(f.action==='rmdir'){
        const r=this.wfs.resolve(f.path);
        if(!r.stat?.isDirectory()||rootIdentity(r.abs)!==f.directoryIdentity)return {path:f.path,reason:'directory identity changed'};
        if(process.platform!=='win32'&&f.mode!==undefined&&(r.stat.mode&0o777)!==(f.beforeMode??f.mode))return {path:f.path,reason:'directory mode changed since preview'};
        if(fs.readdirSync(r.abs).some(n=>!f.directoryChildren?.includes(n)))return {path:f.path,reason:'directory contains unrelated entries'};
        return undefined;
      }
      if(f.beforeMode!==undefined && process.platform!=='win32' && (this.wfs.resolve(f.path).stat!.mode&0o777)!==f.beforeMode)return {path:f.path,reason:'file mode changed since preview'};
      const hash = sha256Bytes(this.readGuarded(f.path));
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
      case 'mkdir': {
        fs.mkdirSync(abs,{mode:f.mode??0o755});
        f.createdDirectoryIdentity=rootIdentity(abs);if(process.platform!=='win32')fs.chmodSync(abs,f.mode??0o755);fsyncDir(path.dirname(abs));break;
      }
      case 'rmdir': {
        if(fs.readdirSync(abs).length)throw new DodoError('FILE_CHANGED','directory is no longer empty');
        fs.rmdirSync(abs);fsyncDir(path.dirname(abs));break;
      }
      case 'create': {
        for (const dir of f.createParents ?? []) {
          const parent = this.wfs.resolve(dir, { allowMissing: true });
          if (parent.stat) {
            if (!parent.stat.isDirectory()) throw new DodoError('PATH_DENIED', 'planned parent is not a directory');
          } else fs.mkdirSync(parent.abs, { mode: 0o755 });
        }
        writeFileAtomic(abs, Buffer.from(f.afterContentB64 ?? '', 'base64'), f.mode ?? 0o644, { mustNotExist: true, beforeReplace: () => {
          if (this.verifyPreState(f)) throw new DodoError('FILE_CHANGED', 'create target changed before publish');
        } });
        break;
      }
      case 'modify': {
        writeFileAtomic(abs, Buffer.from(f.afterContentB64 ?? '', 'base64'), f.mode ?? 0o644, { mustNotExist: false, beforeReplace: () => {
          if (this.verifyPreState(f)) throw new DodoError('FILE_CHANGED', 'file changed before atomic replace');
        } });
        break;
      }
      case 'delete': {
        retryWindowsFs(() => {
          if(this.verifyPreState(f))throw new DodoError('FILE_CHANGED','file changed before delete retry');
          fs.unlinkSync(abs);
        });
        fsyncDir(path.dirname(abs));
        break;
      }
      case 'move': {
        const dest = this.wfs.absOf(f.destPath as string);
        retryWindowsFs(() => {
          if(this.verifyPreState(f))throw new DodoError('FILE_CHANGED','file changed before move retry');
          fs.renameSync(abs, dest);
        });
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
      try {
        if(f.action!=='mkdir'&&f.action!=='rmdir')this.assertGuardedFile(f.path);
        if (f.destPath) this.assertGuardedFile(f.destPath);
        // An attempted syscall may have failed before it changed anything.
        if (this.matchesState(f, true)) {
          this.store.setJournalStepState(changesetId, seq, 'reverted');
          continue;
        }
        const restore = () => {
          const step = this.store.listJournalSteps(changesetId).find(s => s.seq === seq)!;
          const bytes = this.readBackup(step, f.beforeHash!);
          writeFileAtomic(abs, bytes, f.beforeMode ?? f.mode ?? 0o644, { mustNotExist: f.action === 'delete', beforeReplace: () => {
            if (!this.matchesState(f, false)) throw new DodoError('FILE_CHANGED', 'file changed before compensation');
          } });
        };
        switch (f.action) {
          case 'mkdir': {
            if(!this.matchesState(f,false)||fs.readdirSync(abs).length)throw new DodoError('FILE_CHANGED','created directory changed; preserved');
            fs.rmdirSync(abs);fsyncDir(path.dirname(abs));break;
          }
          case 'rmdir': {
            if(!this.matchesState(f,false))throw new DodoError('FILE_CHANGED','directory reappeared; preserved');
            fs.mkdirSync(abs,{mode:f.beforeMode??f.mode??0o755});
            f.directoryIdentity=rootIdentity(abs);
            this.store.setMeta(`journal-directory-reverted:${changesetId}:${seq}`,f.directoryIdentity);
            if(process.platform!=='win32')fs.chmodSync(abs,f.beforeMode??f.mode??0o755);
            fsyncDir(path.dirname(abs));break;
          }
          case 'create': {
            if (this.guardedHash(f.path) === f.afterHash) {
              retryWindowsFs(() => {
                if(!this.matchesState(f,false))throw new DodoError('FILE_CHANGED','created file changed before compensation retry');
                fs.unlinkSync(abs);
              });
              fsyncDir(path.dirname(abs));
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
            if (this.guardedHash(f.path) === f.afterHash) {
              restore();
            } else {
              conflicts.push({ path: f.path, reason: 'file changed before revert' });
            }
            break;
          }
          case 'delete': {
            if (this.guardedHash(f.path) === null) {
              restore();
            } else {
              conflicts.push({ path: f.path, reason: 'a new file appeared at the deleted path' });
            }
            break;
          }
          case 'move': {
            const dest = this.wfs.absOf(f.destPath as string);
            if (this.guardedHash(f.destPath!) === f.afterHash && this.guardedHash(f.path) === null) {
              retryWindowsFs(() => {
                if(!this.matchesState(f,false))throw new DodoError('FILE_CHANGED','moved file changed before compensation retry');
                fs.renameSync(dest, abs);
              });
              fsyncDir(path.dirname(abs));
              if (path.dirname(dest) !== path.dirname(abs)) fsyncDir(path.dirname(dest));
            } else {
              conflicts.push({ path: f.path, reason: 'moved file changed before revert' });
            }
            break;
          }
        }
        if (!this.matchesState(f, true)) throw new DodoError('FILE_CHANGED', 'compensation verification failed');
        this.store.setJournalStepState(changesetId, seq, 'reverted');
      } catch (err) {
        conflicts.push({ path: f.path, reason: err instanceof DodoError ? err.message : 'revert failed' });
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
    return this.withMutationLock(() => this.rollbackLocked(opts, false));
  }

  /** Private owner administration only. Never expose an owner flag in MCP input. */
  async rollbackAsOwner(opts: { changesetId: string; workspaceId: string; epoch: string; principal: string }): Promise<{ changesetId: string; restored: string[] }> {
    return this.withMutationLock(() => this.rollbackLocked(opts, true));
  }

  private async rollbackLocked(opts: { changesetId: string; workspaceId: string; epoch: string; principal: string }, owner: boolean): Promise<{ changesetId: string; restored: string[] }> {
    if (this.recoveryBlocked()) throw new DodoError('RECOVERY_REQUIRED', 'resolve pending recovery before rollback');
    const cs = this.store.getChangeset(opts.changesetId);
    if (!cs || cs.workspaceId !== opts.workspaceId || cs.workspaceId !== this.workspaceId) throw new DodoError('NOT_FOUND', 'unknown changesetId');
    if (!owner && cs.principal !== opts.principal) throw new DodoError('FORBIDDEN', 'changeset belongs to a different principal; ask the owner to recover it');
    if (cs.kind !== 'apply') throw new DodoError('INVALID_INPUT', 'only apply changesets can be rolled back');
    if (cs.status !== 'committed') throw new DodoError('CONFLICT', 'changeset is not committed');
    const steps = this.store.listJournalSteps(cs.id);
    if(steps.some(s=>s.op==='mkdir'||s.op==='rmdir'))throw new DodoError('NOT_SUPPORTED','preview the recovery session/checkpoint to restore directory changes');
    if (steps.length === 0) throw new DodoError('CONFLICT', 'changeset journal is empty');
    const conflicts = steps.map(s => this.verifyRollbackable(s)).filter((c): c is FileConflict => c !== undefined);
    if (conflicts.length) throw new DodoError('CONFLICT', 'files or backups changed; rollback refused', { detail: { conflicts: conflicts.slice(0, 20) } });
    const original = cs.planId ? this.store.getPlan(cs.planId) : undefined;
    const originalFiles = original ? (JSON.parse(original.payload) as StoredPlan).files : [];
    // Express restore as a NEW forward plan. Its journal records the actual
    // restore direction and its backups contain the pre-restore bytes.
    const files: PlanFileChange[] = [...steps].reverse().map(s => {
      const bytes = s.beforeHash === null ? undefined : this.readBackup(s, s.beforeHash);
      const mode = originalFiles.find(f => f.path === s.path)?.mode ?? 0o644;
      const common = { diff: '', diffTruncated: false, mode, bytesBefore: 0, bytesAfter: bytes?.length ?? 0 };
      switch (s.op) {
        case 'create': return { ...common, path: s.path, action: 'delete', beforeHash: s.afterHash, afterHash: null };
        case 'modify': return { ...common, path: s.path, action: 'modify', beforeHash: s.afterHash, afterHash: s.beforeHash, afterContentB64: bytes!.toString('base64') };
        case 'delete': return { ...common, path: s.path, action: 'create', beforeHash: null, afterHash: s.beforeHash, afterContentB64: bytes!.toString('base64') };
        case 'move': return { ...common, path: s.destPath!, destPath: s.path, action: 'move', beforeHash: s.afterHash, afterHash: s.beforeHash };
        default: throw new DodoError('CONFLICT', 'unknown journal operation');
      }
    });
    const payload: StoredPlan = { version: 1, workspaceId: opts.workspaceId, epoch: opts.epoch, principal: opts.principal, source: 'direct', files, summary: `rollback of ${cs.id}` };
    const planId = newId('plan');
    const planHash = digestOf({ planId, payload: JSON.stringify(payload) });
    this.store.putPlan({ id: planId, workspaceId: opts.workspaceId, epoch: opts.epoch, principal: opts.principal, planHash, payload: JSON.stringify(payload), ttlMs: 60_000 });
    const result = await this.applyLocked({ ...opts, planId, planHash }, cs.id);
    return { changesetId: result.changesetId, restored: steps.map(s => s.path) };
  }

  /** A saved journal is not permission to follow a newly introduced link,
   * junction, hardlink or NTFS alias. Revalidate before reading rollback hashes. */
  private assertGuardedFile(rel: string): void {
    const resolved = this.wfs.resolve(rel, { allowMissing: true });
    if (resolved.stat) this.wfs.assertRegularFileForDirectAccess(resolved);
  }

  private verifyRollbackable(s: JournalStepRow): FileConflict | undefined {
    try {
      if (!['create', 'modify', 'delete', 'move'].includes(s.op)) return { path: s.path, reason: 'unknown journal operation' };
      if (!this.matchesState({ path: s.path, beforeHash: s.beforeHash, afterHash: s.afterHash, action: s.op as PlanFileChange['action'], ...(s.destPath ? { destPath: s.destPath } : {}) }, false)) {
        return { path: s.path, reason: 'path policy or content changed after apply' };
      }
      if (s.beforeHash !== null) this.readBackup(s, s.beforeHash);
      return undefined;
    } catch { return { path: s.path, reason: 'backup missing, damaged or inaccessible' }; }
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
      const marker = this.store.getMeta(`journal-v2:${cs.id}`);
      // Historical rollback rows used forward hashes; infer nothing from them.
      const original = cs.kind === 'rollback' && marker ? this.store.getChangeset(marker) : undefined;
      const knownDirection = cs.kind === 'apply' || (original?.workspaceId === cs.workspaceId && original?.kind === 'apply');
      const originalPlan=cs.planId?this.store.getPlan(cs.planId):undefined;
      const planned:PlanFileChange[]=originalPlan?(JSON.parse(originalPlan.payload) as StoredPlan).files:[];
      const asFile = (s: JournalStepRow) => ({ ...planned[s.seq],
        ...(this.store.getMeta(`journal-directory:${cs.id}:${s.seq}`)?{createdDirectoryIdentity:this.store.getMeta(`journal-directory:${cs.id}:${s.seq}`)!}:{}),
        ...(this.store.getMeta(`journal-directory-reverted:${cs.id}:${s.seq}`)?{directoryIdentity:this.store.getMeta(`journal-directory-reverted:${cs.id}:${s.seq}`)!}:{}), path: s.path, action: s.op as PlanFileChange['action'], beforeHash: s.beforeHash, afterHash: s.afterHash, ...(s.destPath ? { destPath: s.destPath } : {}) });
      const allBefore = knownDirection && steps.length > 0 && steps.every(s => this.matchesState(asFile(s), true));
      const allAfter = knownDirection && steps.length > 0 && steps.every(s => {
        if (!['written', 'done'].includes(s.state) || !this.matchesState(asFile(s), false)) return false;
        try { if (s.beforeHash !== null && s.op!=='rmdir') this.readBackup(s, s.beforeHash); return true; } catch { return false; }
      });
      if (allAfter) {
        this.store.db.transaction(() => {
          for (const s of steps) this.store.setJournalStepState(cs.id, s.seq, 'done');
          this.store.setChangesetStatus(cs.id, 'committed');
          if (cs.planId) this.store.invalidatePlan(cs.planId);
          if (cs.kind === 'rollback' && marker) {
            this.store.setChangesetStatus(marker, 'rolled_back');
          }
        })();
        out.committed.push(cs.id);
      } else if (allBefore || (steps.length === 0 && cs.kind === 'apply')) {
        this.store.setChangesetStatus(cs.id, 'failed', 'interrupted; verified original state');
        out.failed.push(cs.id);
      } else {
        this.store.setChangesetStatus(cs.id, 'recovery_required', 'interrupted; state is mixed, changed or unverifiable');
        out.recoveryRequired.push(cs.id);
      }
    }
    return out;
  }
}

function sameFile(a: fs.Stats, b: fs.Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.nlink === b.nlink && a.size === b.size
    && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
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

function writeFileAtomic(abs: string, bytes: Buffer, mode: number, opts: { mustNotExist: boolean; beforeReplace?: () => void }): void {
  const dir = path.dirname(abs);
  const tmp = path.join(dir, `.dodo-tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`);
  try {
    const fd = fs.openSync(tmp, 'wx', mode);
    try { fs.writeFileSync(fd, bytes); if(process.platform!=='win32')fs.fchmodSync(fd,mode); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    if (opts.mustNotExist) {
      // Exclusive publication: rename would silently overwrite a new file.
      retryWindowsFs(() => {opts.beforeReplace?.();fs.linkSync(tmp, abs);});
      retryWindowsFs(() => fs.unlinkSync(tmp));
    } else retryWindowsFs(() => {opts.beforeReplace?.();fs.renameSync(tmp, abs);});
    fsyncDir(dir);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* already published or never created */ }
  }
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
  } catch (error) {
    // Unsupported directory fsync is a documented platform limitation;
    // disk-full and I/O failures must not be mistaken for durable success.
    const code = (error as NodeJS.ErrnoException).code;
    if (!['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'EISDIR'].includes(code ?? '')) throw error;
  }
}
