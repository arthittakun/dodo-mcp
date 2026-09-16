import { z } from 'zod';
import fs from 'node:fs';
import { encodeFileIdentity, type FileIdentity } from '../../platform/fileIdentity.js';
import { sandboxAvailability } from '../jobs/sandbox.js';
import { CronExpressionParser } from 'cron-parser';
import type { AppServices, Principal } from '../../tools/context.js';
import { DodoError } from '../../errors.js';
import { isPersonalMode } from '../../security/accessMode.js';
import { projectScopeCeiling } from '../../security/projectAccess.js';
import { digestOf, newId } from '../../util/hash.js';
import { validateShellCommand } from '../jobs/commandInput.js';

export const ScheduleInput = z.object({
  name: z.string().min(1).max(120),
  command: z.string().min(1).max(64 * 1024),
  cwd: z.string().max(1024).default('.'),
  cron: z.string().min(9).max(128).describe('Five-field cron, minute precision'),
  timezone: z.string().min(1).max(100).default('UTC'),
  expiresAt: z.number().int().positive().describe('Unix milliseconds; at most 30 days ahead'),
  timeoutMs: z.number().int().min(1000).max(30 * 60_000).default(300_000),
  sandbox: z.boolean().default(true),
  network: z.boolean().default(false),
}).strict();
interface Payload {
  spec: z.infer<typeof ScheduleInput>;
  root: string; dev: FileIdentity; ino: FileIdentity; policy: string;
  clientId: string | null; grantId: string | null;
}
interface Row {id:string; workspace_id:string; payload:string; digest:string; status:string; created_at:number; expires_at:number; next_at:number|null; approved_at:number|null}
interface Run {schedule_id:string; due_at:number; status:string; job_id:string|null; error:string|null}

/** Internal timer; no OS cron entries or external services. Only approved active-root jobs run. */
export class ScheduleService {
  private timer: NodeJS.Timeout | undefined;
  private bootedAt = Date.now();
  constructor(private s: Pick<AppServices, 'workspaceId' | 'epoch' | 'store' | 'wfs' | 'jobs' | 'config' | 'limits'>) {}
  private policy() {
    const row = this.s.store.db.prepare('SELECT max(id) AS id FROM policy_versions WHERE workspace_id=?').get(this.s.workspaceId);
    return digestOf({config:this.s.config, policyVersion:row});
  }
  private next(spec: Payload['spec'], from: number) {
    try {
      if (spec.cron.trim().split(/\s+/).length !== 5) throw new Error('five fields required');
      new Intl.DateTimeFormat('en', {timeZone:spec.timezone});
      return CronExpressionParser.parse(spec.cron, {tz:spec.timezone, currentDate:from}).next().getTime();
    } catch { throw new DodoError('INVALID_INPUT', 'invalid five-field cron or IANA timezone'); }
  }
  propose(input: unknown, principal?: Principal) {
    const spec = ScheduleInput.parse(input);
    if (process.platform === 'win32' && spec.sandbox && !sandboxAvailability(process.env, undefined, this.s.wfs.root).available) throw new DodoError('NOT_SUPPORTED', 'Windows sandbox is not ready; run dodo setup --components sandbox locally and pass its confinement probes. Alternatively the owner may explicitly request sandbox:false and approve that separate schedule. No policy was downgraded.');
    const now = Date.now();
    if (spec.expiresAt <= now || spec.expiresAt > now + 30 * 86400_000) throw new DodoError('INVALID_INPUT', 'schedule consent must expire within 30 days');
    validateShellCommand(spec.command, Math.min(64 * 1024, this.s.limits.commandBytes));
    const cwd = this.s.wfs.resolve(spec.cwd);
    if (!cwd.stat?.isDirectory()) throw new DodoError('PATH_DENIED', 'schedule cwd must be a workspace directory');
    spec.cwd = cwd.rel;
    if (this.next(spec, now) >= spec.expiresAt) throw new DodoError('INVALID_INPUT', 'no scheduled occurrence before expiry');
    const n = this.s.store.db.prepare("SELECT count(*) AS n FROM schedules WHERE workspace_id=? AND status IN ('pending','approved') AND expires_at>?").get(this.s.workspaceId, now) as {n:number};
    if (n.n >= 64) throw new DodoError('RESOURCE_LIMIT', 'at most 64 pending/approved schedules per workspace');
    const root = this.s.store.getWorkspace(this.s.workspaceId)!;
    const payload: Payload = {spec, root:root.root, dev:root.dev, ino:root.ino, policy:this.policy(), clientId:principal?.clientId ?? null, grantId:principal?.grantId ?? null};
    const id = newId('sched', 24);
    const digest = digestOf(payload);
    this.s.store.db.prepare('INSERT INTO schedules VALUES (?,?,?,?,?,?,?,?,NULL)').run(id,this.s.workspaceId,JSON.stringify(payload),digest,'pending',now,spec.expiresAt,null);
    this.audit(id, 'schedule.propose');
    return this.inspect(id);
  }
  private row(id: string): Row {
    const r = this.s.store.db.prepare('SELECT * FROM schedules WHERE id=? AND workspace_id=?').get(id, this.s.workspaceId) as Row | undefined;
    if (!r) throw new DodoError('NOT_FOUND', 'unknown schedule');
    return r;
  }
  private checked(r: Row): Payload {
    const p = JSON.parse(r.payload) as Payload;
    if (digestOf(p) !== r.digest) throw new DodoError('CONFLICT', 'schedule content changed since review');
    const root = this.s.store.getWorkspace(this.s.workspaceId)!;
    const liveRoot = fs.statSync(this.s.wfs.resolve('.').abs, { bigint: true });
    if (!liveRoot.isDirectory() || encodeFileIdentity(liveRoot.dev) !== p.dev || encodeFileIdentity(liveRoot.ino) !== p.ino) throw new DodoError('FORBIDDEN', 'workspace directory identity changed');
    if (root.root !== p.root || root.dev !== p.dev || root.ino !== p.ino || p.policy !== this.policy() || this.s.store.trustMode(this.s.workspaceId) !== 'trusted') throw new DodoError('FORBIDDEN', 'root or policy changed, or saved trust is not trusted; propose and approve again');
    if (p.clientId !== null && p.clientId !== 'stdio') {
      const g = p.grantId ? this.s.store.getGrant(p.grantId) : undefined;
      // Personal mode keeps no per-workspace ACL row, so re-check the same live
      // authority the invocation pipeline uses instead of demanding a row that
      // is never written there.
      const live = isPersonalMode(this.s.store) ? g?.scopes ?? [] : this.s.store.clientAccess(this.s.workspaceId, p.clientId);
      const ceiling: readonly string[] = projectScopeCeiling(this.s.store, this.s.workspaceId);
      if (!g || !this.s.store.oauthFind('Grant', p.grantId!) || g.revokedAt !== null || !g.scopes.includes('dodo:exec') || !live.includes('dodo:exec') || !ceiling.includes('dodo:exec')) throw new DodoError('FORBIDDEN', 'schedule client grant/access revoked');
    }
    return p;
  }
  inspect(id: string) {
    const r = this.row(id);
    const p = JSON.parse(r.payload) as Payload;
    return {id:r.id, digest:r.digest, status:r.expires_at <= Date.now() ? 'expired' : r.status, ...p, nextAt:r.next_at, expiresAt:r.expires_at, warning:'Runs current project code with OS-user privileges; command hash does not pin dependencies or project contents.'};
  }
  list() {
    return (this.s.store.db.prepare('SELECT id FROM schedules WHERE workspace_id=? ORDER BY created_at DESC LIMIT 100').all(this.s.workspaceId) as Array<{id:string}>).map(r => this.inspect(r.id));
  }
  approve(id: string, digest: string) {
    const r = this.row(id);
    if (r.status !== 'pending' || r.expires_at <= Date.now() || digest !== r.digest) throw new DodoError('CONFLICT', 'schedule expired, decided or review hash mismatch');
    const p = this.checked(r);
    const next = this.next(p.spec, Date.now());
    if (next >= r.expires_at) throw new DodoError('INVALID_INPUT', 'no occurrence before expiry');
    this.s.store.db.prepare("UPDATE schedules SET status='approved', approved_at=?, next_at=? WHERE id=?").run(Date.now(),next,id);
    this.audit(id,'schedule.approve');
    return this.inspect(id);
  }
  revoke(id: string) {
    this.row(id);
    this.s.store.db.prepare("UPDATE schedules SET status='revoked', next_at=NULL WHERE id=?").run(id);
    const owned = this.s.store.db.prepare("SELECT id FROM jobs WHERE workspace_id=? AND epoch=? AND principal=? AND status='running'").all(this.s.workspaceId,this.s.epoch,`schedule:${id}`) as Array<{id:string}>;
    for (const j of owned) this.s.jobs.cancel(j.id,this.s.workspaceId,500);
    this.audit(id,'schedule.revoke');
    return {id,status:'revoked'};
  }
  history(id: string) {
    this.row(id);
    const runs = this.s.store.db.prepare('SELECT * FROM schedule_runs WHERE schedule_id=? ORDER BY due_at DESC LIMIT 50').all(id) as Run[];
    return runs.map(r => ({...r, job:r.job_id ? this.s.store.getJob(r.job_id) ?? null : null}));
  }
  start(ready: () => boolean) {
    if (this.timer) return;
    this.bootedAt = Date.now();
    this.timer = setInterval(() => { if (ready()) { try { this.tick(); } catch { this.stop(); console.error('[dodo] scheduler stopped after a state error; inspect schedules locally before restarting'); } } }, 1000);
    this.timer.unref();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  /** Synchronous claim->spawn: revoke cannot race between permission check and launch. */
  tick(now = Date.now()) {
    const rows = this.s.store.db.prepare("SELECT * FROM schedules WHERE workspace_id=? AND status='approved' ORDER BY next_at LIMIT 64").all(this.s.workspaceId) as Row[];
    for (const row of rows) {
      if (row.expires_at <= now) { this.revoke(row.id); continue; }
      if (row.next_at === null || row.next_at > now) continue;
      let p: Payload;
      try { p = this.checked(row); } catch {
        this.s.store.db.prepare("UPDATE schedules SET status='paused', next_at=NULL WHERE id=?").run(row.id);
        this.audit(row.id, 'schedule.policy-paused'); continue;
      }
      // A schedule's own overlap still gets a receipt; other mutations defer
      // this tick without claiming it, so no command bypasses the shared queue.
      const ownRunning = !!this.s.store.db.prepare("SELECT id FROM jobs WHERE workspace_id=? AND principal=? AND status='running' LIMIT 1").get(this.s.workspaceId, `schedule:${row.id}`);
      if (this.s.jobs.mutations?.busy && !ownRunning) continue;
      const due = row.next_at;
      const next = this.next(p.spec, now);
      const claimed = this.s.store.db.transaction(() => {
        const update = this.s.store.db.prepare("UPDATE schedules SET next_at=? WHERE id=? AND status='approved' AND next_at=?").run(next,row.id,due);
        if (!update.changes) return false;
        return !!this.s.store.db.prepare("INSERT OR IGNORE INTO schedule_runs VALUES (?,?,'claimed',NULL,NULL)").run(row.id,due).changes;
      }).immediate();
      if (!claimed) continue;
      const finish = (status: string, jobId: string|null=null, error: string|null=null) => this.s.store.db.prepare('UPDATE schedule_runs SET status=?,job_id=?,error=? WHERE schedule_id=? AND due_at=?').run(status,jobId,error,row.id,due);
      // Missed ticks, including downtime, are skipped. Claimed/uncertain ticks are never replayed.
      if (due < this.bootedAt || now - due > 60_000) { finish('skipped_missed'); continue; }
      if (this.s.store.db.prepare("SELECT id FROM jobs WHERE workspace_id=? AND principal=? AND status='running' LIMIT 1").get(this.s.workspaceId,`schedule:${row.id}`)) { finish('skipped_overlap'); continue; }
      try {
        const job = this.s.jobs.start({workspaceId:this.s.workspaceId,epoch:this.s.epoch,principal:`schedule:${row.id}`,kind:'exec',program:p.spec.command,args:[],cwdRel:p.spec.cwd,timeoutMs:p.spec.timeoutMs,shell:true,sandbox:p.spec.sandbox,network:p.spec.network,stdin:false});
        finish('launched',job.jobId);
      } catch { finish('launch_failed',null,'Unable to launch within current limits and sandbox policy'); }
      this.audit(row.id,'schedule.tick');
    }
  }
  private audit(id: string, tool: string) { this.s.store.audit({workspaceId:this.s.workspaceId,principal:'owner-schedule',tool,refId:id,result:'ok'}); }
}
