import fs from 'node:fs';
import Database from 'better-sqlite3';
import { z } from 'zod';
import type { AppServices } from '../../tools/context.js';
import type { RecoveryService } from './recoveryService.js';
import { DodoError } from '../../errors.js';
import { digestOf, newId } from '../../util/hash.js';

const identifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/);
const migrationId = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.-]+$/);
export const DatabaseTargetSchema = z.object({
  name: z.string().min(1).max(80), adapter: z.literal('sqlite-migration-table'),
  databaseFile: z.string().min(1).max(1024).regex(/\.(?:db|sqlite|sqlite3)$/i),
  table: identifier, column: identifier,
  onMismatch: z.enum(['block', 'warn']).default('block'),
}).strict();
type Definition = z.infer<typeof DatabaseTargetSchema>;
interface Row { id: string; workspace_id: string; revision: number; enabled: number; definition: string; file_identity: string }
interface Binding { target_revision: number; manifest_hash: string; expected_ids: string; allow_extra: number }
interface Observation { targetId: string; revision: number; state: 'COMPATIBLE' | 'INCOMPATIBLE' | 'UNKNOWN'; reason: string;
  blocking: boolean; appliedDigest?: string; appliedCount?: number; requiredCount?: number }
const identity = (s: fs.Stats) => `${s.dev}:${s.ino}:${s.birthtimeMs}`;

/** Read-only metadata adapter, never a generic SQL executor or database undo. */
export class RecoveryDatabases {
  constructor(private readonly s: AppServices, private readonly r: RecoveryService) {}
  private get db() { return this.s.store.db; }
  private file(definition: Definition, expected?: string) {
    const rel = this.s.wfs.normalizeRel(definition.databaseFile);
    if (rel !== definition.databaseFile) throw new DodoError('PATH_DENIED', 'database path must be canonical and project-relative');
    const file = this.s.wfs.resolve(rel), st = file.stat;
    if (!st?.isFile() || st.nlink !== 1 || (expected && identity(st) !== expected))
      throw new DodoError('PATH_DENIED', 'registered database identity changed or is not a regular unlinked file');
    for(const suffix of ['-wal','-shm','-journal']){
      const side=this.s.wfs.resolve(rel+suffix,{allowMissing:true});
      if(side.stat&&(!side.stat.isFile()||side.stat.nlink!==1))throw new DodoError('PATH_DENIED','database sidecar is not a regular unlinked file');
    }
    return { ...file, stat: st };
  }
  private row(id: string): Row {
    this.r.assertProject();
    const row = this.db.prepare('SELECT * FROM recovery_database_targets WHERE id=? AND workspace_id=?').get(id, this.s.workspaceId) as Row | undefined;
    if (!row) throw new DodoError('NOT_FOUND', 'database target unavailable for this project'); return row;
  }
  list() {
    this.r.assertProject();
    return (this.db.prepare('SELECT * FROM recovery_database_targets WHERE workspace_id=? ORDER BY id').all(this.s.workspaceId) as Row[])
      .map(row => ({ id: row.id, revision: row.revision, enabled: Boolean(row.enabled), definition: DatabaseTargetSchema.parse(JSON.parse(row.definition)) }));
  }
  summary() {
    const count = (this.db.prepare('SELECT COUNT(*) AS n FROM recovery_database_targets WHERE workspace_id=? AND enabled=1').get(this.s.workspaceId) as { n: number }).n;
    return { configured: count > 0, targetCount: count, state: 'UNKNOWN', databaseRollback: 'NOT_SUPPORTED', mutationsPerformed: false };
  }
  private read(row: Row): string[] {
    const definition = DatabaseTargetSchema.parse(JSON.parse(row.definition));
    const before = this.file(definition, row.file_identity);
    // No URI options, credentials, extension loading, migrations or writable connection.
    const db = new Database(before.abs, { readonly: true, fileMustExist: true, timeout: 1000 });
    try {
      db.pragma('query_only=ON'); db.pragma('trusted_schema=OFF'); db.exec('BEGIN');
      const table = db.prepare('SELECT type,sql FROM sqlite_schema WHERE name=?').get(definition.table) as { type: string; sql: string } | undefined;
      if (!table || table.type !== 'table' || /CREATE\s+VIRTUAL\s+TABLE/i.test(table.sql)) throw new DodoError('NOT_SUPPORTED', 'migration metadata must be an ordinary SQLite table');
      // Identifiers are strictly parsed above; no user-supplied SQL clauses.
      const values = db.prepare(`SELECT m."${definition.column}" AS migration_id FROM "${definition.table}" AS m LIMIT 1001`).all() as Array<{ migration_id: unknown }>;
      if (values.length > 1000) throw new DodoError('RESOURCE_LIMIT', 'migration metadata exceeds the bounded adapter limit');
      const ids = values.map(value => migrationId.parse(value.migration_id));
      if (new Set(ids).size !== ids.length) throw new DodoError('CONFLICT', 'migration metadata contains duplicate IDs');
      db.exec('COMMIT');
      this.file(definition, row.file_identity);
      return ids.sort();
    } catch {
      throw new DodoError('RECOVERY_REQUIRED', 'migration metadata could not be verified; database contents and SQL errors are withheld');
    } finally { db.close(); }
  }
  /** Authenticated owner only; caller must supply a current owner lease. */
  async configure(raw: unknown, revalidate: () => void) {
    const input = z.object({ targetId: z.string().max(128).optional(), expectedRevision: z.number().int().nonnegative(),
      enabled: z.boolean(), confirmReadOnlyAccess: z.literal(true), definition: DatabaseTargetSchema }).strict().parse(raw);
    return this.s.mutations!.run(async () => {
      this.r.assertProject(); revalidate();
      const old = input.targetId ? this.row(input.targetId) : undefined;
      if ((old?.revision ?? 0) !== input.expectedRevision) throw new DodoError('CONFLICT', 'database target revision changed');
      if (!old && this.list().length >= 4) throw new DodoError('RESOURCE_LIMIT', 'database target limit reached');
      const file = this.file(input.definition), id = old?.id ?? newId('dbtarget'), revision = input.expectedRevision + 1;
      const row: Row = { id, workspace_id: this.s.workspaceId, revision, enabled: Number(input.enabled), definition: JSON.stringify(input.definition), file_identity: identity(file.stat) };
      if (input.enabled) this.read(row); // Readiness first; never save a false ready state.
      revalidate();
      this.db.prepare(`INSERT INTO recovery_database_targets VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,
        enabled=excluded.enabled,definition=excluded.definition,file_identity=excluded.file_identity`)
        .run(id, this.s.workspaceId, revision, row.enabled, row.definition, row.file_identity);
      this.audit('configure', id, digestOf(input)); return { id, revision, enabled: input.enabled, readOnly: true };
    });
  }
  inspectOwner(id: string, revalidate: () => void) {
    revalidate(); const row = this.row(id), ids = this.read(row); revalidate();
    return { targetId: id, revision: row.revision, appliedMigrationIds: ids, appliedDigest: digestOf(ids), databaseRollback: 'NOT_SUPPORTED' };
  }
  async bind(raw: unknown, revalidate: () => void) {
    const input = z.object({ targetId: z.string().max(128), expectedRevision: z.number().int().positive(), checkpointId: z.string().max(128),
      requiredMigrationIds: z.array(migrationId).max(1000), allowExtra: z.boolean().default(false), confirmCompatibilityRule: z.literal(true) }).strict().parse(raw);
    return this.s.mutations!.run(async () => {
      revalidate(); const row = this.row(input.targetId);
      if (!row.enabled || row.revision !== input.expectedRevision) throw new DodoError('CONFLICT', 'database target disabled or revision changed');
      if (new Set(input.requiredMigrationIds).size !== input.requiredMigrationIds.length) throw new DodoError('INVALID_INPUT', 'duplicate required migration ID');
      const manifest = await this.r.history.manifest(input.checkpointId, { id: 'local-config-owner', owner: true });
      revalidate();
      this.db.prepare(`INSERT INTO recovery_database_bindings VALUES (?,?,?,?,?,?) ON CONFLICT(target_id,snapshot_id) DO UPDATE SET
        target_revision=excluded.target_revision,manifest_hash=excluded.manifest_hash,expected_ids=excluded.expected_ids,allow_extra=excluded.allow_extra`)
        .run(row.id, manifest.id, row.revision, digestOf(manifest), JSON.stringify([...input.requiredMigrationIds].sort()), Number(input.allowExtra));
      this.audit('bind', row.id, digestOf(input)); return { targetId: row.id, checkpointId: manifest.id, requiredCount: input.requiredMigrationIds.length, ruleSource: 'explicit_owner', databaseChanged: false };
    });
  }
  async compatibility(snapshotIds: string[]) {
    this.r.assertProject();
    const rows = this.db.prepare('SELECT * FROM recovery_database_targets WHERE workspace_id=? AND enabled=1 ORDER BY id').all(this.s.workspaceId) as Row[];
    const items: Observation[] = [];
    for (const row of rows) {
      const definition = DatabaseTargetSchema.parse(JSON.parse(row.definition));
      let result: Observation = { targetId: row.id, revision: row.revision, state: 'UNKNOWN', reason: 'no_single_snapshot_compatibility_rule', blocking: definition.onMismatch === 'block' };
      try {
        if (snapshotIds.length === 1) {
          const binding = this.db.prepare('SELECT * FROM recovery_database_bindings WHERE target_id=? AND snapshot_id=?').get(row.id, snapshotIds[0]) as Binding | undefined;
          if (binding && binding.target_revision === row.revision) {
            const manifest = await this.r.history.manifest(snapshotIds[0]!, { id: 'local-config-owner', owner: true });
            if (binding.manifest_hash !== digestOf(manifest)) throw new DodoError('RECOVERY_REQUIRED', 'manifest binding changed');
            const applied = this.read(row), required = z.array(migrationId).max(1000).parse(JSON.parse(binding.expected_ids));
            const compatible = required.every(id => applied.includes(id)) && (Boolean(binding.allow_extra) || required.length === applied.length);
            result = { ...result, state: compatible ? 'COMPATIBLE' : 'INCOMPATIBLE', reason: compatible ? 'owner_rule_matches_applied_ids' : 'applied_ids_differ_from_owner_rule',
              blocking: !compatible && definition.onMismatch === 'block', appliedDigest: digestOf(applied), appliedCount: applied.length, requiredCount: required.length };
          }
        }
      } catch { result = { ...result, reason: 'metadata_or_manifest_unavailable' }; }
      items.push(result);
    }
    const value = { configured: rows.length > 0, state: !rows.length || items.some(i => i.state === 'UNKNOWN') ? 'UNKNOWN' : items.some(i => i.state === 'INCOMPATIBLE') ? 'INCOMPATIBLE' : 'COMPATIBLE',
      items, blocking: items.some(i => i.blocking), databaseChanged: false, databaseRollback: 'NOT_SUPPORTED' };
    return { ...value, digest: digestOf(value) };
  }
  async unbind(raw: unknown, revalidate: () => void) {
    const input = z.object({ targetId: z.string().max(128), expectedRevision: z.number().int().positive(), checkpointId: z.string().max(128), confirmCompatibilityRemoval: z.literal(true) }).strict().parse(raw);
    return this.s.mutations!.run(async () => {
      revalidate(); const target = this.row(input.targetId);
      if (target.revision !== input.expectedRevision) throw new DodoError('CONFLICT', 'database target revision changed');
      const changed = this.db.prepare('DELETE FROM recovery_database_bindings WHERE target_id=? AND snapshot_id=?').run(target.id,input.checkpointId).changes;
      this.audit('unbind',target.id,digestOf(input));return { targetId: target.id,checkpointId: input.checkpointId,removed:changed>0,databaseChanged:false };
    });
  }
  private audit(action: string, id: string, digest: string) {
    this.s.store.audit({ principal: 'local-config-owner', workspaceId: this.s.workspaceId, tool: `recovery.database.${action}`, refId: id, inputDigest: digest, result: 'owner_readonly_rule' });
  }
}
