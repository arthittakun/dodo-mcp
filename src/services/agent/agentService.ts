import { parsePatch } from 'diff';
import { DodoError } from '../../errors.js';
import { redact } from '../../security/redact.js';
import type { StoredPlan } from '../changes/types.js';
import type { AppServices, ToolCtx } from '../../tools/context.js';
import { digestOf, newId } from '../../util/hash.js';
import { actorKey, liveAccess } from '../multimodal/storage.js';
import {
  AGENT_SCHEMA_VERSION,
  AgentCapabilities,
  AgentHypothesis,
  AgentIntent,
  AgentPlan,
  AgentRun,
  AgentSkillDetail,
  AgentSkillSummary,
  AgentSnapshot,
  type AgentCapabilitiesData,
  type AgentHypothesisData,
  type AgentIntentData,
  type AgentRunData,
  type AgentSnapshotData,
} from './contracts.js';

const MAX_OPEN_RUNS = 16;
const MAX_RETAINED_RUNS = 100;
const MAX_PLAN_STEPS = 100;
const MAX_INTENTS = 128;
const MAX_SNAPSHOT_FILES = 10_000;
const RUN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const SKILL_PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;

type RunStatus = AgentRunData['status'];
type RunRow = {
  id: string; workspace_id: string; opened_epoch: string; owner: string; goal: string; criteria: string;
  capabilities: string; status: RunStatus; revision: number; action_count: number; created_at: number;
  updated_at: number; expires_at: number; completed_at: number | null;
};
type HypothesisRow = {
  id: string; run_id: string; workspace_id: string; owner: string; title: string; probable_cause: string;
  expected_evidence: string; status: AgentHypothesisData['status']; created_at: number; updated_at: number;
};
type IntentRow = {
  id: string; run_id: string; hypothesis_id: string; workspace_id: string; owner: string;
  kind: AgentIntentData['kind']; resource_key: string; status: AgentIntentData['status']; created_at: number;
  expires_at: number; released_at: number | null;
};
type SnapshotManifest = {
  files: Array<{ path: string; bytes: number; mtimeMs: number; ctimeMs: number }>;
  truncated: boolean;
  baselineChangesets: string[];
};
type SnapshotRow = {
  id: string; run_id: string; hypothesis_id: string; workspace_id: string; owner: string;
  manifest_hash: string; manifest: string; created_at: number;
};
type SkillProposalRow = {
  id: string; workspace_id: string; principal: string; skill_key: string; title: string; summary: string;
  steps: string; capabilities: string; base_skill_id: string | null; base_version: number | null; digest: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED'; created_at: number; expires_at: number;
  reviewed_at: number | null; review_note: string | null;
};
type SkillRow = {
  id: string; workspace_id: string; skill_key: string; title: string; summary: string; steps: string;
  capabilities: string; version: number; proposal_id: string; digest: string; status: 'CURRENT' | 'SUPERSEDED';
  created_at: number; approved_at: number;
};

export interface AgentOperationTicket { actionId: string; runId: string; hypothesisId: string }

function parseObject<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function sameProgram(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function withinPrefix(path: string, prefix: string): boolean {
  if (prefix === '.') return true;
  const left = process.platform === 'win32' ? path.toLowerCase() : path;
  const right = process.platform === 'win32' ? prefix.toLowerCase() : prefix;
  return left === right || left.startsWith(`${right}/`);
}

function pathsOverlap(a: string, b: string): boolean {
  return withinPrefix(a, b) || withinPrefix(b, a);
}

/** Durable coordination state. It narrows an existing principal; it never grants authority or executes skills. */
export class AgentRuntimeService {
  private closed = false;

  constructor(private readonly services: AppServices) { this.recoverOnBoot(); }

  close(): void { this.closed = true; }

  open(ctx: ToolCtx, input: { goal: string; completionCriteria: string[]; capabilities: AgentCapabilitiesData }): AgentRunData {
    this.check(); liveAccess(ctx, 'dodo:write'); this.expire();
    const owner = actorKey(ctx.principal);
    const open = (this.services.store.db.prepare("SELECT COUNT(*) AS n FROM agent_runs WHERE workspace_id=? AND owner=? AND status IN ('ACTIVE','PAUSED','RECOVERY_REQUIRED')").get(this.services.workspaceId, owner) as { n: number }).n;
    if (open >= MAX_OPEN_RUNS) throw new DodoError('RESOURCE_LIMIT', `at most ${MAX_OPEN_RUNS} open agent runs per client and workspace`);
    const retained = (this.services.store.db.prepare('SELECT COUNT(*) AS n FROM agent_runs WHERE workspace_id=? AND owner=?').get(this.services.workspaceId, owner) as { n: number }).n;
    if (retained >= MAX_RETAINED_RUNS) throw new DodoError('RESOURCE_LIMIT', `at most ${MAX_RETAINED_RUNS} retained agent runs per client and workspace`);
    const capabilities = this.normalizeCapabilities(ctx, input.capabilities);
    const now = Date.now(), id = newId('arun'), expiresAt = now + capabilities.maxWallMinutes * 60_000;
    this.services.store.db.prepare(`INSERT INTO agent_runs(id,workspace_id,opened_epoch,owner,goal,criteria,capabilities,status,revision,action_count,created_at,updated_at,expires_at,completed_at)
      VALUES (?,?,?,?,?,?,?,'ACTIVE',1,0,?,?,?,NULL)`).run(
        id, this.services.workspaceId, this.services.epoch, owner, input.goal,
        JSON.stringify(input.completionCriteria), JSON.stringify(capabilities), now, now, expiresAt,
      );
    return this.runData(this.runRow(id, owner)!);
  }

  status(ctx: ToolCtx, runId: string): Record<string, unknown> {
    this.check(); liveAccess(ctx, 'dodo:read'); this.expire();
    const owner = actorKey(ctx.principal), run = this.requireRun(runId, owner);
    const planRow = this.services.store.db.prepare('SELECT revision,steps,content_hash,created_at FROM agent_plans WHERE run_id=? AND owner=? ORDER BY revision DESC LIMIT 1')
      .get(run.id, owner) as { revision: number; steps: string; content_hash: string; created_at: number } | undefined;
    const plan = planRow ? AgentPlan.parse({ runId: run.id, revision: planRow.revision, steps: parseObject(planRow.steps, []), contentHash: planRow.content_hash, createdAt: planRow.created_at, immutable: true }) : null;
    const hypotheses = this.hypothesisRows(run.id, owner).map((row) => this.hypothesisData(row));
    const intents = (this.services.store.db.prepare("SELECT * FROM agent_intents WHERE run_id=? AND owner=? AND status='ACTIVE' ORDER BY created_at").all(run.id, owner) as IntentRow[]).map((row) => this.intentData(row));
    const latestJudgement = this.services.store.db.prepare('SELECT id,payload,content_hash,created_at FROM agent_judgements WHERE run_id=? AND owner=? ORDER BY created_at DESC LIMIT 1')
      .get(run.id, owner) as { id: string; payload: string; content_hash: string; created_at: number } | undefined;
    const snapshots = (this.services.store.db.prepare('SELECT COUNT(*) AS n FROM agent_snapshots WHERE run_id=? AND owner=?').get(run.id, owner) as { n: number }).n;
    return {
      schemaVersion: AGENT_SCHEMA_VERSION, run: this.runData(run), plan, hypotheses, intents, snapshots,
      latestJudgement: latestJudgement ? { judgementId: latestJudgement.id, ...parseObject(latestJudgement.payload, {}), contentHash: latestJudgement.content_hash, createdAt: latestJudgement.created_at } : null,
      note: 'Coordinator state is durable guidance. Target tools, live OAuth/workspace ACL, trust, approvals, path guards and command sandbox remain authoritative.',
    };
  }

  setPlan(ctx: ToolCtx, runId: string, expectedRevision: number, steps: unknown[]): ReturnType<typeof AgentPlan.parse> {
    this.check(); liveAccess(ctx, 'dodo:write');
    const owner = actorKey(ctx.principal), run = this.requireActiveRun(runId, owner);
    if (run.revision !== expectedRevision) throw new DodoError('CONFLICT', 'agent run revision changed; read agent_run_status and retry', { detail: { expectedRevision, actualRevision: run.revision } });
    if (steps.length < 1 || steps.length > MAX_PLAN_STEPS) throw new DodoError('RESOURCE_LIMIT', `agent plan must contain 1..${MAX_PLAN_STEPS} steps`);
    const parsed = AgentPlan.shape.steps.parse(steps);
    this.validatePlan(parsed);
    const revision = run.revision + 1, createdAt = Date.now(), contentHash = digestOf(parsed);
    this.services.store.db.transaction(() => {
      const changed = this.services.store.db.prepare('UPDATE agent_runs SET revision=?,updated_at=? WHERE id=? AND owner=? AND revision=?')
        .run(revision, createdAt, run.id, owner, expectedRevision);
      if (changed.changes !== 1) throw new DodoError('CONFLICT', 'agent run revision changed while saving the plan');
      this.services.store.db.prepare('INSERT INTO agent_plans(run_id,revision,workspace_id,owner,steps,content_hash,created_at) VALUES (?,?,?,?,?,?,?)')
        .run(run.id, revision, this.services.workspaceId, owner, JSON.stringify(parsed), contentHash, createdAt);
    })();
    return AgentPlan.parse({ runId: run.id, revision, steps: parsed, contentHash, createdAt, immutable: true });
  }

  openHypothesis(ctx: ToolCtx, runId: string, input: { title: string; probableCause: string; expectedEvidence: string[] }): AgentHypothesisData {
    this.check(); liveAccess(ctx, 'dodo:write');
    const owner = actorKey(ctx.principal), run = this.requireActiveRun(runId, owner), capabilities = this.capabilities(run);
    const count = (this.services.store.db.prepare('SELECT COUNT(*) AS n FROM agent_hypotheses WHERE run_id=? AND owner=?').get(run.id, owner) as { n: number }).n;
    if (count >= capabilities.maxHypotheses) throw new DodoError('RESOURCE_LIMIT', `agent run allows at most ${capabilities.maxHypotheses} hypotheses`);
    const now = Date.now(), id = newId('ahyp');
    this.services.store.db.prepare(`INSERT INTO agent_hypotheses(id,run_id,workspace_id,owner,title,probable_cause,expected_evidence,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,'ACTIVE',?,?)`).run(id, run.id, this.services.workspaceId, owner, input.title, input.probableCause, JSON.stringify(input.expectedEvidence), now, now);
    return this.hypothesisData(this.hypothesisRow(run.id, id, owner)!);
  }

  acquireIntent(ctx: ToolCtx, runId: string, hypothesisId: string, kind: IntentRow['kind'], rawKey: string, ttlMinutes: number): AgentIntentData {
    this.check(); liveAccess(ctx, 'dodo:write'); this.expire();
    const owner = actorKey(ctx.principal), run = this.requireActiveRun(runId, owner);
    this.requireActiveHypothesis(run.id, hypothesisId, owner);
    const held = (this.services.store.db.prepare("SELECT COUNT(*) AS n FROM agent_intents WHERE run_id=? AND owner=? AND status='ACTIVE'").get(run.id, owner) as { n: number }).n;
    if (held >= MAX_INTENTS) throw new DodoError('RESOURCE_LIMIT', `at most ${MAX_INTENTS} active intents per agent run`);
    const resourceKey = this.normalizeIntentKey(kind, rawKey);
    const candidates = this.services.store.db.prepare("SELECT * FROM agent_intents WHERE workspace_id=? AND kind=? AND status='ACTIVE' AND expires_at>?")
      .all(this.services.workspaceId, kind, Date.now()) as IntentRow[];
    const conflict = candidates.find((row) => row.hypothesis_id !== hypothesisId && (kind === 'path' ? pathsOverlap(row.resource_key, resourceKey) : row.resource_key === resourceKey));
    if (conflict) throw new DodoError('CONFLICT', `another active hypothesis holds an overlapping ${kind} intent`, { recovery: 'wait for release/expiry or use a separate non-overlapping path/resource' });
    const existing = candidates.find((row) => row.hypothesis_id === hypothesisId && row.resource_key === resourceKey);
    if (existing) return this.intentData(existing);
    const now = Date.now(), expiresAt = Math.min(run.expires_at, now + ttlMinutes * 60_000), id = newId('aintent');
    this.services.store.db.prepare(`INSERT INTO agent_intents(id,run_id,hypothesis_id,workspace_id,owner,kind,resource_key,status,created_at,expires_at,released_at)
      VALUES (?,?,?,?,?,?,?,'ACTIVE',?,?,NULL)`).run(id, run.id, hypothesisId, this.services.workspaceId, owner, kind, resourceKey, now, expiresAt);
    return this.intentData(this.intentRow(id, owner)!);
  }

  releaseIntent(ctx: ToolCtx, runId: string, hypothesisId: string, intentId: string): AgentIntentData {
    this.check(); liveAccess(ctx, 'dodo:write');
    const owner = actorKey(ctx.principal); this.requireRun(runId, owner); this.requireHypothesis(runId, hypothesisId, owner);
    const row = this.intentRow(intentId, owner);
    if (!row || row.run_id !== runId || row.hypothesis_id !== hypothesisId) throw new DodoError('NOT_FOUND', 'agent intent was not found for this run and hypothesis');
    if (row.status === 'ACTIVE') this.services.store.db.prepare("UPDATE agent_intents SET status='RELEASED',released_at=? WHERE id=? AND owner=?").run(Date.now(), row.id, owner);
    return this.intentData(this.intentRow(row.id, owner)!);
  }

  beginOperation(ctx: ToolCtx, runId: string, hypothesisId: string, operation: string, args: Record<string, unknown>, requiredScope: 'dodo:read' | 'dodo:write' | 'dodo:exec'): AgentOperationTicket {
    this.check(); liveAccess(ctx, requiredScope);
    const owner = actorKey(ctx.principal), run = this.requireActiveRun(runId, owner), hypothesis = this.requireActiveHypothesis(run.id, hypothesisId, owner);
    const capabilities = this.capabilities(run);
    this.assertProjects(args, capabilities);
    this.assertFeature(operation, args, capabilities);
    if (requiredScope === 'dodo:write') this.assertWritableOperation(ctx, run, hypothesis, operation, args, capabilities);
    if (requiredScope === 'dodo:exec') this.assertExecutableOperation(ctx, operation, args, capabilities);
    const id = newId('aaction'), now = Date.now(), inputHash = digestOf({ operation, args });
    this.services.store.db.transaction(() => {
      const updated = this.services.store.db.prepare('UPDATE agent_runs SET action_count=action_count+1,updated_at=? WHERE id=? AND owner=? AND action_count<?')
        .run(now, run.id, owner, capabilities.maxActions);
      if (updated.changes !== 1) throw new DodoError('RESOURCE_LIMIT', `agent run allows at most ${capabilities.maxActions} target actions`);
      this.services.store.db.prepare(`INSERT INTO agent_actions(id,run_id,hypothesis_id,workspace_id,owner,operation,input_hash,status,result_code,result_hash,created_at,completed_at)
        VALUES (?,?,?,?,?,?,?,'RUNNING',NULL,NULL,?,NULL)`).run(id, run.id, hypothesis.id, this.services.workspaceId, owner, operation, inputHash, now);
    })();
    return { actionId: id, runId: run.id, hypothesisId: hypothesis.id };
  }

  finishOperation(ticket: AgentOperationTicket, result: { ok: boolean; code?: string; digest: string }): void {
    this.services.store.db.prepare("UPDATE agent_actions SET status=?,result_code=?,result_hash=?,completed_at=? WHERE id=? AND status='RUNNING'")
      .run(result.ok ? 'COMPLETED' : 'FAILED', result.code ?? null, result.digest, Date.now(), ticket.actionId);
  }

  createSnapshot(ctx: ToolCtx, runId: string, hypothesisId: string): AgentSnapshotData {
    this.check(); liveAccess(ctx, 'dodo:read');
    const owner = actorKey(ctx.principal), run = this.requireActiveRun(runId, owner); this.requireActiveHypothesis(run.id, hypothesisId, owner);
    const manifest = this.buildManifest(), manifestHash = digestOf(manifest.files), id = newId('asnap'), now = Date.now();
    this.services.store.db.prepare('INSERT INTO agent_snapshots(id,run_id,hypothesis_id,workspace_id,owner,manifest_hash,manifest,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, run.id, hypothesisId, this.services.workspaceId, owner, manifestHash, JSON.stringify(manifest), now);
    return AgentSnapshot.parse({ snapshotId: id, runId: run.id, hypothesisId, manifestHash, fileCount: manifest.files.length, truncated: manifest.truncated, createdAt: now, storesFileContents: false });
  }

  compareSnapshot(ctx: ToolCtx, runId: string, hypothesisId: string, snapshotId: string): Record<string, unknown> {
    this.check(); liveAccess(ctx, 'dodo:read');
    const owner = actorKey(ctx.principal); this.requireRun(runId, owner); this.requireHypothesis(runId, hypothesisId, owner);
    const { row, manifest: before } = this.requireSnapshot(runId, hypothesisId, snapshotId, owner), after = this.buildManifest();
    const old = new Map(before.files.map((file) => [file.path, file])), current = new Map(after.files.map((file) => [file.path, file]));
    const added: string[] = [], removed: string[] = [], modified: string[] = [];
    for (const [file, stat] of current) { const prior = old.get(file); if (!prior) added.push(file); else if (digestOf(prior) !== digestOf(stat)) modified.push(file); }
    for (const file of old.keys()) if (!current.has(file)) removed.push(file);
    const candidates = this.rollbackCandidates(before, ctx.principal.grantId);
    const total = added.length + removed.length + modified.length, max = 100;
    return {
      snapshot: AgentSnapshot.parse({ snapshotId: row.id, runId, hypothesisId, manifestHash: row.manifest_hash, fileCount: before.files.length, truncated: before.truncated, createdAt: row.created_at, storesFileContents: false }),
      currentManifestHash: digestOf(after.files), changed: total > 0, changes: { added: added.slice(0, max), removed: removed.slice(0, max), modified: modified.slice(0, max), total, truncated: total > max || before.truncated || after.truncated },
      rollbackCandidates: candidates,
      note: 'Snapshot comparison uses guarded metadata. Rollback candidates still require agent_snapshot_rollback and the original rollback_changes conflict/approval checks.',
    };
  }

  assertSnapshotRollback(ctx: ToolCtx, runId: string, hypothesisId: string, snapshotId: string, changesetId: string): void {
    this.check(); liveAccess(ctx, 'dodo:write');
    const owner = actorKey(ctx.principal), run = this.requireActiveRun(runId, owner), hypothesis = this.requireActiveHypothesis(run.id, hypothesisId, owner);
    const { manifest } = this.requireSnapshot(run.id, hypothesis.id, snapshotId, owner);
    if (!this.rollbackCandidates(manifest, ctx.principal.grantId).some((item) => item.changesetId === changesetId)) throw new DodoError('CONFLICT', 'changeset is not a caller-owned committed rollback candidate created after this snapshot');
    const paths = this.services.store.listJournalSteps(changesetId).flatMap((step) => [step.path, ...(step.destPath ? [step.destPath] : [])]);
    this.assertAllowedPaths(paths, this.capabilities(run));
    this.assertHeldLocks(run.id, hypothesis.id, owner, paths);
  }

  async judge(ctx: ToolCtx, runId: string, results: Array<{ hypothesisId: string; verdict: 'passed' | 'failed' | 'inconclusive'; score: number; rationale: string; evidence: Array<{ sessionId: string; evidenceId: string }> }>): Promise<Record<string, unknown>> {
    this.check(); liveAccess(ctx, 'dodo:write');
    const owner = actorKey(ctx.principal), run = this.requireActiveRun(runId, owner);
    const runtime = this.services.runtime;
    if (!runtime) throw new DodoError('NOT_SUPPORTED', 'Runtime Intelligence is required to judge hypotheses');
    const seen = new Set<string>(), normalized: Array<Record<string, unknown>> = [];
    for (const result of results) {
      if (seen.has(result.hypothesisId)) throw new DodoError('INVALID_INPUT', 'duplicate hypothesis in judge input');
      seen.add(result.hypothesisId); const hypothesis = this.requireActiveHypothesis(run.id, result.hypothesisId, owner);
      if (result.evidence.length < 1) throw new DodoError('INVALID_INPUT', 'each hypothesis judgement requires current runtime evidence');
      const evidenceIds: string[] = [];
      for (const ref of result.evidence) {
        const evidence = await runtime.evidence(ctx, ref.sessionId, ref.evidenceId, true);
        if (evidence.status !== 'CURRENT') throw new DodoError('CONFLICT', `evidence ${ref.evidenceId} is ${evidence.status}; collect current evidence before judging`);
        evidenceIds.push(evidence.evidenceId);
      }
      normalized.push({ hypothesisId: hypothesis.id, verdict: result.verdict, score: result.score, rationale: redact(result.rationale), evidenceIds });
    }
    const ranked = [...normalized].sort((a, b) => Number(b['score']) - Number(a['score']) || String(a['hypothesisId']).localeCompare(String(b['hypothesisId'])));
    const winner = ranked.find((item) => item['verdict'] === 'passed') ?? null, now = Date.now(), id = newId('ajudge');
    this.services.store.db.transaction(() => {
      for (const item of normalized) this.services.store.db.prepare('UPDATE agent_hypotheses SET status=?,updated_at=? WHERE id=? AND run_id=? AND owner=?')
        .run(String(item['verdict']).toUpperCase(), now, item['hypothesisId'], run.id, owner);
      const payload = { results: normalized, winnerHypothesisId: winner?.['hypothesisId'] ?? null, deterministicOrder: ranked.map((item) => item['hypothesisId']), authority: 'evidence_only' };
      const contentHash = digestOf(payload);
      this.services.store.db.prepare('INSERT INTO agent_judgements(id,run_id,workspace_id,owner,payload,content_hash,created_at) VALUES (?,?,?,?,?,?,?)')
        .run(id, run.id, this.services.workspaceId, owner, JSON.stringify(payload), contentHash, now);
    })();
    const row = this.services.store.db.prepare('SELECT payload,content_hash,created_at FROM agent_judgements WHERE id=?').get(id) as { payload: string; content_hash: string; created_at: number };
    return { judgementId: id, ...parseObject(row.payload, {}), contentHash: row.content_hash, createdAt: row.created_at };
  }

  async control(ctx: ToolCtx, runId: string, input: { action: 'pause' | 'resume' | 'cancel' | 'recover' | 'complete'; criteriaResults?: Array<{ criterion: string; passed: boolean; evidence: Array<{ sessionId: string; evidenceId: string }> }> }): Promise<Record<string, unknown>> {
    this.check(); liveAccess(ctx, 'dodo:write'); this.expire();
    const owner = actorKey(ctx.principal), run = this.requireRun(runId, owner), now = Date.now();
    if (input.action === 'pause') {
      if (run.status !== 'ACTIVE') throw new DodoError('CONFLICT', `only an ACTIVE run can pause (current ${run.status})`);
      this.updateRunStatus(run, owner, 'PAUSED');
    } else if (input.action === 'resume') {
      if (run.status !== 'PAUSED') throw new DodoError('CONFLICT', `only a PAUSED run can resume (current ${run.status})`);
      this.updateRunStatus(run, owner, 'ACTIVE');
    } else if (input.action === 'recover') {
      if (run.status !== 'RECOVERY_REQUIRED') throw new DodoError('CONFLICT', `only a RECOVERY_REQUIRED run can recover (current ${run.status})`);
      this.services.store.db.prepare("UPDATE agent_runs SET status='ACTIVE',opened_epoch=?,updated_at=? WHERE id=? AND owner=?").run(this.services.epoch, now, run.id, owner);
    } else if (input.action === 'cancel') {
      if (['COMPLETED', 'CANCELED', 'EXPIRED'].includes(run.status)) throw new DodoError('CONFLICT', `run is already ${run.status}`);
      this.services.store.db.transaction(() => { this.updateRunStatus(run, owner, 'CANCELED', now); this.releaseRunIntents(run.id, owner, now); })();
    } else {
      if (!['ACTIVE', 'PAUSED'].includes(run.status)) throw new DodoError('CONFLICT', `run cannot complete from ${run.status}`);
      const criteria = parseObject<string[]>(run.criteria, []), results = input.criteriaResults ?? [];
      if (results.length !== criteria.length || criteria.some((criterion) => !results.some((result) => result.criterion === criterion && result.passed))) {
        throw new DodoError('CONFLICT', 'every exact completion criterion must have a passed result before completing the run');
      }
      const runtime = this.services.runtime;
      if (!runtime) throw new DodoError('NOT_SUPPORTED', 'Runtime Intelligence is required to verify completion evidence');
      for (const result of results) {
        if (result.evidence.length < 1) throw new DodoError('INVALID_INPUT', `criterion requires current evidence: ${result.criterion}`);
        for (const ref of result.evidence) {
          const evidence = await runtime.evidence(ctx, ref.sessionId, ref.evidenceId, true);
          if (evidence.status !== 'CURRENT') throw new DodoError('CONFLICT', `completion evidence ${ref.evidenceId} is ${evidence.status}`);
        }
      }
      this.services.store.db.transaction(() => { this.updateRunStatus(run, owner, 'COMPLETED', now); this.releaseRunIntents(run.id, owner, now); })();
    }
    return { run: this.runData(this.runRow(run.id, owner)!), jobsKilled: false, note: 'Coordinator control never kills jobs. Cancel target work explicitly through its owning runtime/job operation.' };
  }

  proposeSkill(ctx: ToolCtx, input: { key: string; title: string; summary: string; steps: string[]; requiredCapabilities: string[]; baseVersion?: number }): Record<string, unknown> {
    this.check(); liveAccess(ctx, 'dodo:write'); this.expire();
    const clean = parseObject<{ title: string; summary: string; steps: string[]; requiredCapabilities: string[] }>(redact(JSON.stringify(input)), { title: '', summary: '', steps: [], requiredCapabilities: [] });
    const key = input.key.toLowerCase();
    const current = this.currentSkill(key);
    if (current && input.baseVersion !== current.version) throw new DodoError('CONFLICT', `skill ${key} is at version ${current.version}; propose against that exact baseVersion`);
    if (!current && input.baseVersion !== undefined) throw new DodoError('CONFLICT', 'baseVersion was supplied for a new skill');
    const payload = { key, title: clean.title, summary: clean.summary, steps: clean.steps, requiredCapabilities: clean.requiredCapabilities, baseSkillId: current?.id ?? null, baseVersion: current?.version ?? null, authority: 'untrusted_guidance' };
    const digest = digestOf(payload), now = Date.now(), id = newId('askillprop');
    this.services.store.db.prepare(`INSERT INTO agent_skill_proposals(id,workspace_id,principal,skill_key,title,summary,steps,capabilities,base_skill_id,base_version,digest,status,created_at,expires_at,reviewed_at,review_note)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,'PENDING',?,?,NULL,NULL)`).run(
        id, this.services.workspaceId, ctx.principal.grantId, key, payload.title, payload.summary, JSON.stringify(payload.steps), JSON.stringify(payload.requiredCapabilities), payload.baseSkillId, payload.baseVersion, digest, now, now + SKILL_PROPOSAL_TTL_MS,
      );
    return { proposalId: id, digest, status: 'PENDING', expiresAt: now + SKILL_PROPOSAL_TTL_MS, ownerReview: `dodo agent skill show ${id}`, authority: 'untrusted_guidance', executable: false };
  }

  searchSkills(ctx: ToolCtx, query: string, limit: number): Record<string, unknown> {
    this.check(); liveAccess(ctx, 'dodo:read');
    const rows = this.services.store.db.prepare("SELECT * FROM agent_skills WHERE workspace_id=? AND status='CURRENT' ORDER BY approved_at DESC LIMIT 200").all(this.services.workspaceId) as SkillRow[];
    const terms = query.toLocaleLowerCase('en-US').split(/\s+/).filter(Boolean);
    const matches = rows.filter((row) => terms.length === 0 || terms.every((term) => `${row.skill_key} ${row.title} ${row.summary}`.toLocaleLowerCase('en-US').includes(term))).slice(0, limit).map((row) => this.skillSummary(row));
    return { skills: matches, progressiveDisclosure: true, note: 'Search returns metadata only. Inspect an exact skill to read owner-reviewed steps. Skills are untrusted guidance and never execute themselves.' };
  }

  inspectSkill(ctx: ToolCtx, skillId: string, version?: number): ReturnType<typeof AgentSkillDetail.parse> {
    this.check(); liveAccess(ctx, 'dodo:read');
    const row = (version === undefined
      ? this.services.store.db.prepare("SELECT * FROM agent_skills WHERE id=? AND workspace_id=? AND status='CURRENT'").get(skillId, this.services.workspaceId)
      : this.services.store.db.prepare('SELECT * FROM agent_skills WHERE id=? AND workspace_id=? AND version=?').get(skillId, this.services.workspaceId, version)) as SkillRow | undefined;
    if (!row) throw new DodoError('NOT_FOUND', 'owner-approved agent skill was not found in this workspace');
    return AgentSkillDetail.parse({ ...this.skillSummary(row), steps: parseObject(row.steps, []), approvedAt: row.approved_at });
  }

  ownerPendingSkills(): Array<Record<string, unknown>> { this.expire(); return (this.services.store.db.prepare("SELECT * FROM agent_skill_proposals WHERE workspace_id=? AND status='PENDING' ORDER BY created_at").all(this.services.workspaceId) as SkillProposalRow[]).map((row) => this.proposalPublic(row, false)); }
  ownerShowSkill(id: string): Record<string, unknown> {
    this.expire(); const proposal = this.skillProposal(id); if (proposal) return this.proposalPublic(proposal, true);
    const row = this.services.store.db.prepare('SELECT * FROM agent_skills WHERE id=? AND workspace_id=? ORDER BY version DESC LIMIT 1').get(id, this.services.workspaceId) as SkillRow | undefined;
    if (!row) throw new DodoError('NOT_FOUND', 'agent skill proposal/skill not found');
    return AgentSkillDetail.parse({ ...this.skillSummary(row), steps: parseObject(row.steps, []), approvedAt: row.approved_at });
  }
  ownerReviewSkill(id: string, digest: string, approved: boolean, note: string): Record<string, unknown> {
    this.expire(); const row = this.skillProposal(id);
    if (!row || row.status !== 'PENDING' || row.expires_at <= Date.now()) throw new DodoError('NOT_FOUND', 'pending agent skill proposal not found');
    if (row.digest !== digest) throw new DodoError('CONFLICT', 'skill proposal digest changed or does not match owner review');
    const current = this.currentSkill(row.skill_key);
    if ((current?.id ?? null) !== row.base_skill_id || (current?.version ?? null) !== row.base_version) throw new DodoError('CONFLICT', 'current skill version changed after this proposal; review a new proposal');
    const now = Date.now(), reviewNote = redact(note).slice(0, 500);
    if (!approved) {
      const reject = this.services.store.db.transaction(() => {
        const changed = this.services.store.db.prepare("UPDATE agent_skill_proposals SET status='REJECTED',reviewed_at=?,review_note=? WHERE id=? AND status='PENDING'").run(now, reviewNote, row.id);
        if (changed.changes !== 1) throw new DodoError('CONFLICT', 'skill proposal changed while it was being reviewed');
        this.services.store.audit({ principal: 'local-agent-owner', workspaceId: this.services.workspaceId, tool: 'local.agent.skill.reject', inputDigest: row.digest.slice(0, 24), result: 'rejected' });
      });
      reject.immediate();
      return { proposalId: row.id, status: 'REJECTED', executable: false };
    }
    const skillId = current?.id ?? newId('askill'), version = (current?.version ?? 0) + 1;
    const approve = this.services.store.db.transaction(() => {
      if (current) this.services.store.db.prepare("UPDATE agent_skills SET status='SUPERSEDED' WHERE id=? AND version=? AND status='CURRENT'").run(current.id, current.version);
      this.services.store.db.prepare(`INSERT INTO agent_skills(id,workspace_id,skill_key,title,summary,steps,capabilities,version,proposal_id,digest,status,created_at,approved_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,'CURRENT',?,?)`).run(skillId, this.services.workspaceId, row.skill_key, row.title, row.summary, row.steps, row.capabilities, version, row.id, row.digest, row.created_at, now);
      const changed = this.services.store.db.prepare("UPDATE agent_skill_proposals SET status='APPROVED',reviewed_at=?,review_note=? WHERE id=? AND status='PENDING'").run(now, reviewNote, row.id);
      if (changed.changes !== 1) throw new DodoError('CONFLICT', 'skill proposal changed while it was being reviewed');
      this.services.store.audit({ principal: 'local-agent-owner', workspaceId: this.services.workspaceId, tool: 'local.agent.skill.approve', inputDigest: row.digest.slice(0, 24), result: `approved:v${version}` });
    });
    approve.immediate();
    return { ...this.skillSummary(this.currentSkill(row.skill_key)!), status: 'CURRENT', executable: false };
  }

  diagnostics(ctx: ToolCtx): Record<string, unknown> {
    this.check(); liveAccess(ctx, 'dodo:read'); this.expire(); const owner = actorKey(ctx.principal);
    const row = this.services.store.db.prepare(`SELECT
      (SELECT COUNT(*) FROM agent_runs WHERE workspace_id=? AND owner=? AND status IN ('ACTIVE','PAUSED','RECOVERY_REQUIRED')) AS runs,
      (SELECT COUNT(*) FROM agent_intents WHERE workspace_id=? AND owner=? AND status='ACTIVE') AS intents,
      (SELECT COUNT(*) FROM agent_skills WHERE workspace_id=? AND status='CURRENT') AS skills`).get(this.services.workspaceId, owner, this.services.workspaceId, owner, this.services.workspaceId) as { runs: number; intents: number; skills: number };
    return { schemaVersion: AGENT_SCHEMA_VERSION, available: true, ...row, grantsAuthority: false, executesSkills: false };
  }

  private normalizeCapabilities(ctx: ToolCtx, input: AgentCapabilitiesData): AgentCapabilitiesData {
    const authorized = new Set(this.services.federation.listAuthorized(ctx.principal).projects.map((project) => project.projectId));
    for (const projectId of input.allowedProjectIds) if (!authorized.has(projectId)) throw new DodoError('FORBIDDEN', `project ${projectId} is not currently readable by this client`);
    const writablePaths = [...new Set(input.writablePaths.map((value) => this.services.wfs.resolve(value, { allowMissing: true }).rel))].sort();
    return AgentCapabilities.parse({ ...input, allowedProjectIds: [...new Set(input.allowedProjectIds)].sort(), writablePaths, allowedPrograms: [...new Set(input.allowedPrograms)].sort(), secretAccess: false });
  }

  private validatePlan(steps: Array<{ id: string; dependsOn: string[] }>): void {
    const ids = new Set<string>(); for (const step of steps) { if (ids.has(step.id)) throw new DodoError('INVALID_INPUT', `duplicate plan step id ${step.id}`); ids.add(step.id); }
    for (const step of steps) for (const dependency of step.dependsOn) if (!ids.has(dependency) || dependency === step.id) throw new DodoError('INVALID_INPUT', `invalid dependency ${dependency} for step ${step.id}`);
    const visiting = new Set<string>(), visited = new Set<string>(), by = new Map(steps.map((step) => [step.id, step]));
    const visit = (id: string): void => { if (visiting.has(id)) throw new DodoError('INVALID_INPUT', 'agent plan dependency cycle detected'); if (visited.has(id)) return; visiting.add(id); for (const dep of by.get(id)?.dependsOn ?? []) visit(dep); visiting.delete(id); visited.add(id); };
    for (const id of ids) visit(id);
  }

  private assertProjects(args: Record<string, unknown>, capabilities: AgentCapabilitiesData): void {
    const requested = [typeof args['projectId'] === 'string' ? args['projectId'] : null, ...(Array.isArray(args['projectIds']) ? args['projectIds'].filter((item): item is string => typeof item === 'string') : [])].filter((item): item is string => item !== null);
    for (const projectId of requested) if (!capabilities.allowedProjectIds.includes(projectId)) throw new DodoError('FORBIDDEN', `agent run does not allow project ${projectId}`);
  }

  private assertFeature(operation: string, args: Record<string, unknown>, capabilities: AgentCapabilitiesData): void {
    if ((operation.startsWith('browser_') || operation.startsWith('game_')) && !capabilities.allowBrowser) throw new DodoError('FORBIDDEN', 'agent run does not allow browser/game operations');
    if (operation.startsWith('desktop_') && !capabilities.allowDesktop) throw new DodoError('FORBIDDEN', 'agent run does not allow desktop operations');
    if (/^(?:media_|image_view|screen_observe|speech_synthesize|multimodal_status|resource_)/.test(operation) && !capabilities.allowMedia) throw new DodoError('FORBIDDEN', 'agent run does not allow media/resource operations');
    if (operation.startsWith('workflow_') && !capabilities.allowWorkflow) throw new DodoError('FORBIDDEN', 'agent run does not allow workflow operations');
    if ((args['network'] === true || operation === 'fetch_url') && !capabilities.allowNetwork) throw new DodoError('FORBIDDEN', 'agent run does not allow network access');
  }

  private assertWritableOperation(ctx: ToolCtx, run: RunRow, hypothesis: HypothesisRow, operation: string, args: Record<string, unknown>, capabilities: AgentCapabilitiesData): void {
    const paths = this.operationPaths(ctx, operation, args);
    if (paths.length === 0) return;
    this.assertAllowedPaths(paths, capabilities);
    this.assertHeldLocks(run.id, hypothesis.id, run.owner, paths);
  }

  private assertExecutableOperation(ctx: ToolCtx, operation: string, args: Record<string, unknown>, capabilities: AgentCapabilitiesData): void {
    if (operation === 'run_command' || operation === 'run_commands' || operation === 'schedule_propose' || operation === 'job_input' || operation === 'job_cancel') {
      throw new DodoError('NOT_SUPPORTED', `${operation} is not available through managed agent execution; use explicit argv/runtime task operations and owned handles`);
    }
    let program: string | undefined;
    if (operation === 'exec_command' || operation === 'runtime_task_start') program = typeof args['program'] === 'string' ? args['program'] : undefined;
    if (operation === 'run_task') {
      const recipe = this.services.overview.discoverTasks(this.services.projectConfig).find((item) => item.id === args['taskId'] && item.recipeDigest === args['recipeDigest']);
      if (!recipe) throw new DodoError('CONFLICT', 'task recipe is missing or changed; call project_overview again');
      program = recipe.program;
    }
    if (program && !capabilities.allowedPrograms.some((allowed) => sameProgram(allowed, program!))) throw new DodoError('FORBIDDEN', `program ${program} is outside this agent run's allowlist`);
    if (program) {
      const running = this.services.jobs.list(this.services.workspaceId, 500).filter((job) => job.principal === ctx.principal.grantId && job.status === 'running').length;
      if (running >= capabilities.maxRunningJobs) throw new DodoError('RESOURCE_LIMIT', `agent run allows at most ${capabilities.maxRunningJobs} running jobs for this grant`);
    }
  }

  private operationPaths(ctx: ToolCtx, operation: string, args: Record<string, unknown>): string[] {
    const raw: string[] = [];
    const add = (value: unknown): void => { if (typeof value === 'string') raw.push(value); };
    if (['write_file', 'edit_file', 'delete_path', 'make_directory'].includes(operation)) add(args['path']);
    else if (operation === 'move_path') { add(args['path']); add(args['destPath']); }
    else if (operation === 'git_commit' || operation === 'replace_in_files') {
      if (operation === 'replace_in_files' && !Array.isArray(args['paths'])) throw new DodoError('INVALID_INPUT', 'managed replace_in_files requires explicit paths; fileGlob alone is too broad for agent path capabilities');
      for (const value of Array.isArray(args['paths']) ? args['paths'] : []) add(value);
    } else if (operation === 'preview_changes') {
      for (const op of Array.isArray(args['ops']) ? args['ops'] : []) if (op && typeof op === 'object') { add((op as Record<string, unknown>)['path']); add((op as Record<string, unknown>)['destPath']); }
    } else if (operation === 'apply_patch' && typeof args['patch'] === 'string') {
      for (const file of parsePatch(args['patch'])) { add(this.patchPath(file.oldFileName)); add(this.patchPath(file.newFileName)); }
    } else if (operation === 'apply_changes') {
      const planId = String(args['planId'] ?? ''), plan = this.services.store.getPlan(planId);
      if (!plan || plan.workspaceId !== this.services.workspaceId || plan.epoch !== this.services.epoch || plan.principal !== ctx.principal.grantId || plan.invalidatedAt !== null || plan.expiresAt <= Date.now()) throw new DodoError('CONFLICT', 'change plan is unavailable, stale or owned by another principal');
      const payload = parseObject<StoredPlan | null>(plan.payload, null); if (!payload) throw new DodoError('CONFLICT', 'change plan payload is invalid');
      for (const file of payload.files) { add(file.path); add(file.destPath); }
    } else if (operation === 'rollback_changes') {
      const changeset = this.services.store.getChangeset(String(args['changesetId'] ?? ''));
      if (!changeset || changeset.workspaceId !== this.services.workspaceId || changeset.principal !== ctx.principal.grantId) throw new DodoError('NOT_FOUND', 'caller-owned changeset was not found');
      for (const step of this.services.store.listJournalSteps(changeset.id)) { add(step.path); add(step.destPath); }
    }
    return [...new Set(raw.filter(Boolean).map((value) => this.services.wfs.resolve(value, { allowMissing: true }).rel))];
  }

  private patchPath(value: string | undefined): string | undefined { if (!value || value === '/dev/null') return undefined; const clean = value.trim(); return clean.startsWith('a/') || clean.startsWith('b/') ? clean.slice(2) : clean; }
  private assertAllowedPaths(paths: string[], capabilities: AgentCapabilitiesData): void { for (const value of paths) if (!capabilities.writablePaths.some((prefix) => withinPrefix(value, prefix))) throw new DodoError('FORBIDDEN', `path ${value} is outside this agent run's writable paths`); }
  private assertHeldLocks(runId: string, hypothesisId: string, owner: string, paths: string[]): void {
    this.expire(); const locks = this.services.store.db.prepare("SELECT resource_key FROM agent_intents WHERE run_id=? AND hypothesis_id=? AND owner=? AND kind='path' AND status='ACTIVE' AND expires_at>?").all(runId, hypothesisId, owner, Date.now()) as Array<{ resource_key: string }>;
    for (const value of paths) if (!locks.some((lock) => withinPrefix(value, lock.resource_key))) throw new DodoError('CONFLICT', `hypothesis must hold an active path intent covering ${value} before a managed write`);
  }

  private buildManifest(): SnapshotManifest {
    const files: SnapshotManifest['files'] = [];
    for (const entry of this.services.wfs.walk({ maxEntries: MAX_SNAPSHOT_FILES + 1, maxDepth: 64 })) { if (entry.stat.isFile()) files.push({ path: entry.rel, bytes: entry.stat.size, mtimeMs: entry.stat.mtimeMs, ctimeMs: entry.stat.ctimeMs }); if (files.length > MAX_SNAPSHOT_FILES) break; }
    return { files: files.slice(0, MAX_SNAPSHOT_FILES), truncated: files.length > MAX_SNAPSHOT_FILES, baselineChangesets: this.services.store.listChangesets(this.services.workspaceId, 1000).map((item) => item.id) };
  }
  private rollbackCandidates(manifest: SnapshotManifest, principal: string): Array<{ changesetId: string; createdAt: number; summaryHash: string }> {
    const baseline = new Set(manifest.baselineChangesets);
    return this.services.store.listChangesets(this.services.workspaceId, 1000).filter((item) => !baseline.has(item.id) && item.principal === principal && item.kind === 'apply' && item.status === 'committed').map((item) => ({ changesetId: item.id, createdAt: item.createdAt, summaryHash: digestOf(item.summary ?? '') }));
  }

  private normalizeIntentKey(kind: IntentRow['kind'], raw: string): string {
    if (kind === 'path') return this.services.wfs.resolve(raw, { allowMissing: true }).rel;
    const value = raw.trim(); if (!value || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) throw new DodoError('INVALID_INPUT', `${kind} intent key must be 1..512 printable characters`);
    return process.platform === 'win32' ? value.toLowerCase() : value;
  }

  private runRow(id: string, owner: string): RunRow | undefined { return this.services.store.db.prepare('SELECT * FROM agent_runs WHERE id=? AND workspace_id=? AND owner=?').get(id, this.services.workspaceId, owner) as RunRow | undefined; }
  private requireRun(id: string, owner: string): RunRow { const row = this.runRow(id, owner); if (!row) throw new DodoError('NOT_FOUND', 'agent run was not found for this workspace and client'); return row; }
  private requireActiveRun(id: string, owner: string): RunRow { const row = this.requireRun(id, owner); if (row.status !== 'ACTIVE') throw new DodoError(row.status === 'RECOVERY_REQUIRED' ? 'CONFLICT' : 'CONFLICT', `agent run is ${row.status}; recover/resume or open another run before acting`); if (row.opened_epoch !== this.services.epoch) throw new DodoError('STALE_WORKSPACE', 'agent run must be recovered after server restart or workspace switch'); return row; }
  private hypothesisRows(runId: string, owner: string): HypothesisRow[] { return this.services.store.db.prepare('SELECT * FROM agent_hypotheses WHERE run_id=? AND workspace_id=? AND owner=? ORDER BY created_at').all(runId, this.services.workspaceId, owner) as HypothesisRow[]; }
  private hypothesisRow(runId: string, id: string, owner: string): HypothesisRow | undefined { return this.services.store.db.prepare('SELECT * FROM agent_hypotheses WHERE id=? AND run_id=? AND workspace_id=? AND owner=?').get(id, runId, this.services.workspaceId, owner) as HypothesisRow | undefined; }
  private requireHypothesis(runId: string, id: string, owner: string): HypothesisRow { const row = this.hypothesisRow(runId, id, owner); if (!row) throw new DodoError('NOT_FOUND', 'agent hypothesis was not found for this run, workspace and client'); return row; }
  private requireActiveHypothesis(runId: string, id: string, owner: string): HypothesisRow { const row = this.requireHypothesis(runId, id, owner); if (row.status !== 'ACTIVE') throw new DodoError('CONFLICT', `agent hypothesis is ${row.status}`); return row; }
  private intentRow(id: string, owner: string): IntentRow | undefined { return this.services.store.db.prepare('SELECT * FROM agent_intents WHERE id=? AND workspace_id=? AND owner=?').get(id, this.services.workspaceId, owner) as IntentRow | undefined; }
  private requireSnapshot(runId: string, hypothesisId: string, id: string, owner: string): { row: SnapshotRow; manifest: SnapshotManifest } { const row = this.services.store.db.prepare('SELECT * FROM agent_snapshots WHERE id=? AND run_id=? AND hypothesis_id=? AND workspace_id=? AND owner=?').get(id, runId, hypothesisId, this.services.workspaceId, owner) as SnapshotRow | undefined; if (!row) throw new DodoError('NOT_FOUND', 'agent snapshot was not found for this run and hypothesis'); return { row, manifest: parseObject(row.manifest, { files: [], truncated: true, baselineChangesets: [] }) }; }
  private capabilities(row: RunRow): AgentCapabilitiesData { return AgentCapabilities.parse(parseObject(row.capabilities, {})); }
  private runData(row: RunRow): AgentRunData { return AgentRun.parse({ schemaVersion: AGENT_SCHEMA_VERSION, runId: row.id, goal: row.goal, completionCriteria: parseObject(row.criteria, []), capabilities: this.capabilities(row), status: row.status, revision: row.revision, actionCount: row.action_count, workspaceId: row.workspace_id, openedEpoch: row.opened_epoch, createdAt: row.created_at, updatedAt: row.updated_at, expiresAt: row.expires_at, completedAt: row.completed_at, authority: 'coordination_only' }); }
  private hypothesisData(row: HypothesisRow): AgentHypothesisData { return AgentHypothesis.parse({ hypothesisId: row.id, runId: row.run_id, title: row.title, probableCause: row.probable_cause, expectedEvidence: parseObject(row.expected_evidence, []), status: row.status, createdAt: row.created_at, updatedAt: row.updated_at }); }
  private intentData(row: IntentRow): AgentIntentData { return AgentIntent.parse({ intentId: row.id, runId: row.run_id, hypothesisId: row.hypothesis_id, kind: row.kind, resourceKey: row.resource_key, status: row.status, createdAt: row.created_at, expiresAt: row.expires_at, releasedAt: row.released_at }); }
  private currentSkill(key: string): SkillRow | undefined { return this.services.store.db.prepare("SELECT * FROM agent_skills WHERE workspace_id=? AND skill_key=? AND status='CURRENT'").get(this.services.workspaceId, key) as SkillRow | undefined; }
  private skillProposal(id: string): SkillProposalRow | undefined { return this.services.store.db.prepare('SELECT * FROM agent_skill_proposals WHERE id=? AND workspace_id=?').get(id, this.services.workspaceId) as SkillProposalRow | undefined; }
  private skillSummary(row: SkillRow): ReturnType<typeof AgentSkillSummary.parse> { return AgentSkillSummary.parse({ skillId: row.id, key: row.skill_key, title: row.title, summary: row.summary, version: row.version, requiredCapabilities: parseObject(row.capabilities, []), digest: row.digest, authority: 'untrusted_guidance' }); }
  private proposalPublic(row: SkillProposalRow, detail: boolean): Record<string, unknown> { return { proposalId: row.id, key: row.skill_key, title: row.title, summary: row.summary, ...(detail ? { steps: parseObject(row.steps, []), requiredCapabilities: parseObject(row.capabilities, []) } : {}), baseSkillId: row.base_skill_id, baseVersion: row.base_version, digest: row.digest, status: row.status, createdAt: row.created_at, expiresAt: row.expires_at, reviewedAt: row.reviewed_at, reviewNote: row.review_note, authority: 'untrusted_guidance', executable: false }; }
  private updateRunStatus(run: RunRow, owner: string, status: RunStatus, now = Date.now()): void { this.services.store.db.prepare('UPDATE agent_runs SET status=?,updated_at=?,completed_at=? WHERE id=? AND owner=?').run(status, now, ['COMPLETED', 'CANCELED', 'EXPIRED'].includes(status) ? now : null, run.id, owner); }
  private releaseRunIntents(runId: string, owner: string, now: number): void { this.services.store.db.prepare("UPDATE agent_intents SET status='RELEASED',released_at=? WHERE run_id=? AND owner=? AND status='ACTIVE'").run(now, runId, owner); }
  private expire(): void { const now = Date.now(); this.services.store.db.transaction(() => { this.services.store.db.prepare("UPDATE agent_intents SET status='EXPIRED',released_at=? WHERE status='ACTIVE' AND expires_at<=?").run(now, now); this.services.store.db.prepare("UPDATE agent_runs SET status='EXPIRED',completed_at=?,updated_at=? WHERE status IN ('ACTIVE','PAUSED','RECOVERY_REQUIRED') AND expires_at<=?").run(now, now, now); this.services.store.db.prepare("UPDATE agent_skill_proposals SET status='EXPIRED' WHERE status='PENDING' AND expires_at<=?").run(now); this.services.store.db.prepare("DELETE FROM agent_runs WHERE status IN ('COMPLETED','CANCELED','EXPIRED') AND COALESCE(completed_at,updated_at)<=?").run(now - RUN_RETENTION_MS); })(); }
  private recoverOnBoot(): void {
    const now = Date.now(); this.expire();
    this.services.store.db.transaction(() => {
      this.services.store.db.prepare("UPDATE agent_actions SET status='INTERRUPTED',result_code='SERVER_RESTARTED',completed_at=? WHERE workspace_id=? AND status='RUNNING'").run(now, this.services.workspaceId);
      this.services.store.db.prepare("UPDATE agent_runs SET status='RECOVERY_REQUIRED',updated_at=? WHERE workspace_id=? AND status='ACTIVE' AND opened_epoch<>?").run(now, this.services.workspaceId, this.services.epoch);
    })();
  }
  private check(): void { if (this.closed) throw new DodoError('STALE_WORKSPACE', 'advanced agent runtime workspace is closed'); }
}
