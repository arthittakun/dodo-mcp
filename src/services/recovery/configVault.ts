import fs from 'node:fs';
import path from 'node:path';
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { AppServices } from '../../tools/context.js';
import type { RecoveryService } from './recoveryService.js';
import { DodoError } from '../../errors.js';
import { digestOf, newId } from '../../util/hash.js';
import { assertPrivatePath } from '../../platform/privateFs.js';
import { rootIdentity } from './storage.js';
import { OSRecoveryKeys, type RecoveryKeyStore } from './configKeys.js';

const MAX_BYTES = 1024 * 1024;
const Definition = z.object({ name: z.string().min(1).max(80), path: z.string().min(1).max(1024),
  retention: z.number().int().min(2).max(100).default(10) }).strict();
interface Target { id: string; workspace_id: string; revision: number; enabled: number; payload: string; key_ref: string }
interface Backup { id: string; workspace_id: string; target_id: string; target_revision: number; key_ref: string; sealed: string; bytes: number; created_at: number }
interface Restore { id: string; targetId: string; targetRevision: number; backupId: string; epoch: string; root: string; expiresAt: number;
  keyRef: string; expectedMac: string; fileIdentity: string; backupDigest: string }
const fileIdentity = (s: fs.Stats) => `${s.dev}:${s.ino}:${s.birthtimeMs}`;

/** Explicit owner-only encrypted private-file backups. No source-tool/resource
 * export, plaintext state, session-key fallback, or automatic config reload. */
export class RecoveryConfigVault {
  private readonly keys: RecoveryKeyStore;
  constructor(private readonly s: AppServices, private readonly r: RecoveryService, keys?: RecoveryKeyStore) {
    this.keys = keys ?? new OSRecoveryKeys(s.wfs.root);
  }
  private get db() { return this.s.store.db; }
  private target(id: string): Target {
    this.r.assertProject();
    const row = this.db.prepare('SELECT * FROM recovery_config_targets WHERE id=? AND workspace_id=?').get(id, this.s.workspaceId) as Target | undefined;
    if (!row) throw new DodoError('NOT_FOUND', 'private config target unavailable'); return row;
  }
  private definition(target: Target) { return Definition.parse(JSON.parse(target.payload)); }
  private resolve(target: Target) {
    this.r.assertProject(); const rel = this.definition(target).path;
    if (this.s.wfs.normalizeRel(rel) !== rel || !this.s.wfs.ignores.isSecret(rel) || this.s.wfs.ignores.isProtected(rel))
      throw new DodoError('PATH_DENIED', 'config backup accepts only explicit project paths denied to source tools');
    let absolute = this.s.wfs.root;
    for (const [i, name] of rel.split('/').entries()) {
      absolute = path.join(absolute, name); const st = fs.lstatSync(absolute), real = fs.realpathSync.native(absolute);
      if (st.isSymbolicLink() || (process.platform === 'win32' ? real.toLowerCase() !== absolute.toLowerCase() : real !== absolute)
        || (i < rel.split('/').length - 1 && !st.isDirectory())) throw new DodoError('PATH_DENIED', 'private config path contains a link or alias');
    }
    // Owner must keep the original secret file private too. Never chmod the
    // workspace or silently grant another user access during restore.
    const stat = assertPrivatePath(absolute);
    if (stat.size > MAX_BYTES) throw new DodoError('RESOURCE_LIMIT', 'private config exceeds 1 MiB');
    return { absolute, stat };
  }
  private read(target: Target) {
    const file = this.resolve(target), fd = fs.openSync(file.absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    let bytes: Buffer | undefined, returned = false;
    try {
      const before = fs.fstatSync(fd);
      if (fileIdentity(before) !== fileIdentity(file.stat) || before.nlink !== 1 || before.size > MAX_BYTES) throw new DodoError('PATH_DENIED', 'private config identity changed');
      bytes = Buffer.alloc(before.size); let n = 0;
      while (n < bytes.length) { const count = fs.readSync(fd, bytes, n, bytes.length - n, n); if (!count) break; n += count; }
      const after = fs.fstatSync(fd), live = this.resolve(target).stat;
      if (n !== bytes.length || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || fileIdentity(live) !== fileIdentity(before)) {
        bytes.fill(0); throw new DodoError('FILE_CHANGED', 'private config changed while reading');
      }
      returned = true; return { bytes, stat: after };
    } finally { if (!returned) bytes?.fill(0); fs.closeSync(fd); }
  }
  private async createKey(revalidate: () => void) {
    const reference = 'recoverykey_' + randomBytes(16).toString('hex'), key = randomBytes(32);
    try { revalidate(); await this.keys.put(reference, key); revalidate(); return reference; }
    catch (e) { try { await this.keys.delete(reference); } catch { /* dedicated orphan reference only; never delete an older key */ } throw e; }
    finally { key.fill(0); }
  }
  list() {
    this.r.assertProject();
    const targets = (this.db.prepare('SELECT * FROM recovery_config_targets WHERE workspace_id=? ORDER BY id').all(this.s.workspaceId) as Target[])
      .map(t => ({ id: t.id, revision: t.revision, enabled: Boolean(t.enabled), definition: this.definition(t), keyStorage: 'os', plaintextExport: false }));
    const backups = this.db.prepare('SELECT id,target_id,bytes,created_at FROM recovery_config_backups WHERE workspace_id=? ORDER BY created_at DESC LIMIT 100').all(this.s.workspaceId);
    const restores=this.db.prepare('SELECT id,target_id,snapshot_id,before_id,state FROM recovery_config_restores WHERE workspace_id=? ORDER BY rowid DESC LIMIT 100').all(this.s.workspaceId);
    return { targets, backups, restores, sourceBackupIncludesSecrets: false, automaticRestart: false,
      retention: 'unreferenced_backups_only', referencedBackupsProtected: true, quotaBytes: 32 * 1024 * 1024 };
  }
  async configure(raw: unknown, revalidate: () => void) {
    const input = z.object({ targetId: z.string().max(128).optional(), expectedRevision: z.number().int().nonnegative(), enabled: z.boolean(),
      definition: Definition, confirmEncryptedPrivateBackup: z.literal(true) }).strict().parse(raw);
    return this.s.mutations!.run(async () => {
      this.r.assertProject(); revalidate(); const old = input.targetId ? this.target(input.targetId) : undefined;
      if ((old?.revision ?? 0) !== input.expectedRevision) throw new DodoError('CONFLICT', 'private config target revision changed');
      if (!old && this.list().targets.length >= 10) throw new DodoError('RESOURCE_LIMIT', 'private config target limit reached');
      if (old && this.definition(old).path !== input.definition.path) throw new DodoError('CONFLICT', 'create a separate target for a different private file');
      const target: Target = { id: old?.id ?? newId('configtarget'), workspace_id: this.s.workspaceId, revision: input.expectedRevision + 1,
        enabled: Number(input.enabled), payload: JSON.stringify(input.definition), key_ref: old?.key_ref ?? '' };
      // Disabling an already registered missing file must remain possible.
      if (input.enabled || !old) this.resolve(target);
      if (!target.key_ref) target.key_ref = await this.createKey(revalidate);
      else if (input.enabled) { const key = await this.keys.get(target.key_ref); key.fill(0); }
      revalidate();
      this.db.prepare(`INSERT INTO recovery_config_targets VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,
        enabled=excluded.enabled,payload=excluded.payload`).run(target.id, target.workspace_id, target.revision, target.enabled, target.payload, target.key_ref);
      // Owner lowering the separate retention can release ciphertext quota.
      // Plans/receipts always retain their source and pre-restore backups.
      this.prune(target);
      this.audit('configure', target.id, digestOf(input)); return { id: target.id, revision: target.revision, enabled: input.enabled, keyStorage: 'os' };
    });
  }
  private async seal(target: Target, bytes: Buffer, revalidate: () => void): Promise<string> {
    const used = (this.db.prepare('SELECT COALESCE(SUM(bytes),0) n FROM recovery_config_backups WHERE workspace_id=?').get(this.s.workspaceId) as { n: number }).n;
    if (used + bytes.length > 32 * 1024 * 1024) throw new DodoError('RESOURCE_LIMIT', 'encrypted private config quota reached; review retention first');
    const id = newId('configbackup'), key = await this.keys.get(target.key_ref), iv = randomBytes(12);
    const header = { version: 1, id, workspaceId: this.s.workspaceId, root: rootIdentity(this.s.wfs.root), targetId: target.id, targetRevision: target.revision, keyRef: target.key_ref };
    try {
      revalidate(); const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(Buffer.from(JSON.stringify(header)));
      const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
      const sealed = JSON.stringify({ header, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: encrypted.toString('base64') });
      revalidate(); this.db.prepare('INSERT INTO recovery_config_backups VALUES (?,?,?,?,?,?,?,?)').run(id, this.s.workspaceId, target.id, target.revision, target.key_ref, sealed, bytes.length, Date.now());
      return id;
    } finally { key.fill(0); }
  }
  private backupRow(id: string): Backup {
    const row = this.db.prepare('SELECT * FROM recovery_config_backups WHERE id=? AND workspace_id=?').get(id, this.s.workspaceId) as Backup | undefined;
    if (!row) throw new DodoError('NOT_FOUND', 'encrypted private backup unavailable'); return row;
  }
  private async open(row: Backup, target: Target, revalidate: () => void) {
    const key = await this.keys.get(row.key_ref);
    try {
      revalidate(); const data = z.object({ header: z.object({ version: z.literal(1), id: z.literal(row.id), workspaceId: z.literal(this.s.workspaceId), root: z.literal(rootIdentity(this.s.wfs.root)),
        targetId: z.literal(target.id), targetRevision: z.literal(row.target_revision), keyRef: z.literal(row.key_ref) }).strict(),
        iv: z.string().max(24), tag: z.string().max(32), ciphertext: z.string().max(2 * MAX_BYTES) }).strict().parse(JSON.parse(row.sealed));
      if (row.target_id !== target.id || row.bytes > MAX_BYTES) throw new Error();
      const iv = Buffer.from(data.iv, 'base64'), tag = Buffer.from(data.tag, 'base64');
      if (iv.length !== 12 || tag.length !== 16) throw new Error();
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAAD(Buffer.from(JSON.stringify(data.header))); decipher.setAuthTag(tag);
      const partial = decipher.update(Buffer.from(data.ciphertext, 'base64'));
      let bytes: Buffer | undefined, returned = false;
      try { bytes = Buffer.concat([partial, decipher.final()]); if (bytes.length !== row.bytes) throw new Error(); revalidate(); returned = true; return bytes; }
      finally { partial.fill(0); if (!returned) bytes?.fill(0); }
    } catch { throw new DodoError('RECOVERY_REQUIRED', 'encrypted backup integrity or current authority could not be verified; plaintext withheld'); }
    finally { key.fill(0); }
  }
  async backup(targetId: string, revalidate: () => void) {
    return this.s.mutations!.run(async () => {
      revalidate(); const target = this.target(targetId);
      if (!target.enabled) throw new DodoError('FORBIDDEN', 'private config backup is disabled');
      const current = this.read(target);
      try { const id = await this.seal(target, current.bytes, revalidate); this.audit('backup', id, digestOf({ targetId })); this.prune(target); return { id, bytes: current.bytes.length, encrypted: true }; }
      finally { current.bytes.fill(0); }
    });
  }
  private prune(target: Target) {
    const rows = this.db.prepare('SELECT id FROM recovery_config_backups WHERE target_id=? ORDER BY created_at DESC,id DESC').all(target.id) as Array<{ id: string }>;
    for (const row of rows.slice(this.definition(target).retention)) {
      if (this.db.prepare('SELECT 1 FROM recovery_config_restores WHERE snapshot_id=? OR before_id=? LIMIT 1').get(row.id, row.id)) continue;
      this.db.prepare('DELETE FROM recovery_config_backups WHERE id=?').run(row.id);
    }
  }
  async rotate(targetId: string, expectedRevision: number, revalidate: () => void) {
    return this.s.mutations!.run(async () => {
      revalidate(); const target = this.target(targetId);
      if (target.revision !== expectedRevision) throw new DodoError('CONFLICT', 'private config target revision changed');
      const reference = await this.createKey(revalidate); revalidate();
      this.db.prepare('UPDATE recovery_config_targets SET key_ref=?,revision=revision+1 WHERE id=?').run(reference, target.id);
      this.audit('rotate', target.id, digestOf({ expectedRevision }));
      return { targetId, revision: expectedRevision + 1, oldBackupsKeepOldOSKeys: true, oldBackupsReencrypted: false };
    });
  }
  async preview(backupId: string, revalidate: () => void) {
    return this.s.mutations!.run(async () => {
      revalidate();
      if((this.db.prepare('SELECT COUNT(*) n FROM recovery_config_restores WHERE workspace_id=?').get(this.s.workspaceId) as {n:number}).n>=1000)throw new DodoError('RESOURCE_LIMIT','private config restore history limit reached');
      const backup = this.backupRow(backupId), target = this.target(backup.target_id);
      if (!target.enabled) throw new DodoError('FORBIDDEN', 'private config target is disabled');
      let desired: Buffer | undefined, current: ReturnType<RecoveryConfigVault['read']> | undefined, key: Buffer | undefined;
      try {
        desired = await this.open(backup, target, revalidate); current = this.read(target); key = await this.keys.get(target.key_ref);
        revalidate(); const plan: Restore = { id: newId('configrestore'), targetId: target.id, targetRevision: target.revision, backupId,
          epoch: this.s.epoch, root: rootIdentity(this.s.wfs.root), expiresAt: Date.now() + 10 * 60000, keyRef: target.key_ref,
          expectedMac: createHmac('sha256', key).update(current.bytes).digest('hex'), fileIdentity: fileIdentity(current.stat), backupDigest: digestOf(backup.sealed) };
        const planHash = digestOf(plan);
        this.db.prepare("INSERT INTO recovery_config_restores VALUES (?,?,?,?,NULL,?,?,'PREVIEW',NULL)").run(plan.id, this.s.workspaceId, target.id, backup.id, JSON.stringify(plan), planHash);
        return { planId: plan.id, planHash, expiresAt: plan.expiresAt, targetId: target.id, changed: !current.bytes.equals(desired),
          bytesBefore: current.bytes.length, bytesAfter: desired.length, plaintext: 'REDACTED', encryptedPreRestoreBackupRequired: true,
          restartRequired: 'owner_managed', writeMode: 'single_existing_private_file_journaled_in_place' };
      } finally { current?.bytes.fill(0); desired?.fill(0); key?.fill(0); }
    });
  }
  async apply(planId: string, planHash: string, revalidate: () => void) {
    return this.s.mutations!.run(async () => {
      revalidate(); this.r.assertProject();
      const row = this.db.prepare('SELECT * FROM recovery_config_restores WHERE id=? AND workspace_id=?').get(planId, this.s.workspaceId) as { payload: string; hash: string; state: string; result: string | null } | undefined;
      if (!row) throw new DodoError('NOT_FOUND', 'private config restore unavailable');
      const plan = JSON.parse(row.payload) as Restore;
      if (digestOf(plan) !== row.hash || row.hash !== planHash) throw new DodoError('PLAN_HASH_MISMATCH', 'review exact private config restore');
      if (row.state !== 'PREVIEW') return { state: row.state, outcome: row.result ? JSON.parse(row.result) as object : null, replayed: true };
      const target = this.target(plan.targetId), backup = this.backupRow(plan.backupId);
      if (!target.enabled || target.revision !== plan.targetRevision || target.key_ref !== plan.keyRef || plan.epoch !== this.s.epoch || plan.expiresAt < Date.now()
        || plan.root !== rootIdentity(this.s.wfs.root) || digestOf(backup.sealed) !== plan.backupDigest) throw new DodoError('CONFLICT', 'private config plan or authority changed; preview again');
      let desired: Buffer | undefined, current: ReturnType<RecoveryConfigVault['read']> | undefined, key: Buffer | undefined;
      let fd: number | undefined, started = false;
      try {
        desired = await this.open(backup, target, revalidate); current = this.read(target); key = await this.keys.get(target.key_ref);
        if (fileIdentity(current.stat) !== plan.fileIdentity || createHmac('sha256', key).update(current.bytes).digest('hex') !== plan.expectedMac)
          throw new DodoError('FILE_CHANGED', 'private config changed after preview');
        const beforeId = await this.seal(target, current.bytes, revalidate), file = this.resolve(target);
        fd = fs.openSync(file.absolute, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0)); const opened = fs.fstatSync(fd);
        if (fileIdentity(opened) !== plan.fileIdentity || opened.nlink !== 1 || opened.size !== current.stat.size || opened.mtimeMs !== current.stat.mtimeMs || opened.ctimeMs !== current.stat.ctimeMs)
          throw new DodoError('FILE_CHANGED', 'private config changed before write');
        revalidate();
        this.db.prepare("UPDATE recovery_config_restores SET before_id=?,state='UNKNOWN',result=? WHERE id=?").run(beforeId, JSON.stringify({ retryAllowed: false, reason: 'write_may_have_started', encryptedBeforeId:beforeId }), plan.id);
        started = true;
        let n = 0; while (n < desired.length) { const count = fs.writeSync(fd, desired, n, desired.length - n, n); if (!count) throw new Error('short config write'); n += count; }
        fs.ftruncateSync(fd, desired.length); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
        revalidate(); const verified = this.read(target);
        try { if (!verified.bytes.equals(desired)) throw new DodoError('FILE_CHANGED', 'private config read-back differs'); }
        finally { verified.bytes.fill(0); }
        const outcome = { verified: true, encryptedBeforeId: beforeId, restarted: false };
        this.db.prepare("UPDATE recovery_config_restores SET state='APPLIED',result=? WHERE id=?").run(JSON.stringify(outcome), plan.id);
        this.audit('restore', plan.id, planHash); return { state: 'APPLIED', outcome, replayed: false };
      } catch (e) {
        if (!started) throw e;
        return { state: 'UNKNOWN', retryAllowed: false, recovery: 'inspect the private file locally; a new reviewed restore may use the encrypted pre-restore backup', replayed: false };
      } finally { try { if (fd !== undefined) fs.closeSync(fd); } finally { current?.bytes.fill(0); desired?.fill(0); key?.fill(0); } }
    });
  }
  reconcile() {
    // UNKNOWN is written before the first byte: never repeat it after restart.
    this.db.prepare("UPDATE recovery_config_restores SET state='EXPIRED' WHERE workspace_id=? AND state='PREVIEW' AND json_extract(payload,'$.epoch')<>?").run(this.s.workspaceId, this.s.epoch);
  }
  private audit(action: string, id: string, digest: string) {
    this.s.store.audit({ principal: 'local-config-owner', workspaceId: this.s.workspaceId, tool: `recovery.config.${action}`, refId: id, inputDigest: digest, result: 'encrypted_owner_action' });
  }
}
