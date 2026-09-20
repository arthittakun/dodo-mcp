import { z } from 'zod';
import type { AppServices } from '../../tools/context.js';
import type { RecoveryDeployments } from './deploymentService.js';
import type { DockerDeploymentAdapter, SourceProbe } from './dockerDeployment.js';
import { DodoError } from '../../errors.js';
import { digestOf, newId } from '../../util/hash.js';

const id = z.string().min(1).max(128);
export const DeploymentMaintenanceInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('pin'), deploymentId: id, pinned: z.boolean(), expectedPinned: z.boolean() }).strict(),
  z.object({ action: z.literal('resolve_preview'), deploymentId: id }).strict(),
  z.object({ action: z.literal('image_preview'), deploymentId: id }).strict(),
  z.object({ action: z.literal('probe_preview'), deploymentId: id }).strict(),
  z.object({ action: z.literal('cleanup_preview'), targetId: id }).strict(),
  z.object({ action: z.literal('apply'), reviewId: id, reviewHash: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).strict(),
]);
type Record = ReturnType<RecoveryDeployments['inspect']>;
type Target = ReturnType<RecoveryDeployments['targets']>[number];
interface MaintenanceRow { pinned: number; retired: number; probe_json: string | null; resolution_json: string | null; cleanup_json: string | null }
interface CleanupItem { image: string; deployments: string[]; present: boolean; tags: string[]; eligible: boolean; reasons: string[] }
interface Review { kind: 'resolve' | 'probe' | 'cleanup' | 'image'; reference: string; epoch: string; observation: unknown }

/** Private owner administration only. Preview is durable; apply reobserves and
 * binds the exact preview. Interrupted effects remain UNKNOWN, never replayed. */
export class DeploymentMaintenance {
  constructor(private readonly s: AppServices, private readonly revalidate: () => void,
    private readonly inspect: (id: string) => Record, private readonly target: (id: string) => Target,
    private readonly adapter: (record: Record, target: Target) => DockerDeploymentAdapter) {}
  private get db() { return this.s.store.db; }
  private meta(id: string): MaintenanceRow {
    return this.db.prepare('SELECT * FROM recovery_deployment_maintenance WHERE deployment_id=?').get(id) as MaintenanceRow
      ?? { pinned: 0, retired: 0, probe_json: null, resolution_json: null, cleanup_json: null };
  }
  private assertIdle(id: string) {
    if (this.db.prepare("SELECT 1 FROM recovery_deployment_jobs d JOIN jobs j ON j.id=d.job_id WHERE d.deployment_id=? AND j.status='running' LIMIT 1").get(id))
      throw new DodoError('CONFLICT', 'deployment jobs are still running; wait or explicitly cancel them before maintenance');
  }
  private async observation(kind: Review['kind'], reference: string): Promise<unknown> {
    this.revalidate();
    if (kind === 'cleanup') return this.cleanup(reference);
    const record = this.inspect(reference), target = this.target(record.plan.targetId);
    this.assertIdle(reference);
    if (target.hash !== record.plan.targetHash) throw new DodoError('CONFLICT', 'registered target changed; do not inspect an unrelated Docker endpoint');
    const adapter = this.adapter(record, target), meta = this.meta(reference);
    if(kind==='image'){
      if(!record.imageDigest||!meta.cleanup_json)throw new DodoError('NOT_FOUND','no image cleanup receipt to inspect');
      return {targetHash:target.hash,image:record.imageDigest,actual:await adapter.imageInventory(record.imageDigest)};
    }
    if (kind === 'probe') {
      if (!meta.probe_json) throw new DodoError('NOT_FOUND', 'no recorded source probe');
      const probe = JSON.parse(meta.probe_json) as SourceProbe;
      return { targetHash: target.hash, probe, actual: await adapter.probeObservation(probe) };
    }
    if (record.state !== 'UNKNOWN' || meta.resolution_json) throw new DodoError('CONFLICT', 'this deployment has no unresolved uncertain outcome');
    return { targetHash: target.hash, planHash: record.planHash, containers: await adapter.containers(),
      image: record.imageDigest ? await adapter.imageInventory(record.imageDigest) : null,
      probe: meta.probe_json ? await adapter.probeObservation(JSON.parse(meta.probe_json) as SourceProbe) : null,
      action: 'acknowledge_uncertainty_without_retry_or_health_claim', previousKnownGoodUnchanged: true };
  }
  private async cleanup(targetId: string) {
    const target = this.target(targetId);
    const rows = this.db.prepare('SELECT id FROM recovery_deployments WHERE target_id=? ORDER BY created_at DESC,id DESC LIMIT 501').all(targetId) as Array<{ id: string }>;
    if (rows.length > 500) throw new DodoError('RESOURCE_LIMIT', 'deployment history exceeds the bounded maintenance limit');
    const records = rows.map(row => this.inspect(row.id));
    if(records.some(r=>r.imageDigest&&!this.meta(r.plan.deploymentId).retired&&r.plan.targetHash!==target.hash))
      throw new DodoError('CONFLICT','image history binds an earlier target definition; restore its reviewed definition before cleanup');
    const pointer = this.db.prepare('SELECT deployment_id,previous_id,revision FROM recovery_production_pointers WHERE target_id=?').get(targetId) as { deployment_id: string; previous_id: string | null; revision: number } | undefined;
    const groups = new Map<string, Record[]>();
    for (const r of records) if (r.imageDigest && !this.meta(r.plan.deploymentId).retired)
      groups.set(r.imageDigest, [...(groups.get(r.imageDigest) ?? []), r]);
    const keep = new Set([...groups.keys()].slice(0, target.definition.retainedImages));
    const items: CleanupItem[] = [];
    for (const [image, refs] of groups) {
      const adapter = this.adapter(refs[0]!, target), inventory = await adapter.imageInventory(image), reasons = new Set<string>();
      if (keep.has(image)) reasons.add('retention_budget');
      if (inventory.used) reasons.add('container_reference');
      const managedTags = refs.filter(r => !r.plan.rollback).map(r => `dodo-recovery:${r.plan.deploymentId}`);
      if (inventory.tags.some(tag => !managedTags.includes(tag))) reasons.add('unowned_tag');
      for (const r of refs) {
        const deploymentId = r.plan.deploymentId, meta = this.meta(deploymentId);
        this.assertIdle(deploymentId);
        if (meta.pinned) reasons.add('owner_pin');
        if (meta.cleanup_json) reasons.add('previous_cleanup_outcome_requires_inspection');
        if (pointer?.deployment_id === deploymentId || pointer?.previous_id === deploymentId) reasons.add('known_good_pointer');
        if (['BUILDING', 'DEPLOYING', 'HEALTH_CHECKING'].includes(r.state) || (r.state === 'UNKNOWN' && !meta.resolution_json)) reasons.add('unfinished_outcome');
        if (r.state === 'BUILT' && r.plan.expiresAt > Date.now()) reasons.add('live_deployment_plan');
      }
      // Another project/target may use the same image ID. No cross-target purge.
      if (this.db.prepare('SELECT 1 FROM recovery_deployments WHERE image_digest=? AND target_id<>? LIMIT 1').get(image, targetId)) reasons.add('other_target_reference');
      items.push({ image, deployments: refs.map(r => r.plan.deploymentId), ...inventory, eligible: inventory.present && !reasons.size, reasons: [...reasons].sort() });
    }
    return { targetId, targetHash: target.hash, pointerRevision: pointer?.revision ?? 0, retainedImages: target.definition.retainedImages,
      items, externalImagesIncluded: false, deletesVolumes: false };
  }
  async execute(raw: unknown) {
    const input = DeploymentMaintenanceInput.parse(raw); this.revalidate();
    if (input.action === 'pin') {
      this.inspect(input.deploymentId); const before = this.meta(input.deploymentId);
      if (Boolean(before.pinned) !== input.expectedPinned || before.retired) throw new DodoError('CONFLICT', 'image pin changed or image was retired');
      this.revalidate();
      this.db.prepare('INSERT INTO recovery_deployment_maintenance(deployment_id,pinned) VALUES (?,?) ON CONFLICT(deployment_id) DO UPDATE SET pinned=excluded.pinned')
        .run(input.deploymentId, Number(input.pinned));
      this.audit(input.deploymentId, 'pin', digestOf(input)); return { deploymentId: input.deploymentId, pinned: input.pinned };
    }
    if (input.action !== 'apply') {
      const kind = input.action === 'cleanup_preview' ? 'cleanup' : input.action === 'probe_preview' ? 'probe' : input.action==='image_preview'?'image':'resolve';
      const reference = 'targetId' in input ? input.targetId : input.deploymentId;
      const review: Review = { kind, reference, epoch: this.s.epoch, observation: await this.observation(kind, reference) };
      this.revalidate();
      // Expired completed previews contain no source/credentials; bound owner review storage.
      this.db.prepare('DELETE FROM recovery_deployment_reviews WHERE workspace_id=? AND expires_at<? AND result_json IS NULL').run(this.s.workspaceId, Date.now());
      if ((this.db.prepare('SELECT COUNT(*) AS n FROM recovery_deployment_reviews WHERE workspace_id=?').get(this.s.workspaceId) as { n: number }).n >= 2000)
        throw new DodoError('RESOURCE_LIMIT', 'deployment review limit reached');
      const reviewId = newId('deployreview'), reviewHash = digestOf(review), expiresAt = Date.now() + 10 * 60000;
      this.db.prepare('INSERT INTO recovery_deployment_reviews VALUES (?,?,?,?,?,?,NULL)').run(reviewId, this.s.workspaceId, kind, JSON.stringify(review), reviewHash, expiresAt);
      return { reviewId, reviewHash, expiresAt, ...review };
    }
    const row = this.db.prepare('SELECT * FROM recovery_deployment_reviews WHERE id=? AND workspace_id=?').get(input.reviewId, this.s.workspaceId) as
      { payload: string; digest: string; expires_at: number; result_json: string | null } | undefined;
    if (!row) throw new DodoError('NOT_FOUND', 'owner review unavailable');
    const review = JSON.parse(row.payload) as Review;
    if (digestOf(review) !== row.digest || input.reviewHash !== row.digest) throw new DodoError('PLAN_HASH_MISMATCH', 'review the exact maintenance plan');
    if (row.result_json) return { ...JSON.parse(row.result_json) as object, replayed: true };
    if (review.epoch !== this.s.epoch || row.expires_at < Date.now()) throw new DodoError('PLAN_EXPIRED', 'maintenance review expired; inspect again');
    const actual = await this.observation(review.kind, review.reference);
    if (digestOf(actual) !== digestOf(review.observation)) throw new DodoError('CONFLICT', 'live deployment state changed since maintenance preview');
    this.revalidate();
    const finish = (value: object) => {
      this.db.prepare('UPDATE recovery_deployment_reviews SET result_json=? WHERE id=?').run(JSON.stringify(value), input.reviewId); return value;
    };
    // Commit uncertain receipt BEFORE any daemon command. A retry only returns it.
    finish({ state: 'UNKNOWN', retryAllowed: false, reviewId: input.reviewId });
    try {
      if (review.kind === 'resolve') {
        this.db.prepare('INSERT INTO recovery_deployment_maintenance(deployment_id,resolution_json) VALUES (?,?) ON CONFLICT(deployment_id) DO UPDATE SET resolution_json=excluded.resolution_json')
          .run(review.reference, JSON.stringify({ reviewId: input.reviewId, acknowledgedAt: Date.now(), historicalOutcome: 'UNKNOWN', noRetry: true }));
      } else if(review.kind==='image'){
        const observed=actual as {actual:{present:boolean}};
        this.db.prepare('UPDATE recovery_deployment_maintenance SET retired=?,cleanup_json=? WHERE deployment_id=?').run(Number(!observed.actual.present),observed.actual.present?null:JSON.stringify({state:'REMOVAL_OBSERVED',reviewId:input.reviewId}),review.reference);
      } else if (review.kind === 'probe') {
        const r = this.inspect(review.reference);
        await this.adapter(r, this.target(r.plan.targetId)).removeProbe((actual as { probe: SourceProbe }).probe);
      } else {
        const data = actual as Awaited<ReturnType<DeploymentMaintenance['cleanup']>>;
        for (const item of data.items.filter(i => i.eligible)) {
          this.revalidate(); const record = this.inspect(item.deployments[0]!);
          for (const id of item.deployments) this.db.prepare('INSERT INTO recovery_deployment_maintenance(deployment_id,cleanup_json) VALUES (?,?) ON CONFLICT(deployment_id) DO UPDATE SET cleanup_json=excluded.cleanup_json')
            .run(id, JSON.stringify({ reviewId: input.reviewId, state: 'UNKNOWN', retryAllowed: false }));
          await this.adapter(record, this.target(data.targetId)).removeImage(item.image, item.tags);
          this.revalidate();
          for (const id of item.deployments) this.db.prepare('UPDATE recovery_deployment_maintenance SET retired=1,cleanup_json=? WHERE deployment_id=?')
            .run(JSON.stringify({ reviewId: input.reviewId, state: 'REMOVED' }), id);
        }
      }
      this.revalidate(); this.audit(input.reviewId, review.kind, row.digest);
      return finish({ state: 'COMPLETED', kind: review.kind, productionHealthClaim: false, reviewId: input.reviewId, replayed: false });
    } catch (e) {
      return finish({ state: 'UNKNOWN', reviewId: input.reviewId, errorCode: e instanceof DodoError ? e.code : 'INTERNAL_ERROR', retryAllowed: false });
    }
  }
  private audit(id: string, action: string, digest: string) {
    this.s.store.audit({ principal: 'local-config-owner', workspaceId: this.s.workspaceId, tool: `deployment.maintenance.${action}`, refId: id, inputDigest: digest, result: 'owner_reviewed' });
  }
}
