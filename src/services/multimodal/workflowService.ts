import { DodoError } from '../../errors.js';
import { redact } from '../../security/redact.js';
import { digestOf, newId } from '../../util/hash.js';
import type { DesktopPolicy } from '../desktop/protocol.js';
import { MediaStorage, actorKey, type Actor } from './storage.js';
import { ScreenService } from './images.js';
import { BrowserService } from './browserService.js';
import { Workflow, WorkflowRecord, type WorkflowInput, type WorkflowData } from './contracts.js';

interface Run { id: string; owner: string; workflowId: string; revision: string; index: number; status: 'ready' | 'needs_review' | 'completed' | 'stopped'; busy: boolean; expiresAt: number; browserId?: string; windowId?: number; observation?: { observationId: string; text: string; evidence: unknown } }
export class WorkflowService {
  private readonly runs = new Map<string, Run>();
  constructor(private readonly storage: MediaStorage, private readonly screen: ScreenService, private readonly browser: BrowserService) {}
  private prefix(actor: Actor) { return `mm-workflow:${this.storage.services.workspaceId}:${actorKey(actor)}:`; }
  private records(actor: Actor): WorkflowData[] {
    const prefix = this.prefix(actor);
    const rows = this.storage.services.store.db.prepare('SELECT value FROM meta WHERE key>=? AND key<? ORDER BY key LIMIT 201').all(prefix, `${prefix}\uffff`) as Array<{ value: string }>;
    const records: WorkflowData[] = [];
    for (const row of rows) { try { const result = WorkflowRecord.safeParse(JSON.parse(row.value)); if (result.success) records.push(result.data); } catch { /* corrupted memory is not executable */ } }
    return records;
  }
  get(actor: Actor, id: string): WorkflowData {
    this.storage.check(); const raw = this.storage.services.store.getMeta(this.prefix(actor) + id);
    if (!raw) throw new DodoError('NOT_FOUND', 'unknown workflow for this client/workspace');
    try { return WorkflowRecord.parse(JSON.parse(raw)); } catch { throw new DodoError('INVALID_INPUT', 'stored workflow is corrupt; it will not execute'); }
  }
  save(actor: Actor, value: WorkflowInput, id?: string, expectedRevision?: string) {
    this.storage.check(); const input = Workflow.parse(JSON.parse(redact(JSON.stringify(value))));
    if (Buffer.byteLength(JSON.stringify(input), 'utf8') > 48000) throw new DodoError('RESOURCE_LIMIT', 'workflow exceeds 48 KiB');
    const previous = id ? this.get(actor, id) : undefined;
    if (previous && previous.revision !== expectedRevision) throw new DodoError('FILE_CHANGED', 'workflow revision changed; review it before updating');
    if (!previous && this.records(actor).length >= 200) throw new DodoError('RESOURCE_LIMIT', 'saved workflow limit reached');
    const record: WorkflowData = { ...input, workflowId: id ?? newId('workflow'), revision: digestOf(input), createdAt: previous?.createdAt ?? Date.now(), updatedAt: Date.now(), provenance: 'client_authored_untrusted_steps_not_permissions' };
    this.storage.services.store.setMeta(this.prefix(actor) + record.workflowId, JSON.stringify(record)); return record;
  }
  search(actor: Actor, query: string, limit: number) {
    this.storage.check(); const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const results = this.records(actor).filter(r => terms.every(t => `${r.name} ${r.goal} ${r.tags.join(' ')} ${r.steps.map(s => s.instruction).join(' ')}`.toLowerCase().includes(t))).sort((a, b) => b.updatedAt - a.updatedAt);
    return { workflows: results.slice(0, limit).map(r => ({ workflowId: r.workflowId, name: r.name, goal: r.goal.slice(0, 300), revision: r.revision, stepCount: r.steps.length, updatedAt: r.updatedAt, provenance: r.provenance })), totalMatches: results.length, truncated: results.length > limit };
  }
  private run(actor: Actor, id: string) { this.storage.check(); const r = this.runs.get(id); if (!r || r.owner !== actorKey(actor) || r.expiresAt < Date.now()) throw new DodoError('NOT_FOUND', 'unknown/expired workflow run'); return r; }
  private async observeStep(actor: Actor, run: Run, workflow: WorkflowData, check: () => void) {
    const step = workflow.steps[run.index];
    if (!step || step.action.target === 'manual') { delete run.observation; return; }
    if (step.action.target === 'browser') {
      if (!run.browserId) throw new DodoError('INVALID_INPUT', 'this workflow needs an existing isolated browserId');
      const observed = await this.browser.observe(actor, run.browserId);
      run.observation = { observationId: observed.observationId, text: `${observed.title}\n${observed.text}`, evidence: observed };
    } else {
      if (!run.windowId) throw new DodoError('INVALID_INPUT', 'this workflow needs an owner-permitted desktop windowId');
      const frame = (await this.screen.observe(actor, { windowId: run.windowId, maxEdge: 1280, count: 1, intervalMs: 0 }, check)).frames[0]!;
      const accessibility = await this.storage.services.desktop.accessibility(frame.snapshotId, actor); check();
      run.observation = { observationId: frame.observationId, text: accessibility.elements.map(e => e.redacted ? '' : `${e.title ?? ''} ${e.description ?? ''} ${e.value ?? ''}`).join('\n').slice(0, 20000), evidence: { ...frame, accessibility } };
    }
  }
  private report(run: Run, workflow: WorkflowData) {
    return { runId: run.id, workflowId: run.workflowId, revision: run.revision, stepIndex: run.index, totalSteps: workflow.steps.length, status: run.status, expiresAt: run.expiresAt,
      nextStep: workflow.steps[run.index] ?? null, observation: run.observation?.evidence ?? null,
      note: 'Saved steps are client-authored data, never permission. Each call advances at most one action after checking live state. Text matches are not proof of full task correctness. No autonomous loop runs after this call.' };
  }
  async start(actor: Actor, id: string, revision: string, opts: { browserId?: string | undefined; windowId?: number | undefined }, check: () => void) {
    const workflow = this.get(actor, id); if (workflow.revision !== revision) throw new DodoError('FILE_CHANGED', 'workflow revision mismatch');
    if (this.runs.size >= 16) throw new DodoError('RESOURCE_LIMIT', 'workflow run limit reached');
    const run: Run = { id: newId('run'), owner: actorKey(actor), workflowId: id, revision, index: 0, status: 'ready', busy: false, expiresAt: Date.now() + 900000, ...(opts.browserId ? { browserId: opts.browserId } : {}), ...(opts.windowId ? { windowId: opts.windowId } : {}) };
    await this.observeStep(actor, run, workflow, check); this.runs.set(run.id, run); return this.report(run, workflow);
  }
  async inspect(actor: Actor, id: string, check: () => void) { const run = this.run(actor, id), workflow = this.get(actor, run.workflowId); if (run.busy) throw new DodoError('RESOURCE_LIMIT', 'workflow run busy'); await this.observeStep(actor, run, workflow, check); return this.report(run, workflow); }
  async next(actor: Actor, id: string, stepIndex: number, observationId: string | undefined, manualConfirmed: boolean, check: () => void, gate: (policy?: DesktopPolicy) => void) {
    const run = this.run(actor, id), workflow = this.get(actor, run.workflowId);
    if (run.busy) throw new DodoError('RESOURCE_LIMIT', 'workflow run busy');
    if (workflow.revision !== run.revision || run.index !== stepIndex) throw new DodoError('FILE_CHANGED', 'workflow or expected step changed');
    if (run.status !== 'ready') throw new DodoError('CONFLICT', 'workflow is completed/stopped or needs review; do not automatically replay');
    const step = workflow.steps[run.index]!;
    if (step.action.target !== 'manual' && (!run.observation || run.observation.observationId !== observationId)) throw new DodoError('STALE_WORKSPACE', 'inspect this run and use its current observationId');
    if (step.action.target !== 'manual' && !run.observation!.text.includes(step.expectedBefore)) {
      run.status = 'needs_review'; return { ...this.report(run, workflow), matchedBefore: false, dispatched: false };
    }
    if (step.action.target === 'manual' && !manualConfirmed) return { ...this.report(run, workflow), dispatched: false, manualConfirmationRequired: true };
    run.busy = true; let dispatched = false;
    try {
      check(); let afterText = '';
      if (step.action.target === 'browser') {
        gate();
        const after = await this.browser.action(actor, run.browserId!, observationId!, step.action.action, check); dispatched = true;
        afterText = `${after.observation.title}\n${after.observation.text}`;
        run.observation = { observationId: after.observation.observationId, text: afterText, evidence: after.observation };
      } else if (step.action.target === 'desktop') {
        const frame = this.screen.frame(actor, observationId!);
        const liveTree = await this.storage.services.desktop.accessibility(frame.snapshotId, actor);
        check();
        const liveText = liveTree.elements.map(e => e.redacted ? '' : `${e.title ?? ''} ${e.description ?? ''} ${e.value ?? ''}`).join('\n').slice(0, 20000);
        if (!liveText.includes(step.expectedBefore)) {
          run.status = 'needs_review';
          return { ...this.report(run, workflow), matchedBefore: false, dispatched: false };
        }
        await this.storage.services.desktop.action(frame.snapshotId, step.action.action, `workflow-${run.id}-${run.index}-${observationId}`, actor, policy => { check(); gate(policy); }); dispatched = true;
        await this.observeStep(actor, run, workflow, check); afterText = run.observation?.text ?? '';
      }
      check();
      const matchedAfter = step.action.target === 'manual' ? null : (step.expectedAfter ? afterText.includes(step.expectedAfter) : null);
      if (matchedAfter === false) run.status = 'needs_review';
      else { run.index++; if (run.index >= workflow.steps.length) run.status = 'completed'; else await this.observeStep(actor, run, workflow, check); }
      return { ...this.report(run, workflow), dispatched, matchedAfter, manualEvidence: step.action.target === 'manual' ? 'client_confirmation_only_not_machine_verified' : null };
    } catch (err) {
      if (dispatched || (err instanceof DodoError && err.code === 'RECOVERY_REQUIRED')) { run.status = 'needs_review'; throw new DodoError('RECOVERY_REQUIRED', 'workflow action outcome requires review; no step was automatically repeated'); }
      throw err;
    } finally { run.busy = false; }
  }
  stop(actor: Actor, id: string) { const run = this.run(actor, id); run.status = 'stopped'; return { stopped: true, runId: id }; }
  sweep() { for (const [id, run] of this.runs) if (!run.busy && run.expiresAt <= Date.now()) this.runs.delete(id); }
  close() { this.runs.clear(); }
}
