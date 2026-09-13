import { DodoError, toDodoError } from '../../errors.js';
import type { AppServices, ToolCtx } from '../../tools/context.js';
import { digestOf, newId, sha256Bytes } from '../../util/hash.js';
import { actorKey, liveAccess } from '../multimodal/storage.js';
import {
  RUNTIME_SCHEMA_VERSION,
  RuntimeDiagnosis,
  RuntimeEvidence,
  RuntimeSession,
  RuntimeSessionStatus,
  RuntimeTask,
  type RuntimeEvidenceData,
  type RuntimeSessionData,
  type RuntimeTaskData,
} from './contracts.js';

const SESSION_DEFAULT_MS = 60 * 60 * 1000;
const SESSION_MAX_MS = 24 * 60 * 60 * 1000;
const EVIDENCE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 32;
const MAX_RETAINED_SESSIONS = 128;
const MAX_TASKS = 32;
const MAX_EVIDENCE_PER_SESSION = 500;
const MAX_EVIDENCE_TOTAL = 2000;
const OUTPUT_SAMPLE_BYTES = 32 * 1024;

type SessionRow = {
  id: string; workspace_id: string; opened_epoch: string; owner: string; label: string;
  status: 'OPEN' | 'CLOSED' | 'EXPIRED'; created_at: number; last_seen_at: number; expires_at: number; closed_at: number | null;
};
type TaskRow = { id: string; session_id: string; workspace_id: string; owner: string; job_id: string; kind: 'process' | 'test' | 'container'; created_at: number };
type EvidenceRow = {
  id: string; session_id: string; workspace_id: string; owner: string; kind: RuntimeEvidenceData['kind']; payload: string;
  source_ref: string; source_hash: string; content_hash: string; status: 'CURRENT' | 'STALE' | 'EXPIRED'; stale_reason: string | null;
  created_at: number; last_verified_at: number; expires_at: number;
};

/** Durable runtime intelligence. It stores metadata and hashes only, never raw process output, DOM, headers, cookies or environment values. */
export class RuntimeService {
  private closed = false;

  constructor(private readonly services: AppServices) { this.recover(); }

  close(): void { this.closed = true; }

  open(ctx: ToolCtx, label: string, ttlMinutes: number): RuntimeSessionData {
    this.check(); liveAccess(ctx, 'dodo:write'); this.recover();
    const owner = actorKey(ctx.principal);
    const count = (this.services.store.db.prepare("SELECT COUNT(*) AS n FROM runtime_sessions WHERE workspace_id=? AND owner=? AND status='OPEN'").get(this.services.workspaceId, owner) as { n: number }).n;
    if (count >= MAX_SESSIONS) throw new DodoError('RESOURCE_LIMIT', `at most ${MAX_SESSIONS} open runtime sessions per client and workspace`);
    const retained = (this.services.store.db.prepare('SELECT COUNT(*) AS n FROM runtime_sessions WHERE workspace_id=? AND owner=?').get(this.services.workspaceId, owner) as { n: number }).n;
    if (retained >= MAX_RETAINED_SESSIONS) throw new DodoError('RESOURCE_LIMIT', `at most ${MAX_RETAINED_SESSIONS} retained runtime sessions per client and workspace; wait for retention cleanup`);
    const now = Date.now(), id = newId('runtime'), expiresAt = now + Math.min(SESSION_MAX_MS, Math.max(60_000, ttlMinutes * 60_000 || SESSION_DEFAULT_MS));
    this.services.store.db.prepare(`INSERT INTO runtime_sessions(id,workspace_id,opened_epoch,owner,label,status,created_at,last_seen_at,expires_at,closed_at)
      VALUES (?,?,?,?,?,'OPEN',?,?,?,NULL)`).run(id, this.services.workspaceId, this.services.epoch, owner, label, now, now, expiresAt);
    return this.sessionData(this.row(id, owner)!);
  }

  status(ctx: ToolCtx, sessionId: string): ReturnType<typeof RuntimeSessionStatus.parse> {
    this.check(); liveAccess(ctx, 'dodo:read'); this.recover();
    const owner = actorKey(ctx.principal), session = this.requireSession(sessionId, owner, true);
    const tasks = this.taskRows(session.id, owner).map((row) => this.taskData(row));
    const counts = this.services.store.db.prepare('SELECT status,COUNT(*) AS n FROM runtime_evidence WHERE session_id=? AND owner=? GROUP BY status').all(session.id, owner) as Array<{ status: string; n: number }>;
    const by = new Map(counts.map((r) => [r.status, r.n]));
    return RuntimeSessionStatus.parse({
      session: this.sessionData(session), tasks,
      evidence: { current: by.get('CURRENT') ?? 0, stale: by.get('STALE') ?? 0, expired: by.get('EXPIRED') ?? 0 },
      reconnectable: true,
      note: 'Session/task metadata is durable across MCP reconnects and server restarts. Runtime evidence is untrusted and never grants permission.',
    });
  }

  diagnostics(ctx: ToolCtx): Record<string, unknown> {
    this.check(); liveAccess(ctx, 'dodo:read'); this.recover();
    const owner = actorKey(ctx.principal);
    const row = this.services.store.db.prepare(`SELECT
      (SELECT COUNT(*) FROM runtime_sessions WHERE workspace_id=? AND owner=? AND status='OPEN') AS sessions,
      (SELECT COUNT(*) FROM runtime_tasks WHERE workspace_id=? AND owner=?) AS tasks,
      (SELECT COUNT(*) FROM runtime_evidence WHERE workspace_id=? AND owner=? AND status='CURRENT') AS evidence`).get(
        this.services.workspaceId, owner, this.services.workspaceId, owner, this.services.workspaceId, owner,
      ) as { sessions: number; tasks: number; evidence: number };
    return { schemaVersion: RUNTIME_SCHEMA_VERSION, available: true, ...row, retentionHours: 24, storesRawOutput: false, autonomousMonitoring: false };
  }

  closeSession(ctx: ToolCtx, sessionId: string): RuntimeSessionData {
    this.check(); liveAccess(ctx, 'dodo:write');
    const owner = actorKey(ctx.principal), session = this.requireSession(sessionId, owner, true);
    if (session.status === 'CLOSED') return this.sessionData(session);
    if (session.status === 'EXPIRED') throw new DodoError('CONFLICT', 'runtime session is expired');
    const running = this.taskRows(session.id, owner).filter((task) => this.services.jobs.getJobChecked(task.job_id, this.services.workspaceId).status === 'running');
    if (running.length) throw new DodoError('CONFLICT', `${running.length} runtime task(s) are still running`, { recovery: 'cancel them with runtime_task_cancel or wait for completion before closing the session' });
    const now = Date.now();
    this.services.store.db.prepare("UPDATE runtime_sessions SET status='CLOSED',closed_at=?,last_seen_at=? WHERE id=? AND owner=?").run(now, now, session.id, owner);
    return this.sessionData(this.row(session.id, owner)!);
  }

  prepareTask(ctx: ToolCtx, sessionId: string): void {
    this.check(); liveAccess(ctx, 'dodo:exec');
    this.requireSession(sessionId, actorKey(ctx.principal), false);
  }

  attachTask(ctx: ToolCtx, sessionId: string, jobId: string, kind: TaskRow['kind']): RuntimeTaskData {
    this.check(); liveAccess(ctx, 'dodo:exec');
    const owner = actorKey(ctx.principal), session = this.requireSession(sessionId, owner, false);
    const count = (this.services.store.db.prepare('SELECT COUNT(*) AS n FROM runtime_tasks WHERE session_id=? AND owner=?').get(session.id, owner) as { n: number }).n;
    if (count >= MAX_TASKS) throw new DodoError('RESOURCE_LIMIT', `at most ${MAX_TASKS} tasks per runtime session`);
    const job = this.services.jobs.getJobChecked(jobId, this.services.workspaceId);
    if (job.principal !== ctx.principal.grantId) throw new DodoError('FORBIDDEN', 'runtime tasks can attach only to jobs created by this OAuth grant');
    const id = newId('rtask'), now = Date.now();
    this.services.store.db.prepare('INSERT INTO runtime_tasks(id,session_id,workspace_id,owner,job_id,kind,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, session.id, this.services.workspaceId, owner, jobId, kind, now);
    return this.taskData({ id, session_id: session.id, workspace_id: this.services.workspaceId, owner, job_id: jobId, kind, created_at: now });
  }

  observeTask(ctx: ToolCtx, sessionId: string, taskId: string, reportPath?: string): { task: RuntimeTaskData; evidence: RuntimeEvidenceData } {
    this.check(); liveAccess(ctx, 'dodo:read');
    const owner = actorKey(ctx.principal), session = this.requireSession(sessionId, owner, false), task = this.requireTask(session.id, taskId, owner);
    const payload = this.taskPayload(task, reportPath);
    return { task: this.taskData(task), evidence: this.putEvidence(session, owner, task.kind, `job:${task.job_id}${reportPath ? `:report:${reportPath}` : ''}`, payload) };
  }

  cancelTask(ctx: ToolCtx, sessionId: string, taskId: string): { taskId: string; jobId: string; status: string } {
    this.check(); liveAccess(ctx, 'dodo:exec');
    const owner = actorKey(ctx.principal), session = this.requireSession(sessionId, owner, false), task = this.requireTask(session.id, taskId, owner);
    const result = this.services.jobs.cancel(task.job_id, this.services.workspaceId);
    return { taskId: task.id, jobId: task.job_id, status: result.status };
  }

  async collectBrowser(ctx: ToolCtx, sessionId: string, browserSessionId: string) {
    this.check(); liveAccess(ctx, 'dodo:read');
    const owner = actorKey(ctx.principal), session = this.requireSession(sessionId, owner, false);
    const browser = this.services.multimodal?.browser;
    if (!browser) throw new DodoError('NOT_SUPPORTED', 'browser runtime collection is unavailable in this build');
    const observation = await browser.observe(ctx.principal, browserSessionId);
    liveAccess(ctx, 'dodo:read');
    const safe = await browser.verifyObservation(ctx.principal, browserSessionId, observation.observationId);
    const payload = {
      browserSessionId, observationId: observation.observationId, url: safe.url,
      titleHash: sha256Bytes(observation.title), domHash: sha256Bytes(JSON.stringify({ text: observation.text, elements: observation.elements })),
      screenshotHash: observation.asset.sha256, elementCount: observation.elements.length, mediaCount: observation.media.length,
      consoleCount: observation.console.length, networkCount: observation.network.length,
      blockedNetworkCount: observation.network.filter((entry) => entry.startsWith('BLOCKED ')).length,
      webSocketPolicy: 'blocked', timing: safe.timing, truncated: observation.truncated,
    };
    const evidence = this.putEvidence(session, owner, 'browser', `browser:${browserSessionId}:${observation.observationId}`, payload, safe.sourceHash);
    return { observation, evidence };
  }

  snapshot(ctx: ToolCtx, sessionId: string): RuntimeEvidenceData {
    this.check(); liveAccess(ctx, 'dodo:read');
    const owner = actorKey(ctx.principal), session = this.requireSession(sessionId, owner, false), payload = this.snapshotPayload(ctx);
    return this.putEvidence(session, owner, 'snapshot', `workspace:${this.services.workspaceId}`, payload);
  }

  async evidence(ctx: ToolCtx, sessionId: string, evidenceId: string, refresh: boolean): Promise<RuntimeEvidenceData> {
    this.check(); liveAccess(ctx, 'dodo:read'); this.recover();
    const owner = actorKey(ctx.principal), session = this.requireSession(sessionId, owner, true);
    let row = this.services.store.db.prepare('SELECT * FROM runtime_evidence WHERE id=? AND session_id=? AND workspace_id=? AND owner=?')
      .get(evidenceId, session.id, this.services.workspaceId, owner) as EvidenceRow | undefined;
    if (!row) throw new DodoError('NOT_FOUND', 'runtime evidence was not found for this session, workspace and client');
    if (refresh && row.status === 'CURRENT') row = await this.refreshEvidence(ctx, row);
    return this.evidenceData(row);
  }

  async diagnose(ctx: ToolCtx, sessionId: string, evidenceIds: string[]) {
    this.check(); liveAccess(ctx, 'dodo:read');
    if (!evidenceIds.length) throw new DodoError('INVALID_INPUT', 'provide at least one runtime evidence ID');
    const evidence = await Promise.all(evidenceIds.map((id) => this.evidence(ctx, sessionId, id, true)));
    const facts: string[] = [], observations: string[] = [], inferences: Array<{ statement: string; confidence: 'low' | 'medium' | 'high'; evidenceIds: string[] }> = [];
    for (const item of evidence) {
      facts.push(`${item.kind} evidence ${item.evidenceId} is ${item.status} and source-hash bound`);
      const p = item.payload;
      if (item.kind === 'process' || item.kind === 'test' || item.kind === 'container') {
        observations.push(`task ${String(p['taskId'])} status=${String(p['status'])} exitCode=${String(p['exitCode'])}`);
        if (p['status'] === 'exited' && p['exitCode'] === 0) inferences.push({ statement: 'The observed process completed successfully at the OS process level.', confidence: 'high', evidenceIds: [item.evidenceId] });
        else if (p['status'] !== 'running') inferences.push({ statement: 'The observed process did not complete successfully; inspect bounded job output before changing code.', confidence: 'high', evidenceIds: [item.evidenceId] });
      } else if (item.kind === 'browser') {
        observations.push(`browser observation recorded ${String(p['elementCount'])} elements, ${String(p['consoleCount'])} console events and ${String(p['blockedNetworkCount'])} blocked network requests`);
        if (Number(p['blockedNetworkCount']) > 0) inferences.push({ statement: 'Blocked browser requests may explain missing runtime behavior.', confidence: 'medium', evidenceIds: [item.evidenceId] });
      } else {
        observations.push(`workspace snapshot contains ${String(p['fileCount'])} guarded file metadata entries and ${String((p['rollbackCandidates'] as unknown[] | undefined)?.length ?? 0)} rollback candidates`);
      }
    }
    return RuntimeDiagnosis.parse({
      sessionId, facts, observations, inferences,
      limitations: ['Diagnosis is deterministic over bounded metadata and hashes; it does not inspect raw stdout, secrets, cookies, headers, environment values or hidden browser inputs.', 'Process exit success does not by itself prove product behavior; verify source and user-visible state.'],
      trust: 'untrusted_runtime_evidence',
    });
  }

  /** Bounded current evidence used by Context Engine; same caller/workspace only. */
  contextHits(ctx: ToolCtx, terms: string[], limit: number): Array<{ evidenceId: string; claim: string; contentHash: string; score: number; limitations: string[] }> {
    this.check(); liveAccess(ctx, 'dodo:read'); this.recover();
    const owner = actorKey(ctx.principal);
    const rows = this.services.store.db.prepare("SELECT * FROM runtime_evidence WHERE workspace_id=? AND owner=? AND status='CURRENT' AND expires_at>? ORDER BY created_at DESC LIMIT 200")
      .all(this.services.workspaceId, owner, Date.now()) as EvidenceRow[];
    const wanted = terms.map((term) => term.toLocaleLowerCase('en-US'));
    return rows.map((row) => {
      const payload = this.parsePayload(row.payload), haystack = `${row.kind} ${row.source_ref} ${JSON.stringify(payload)}`.toLocaleLowerCase('en-US');
      const matched = wanted.filter((term) => haystack.includes(term)).length;
      return { row, payload, matched };
    }).filter((item) => wanted.length === 0 || item.matched > 0).sort((a, b) => b.matched - a.matched || b.row.created_at - a.row.created_at).slice(0, limit).map(({ row, payload, matched }) => ({
      evidenceId: row.id,
      claim: this.safeClaim(row.kind, payload),
      contentHash: row.content_hash,
      score: 68 + Math.min(16, matched * 4),
      limitations: ['Bounded runtime metadata; raw command/browser data is intentionally not retained.'],
    }));
  }

  manifest(ctx: ToolCtx): string {
    this.check(); liveAccess(ctx, 'dodo:read'); this.recover(); const owner = actorKey(ctx.principal);
    const rows = this.services.store.db.prepare("SELECT id,content_hash,status,last_verified_at FROM runtime_evidence WHERE workspace_id=? AND owner=? AND expires_at>? ORDER BY id")
      .all(this.services.workspaceId, owner, Date.now());
    return digestOf(rows);
  }

  dependencyHash(ctx: ToolCtx, evidenceId: string): string | undefined {
    const owner = actorKey(ctx.principal);
    const row = this.services.store.db.prepare("SELECT content_hash,status,expires_at FROM runtime_evidence WHERE id=? AND workspace_id=? AND owner=?")
      .get(evidenceId, this.services.workspaceId, owner) as { content_hash: string; status: string; expires_at: number } | undefined;
    return row && row.status === 'CURRENT' && row.expires_at > Date.now() ? row.content_hash : undefined;
  }

  private taskPayload(task: TaskRow, reportPath?: string): Record<string, unknown> {
    const job = this.services.jobs.getJobChecked(task.job_id, this.services.workspaceId);
    if (job.principal !== this.grantForOwner(task.owner)) throw new DodoError('FORBIDDEN', 'runtime task ownership no longer matches its job');
    const stdout = this.services.jobs.inlineOutput(job.id, this.services.workspaceId, 'stdout', OUTPUT_SAMPLE_BYTES);
    const stderr = this.services.jobs.inlineOutput(job.id, this.services.workspaceId, 'stderr', OUTPUT_SAMPLE_BYTES);
    const payload: Record<string, unknown> = {
      taskId: task.id, jobId: job.id, kind: task.kind, status: job.status, exitCode: job.exitCode, signal: job.signal,
      startedAt: job.startedAt, endedAt: job.endedAt, timeoutMs: job.timeoutMs,
      durationMs: job.startedAt !== null && job.endedAt !== null ? Math.max(0, job.endedAt - job.startedAt) : null,
      stdout: { bytes: stdout.totalBytes, sampleSha256: sha256Bytes(`${stdout.content}${stdout.tail ?? ''}`), truncated: stdout.truncated },
      stderr: { bytes: stderr.totalBytes, sampleSha256: sha256Bytes(`${stderr.content}${stderr.tail ?? ''}`), truncated: stderr.truncated },
    };
    if (reportPath) payload['testReport'] = this.testReport(reportPath);
    return payload;
  }

  /** Resolve the grant id for a hashed owner through the attached job, without storing or exposing it in evidence. */
  private grantForOwner(owner: string): string {
    const row = this.services.store.db.prepare('SELECT j.principal FROM runtime_tasks t JOIN jobs j ON j.id=t.job_id WHERE t.owner=? ORDER BY t.created_at DESC LIMIT 1').get(owner) as { principal: string } | undefined;
    return row?.principal ?? '';
  }

  private testReport(reportPath: string): Record<string, unknown> {
    const file = this.services.wfs.readTextFile(reportPath, 2 * 1024 * 1024);
    let value: unknown;
    try { value = JSON.parse(file.text); } catch { throw new DodoError('INVALID_INPUT', 'test report must be valid JSON'); }
    const root = value && typeof value === 'object' ? value as Record<string, unknown> : {};
    const number = (...keys: string[]): number | null => { for (const key of keys) if (typeof root[key] === 'number' && Number.isFinite(root[key])) return Math.max(0, Math.trunc(root[key] as number)); return null; };
    return { path: file.rel, hash: file.hash, total: number('numTotalTests', 'total'), passed: number('numPassedTests', 'passed'), failed: number('numFailedTests', 'failed'), skipped: number('numPendingTests', 'skipped'), success: typeof root['success'] === 'boolean' ? root['success'] : null };
  }

  private snapshotPayload(ctx: ToolCtx): Record<string, unknown> {
    const limit = Math.min(10_000, this.services.limits.semanticFilesMax * 4), files: Array<{ path: string; bytes: number; mtimeMs: number; ctimeMs: number }> = [];
    for (const entry of this.services.wfs.walk({ maxEntries: limit + 1, maxDepth: 64 })) {
      if (entry.stat.isFile()) files.push({ path: entry.rel, bytes: entry.stat.size, mtimeMs: entry.stat.mtimeMs, ctimeMs: entry.stat.ctimeMs });
      if (files.length > limit) break;
    }
    const visible = files.slice(0, limit), manifestHash = digestOf(visible);
    const rollbackCandidates = this.services.store.listChangesets(this.services.workspaceId, 50)
      .filter((change) => change.principal === ctx.principal.grantId && change.kind === 'apply' && change.status === 'committed')
      .map((change) => ({ changesetId: change.id, createdAt: change.createdAt, summaryHash: sha256Bytes(change.summary ?? '') }));
    return { manifestHash, fileCount: visible.length, truncated: files.length > limit, rollbackCandidates, note: 'Snapshot stores guarded file metadata hash only. Rollback remains an explicit rollback_changes call with its existing conflict checks.' };
  }

  private async refreshEvidence(ctx: ToolCtx, row: EvidenceRow): Promise<EvidenceRow> {
    let payload: Record<string, unknown> | undefined, sourceHash: string | undefined, reason: string | null = null;
    try {
      if (row.kind === 'process' || row.kind === 'test' || row.kind === 'container') {
        const taskId = String(this.parsePayload(row.payload)['taskId']);
        const task = this.requireTask(row.session_id, taskId, row.owner);
        payload = this.taskPayload(task, typeof (this.parsePayload(row.payload)['testReport'] as Record<string, unknown> | undefined)?.['path'] === 'string' ? String((this.parsePayload(row.payload)['testReport'] as Record<string, unknown>)['path']) : undefined);
      } else if (row.kind === 'browser') {
        const old = this.parsePayload(row.payload), browser = this.services.multimodal?.browser;
        if (!browser) throw new DodoError('NOT_SUPPORTED', 'browser unavailable');
        const verified = await browser.verifyObservation(ctx.principal, String(old['browserSessionId']), String(old['observationId']));
        sourceHash = verified.sourceHash;
        payload = old;
      } else payload = this.snapshotPayload(ctx);
    } catch (error) { reason = `source recheck failed (${toDodoError(error).code})`; }
    const nextSource = sourceHash ?? (payload ? digestOf(payload) : row.source_hash);
    const status = reason || nextSource !== row.source_hash ? 'STALE' : 'CURRENT';
    if (!reason && status === 'STALE') reason = 'source hash changed since evidence was recorded';
    // Evidence is immutable: a changed source marks the original record stale.
    // A fresh runtime_task_observe/runtime_snapshot call creates a new record.
    this.services.store.db.prepare('UPDATE runtime_evidence SET status=?,stale_reason=?,last_verified_at=? WHERE id=?')
      .run(status, reason, Date.now(), row.id);
    return this.services.store.db.prepare('SELECT * FROM runtime_evidence WHERE id=?').get(row.id) as EvidenceRow;
  }

  private putEvidence(session: SessionRow, owner: string, kind: RuntimeEvidenceData['kind'], sourceRef: string, payload: Record<string, unknown>, explicitSourceHash?: string): RuntimeEvidenceData {
    this.enforceEvidenceQuota(session.id, owner);
    const sourceHash = explicitSourceHash ?? digestOf(payload), contentHash = digestOf(payload), now = Date.now();
    const existing = this.services.store.db.prepare('SELECT * FROM runtime_evidence WHERE session_id=? AND owner=? AND kind=? AND source_ref=? AND source_hash=?')
      .get(session.id, owner, kind, sourceRef, sourceHash) as EvidenceRow | undefined;
    if (existing) { this.services.store.db.prepare('UPDATE runtime_evidence SET last_verified_at=? WHERE id=?').run(now, existing.id); return this.evidenceData({ ...existing, last_verified_at: now }); }
    const id = newId('runtimeev');
    this.services.store.db.prepare(`INSERT INTO runtime_evidence(id,session_id,workspace_id,owner,kind,payload,source_ref,source_hash,content_hash,status,stale_reason,created_at,last_verified_at,expires_at)
      VALUES (?,?,?,?,?,?,?,?,?,'CURRENT',NULL,?,?,?)`).run(id, session.id, this.services.workspaceId, owner, kind, JSON.stringify(payload), sourceRef, sourceHash, contentHash, now, now, now + EVIDENCE_TTL_MS);
    return this.evidenceData(this.services.store.db.prepare('SELECT * FROM runtime_evidence WHERE id=?').get(id) as EvidenceRow);
  }

  private enforceEvidenceQuota(sessionId: string, owner: string): void {
    const local = (this.services.store.db.prepare('SELECT COUNT(*) AS n FROM runtime_evidence WHERE session_id=? AND owner=?').get(sessionId, owner) as { n: number }).n;
    const total = (this.services.store.db.prepare('SELECT COUNT(*) AS n FROM runtime_evidence WHERE workspace_id=? AND owner=?').get(this.services.workspaceId, owner) as { n: number }).n;
    if (local >= MAX_EVIDENCE_PER_SESSION || total >= MAX_EVIDENCE_TOTAL) throw new DodoError('RESOURCE_LIMIT', 'runtime evidence retention quota reached; close old sessions or wait for expiry');
  }

  private row(id: string, owner: string): SessionRow | undefined { return this.services.store.db.prepare('SELECT * FROM runtime_sessions WHERE id=? AND workspace_id=? AND owner=?').get(id, this.services.workspaceId, owner) as SessionRow | undefined; }
  private requireSession(id: string, owner: string, allowClosed: boolean): SessionRow {
    const row = this.row(id, owner); if (!row) throw new DodoError('NOT_FOUND', 'runtime session was not found for this workspace and client');
    if (!allowClosed && row.status !== 'OPEN') throw new DodoError('CONFLICT', `runtime session is ${row.status.toLowerCase()}`);
    if (row.status === 'OPEN') this.services.store.db.prepare('UPDATE runtime_sessions SET last_seen_at=? WHERE id=?').run(Date.now(), id);
    return { ...row, last_seen_at: row.status === 'OPEN' ? Date.now() : row.last_seen_at };
  }
  private taskRows(sessionId: string, owner: string): TaskRow[] { return this.services.store.db.prepare('SELECT * FROM runtime_tasks WHERE session_id=? AND workspace_id=? AND owner=? ORDER BY created_at DESC').all(sessionId, this.services.workspaceId, owner) as TaskRow[]; }
  private requireTask(sessionId: string, id: string, owner: string): TaskRow { const row = this.services.store.db.prepare('SELECT * FROM runtime_tasks WHERE id=? AND session_id=? AND workspace_id=? AND owner=?').get(id, sessionId, this.services.workspaceId, owner) as TaskRow | undefined; if (!row) throw new DodoError('NOT_FOUND', 'runtime task was not found for this session, workspace and client'); return row; }
  private sessionData(row: SessionRow): RuntimeSessionData { return RuntimeSession.parse({ schemaVersion: RUNTIME_SCHEMA_VERSION, sessionId: row.id, label: row.label, status: row.status, workspaceId: row.workspace_id, openedEpoch: row.opened_epoch, createdAt: row.created_at, lastSeenAt: row.last_seen_at, expiresAt: row.expires_at, closedAt: row.closed_at }); }
  private taskData(row: TaskRow): RuntimeTaskData { const job = this.services.jobs.getJobChecked(row.job_id, this.services.workspaceId); return RuntimeTask.parse({ taskId: row.id, sessionId: row.session_id, jobId: row.job_id, kind: row.kind, status: job.status, exitCode: job.exitCode, signal: job.signal, createdAt: row.created_at, startedAt: job.startedAt, endedAt: job.endedAt, timeoutMs: job.timeoutMs }); }
  private evidenceData(row: EvidenceRow): RuntimeEvidenceData { return RuntimeEvidence.parse({ schemaVersion: RUNTIME_SCHEMA_VERSION, evidenceId: row.id, sessionId: row.session_id, kind: row.kind, status: row.status, sourceRef: row.source_ref, sourceHash: row.source_hash, contentHash: row.content_hash, payload: this.parsePayload(row.payload), staleReason: row.stale_reason, createdAt: row.created_at, lastVerifiedAt: row.last_verified_at, expiresAt: row.expires_at, trust: 'untrusted_runtime_evidence' }); }
  private parsePayload(value: string): Record<string, unknown> { try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; } catch { return {}; } }
  private safeClaim(kind: RuntimeEvidenceData['kind'], payload: Record<string, unknown>): string { if (kind === 'snapshot') return `Runtime snapshot: ${String(payload['fileCount'])} guarded files; manifest ${String(payload['manifestHash'])}`; if (kind === 'browser') return `Browser runtime observation: ${String(payload['elementCount'])} elements, ${String(payload['consoleCount'])} console events, ${String(payload['blockedNetworkCount'])} blocked requests`; return `${kind} runtime task ${String(payload['taskId'])}: status ${String(payload['status'])}, exit ${String(payload['exitCode'])}`; }
  private recover(): void {
    const now = Date.now();
    this.services.store.db.prepare("UPDATE runtime_sessions SET status='EXPIRED',closed_at=? WHERE status='OPEN' AND expires_at<=?").run(now, now);
    // Expired evidence handles cease to exist and free their bounded quota.
    this.services.store.db.prepare('DELETE FROM runtime_evidence WHERE expires_at<=?').run(now);
    // Keep closed/expired session metadata for one evidence-retention window, then
    // cascade task/evidence references. Jobs themselves remain in the job store.
    this.services.store.db.prepare("DELETE FROM runtime_sessions WHERE status IN ('CLOSED','EXPIRED') AND COALESCE(closed_at,expires_at)<=?").run(now - EVIDENCE_TTL_MS);
  }
  private check(): void { if (this.closed) throw new DodoError('STALE_WORKSPACE', 'runtime workspace is closed'); }
}
