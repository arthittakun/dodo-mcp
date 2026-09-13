import type Database from 'better-sqlite3';
import { decodeAccessScopes } from './scopeEncoding.js';
import { randomBytes } from 'node:crypto';
import { newId } from '../util/hash.js';

/** Typed repository facade over the SQLite state database. */

export type TrustMode = 'inspect' | 'edit' | 'trusted';

export interface WorkspaceRow {
  id: string;
  root: string;
  dev: number;
  ino: number;
  trustMode: TrustMode;
  createdAt: number;
  lastEpoch: string | null;
}

export interface GrantRow {
  id: string;
  workspaceId: string;
  clientId: string;
  accountId: string;
  scopes: string[];
  createdAt: number;
  revokedAt: number | null;
}

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'consumed' | 'expired';

export interface ApprovalRow {
  id: string;
  kind: 'action' | 'oauth';
  workspaceId: string | null;
  epoch: string | null;
  principal: string | null;
  tool: string | null;
  digest: string | null;
  summary: string;
  createdAt: number;
  expiresAt: number;
  status: ApprovalStatus;
  approvedAt: number | null;
  consumedAt: number | null;
}

export interface PlanRow {
  id: string;
  workspaceId: string;
  epoch: string;
  principal: string;
  planHash: string;
  payload: string;
  createdAt: number;
  expiresAt: number;
  invalidatedAt: number | null;
}

export type ChangesetStatus = 'committing' | 'committed' | 'failed' | 'rolled_back' | 'recovery_required';

export interface ChangesetRow {
  id: string;
  workspaceId: string;
  epoch: string;
  planId: string | null;
  principal: string;
  status: ChangesetStatus;
  kind: 'apply' | 'rollback';
  createdAt: number;
  committedAt: number | null;
  summary: string | null;
  error: string | null;
}

export type JournalStepState = 'pending' | 'backed_up' | 'written' | 'done' | 'reverted';

export interface JournalStepRow {
  changesetId: string;
  seq: number;
  op: string;
  path: string;
  destPath: string | null;
  beforeHash: string | null;
  afterHash: string | null;
  backupPath: string | null;
  state: JournalStepState;
}

export type JobStatus = 'running' | 'exited' | 'failed_to_start' | 'canceled' | 'timed_out' | 'interrupted_on_restart';

export interface JobRow {
  id: string;
  workspaceId: string;
  epoch: string;
  principal: string;
  kind: 'exec' | 'task';
  program: string;
  args: string[];
  cwd: string;
  recipeId: string | null;
  pid: number | null;
  status: JobStatus;
  exitCode: number | null;
  signal: string | null;
  startedAt: number | null;
  endedAt: number | null;
  timeoutMs: number;
  createdAt: number;
}

export interface HandoffRow {
  id: string;
  workspaceId: string;
  principal: string;
  payload: string;
  createdAt: number;
}

export class Store {
  constructor(readonly db: Database.Database) {}

  setClientAccess(workspaceId: string, clientId: string, scopes: string[]): void {
    this.db.prepare('INSERT INTO workspace_clients VALUES (?,?,?) ON CONFLICT(workspace_id,client_id) DO UPDATE SET scopes=excluded.scopes').run(workspaceId, clientId, JSON.stringify(scopes));
  }

  clientAccess(workspaceId: string, clientId: string): string[] {
    const row = this.db.prepare('SELECT scopes FROM workspace_clients WHERE workspace_id=? AND client_id=?').get(workspaceId, clientId) as { scopes: string } | undefined;
    return row ? decodeAccessScopes(row.scopes) : [];
  }

  // ---- meta -------------------------------------------------------------
  getMeta(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  /** Stable per-install secret used to mint workspace ids; created once. */
  installSecret(): string {
    const existing = this.getMeta('install_secret');
    if (existing) return existing;
    const secret = randomBytes(32).toString('hex');
    this.setMeta('install_secret', secret);
    return secret;
  }

  /** Read the install secret without creating one (read-only CLI paths). */
  readInstallSecret(): string | undefined {
    try {
      return this.getMeta('install_secret');
    } catch {
      return undefined;
    }
  }

  // ---- workspaces -------------------------------------------------------
  upsertWorkspace(w: { id: string; root: string; dev: number; ino: number; epoch: string }): WorkspaceRow {
    const existing = this.getWorkspace(w.id);
    if (!existing) {
      this.db
        .prepare('INSERT INTO workspaces (id, root, dev, ino, trust_mode, created_at, last_epoch, last_seen_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(w.id, w.root, w.dev, w.ino, 'inspect', Date.now(), w.epoch, Date.now());
    } else {
      this.db
        .prepare('UPDATE workspaces SET root = ?, dev = ?, ino = ?, last_epoch = ?, last_seen_at = ? WHERE id = ?')
        .run(w.root, w.dev, w.ino, w.epoch, Date.now(), w.id);
    }
    return this.getWorkspace(w.id) as WorkspaceRow;
  }

  getWorkspace(id: string): WorkspaceRow | undefined {
    const r = this.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    return {
      id: r['id'] as string,
      root: r['root'] as string,
      dev: r['dev'] as number,
      ino: r['ino'] as number,
      trustMode: r['trust_mode'] as TrustMode,
      createdAt: r['created_at'] as number,
      lastEpoch: (r['last_epoch'] as string) ?? null,
    };
  }

  findWorkspaceByRoot(root: string): WorkspaceRow | undefined {
    const r = this.db.prepare('SELECT id FROM workspaces WHERE root = ?').get(root) as { id: string } | undefined;
    return r ? this.getWorkspace(r.id) : undefined;
  }

  setTrustMode(workspaceId: string, mode: TrustMode): void {
    const tx = this.db.transaction(() => {
      this.db.prepare('UPDATE workspaces SET trust_mode = ? WHERE id = ?').run(mode, workspaceId);
      this.db.prepare('INSERT INTO policy_versions (workspace_id, mode, changed_at) VALUES (?,?,?)').run(workspaceId, mode, Date.now());
    });
    tx();
  }

  trustMode(workspaceId: string): TrustMode {
    const r = this.db.prepare('SELECT trust_mode FROM workspaces WHERE id = ?').get(workspaceId) as { trust_mode: TrustMode } | undefined;
    return r?.trust_mode ?? 'inspect';
  }

  // ---- oauth clients (static registrations) -----------------------------
  putOAuthClient(clientId: string, payload: Record<string, unknown>): void {
    this.db
      .prepare('INSERT INTO oauth_clients (client_id, payload, created_at) VALUES (?,?,?) ON CONFLICT(client_id) DO UPDATE SET payload = excluded.payload')
      .run(clientId, JSON.stringify(payload), Date.now());
  }

  getOAuthClient(clientId: string): Record<string, unknown> | undefined {
    const r = this.db.prepare('SELECT payload FROM oauth_clients WHERE client_id = ?').get(clientId) as { payload: string } | undefined;
    return r ? (JSON.parse(r.payload) as Record<string, unknown>) : undefined;
  }

  listOAuthClients(): Array<{ clientId: string; payload: Record<string, unknown>; createdAt: number }> {
    const rows = this.db.prepare('SELECT client_id, payload, created_at FROM oauth_clients ORDER BY created_at').all() as Array<{
      client_id: string;
      payload: string;
      created_at: number;
    }>;
    return rows.map((r) => ({ clientId: r.client_id, payload: JSON.parse(r.payload) as Record<string, unknown>, createdAt: r.created_at }));
  }

  // ---- oauth models (oidc-provider adapter backing) ----------------------
  oauthUpsert(model: string, id: string, payload: Record<string, unknown>, expiresIn?: number): void {
    const expiresAt = expiresIn ? Date.now() + expiresIn * 1000 : null;
    this.db
      .prepare(
        `INSERT INTO oauth_models (model, id, payload, grant_id, uid, user_code, expires_at, consumed_at)
         VALUES (?,?,?,?,?,?,?,NULL)
         ON CONFLICT(model, id) DO UPDATE SET payload = excluded.payload, grant_id = excluded.grant_id,
           uid = excluded.uid, user_code = excluded.user_code, expires_at = excluded.expires_at`,
      )
      .run(
        model,
        id,
        JSON.stringify(payload),
        (payload['grantId'] as string) ?? null,
        (payload['uid'] as string) ?? null,
        (payload['userCode'] as string) ?? null,
        expiresAt,
      );
  }

  oauthFind(model: string, id: string): Record<string, unknown> | undefined {
    const r = this.db.prepare('SELECT payload, expires_at, consumed_at FROM oauth_models WHERE model = ? AND id = ?').get(model, id) as
      | { payload: string; expires_at: number | null; consumed_at: number | null }
      | undefined;
    if (!r) return undefined;
    if (r.expires_at !== null && r.expires_at < Date.now()) return undefined;
    const payload = JSON.parse(r.payload) as Record<string, unknown>;
    if (r.consumed_at !== null) payload['consumed'] = Math.floor(r.consumed_at / 1000);
    return payload;
  }

  oauthFindByUid(model: string, uid: string): Record<string, unknown> | undefined {
    const r = this.db.prepare('SELECT id FROM oauth_models WHERE model = ? AND uid = ?').get(model, uid) as { id: string } | undefined;
    return r ? this.oauthFind(model, r.id) : undefined;
  }

  oauthFindByUserCode(model: string, userCode: string): Record<string, unknown> | undefined {
    const r = this.db.prepare('SELECT id FROM oauth_models WHERE model = ? AND user_code = ?').get(model, userCode) as { id: string } | undefined;
    return r ? this.oauthFind(model, r.id) : undefined;
  }

  oauthConsume(model: string, id: string): void {
    this.db.prepare('UPDATE oauth_models SET consumed_at = ? WHERE model = ? AND id = ?').run(Date.now(), model, id);
  }

  oauthDestroy(model: string, id: string): void {
    this.db.prepare('DELETE FROM oauth_models WHERE model = ? AND id = ?').run(model, id);
  }

  oauthRevokeByGrantId(grantId: string): void {
    this.db.prepare('DELETE FROM oauth_models WHERE grant_id = ?').run(grantId);
  }

  oauthSweepExpired(): number {
    const r = this.db.prepare('DELETE FROM oauth_models WHERE expires_at IS NOT NULL AND expires_at < ?').run(Date.now());
    return r.changes;
  }

  // ---- grants (application-level, workspace-bound) -----------------------
  putGrant(g: { id: string; workspaceId: string; clientId: string; accountId: string; scopes: string[] }): void {
    this.db
      .prepare(
        `INSERT INTO grants (id, workspace_id, client_id, account_id, scopes, created_at, revoked_at) VALUES (?,?,?,?,?,?,NULL)
         ON CONFLICT(id) DO UPDATE SET scopes = excluded.scopes`,
      )
      .run(g.id, g.workspaceId, g.clientId, g.accountId, g.scopes.join(' '), Date.now());
  }

  getGrant(id: string): GrantRow | undefined {
    const r = this.db.prepare('SELECT * FROM grants WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    return {
      id: r['id'] as string,
      workspaceId: r['workspace_id'] as string,
      clientId: r['client_id'] as string,
      accountId: r['account_id'] as string,
      scopes: (r['scopes'] as string).split(' ').filter(Boolean),
      createdAt: r['created_at'] as number,
      revokedAt: (r['revoked_at'] as number) ?? null,
    };
  }

  listGrants(workspaceId?: string): GrantRow[] {
    const rows = (
      workspaceId
        ? this.db.prepare('SELECT id FROM grants WHERE workspace_id = ? ORDER BY created_at').all(workspaceId)
        : this.db.prepare('SELECT id FROM grants ORDER BY created_at').all()
    ) as Array<{ id: string }>;
    return rows.map((r) => this.getGrant(r.id) as GrantRow);
  }

  revokeGrant(id: string): boolean {
    const r = this.db.prepare('UPDATE grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(Date.now(), id);
    return r.changes > 0;
  }

  // ---- approvals ---------------------------------------------------------
  createApproval(a: {
    kind: 'action' | 'oauth';
    workspaceId?: string;
    epoch?: string;
    principal?: string;
    tool?: string;
    digest?: string;
    summary: string;
    ttlMs: number;
    id?: string;
  }): ApprovalRow {
    const id = a.id ?? newId('apr');
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO pending_approvals (id, kind, workspace_id, epoch, principal, tool, digest, summary, created_at, expires_at, status)
         VALUES (?,?,?,?,?,?,?,?,?,?,'pending')`,
      )
      .run(id, a.kind, a.workspaceId ?? null, a.epoch ?? null, a.principal ?? null, a.tool ?? null, a.digest ?? null, a.summary, now, now + a.ttlMs);
    return this.getApproval(id) as ApprovalRow;
  }

  getApproval(id: string): ApprovalRow | undefined {
    const r = this.db.prepare('SELECT * FROM pending_approvals WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    const row: ApprovalRow = {
      id: r['id'] as string,
      kind: r['kind'] as 'action' | 'oauth',
      workspaceId: (r['workspace_id'] as string) ?? null,
      epoch: (r['epoch'] as string) ?? null,
      principal: (r['principal'] as string) ?? null,
      tool: (r['tool'] as string) ?? null,
      digest: (r['digest'] as string) ?? null,
      summary: r['summary'] as string,
      createdAt: r['created_at'] as number,
      expiresAt: r['expires_at'] as number,
      status: r['status'] as ApprovalStatus,
      approvedAt: (r['approved_at'] as number) ?? null,
      consumedAt: (r['consumed_at'] as number) ?? null,
    };
    if (row.status === 'pending' && row.expiresAt < Date.now()) row.status = 'expired';
    return row;
  }

  findPendingActionApproval(workspaceId: string, digest: string, principal: string): ApprovalRow | undefined {
    const rows = this.db
      .prepare(
        `SELECT id FROM pending_approvals WHERE kind = 'action' AND workspace_id = ? AND digest = ? AND principal = ? AND status IN ('pending','approved') ORDER BY created_at DESC`,
      )
      .all(workspaceId, digest, principal) as Array<{ id: string }>;
    for (const { id } of rows) {
      const row = this.getApproval(id);
      if (row && (row.status === 'pending' || row.status === 'approved')) return row;
    }
    return undefined;
  }

  listPendingApprovals(kind?: 'action' | 'oauth'): ApprovalRow[] {
    const rows = (
      kind
        ? this.db.prepare(`SELECT id FROM pending_approvals WHERE kind = ? AND status = 'pending' ORDER BY created_at`).all(kind)
        : this.db.prepare(`SELECT id FROM pending_approvals WHERE status = 'pending' ORDER BY created_at`).all()
    ) as Array<{ id: string }>;
    return rows.map((r) => this.getApproval(r.id) as ApprovalRow).filter((r) => r.status === 'pending');
  }

  setApprovalStatus(id: string, status: 'approved' | 'denied' | 'consumed'): boolean {
    const now = Date.now();
    if (status === 'approved') {
      const r = this.db
        .prepare(`UPDATE pending_approvals SET status = 'approved', approved_at = ? WHERE id = ? AND status = 'pending' AND expires_at > ?`)
        .run(now, id, now);
      return r.changes > 0;
    }
    if (status === 'denied') {
      const r = this.db.prepare(`UPDATE pending_approvals SET status = 'denied' WHERE id = ? AND status IN ('pending','approved')`).run(id);
      return r.changes > 0;
    }
    const r = this.db
      .prepare(`UPDATE pending_approvals SET status = 'consumed', consumed_at = ? WHERE id = ? AND status = 'approved' AND expires_at > ?`)
      .run(now, id, now);
    return r.changes > 0;
  }

  // ---- change plans ------------------------------------------------------
  putPlan(p: { id: string; workspaceId: string; epoch: string; principal: string; planHash: string; payload: string; ttlMs: number }): void {
    const now = Date.now();
    this.db
      .prepare('INSERT INTO change_plans (id, workspace_id, epoch, principal, plan_hash, payload, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(p.id, p.workspaceId, p.epoch, p.principal, p.planHash, p.payload, now, now + p.ttlMs);
  }

  getPlan(id: string): PlanRow | undefined {
    const r = this.db.prepare('SELECT * FROM change_plans WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    return {
      id: r['id'] as string,
      workspaceId: r['workspace_id'] as string,
      epoch: r['epoch'] as string,
      principal: r['principal'] as string,
      planHash: r['plan_hash'] as string,
      payload: r['payload'] as string,
      createdAt: r['created_at'] as number,
      expiresAt: r['expires_at'] as number,
      invalidatedAt: (r['invalidated_at'] as number) ?? null,
    };
  }

  invalidatePlan(id: string): void {
    this.db.prepare('UPDATE change_plans SET invalidated_at = ? WHERE id = ?').run(Date.now(), id);
  }

  // ---- changesets / journal ---------------------------------------------
  createChangeset(c: { id: string; workspaceId: string; epoch: string; planId: string | null; principal: string; kind: 'apply' | 'rollback'; summary: string }): void {
    this.db
      .prepare(`INSERT INTO changesets (id, workspace_id, epoch, plan_id, principal, status, kind, created_at, summary) VALUES (?,?,?,?,?,'committing',?,?,?)`)
      .run(c.id, c.workspaceId, c.epoch, c.planId, c.principal, c.kind, Date.now(), c.summary);
  }

  getChangeset(id: string): ChangesetRow | undefined {
    const r = this.db.prepare('SELECT * FROM changesets WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    return {
      id: r['id'] as string,
      workspaceId: r['workspace_id'] as string,
      epoch: r['epoch'] as string,
      planId: (r['plan_id'] as string) ?? null,
      principal: r['principal'] as string,
      status: r['status'] as ChangesetStatus,
      kind: r['kind'] as 'apply' | 'rollback',
      createdAt: r['created_at'] as number,
      committedAt: (r['committed_at'] as number) ?? null,
      summary: (r['summary'] as string) ?? null,
      error: (r['error'] as string) ?? null,
    };
  }

  listChangesets(workspaceId: string, limit: number): ChangesetRow[] {
    const rows = this.db
      .prepare('SELECT id FROM changesets WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(workspaceId, limit) as Array<{ id: string }>;
    return rows.map((r) => this.getChangeset(r.id) as ChangesetRow);
  }

  listChangesetsByStatus(status: ChangesetStatus): ChangesetRow[] {
    const rows = this.db.prepare('SELECT id FROM changesets WHERE status = ?').all(status) as Array<{ id: string }>;
    return rows.map((r) => this.getChangeset(r.id) as ChangesetRow);
  }

  setChangesetStatus(id: string, status: ChangesetStatus, error?: string): void {
    this.db
      .prepare('UPDATE changesets SET status = ?, committed_at = CASE WHEN ? = \'committed\' THEN ? ELSE committed_at END, error = ? WHERE id = ?')
      .run(status, status, Date.now(), error ?? null, id);
  }

  addJournalStep(s: JournalStepRow): void {
    this.db
      .prepare('INSERT INTO journal_steps (changeset_id, seq, op, path, dest_path, before_hash, after_hash, backup_path, state) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(s.changesetId, s.seq, s.op, s.path, s.destPath, s.beforeHash, s.afterHash, s.backupPath, s.state);
  }

  setJournalStepState(changesetId: string, seq: number, state: JournalStepState): void {
    this.db.prepare('UPDATE journal_steps SET state = ? WHERE changeset_id = ? AND seq = ?').run(state, changesetId, seq);
  }

  listJournalSteps(changesetId: string): JournalStepRow[] {
    const rows = this.db.prepare('SELECT * FROM journal_steps WHERE changeset_id = ? ORDER BY seq').all(changesetId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      changesetId: r['changeset_id'] as string,
      seq: r['seq'] as number,
      op: r['op'] as string,
      path: r['path'] as string,
      destPath: (r['dest_path'] as string) ?? null,
      beforeHash: (r['before_hash'] as string) ?? null,
      afterHash: (r['after_hash'] as string) ?? null,
      backupPath: (r['backup_path'] as string) ?? null,
      state: r['state'] as JournalStepState,
    }));
  }

  // ---- idempotency -------------------------------------------------------
  reserveIdempotency(k: { key: string; principal: string; workspaceId: string; tool: string; payloadHash: string }):
    | { outcome: 'reserved' }
    | { outcome: 'duplicate'; result: string | null; state: string }
    | { outcome: 'conflict' } {
    const existing = this.db
      .prepare('SELECT payload_hash, state, result FROM idempotency_keys WHERE key = ? AND principal = ? AND workspace_id = ? AND tool = ?')
      .get(k.key, k.principal, k.workspaceId, k.tool) as { payload_hash: string; state: string; result: string | null } | undefined;
    if (existing) {
      if (existing.payload_hash !== k.payloadHash) return { outcome: 'conflict' };
      return { outcome: 'duplicate', result: existing.result, state: existing.state };
    }
    this.db
      .prepare(`INSERT INTO idempotency_keys (key, principal, workspace_id, tool, payload_hash, state, created_at) VALUES (?,?,?,?,?,'reserved',?)`)
      .run(k.key, k.principal, k.workspaceId, k.tool, k.payloadHash, Date.now());
    return { outcome: 'reserved' };
  }

  completeIdempotency(k: { key: string; principal: string; workspaceId: string; tool: string }, result: string): void {
    this.db
      .prepare(`UPDATE idempotency_keys SET state = 'completed', result = ? WHERE key = ? AND principal = ? AND workspace_id = ? AND tool = ?`)
      .run(result, k.key, k.principal, k.workspaceId, k.tool);
  }

  releaseIdempotency(k: { key: string; principal: string; workspaceId: string; tool: string }): void {
    this.db
      .prepare(`DELETE FROM idempotency_keys WHERE key = ? AND principal = ? AND workspace_id = ? AND tool = ? AND state = 'reserved'`)
      .run(k.key, k.principal, k.workspaceId, k.tool);
  }

  sweepIdempotency(retentionMs: number): number {
    const r = this.db.prepare('DELETE FROM idempotency_keys WHERE created_at < ?').run(Date.now() - retentionMs);
    return r.changes;
  }

  // ---- jobs --------------------------------------------------------------
  createJob(j: {
    id: string;
    workspaceId: string;
    epoch: string;
    principal: string;
    kind: 'exec' | 'task';
    program: string;
    args: string[];
    cwd: string;
    recipeId: string | null;
    timeoutMs: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO jobs (id, workspace_id, epoch, principal, kind, program, args, cwd, recipe_id, status, timeout_ms, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,'running',?,?)`,
      )
      .run(j.id, j.workspaceId, j.epoch, j.principal, j.kind, j.program, JSON.stringify(j.args), j.cwd, j.recipeId, j.timeoutMs, Date.now());
  }

  getJob(id: string): JobRow | undefined {
    const r = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    return {
      id: r['id'] as string,
      workspaceId: r['workspace_id'] as string,
      epoch: r['epoch'] as string,
      principal: r['principal'] as string,
      kind: r['kind'] as 'exec' | 'task',
      program: r['program'] as string,
      args: JSON.parse(r['args'] as string) as string[],
      cwd: r['cwd'] as string,
      recipeId: (r['recipe_id'] as string) ?? null,
      pid: (r['pid'] as number) ?? null,
      status: r['status'] as JobStatus,
      exitCode: (r['exit_code'] as number) ?? null,
      signal: (r['signal'] as string) ?? null,
      startedAt: (r['started_at'] as number) ?? null,
      endedAt: (r['ended_at'] as number) ?? null,
      timeoutMs: r['timeout_ms'] as number,
      createdAt: r['created_at'] as number,
    };
  }

  updateJob(id: string, fields: Partial<Pick<JobRow, 'pid' | 'status' | 'exitCode' | 'signal' | 'startedAt' | 'endedAt'>>): void {
    const sets: string[] = [];
    const vals: unknown[] = [];
    const map: Record<string, string> = { pid: 'pid', status: 'status', exitCode: 'exit_code', signal: 'signal', startedAt: 'started_at', endedAt: 'ended_at' };
    for (const [k, col] of Object.entries(map)) {
      if (k in fields) {
        sets.push(`${col} = ?`);
        vals.push((fields as Record<string, unknown>)[k]);
      }
    }
    if (sets.length === 0) return;
    vals.push(id);
    this.db.prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  listJobs(workspaceId: string, limit: number): JobRow[] {
    const rows = this.db.prepare('SELECT id FROM jobs WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?').all(workspaceId, limit) as Array<{ id: string }>;
    return rows.map((r) => this.getJob(r.id) as JobRow);
  }

  markInterruptedJobs(currentEpoch: string, workspaceId: string): number {
    const r = this.db
      .prepare(`UPDATE jobs SET status = 'interrupted_on_restart', ended_at = ? WHERE status = 'running' AND epoch != ? AND workspace_id = ?`)
      .run(Date.now(), currentEpoch, workspaceId);
    return r.changes;
  }

  // ---- handoffs ----------------------------------------------------------
  putHandoff(h: { id: string; workspaceId: string; principal: string; payload: string }): void {
    this.db.prepare('INSERT INTO handoffs (id, workspace_id, principal, payload, created_at) VALUES (?,?,?,?,?)').run(h.id, h.workspaceId, h.principal, h.payload, Date.now());
  }

  getHandoff(id: string, workspaceId: string): HandoffRow | undefined {
    const r = this.db.prepare('SELECT * FROM handoffs WHERE id = ? AND workspace_id = ?').get(id, workspaceId) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    return { id: r['id'] as string, workspaceId: r['workspace_id'] as string, principal: r['principal'] as string, payload: r['payload'] as string, createdAt: r['created_at'] as number };
  }

  latestHandoff(workspaceId: string): HandoffRow | undefined {
    const r = this.db.prepare('SELECT id FROM handoffs WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 1').get(workspaceId) as { id: string } | undefined;
    return r ? this.getHandoff(r.id, workspaceId) : undefined;
  }

  listHandoffs(workspaceId: string, limit: number): HandoffRow[] {
    const rows = this.db.prepare('SELECT id FROM handoffs WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?').all(workspaceId, limit) as Array<{ id: string }>;
    return rows.map((r) => this.getHandoff(r.id, workspaceId) as HandoffRow);
  }

  // ---- todos -------------------------------------------------------------
  getTodos(workspaceId: string): { payload: string; updatedAt: number } | undefined {
    const r = this.db.prepare('SELECT payload, updated_at FROM todos WHERE workspace_id = ?').get(workspaceId) as { payload: string; updated_at: number } | undefined;
    return r ? { payload: r.payload, updatedAt: r.updated_at } : undefined;
  }

  setTodos(workspaceId: string, principal: string, payload: string): void {
    this.db
      .prepare(
        'INSERT INTO todos (workspace_id, payload, updated_at, principal) VALUES (?,?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at, principal = excluded.principal',
      )
      .run(workspaceId, payload, Date.now(), principal);
  }

  // ---- audit -------------------------------------------------------------
  recentAudit(
    workspaceId: string | undefined,
    limit: number,
  ): Array<{ ts: number; principal: string | null; tool: string | null; result: string; durationMs: number | null; inputDigest: string | null }> {
    const rows = (
      workspaceId
        ? this.db.prepare('SELECT ts, principal, tool, result, duration_ms, input_digest FROM audit_events WHERE workspace_id = ? ORDER BY ts DESC LIMIT ?').all(workspaceId, limit)
        : this.db.prepare('SELECT ts, principal, tool, result, duration_ms, input_digest FROM audit_events ORDER BY ts DESC LIMIT ?').all(limit)
    ) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      ts: r['ts'] as number,
      principal: (r['principal'] as string) ?? null,
      tool: (r['tool'] as string) ?? null,
      result: r['result'] as string,
      durationMs: (r['duration_ms'] as number) ?? null,
      inputDigest: (r['input_digest'] as string) ?? null,
    }));
  }

  audit(e: {
    requestId?: string;
    principal?: string;
    workspaceId?: string;
    tool?: string;
    paths?: string[];
    inputDigest?: string;
    refId?: string;
    durationMs?: number;
    result: string;
  }): void {
    this.db
      .prepare('INSERT INTO audit_events (ts, request_id, principal, workspace_id, tool, paths, input_digest, ref_id, duration_ms, result) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(
        Date.now(),
        e.requestId ?? null,
        e.principal ?? null,
        e.workspaceId ?? null,
        e.tool ?? null,
        e.paths && e.paths.length > 0 ? JSON.stringify(e.paths.slice(0, 50)) : null,
        e.inputDigest ?? null,
        e.refId ?? null,
        e.durationMs ?? null,
        e.result,
      );
  }

  sweepAudit(retentionMs: number): number {
    const r = this.db.prepare('DELETE FROM audit_events WHERE ts < ?').run(Date.now() - retentionMs);
    return r.changes;
  }
}
