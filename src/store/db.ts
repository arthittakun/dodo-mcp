import Database from 'better-sqlite3';
import { decodeAccessScopes } from './scopeEncoding.js';
import fs from 'node:fs';
import { DodoError } from '../errors.js';

/**
 * Durable state (spec §5). WAL mode so the CLI can perform offline writes
 * (trust, client registration) while a server holds the database.
 * Fail closed on migration problems — never fall back to in-memory auth state.
 */
const MIGRATIONS: Array<string | ((db: Database.Database) => void)> = [
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE workspaces (
    id TEXT PRIMARY KEY, root TEXT NOT NULL, dev INTEGER NOT NULL, ino INTEGER NOT NULL,
    trust_mode TEXT NOT NULL DEFAULT 'inspect', created_at INTEGER NOT NULL,
    last_epoch TEXT, last_seen_at INTEGER
  );
  CREATE TABLE policy_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL,
    mode TEXT NOT NULL, changed_at INTEGER NOT NULL
  );
  CREATE TABLE oauth_clients (
    client_id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE TABLE oauth_models (
    model TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL,
    grant_id TEXT, uid TEXT, user_code TEXT,
    expires_at INTEGER, consumed_at INTEGER,
    PRIMARY KEY (model, id)
  );
  CREATE INDEX idx_oauth_models_grant ON oauth_models (grant_id);
  CREATE INDEX idx_oauth_models_uid ON oauth_models (uid);
  CREATE INDEX idx_oauth_models_expiry ON oauth_models (expires_at);
  CREATE TABLE grants (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, client_id TEXT NOT NULL,
    account_id TEXT NOT NULL, scopes TEXT NOT NULL,
    created_at INTEGER NOT NULL, revoked_at INTEGER
  );
  CREATE INDEX idx_grants_workspace ON grants (workspace_id);
  CREATE TABLE pending_approvals (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, workspace_id TEXT, epoch TEXT,
    principal TEXT, tool TEXT, digest TEXT, summary TEXT NOT NULL,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', approved_at INTEGER, consumed_at INTEGER
  );
  CREATE INDEX idx_approvals_digest ON pending_approvals (workspace_id, digest);
  CREATE TABLE change_plans (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, epoch TEXT NOT NULL,
    principal TEXT NOT NULL, plan_hash TEXT NOT NULL, payload TEXT NOT NULL,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, invalidated_at INTEGER
  );
  CREATE TABLE changesets (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, epoch TEXT NOT NULL,
    plan_id TEXT, principal TEXT NOT NULL, status TEXT NOT NULL, kind TEXT NOT NULL,
    created_at INTEGER NOT NULL, committed_at INTEGER, summary TEXT, error TEXT
  );
  CREATE INDEX idx_changesets_ws ON changesets (workspace_id, created_at);
  CREATE TABLE journal_steps (
    changeset_id TEXT NOT NULL, seq INTEGER NOT NULL, op TEXT NOT NULL,
    path TEXT NOT NULL, dest_path TEXT, before_hash TEXT, after_hash TEXT,
    backup_path TEXT, state TEXT NOT NULL,
    PRIMARY KEY (changeset_id, seq)
  );
  CREATE TABLE idempotency_keys (
    key TEXT NOT NULL, principal TEXT NOT NULL, workspace_id TEXT NOT NULL, tool TEXT NOT NULL,
    payload_hash TEXT NOT NULL, state TEXT NOT NULL, result TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (key, principal, workspace_id, tool)
  );
  CREATE TABLE jobs (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, epoch TEXT NOT NULL, principal TEXT NOT NULL,
    kind TEXT NOT NULL, program TEXT NOT NULL, args TEXT NOT NULL, cwd TEXT NOT NULL,
    recipe_id TEXT, pid INTEGER, status TEXT NOT NULL,
    exit_code INTEGER, signal TEXT, started_at INTEGER, ended_at INTEGER,
    timeout_ms INTEGER NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_jobs_ws ON jobs (workspace_id, created_at);
  CREATE TABLE audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, request_id TEXT,
    principal TEXT, workspace_id TEXT, tool TEXT, paths TEXT, input_digest TEXT,
    ref_id TEXT, duration_ms INTEGER, result TEXT NOT NULL
  );
  CREATE INDEX idx_audit_ts ON audit_events (ts);
  CREATE TABLE handoffs (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, principal TEXT NOT NULL,
    payload TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_handoffs_ws ON handoffs (workspace_id, created_at);
  `,
  `
  CREATE TABLE todos (
    workspace_id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at INTEGER NOT NULL, principal TEXT NOT NULL
  );
  `,
  `CREATE TABLE workspace_clients (
    workspace_id TEXT NOT NULL, client_id TEXT NOT NULL, scopes TEXT NOT NULL,
    PRIMARY KEY (workspace_id, client_id)
  );
  INSERT OR REPLACE INTO workspace_clients(workspace_id,client_id,scopes)
    SELECT workspace_id,client_id,scopes FROM grants WHERE revoked_at IS NULL ORDER BY created_at;
  `,
  (db) => {
    // An earlier schema step copied grants.scopes (space-separated) into a
    // JSON ACL. Normalize both partially and directly upgraded stores.
    const rows = db.prepare('SELECT workspace_id, client_id, scopes FROM workspace_clients').all() as Array<{workspace_id: string; client_id: string; scopes: string}>;
    const update = db.prepare('UPDATE workspace_clients SET scopes=? WHERE workspace_id=? AND client_id=?');
    for (const row of rows) update.run(JSON.stringify(decodeAccessScopes(row.scopes, true)), row.workspace_id, row.client_id);
  },
  `CREATE TABLE usage_consents (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, epoch TEXT NOT NULL,
    client_id TEXT NOT NULL, grant_id TEXT NOT NULL, label TEXT NOT NULL,
    status TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
  );
  CREATE INDEX idx_usage_ws ON usage_consents(workspace_id, epoch);
  CREATE TABLE schedules (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, payload TEXT NOT NULL,
    digest TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL, next_at INTEGER, approved_at INTEGER
  );
  CREATE TABLE schedule_runs (
    schedule_id TEXT NOT NULL, due_at INTEGER NOT NULL, status TEXT NOT NULL,
    job_id TEXT, error TEXT, PRIMARY KEY(schedule_id, due_at)
  );`,
  `CREATE TABLE chat_permissions (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, client_id TEXT NOT NULL, chat_id TEXT NOT NULL,
    created_at INTEGER NOT NULL, expires_at INTEGER, revoked_at INTEGER,
    root_dev INTEGER NOT NULL, root_ino INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX idx_chat_active ON chat_permissions(workspace_id,client_id,chat_id) WHERE revoked_at IS NULL;
  ALTER TABLE usage_consents ADD COLUMN chat_permission_id TEXT;
  CREATE INDEX idx_usage_chat ON usage_consents(chat_permission_id);`,
  `CREATE TABLE project_registry (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    canonical_root TEXT NOT NULL,
    display_name TEXT NOT NULL,
    root_dev INTEGER NOT NULL,
    root_ino INTEGER NOT NULL,
    metadata_version INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    removed_at INTEGER
  );
  CREATE UNIQUE INDEX idx_project_registry_active_root
    ON project_registry(canonical_root) WHERE removed_at IS NULL;
  CREATE UNIQUE INDEX idx_project_registry_active_identity
    ON project_registry(root_dev, root_ino) WHERE removed_at IS NULL;
  CREATE INDEX idx_project_registry_updated
    ON project_registry(removed_at, updated_at DESC);`,
  `CREATE TABLE resource_objects (
    hash TEXT PRIMARY KEY,
    bytes INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    verified_at INTEGER NOT NULL
  );
  CREATE TABLE resource_refs (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    principal TEXT NOT NULL,
    object_hash TEXT NOT NULL REFERENCES resource_objects(hash) ON DELETE RESTRICT,
    mime_type TEXT NOT NULL,
    source_kind TEXT NOT NULL,
    source_label TEXT NOT NULL,
    capabilities TEXT NOT NULL,
    metadata TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX idx_resource_refs_owner
    ON resource_refs(workspace_id, principal, expires_at);
  CREATE INDEX idx_resource_refs_object
    ON resource_refs(object_hash);
  CREATE INDEX idx_resource_refs_expiry
    ON resource_refs(expires_at);`,
  `CREATE TRIGGER resource_objects_quota
    BEFORE INSERT ON resource_objects
    WHEN NOT EXISTS (SELECT 1 FROM resource_objects WHERE hash=NEW.hash)
      AND COALESCE((SELECT SUM(bytes) FROM resource_objects),0) + NEW.bytes > 2147483648
    BEGIN
      SELECT RAISE(ABORT, 'resource store quota exceeded');
    END;`,
  `CREATE TABLE brain_index_state (
    workspace_id TEXT PRIMARY KEY,
    namespace TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    parser_version TEXT NOT NULL,
    config_hash TEXT NOT NULL,
    status TEXT NOT NULL,
    paused INTEGER NOT NULL DEFAULT 0,
    generation INTEGER NOT NULL DEFAULT 0,
    active_run_id TEXT,
    last_run_id TEXT,
    last_started_at INTEGER,
    last_completed_at INTEGER,
    last_error TEXT,
    source_hash TEXT,
    metrics TEXT NOT NULL
  );
  CREATE TABLE brain_file_cache (
    workspace_id TEXT NOT NULL,
    path TEXT NOT NULL,
    file_id TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    mtime_ms REAL NOT NULL,
    ctime_ms REAL NOT NULL,
    parser_version TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    config_hash TEXT NOT NULL,
    payload TEXT NOT NULL,
    indexed_at INTEGER NOT NULL,
    generation INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, path),
    UNIQUE (workspace_id, file_id)
  );
  CREATE INDEX idx_brain_files_hash ON brain_file_cache(workspace_id, content_hash);
  CREATE TABLE brain_nodes (
    workspace_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    uri TEXT NOT NULL,
    node_type TEXT NOT NULL,
    name TEXT NOT NULL,
    qualified_name TEXT,
    path TEXT NOT NULL,
    line INTEGER NOT NULL,
    column_no INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    end_column INTEGER NOT NULL,
    source_hash TEXT NOT NULL,
    parser_version TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    freshness TEXT NOT NULL,
    details TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    generation INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, node_id),
    UNIQUE (workspace_id, uri)
  );
  CREATE INDEX idx_brain_nodes_query ON brain_nodes(workspace_id, node_type, name);
  CREATE INDEX idx_brain_nodes_path ON brain_nodes(workspace_id, path);
  CREATE TABLE brain_edges (
    workspace_id TEXT NOT NULL,
    edge_id TEXT NOT NULL,
    edge_type TEXT NOT NULL,
    from_node_id TEXT NOT NULL,
    to_node_id TEXT,
    target_key TEXT,
    source_path TEXT NOT NULL,
    target_path TEXT,
    line INTEGER NOT NULL,
    source_hash TEXT NOT NULL,
    parser_version TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    freshness TEXT NOT NULL,
    details TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    generation INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, edge_id)
  );
  CREATE INDEX idx_brain_edges_source ON brain_edges(workspace_id, source_path, edge_type);
  CREATE INDEX idx_brain_edges_target ON brain_edges(workspace_id, target_path, edge_type);
  CREATE TABLE brain_runs (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    mode TEXT NOT NULL,
    trigger_kind TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    metrics TEXT NOT NULL,
    error TEXT
  );
  CREATE INDEX idx_brain_runs_workspace ON brain_runs(workspace_id, started_at DESC);`,
];

/**
 * Read-only open with NO migration — for CLI helpers (status/approve) that
 * only need to read the install secret to derive the workspace id. A readonly
 * connection never takes a write lock, so it cannot race a running server's
 * startup migration. Returns undefined if the store does not exist yet.
 */
export function openDatabaseReadonly(dbFile: string): Database.Database | undefined {
  try {
    const db = new Database(dbFile, { readonly: true, fileMustExist: true });
    db.pragma('busy_timeout = 5000');
    return db;
  } catch {
    return undefined;
  }
}

export function openDatabase(dbFile: string): Database.Database {
  let db: Database.Database;
  try {
    db = new Database(dbFile);
  } catch (err) {
    throw new DodoError('INTERNAL_ERROR', `cannot open state database: ${(err as Error).message}`, {
      recovery: `check permissions on ${dbFile}`,
    });
  }
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 10000');
    migrateWithRetry(db);
  } catch (err) {
    db.close();
    if (err instanceof DodoError) throw err;
    throw new DodoError('INTERNAL_ERROR', `state database migration failed: ${(err as Error).message}`, {
      recovery: 'the database may be corrupt; restore from backup or move it aside (auth state will be lost)',
    });
  }
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(dbFile, 0o600);
    } catch {
      /* best effort */
    }
  }
  return db;
}

/**
 * Two processes may open the store at once (e.g. `dodo status` while
 * `dodo start` boots). WAL allows concurrent readers and one writer; the
 * loser of a migration-write race retries within busy_timeout rather than
 * failing the command. Migrations are idempotent (guarded by
 * schema_migrations), so a retry after another process finished is a no-op.
 */
function migrateWithRetry(db: Database.Database, attempts = 5): void {
  for (let i = 0; ; i += 1) {
    try {
      migrate(db);
      return;
    } catch (err) {
      const code = (err as { code?: string }).code ?? '';
      if ((code === 'SQLITE_BUSY' || code === 'SQLITE_BUSY_SNAPSHOT' || /database is locked/.test((err as Error).message)) && i < attempts) {
        // brief spin; better-sqlite3 is synchronous so we busy-wait shortly
        const until = Date.now() + 200 * (i + 1);
        while (Date.now() < until) {
          /* wait */
        }
        continue;
      }
      throw err;
    }
  }
}

function migrate(db: Database.Database): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
  // Run the whole migration under BEGIN IMMEDIATE so a second process that
  // opens the store concurrently takes the write lock only after the first
  // has committed, then re-reads applied versions and does nothing — instead
  // of both racing the same CREATE TABLE (which would throw "already exists").
  const apply = db.transaction(() => {
    const appliedRows = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: number }>;
    const applied = new Set(appliedRows.map((r) => r.version));
    if (appliedRows.some((r) => r.version > MIGRATIONS.length)) {
      throw new DodoError('INTERNAL_ERROR', 'state database is from a newer DODO version; refusing to run', {
        recovery: 'upgrade DODO or restore the matching database',
      });
    }
    for (let i = 0; i < MIGRATIONS.length; i += 1) {
      const version = i + 1;
      if (applied.has(version)) continue;
      const migration = MIGRATIONS[i]!;
      if (typeof migration === 'string') db.exec(migration); else migration(db);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(version, Date.now());
    }
  });
  apply.immediate();
}
