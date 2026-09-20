import { z } from 'zod';
import { DodoError } from '../../errors.js';
import { digestOf, newId } from '../../util/hash.js';
import type { AppServices } from '../../tools/context.js';
import type { RecoveryService } from './recoveryService.js';
import type { RecoveryActor } from './history.js';
import { rootIdentity } from './storage.js';
import { DeploymentTargetSchema, type DeploymentPlan, type DeploymentState, type DeploymentTarget } from './deploymentContracts.js';
import { buildContextEntries, recoverySourceDigest, sourceComparison } from './deploymentSource.js';
import { validateHealthUrl } from './deploymentHealth.js';
import { evaluateHealth, readHealth } from './deploymentHealth.js';
import { packDeploymentSource } from './deploymentArchive.js';
import { mappedSourceEntries } from './deploymentSource.js';
import { DockerDeploymentAdapter } from './dockerDeployment.js';
import { policyGate, type ToolCtx } from '../../tools/context.js';
import { sha256Bytes } from '../../util/hash.js';
import { DeploymentMaintenance, DeploymentMaintenanceInput } from './deploymentMaintenance.js';
import { isOwner } from '../../security/projectAuthority.js';

interface TargetRow { id: string; revision: number; payload: string; enabled: number }
interface PlanRow { id: string; actor: string; payload: string; plan_hash: string; state: DeploymentState; image_digest: string | null; result_json: string | null; request_hash: string }

/** Durable provenance. Owner target configuration never grants execution authority. */
export class RecoveryDeployments {
  constructor(private readonly s: AppServices, private readonly r: RecoveryService) {}
  private get db() { return this.s.store.db; }
  private get networkPolicy() { return { ...this.s.config, controlPorts: this.s.installation?.ai.settings.ports ?? [] }; }
  private target(id: string): { id: string; revision: number; definition: DeploymentTarget; hash: string; enabled: boolean } {
    this.r.assertProject();
    const row = this.db.prepare('SELECT * FROM recovery_deployment_targets WHERE id=? AND workspace_id=?').get(id, this.s.workspaceId) as TargetRow | undefined;
    if (!row) throw new DodoError('NOT_FOUND', 'deployment target unavailable for this project');
    const definition = DeploymentTargetSchema.parse(JSON.parse(row.payload));
    return { id: row.id, revision: row.revision, definition, hash: digestOf(definition), enabled: Boolean(row.enabled) };
  }
  targets() {
    this.r.assertProject();
    const rows = this.db.prepare('SELECT id FROM recovery_deployment_targets WHERE workspace_id=? ORDER BY id').all(this.s.workspaceId) as Array<{ id: string }>;
    return rows.map(row => this.target(row.id));
  }
  summary() {
    const count = (this.db.prepare('SELECT COUNT(*) AS n FROM recovery_deployment_targets WHERE workspace_id=?').get(this.s.workspaceId) as { n: number }).n;
    return { state: count ? 'CONFIGURED_LIVE_STATUS_UNKNOWN' : 'NOT_CONFIGURED', targetCount: count, liveHealth: 'NOT_CHECKED' };
  }
  /** Called only by authenticated owner administration, never exposed as an MCP operation. */
  async configure(raw: unknown, revalidate: () => void) {
    const body = z.object({ targetId: z.string().max(128).optional(), expectedRevision: z.number().int().nonnegative(), enabled: z.boolean(),
      definition: DeploymentTargetSchema, confirmDaemonAccess: z.literal(true) }).strict().parse(raw);
    return this.s.mutations!.run(async () => {
      this.r.assertProject();
      const d = body.definition;
      for (const rel of [d.contextRoot, d.contextRoot === '.' ? d.dockerfile : `${d.contextRoot}/${d.dockerfile}`, d.sourceMapping?.workspaceRoot]) {
        if (rel && rel !== '.') this.r.assertSourcePath(rel);
      }
      for (const check of d.health) validateHealthUrl(check, this.networkPolicy);
      const tasks = this.s.overview.discoverTasks(this.s.projectConfig);
      if (d.requiredChecks.some(check => !tasks.some(task => task.id === check.taskId && task.recipeDigest === check.recipeDigest)))
        throw new DodoError('CONFLICT', 'required verification recipe changed or is unavailable; review current recipes');
      revalidate();
      return this.db.transaction(() => {
        const existing = body.targetId ? this.target(body.targetId) : undefined;
        if ((existing?.revision ?? 0) !== body.expectedRevision) throw new DodoError('CONFLICT', 'deployment target revision changed; refresh before saving');
        if (!existing && this.targets().length >= 20) throw new DodoError('RESOURCE_LIMIT', 'deployment target limit reached');
        if (existing && this.db.prepare("SELECT 1 FROM recovery_deployments d LEFT JOIN recovery_deployment_maintenance m ON m.deployment_id=d.id WHERE d.target_id=? AND (d.state IN ('BUILDING','DEPLOYING','HEALTH_CHECKING') OR (d.state='UNKNOWN' AND m.resolution_json IS NULL)) LIMIT 1").get(existing.id))
          throw new DodoError('CONFLICT', 'inspect unfinished deployment outcomes before changing this target');
        const id = existing?.id ?? newId('deploytarget'), revision = body.expectedRevision + 1;
        // Installation-wide identity prevents two projects claiming the same Compose service.
        const collision = this.db.prepare('SELECT id FROM recovery_deployment_targets WHERE docker_context=? AND compose_project=? AND service=? AND id<>?')
          .get(d.dockerContext, d.composeProject, d.service, id);
        if (collision) throw new DodoError('CONFLICT', 'this Docker Compose service is already registered');
        this.db.prepare(`INSERT INTO recovery_deployment_targets (id,workspace_id,revision,enabled,payload,docker_context,compose_project,service,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,enabled=excluded.enabled,payload=excluded.payload,
          docker_context=excluded.docker_context,compose_project=excluded.compose_project,service=excluded.service,updated_at=excluded.updated_at`)
          .run(id, this.s.workspaceId, revision, Number(body.enabled), JSON.stringify(d), d.dockerContext, d.composeProject, d.service, Date.now());
        this.s.store.audit({ principal: 'local-config-owner', workspaceId: this.s.workspaceId, tool: 'deployment.target.configure', refId: id, inputDigest: digestOf(d), result: body.enabled ? 'enabled' : 'disabled' });
        return this.target(id);
      }).immediate();
    });
  }
  private row(id: string, actor: RecoveryActor): PlanRow {
    this.r.assertProject();
    const row = this.db.prepare('SELECT * FROM recovery_deployments WHERE id=? AND workspace_id=?').get(id, this.s.workspaceId) as PlanRow | undefined;
    if (!row || (!actor.owner && row.actor !== actor.id)) throw new DodoError('NOT_FOUND', 'deployment unavailable for this caller/project');
    return row;
  }
  inspect(id: string, actor: RecoveryActor) {
    const row = this.row(id, actor), plan = JSON.parse(row.payload) as DeploymentPlan;
    if (digestOf(plan) !== row.plan_hash) throw new DodoError('RECOVERY_REQUIRED', 'deployment plan integrity failed');
    const maintenance = this.db.prepare('SELECT pinned,retired,probe_json,resolution_json,cleanup_json FROM recovery_deployment_maintenance WHERE deployment_id=?').get(id) as {pinned:number;retired:number;probe_json:string|null;resolution_json:string|null;cleanup_json:string|null}|undefined;
    return { plan, planHash: row.plan_hash, state: row.state, imageDigest: row.image_digest,
      retention: { pinned: Boolean(maintenance?.pinned), imageRetired: Boolean(maintenance?.retired), unfinishedProbe: Boolean(maintenance?.probe_json && !(JSON.parse(maintenance.probe_json) as {removed:boolean}).removed), uncertaintyAcknowledged: Boolean(maintenance?.resolution_json), cleanupOutcome: maintenance?.cleanup_json ? JSON.parse(maintenance.cleanup_json) as object : null },
      outcome: row.result_json ? JSON.parse(row.result_json) as Record<string, unknown> : null };
  }
  list(actor: RecoveryActor, cursor = 0, limit = 20) {
    this.r.assertProject();
    const page = z.object({ cursor: z.number().int().min(0).max(1000000), limit: z.number().int().min(1).max(50) }).parse({ cursor, limit });
    const rows = this.db.prepare(`SELECT id FROM recovery_deployments WHERE workspace_id=? ${actor.owner ? '' : 'AND actor=?'} ORDER BY created_at DESC,id LIMIT ? OFFSET ?`)
      .all(this.s.workspaceId, ...(actor.owner ? [] : [actor.id]), page.limit + 1, page.cursor) as Array<{ id: string }>;
    return { items: rows.slice(0, page.limit).map(row => this.inspect(row.id, actor)), nextCursor: rows.length > page.limit ? page.cursor + page.limit : null };
  }
  async prepare(raw: unknown, actor: RecoveryActor, revalidate: () => void) {
    const body = z.object({ targetId: z.string().min(1).max(128), expectedTargetRevision: z.number().int().positive(),
      verificationId: z.string().min(1).max(128), idempotencyKey: z.string().min(8).max(128) }).strict().parse(raw);
    return this.s.mutations!.run(async () => {
      this.r.assertProject(); revalidate();
      const key = digestOf(body.idempotencyKey), requestHash = digestOf({ targetId: body.targetId, revision: body.expectedTargetRevision, verificationId: body.verificationId });
      const previous = this.db.prepare('SELECT id,request_hash FROM recovery_deployments WHERE workspace_id=? AND actor=? AND key_hash=?')
        .get(this.s.workspaceId, actor.id, key) as { id: string; request_hash: string } | undefined;
      if (previous) {
        if (previous.request_hash !== requestHash) throw new DodoError('IDEMPOTENCY_CONFLICT', 'deployment key already binds different inputs');
        return { ...this.inspect(previous.id, actor), replayed: true };
      }
      const target = this.target(body.targetId);
      if ((this.db.prepare('SELECT COUNT(*) AS n FROM recovery_deployments WHERE target_id=?').get(target.id) as {n:number}).n >= 500)
        throw new DodoError('RESOURCE_LIMIT', 'deployment record limit reached for this target');
      if (!this.r.policy().enabled || !target.enabled) throw new DodoError('FORBIDDEN', 'enable Recovery and this deployment target before preparing');
      if (target.revision !== body.expectedTargetRevision) throw new DodoError('CONFLICT', 'deployment target changed since review');
      await this.r.drift.guard();
      const verification = await this.r.evidence.inspect(body.verificationId, actor);
      if (verification.state !== 'VERIFIED' || !verification.evidence) throw new DodoError('CONFLICT', 'deployment needs current manifest-bound VERIFIED evidence');
      if (target.definition.requiredChecks.some(required => !verification.evidence!.requiredChecks.some(check =>
        check.taskId === required.taskId && check.recipeDigest === required.recipeDigest && check.jobId)))
        throw new DodoError('CONFLICT', 'verification does not cover every owner-required deployment check');
      const manifest = await this.r.history.manifest(verification.checkpointId, actor);
      for (const entry of manifest.entries) this.r.assertSourcePath(entry.path);
      const context = buildContextEntries(manifest, target.definition);
      const sourceDigest = recoverySourceDigest(manifest.entries);
      if (sourceDigest !== recoverySourceDigest(await this.r.currentEntries())) throw new DodoError('FILE_CHANGED', 'source changed while preparing deployment');
      revalidate();
      const now = Date.now();
      const plan: DeploymentPlan = { version: 1, deploymentId: newId('deploy'), workspaceId: this.s.workspaceId, epoch: this.s.epoch,
        rootIdentity: rootIdentity(this.s.wfs.root), actor: actor.id, targetId: target.id, targetRevision: target.revision, targetHash: target.hash,
        checkpointId: manifest.id, manifestHash: digestOf(manifest), sourceDigest, contextDigest: recoverySourceDigest(context),
        verificationId: body.verificationId, verificationDigest: digestOf(verification.evidence), createdAt: now, expiresAt: now + 30 * 60000 };
      this.db.transaction(() => {
        this.db.prepare(`INSERT INTO recovery_deployments (id,workspace_id,actor,target_id,snapshot_id,key_hash,request_hash,payload,plan_hash,state,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,'PREPARED',?)`).run(plan.deploymentId, this.s.workspaceId, actor.id, target.id, manifest.id, key, requestHash, JSON.stringify(plan), digestOf(plan), now);
        this.s.store.audit({ principal: actor.id, workspaceId: this.s.workspaceId, tool: 'deployment.prepare', refId: plan.deploymentId, inputDigest: digestOf(plan), result: 'prepared_no_effects' });
      }).immediate();
      return { ...this.inspect(plan.deploymentId, actor), replayed: false };
    });
  }
  /** Called at each execution boundary inside the project's mutation queue. */
  async validate(id: string, planHash: string, actor: RecoveryActor, revalidate: () => void) {
    const record = this.inspect(id, actor), p = record.plan;
    if (record.planHash !== planHash) throw new DodoError('PLAN_HASH_MISMATCH', 'review the exact deployment plan');
    if (p.epoch !== this.s.epoch || p.rootIdentity !== rootIdentity(this.s.wfs.root)) throw new DodoError('STALE_WORKSPACE', 'deployment context changed; inspect outcome before preparing again');
    if (Date.now() > p.expiresAt) throw new DodoError('PLAN_EXPIRED', 'deployment plan expired; no automatic retry');
    const target = this.target(p.targetId);
    if (!this.r.policy().enabled || !target.enabled) throw new DodoError('FORBIDDEN', 'Recovery or deployment target is disabled');
    if (target.revision !== p.targetRevision || target.hash !== p.targetHash) throw new DodoError('CONFLICT', 'deployment target changed');
    const m = await this.r.history.manifest(p.checkpointId, actor);
    for (const entry of m.entries) this.r.assertSourcePath(entry.path);
    if (digestOf(m) !== p.manifestHash || recoverySourceDigest(buildContextEntries(m, target.definition)) !== p.contextDigest)
      throw new DodoError('RECOVERY_REQUIRED', 'deployment manifest no longer matches its recorded context');
    if (recoverySourceDigest(await this.r.currentEntries()) !== p.sourceDigest) throw new DodoError('FILE_CHANGED', 'source changed since deployment review');
    if (p.rollback) {
      const original = this.inspect(p.rollback.fromDeploymentId, actor);
      if (original.state !== 'KNOWN_GOOD' || original.imageDigest !== record.imageDigest || original.plan.manifestHash !== p.manifestHash
        || original.plan.verificationDigest !== p.verificationDigest || original.plan.targetHash !== p.targetHash)
        throw new DodoError('RECOVERY_REQUIRED', 'rollback no longer binds its original verified known-good image');
    } else {
      const verification = await this.r.evidence.inspect(p.verificationId, actor);
      if (verification.state !== 'VERIFIED' || digestOf(verification.evidence) !== p.verificationDigest) throw new DodoError('CONFLICT', 'deployment verification is no longer current');
    }
    revalidate();
    return { ...record, target, manifest: m };
  }
  async compare(id: string, actor: RecoveryActor) {
    const record = this.inspect(id, actor), m = await this.r.history.manifest(record.plan.checkpointId, actor);
    const allowed = m.entries.filter(e => { try { this.r.assertSourcePath(e.path); return true; } catch { return false; } });
    return { deploymentId: id, state: record.state, source: sourceComparison(allowed, await this.r.currentEntries()),
      production: 'UNKNOWN', reason: 'live_container_inspection_required', labelsAreProof: false };
  }
  private authority(ctx: ToolCtx): () => void {
    // HTTP registration adds request-local lifecycle hooks to a shallow service
    // view. Bind its runtime/state, not the wrapper object's identity.
    if (ctx.services.recovery !== this.r || ctx.services.store !== this.s.store || ctx.services.wfs !== this.s.wfs
      || ctx.services.workspaceId !== this.s.workspaceId || ctx.services.epoch !== this.s.epoch || !ctx.revalidate)
      throw new DodoError('AUTH_REQUIRED', 'deployment needs a live invocation authority');
    return () => {
      ctx.revalidate!(); this.r.assertProject();
      if (!ctx.principal.scopes.includes('dodo:exec') || this.s.trustMode() !== ctx.trustMode) throw new DodoError('FORBIDDEN', 'deployment exec authority changed');
    };
  }
  private adapter(id: string, planHash: string, actor: RecoveryActor, target: DeploymentTarget, revalidate: () => void) {
    return new DockerDeploymentAdapter(this.s, actor.id, target, revalidate, (jobId, stage) => {
      this.db.prepare('INSERT INTO recovery_deployment_jobs VALUES (?,?,?,?)').run(id, jobId, stage, Date.now());
    }, async () => { await this.validate(id, planHash, actor, revalidate); }, probe => {
      this.db.prepare('INSERT INTO recovery_deployment_maintenance(deployment_id,probe_json) VALUES (?,?) ON CONFLICT(deployment_id) DO UPDATE SET probe_json=excluded.probe_json').run(id,JSON.stringify(probe));
    });
  }
  private outcome(id: string, state: DeploymentState, value: Record<string, unknown>) {
    this.db.prepare('UPDATE recovery_deployments SET state=?,result_json=? WHERE id=? AND workspace_id=?')
      .run(state, JSON.stringify(value), id, this.s.workspaceId);
  }
  async prepareRollback(id: string, idempotencyKey: string, ctx: ToolCtx) {
    z.string().min(8).max(128).parse(idempotencyKey);
    const revalidate = this.authority(ctx), actor = { id: ctx.principal.grantId, owner: isOwner(ctx.principal) };
    return this.s.mutations!.run(async () => {
      revalidate(); const original = this.inspect(id, actor), target = this.target(original.plan.targetId);
      const requestHash = digestOf({ kind: 'rollback', fromDeploymentId: id }), key = digestOf(idempotencyKey);
      const old = this.db.prepare('SELECT id,request_hash FROM recovery_deployments WHERE workspace_id=? AND actor=? AND key_hash=?').get(this.s.workspaceId, actor.id, key) as { id: string; request_hash: string } | undefined;
      if (old) {
        if (old.request_hash !== requestHash) throw new DodoError('IDEMPOTENCY_CONFLICT', 'key binds another deployment operation');
        return { ...this.inspect(old.id, actor), replayed: true };
      }
      if (!this.r.policy().enabled || !target.enabled || target.hash !== original.plan.targetHash || original.state !== 'KNOWN_GOOD' || !original.imageDigest || original.retention.imageRetired)
        throw new DodoError('CONFLICT', 'rollback requires a recorded known-good image and the same enabled owner target');
      policyGate(ctx, { tool: 'deployment_rollback_prepare', action: 'exec', approvalAction: { deploymentId: id, imageDigest: original.imageDigest, targetHash: target.hash },
        summary: 'inspect current Docker service and prepare an image-only rollback; no deploy, rebuild or database migration' });
      await this.r.drift.guard();
      const adapter = this.adapter(id, original.planHash, actor, target.definition, revalidate);
      const containers = await adapter.containers();
      const manifest = await this.r.history.manifest(original.plan.checkpointId, actor);
      if (digestOf(manifest) !== original.plan.manifestHash) throw new DodoError('RECOVERY_REQUIRED', 'rollback source manifest changed');
      for (const entry of manifest.entries) this.r.assertSourcePath(entry.path);
      const pointer = this.db.prepare('SELECT revision FROM recovery_production_pointers WHERE target_id=?').get(target.id) as { revision: number } | undefined;
      const now = Date.now(), plan: DeploymentPlan = { ...original.plan, deploymentId: newId('deploy'), actor: actor.id, epoch: this.s.epoch,
        rootIdentity: rootIdentity(this.s.wfs.root), sourceDigest: recoverySourceDigest(await this.r.currentEntries()),
        targetRevision: target.revision, createdAt: now, expiresAt: now + 30 * 60000,
        rollback: { fromDeploymentId: id, observedContainersHash: digestOf(containers), pointerRevision: pointer?.revision ?? 0 } };
      revalidate();
      this.db.prepare(`INSERT INTO recovery_deployments (id,workspace_id,actor,target_id,snapshot_id,key_hash,request_hash,payload,plan_hash,state,image_digest,result_json,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,'BUILT',?,?,?)`).run(plan.deploymentId, this.s.workspaceId, actor.id, target.id, manifest.id, key, requestHash,
        JSON.stringify(plan), digestOf(plan), original.imageDigest, JSON.stringify({ kind: 'reviewed_image_rollback', rebuilt: false, originalVerificationIsHistorical: true, requiresFreshHealth: true }), now);
      this.s.store.audit({ principal: actor.id, workspaceId: this.s.workspaceId, tool: 'deployment.rollback.prepare', refId: plan.deploymentId, inputDigest: digestOf(plan), result: 'prepared_no_deploy' });
      return { ...this.inspect(plan.deploymentId, actor), replayed: false };
    });
  }
  /** Live observation is separate from durable deployment success, and never retries effects. */
  async observe(id: string, ctx: ToolCtx, sourcePreview = false) {
    const revalidate = this.authority(ctx), actor = { id: ctx.principal.grantId, owner: isOwner(ctx.principal) };
    return this.s.mutations!.run(async () => {
      revalidate(); const record = this.inspect(id, actor), target = this.target(record.plan.targetId);
      if (!target.enabled || target.hash !== record.plan.targetHash) throw new DodoError('CONFLICT', 'review the original enabled target before inspecting its deployment');
      policyGate(ctx, { tool: sourcePreview ? 'deployment_source_preview' : 'deployment_observe', action: 'exec',
        approvalAction: { deploymentId: id, targetHash: target.hash }, summary: 'inspect the registered Docker service and declared source without stopping it or copying volume data' });
      const adapter = this.adapter(id, record.planHash, actor, target.definition, revalidate);
      const containers = await adapter.containers();
      const imageMatches = Boolean(record.imageDigest && containers.length === 1 && containers[0]!.image === record.imageDigest);
      let source: Record<string, unknown> = { state: target.definition.sourceMapping ? 'UNVERIFIED' : 'NOT_DECLARED' };
      if (imageMatches && target.definition.sourceMapping) {
        const manifest = await this.r.history.manifest(record.plan.checkpointId, actor);
        if (digestOf(manifest) !== record.plan.manifestHash) throw new DodoError('RECOVERY_REQUIRED', 'source manifest changed');
        const mapped = mappedSourceEntries(manifest, target.definition), root = target.definition.sourceMapping.workspaceRoot;
        const bytes = await adapter.sourceFromContainer(containers[0]!.id, record.imageDigest!, mapped,
          name => this.r.assertSourcePath(root === '.' ? name : `${root}/${name}`));
        source = { state: 'VERIFIED', fileCount: bytes.fileCount, bytes: bytes.bytes, scope: root };
      }
      const observation = { deploymentId: id, targetRevision: target.revision, containers, imageMatches, source,
        checkedAt: Date.now(), liveHealth: 'NOT_CHECKED', knownGoodIsHistorical: true };
      revalidate();
      this.s.store.audit({ principal: actor.id, workspaceId: this.s.workspaceId, tool: 'deployment.observe', refId: id, inputDigest: digestOf(observation), result: imageMatches ? 'image_matches' : 'image_differs_or_unavailable' });
      if (!sourcePreview) return observation;
      if (!imageMatches || source['state'] !== 'VERIFIED' || !target.definition.sourceMapping)
        throw new DodoError('NOT_SUPPORTED', 'verified running-container source is unavailable; no restore plan created');
      // Verified bytes equal the immutable CAS manifest. R02 owns the actual
      // preview/apply, current-state backup, conflicts and journal; Docker does
      // not write a single workspace file or return the raw archive.
      const restore = await this.r.history.preview(actor, { checkpointId: record.plan.checkpointId,
        paths: [target.definition.sourceMapping.workspaceRoot], exactMirror: false });
      revalidate(); return { observation, restore, sourceOnly: true, databaseChanged: false, containerRestarted: false };
    });
  }
  async build(id: string, planHash: string, ctx: ToolCtx) {
    const revalidate = this.authority(ctx), actor = { id: ctx.principal.grantId, owner: isOwner(ctx.principal) };
    return this.s.mutations!.run(async () => {
      revalidate(); const current = this.inspect(id, actor);
      if (current.retention.imageRetired) throw new DodoError('NOT_FOUND', 'recorded image was retired by the owner');
      if (current.planHash !== planHash) throw new DodoError('PLAN_HASH_MISMATCH', 'review the exact deployment plan');
      if (current.state !== 'PREPARED') return { ...current, replayed: true };
      const record = await this.validate(id, planHash, actor, revalidate);
      policyGate(ctx, { tool: 'deployment_build', action: 'exec', approvalAction: { deploymentId: id, planHash }, summary: 'build the reviewed source snapshot using the owner-registered Docker target' });
      const target = record.target.definition, entries = buildContextEntries(record.manifest, target);
      const archive = await packDeploymentSource(entries,
        e => this.r.storage.readObject(e.hash!, e.bytes, this.r.policy().fileBytes),
        name => this.r.assertSourcePath(target.contextRoot === '.' ? name : `${target.contextRoot}/${name}`));
      await this.validate(id, planHash, actor, revalidate);
      this.outcome(id, 'BUILDING', { archiveHash: sha256Bytes(archive), retryAllowed: false });
      try {
        const adapter = this.adapter(id, planHash, actor, target, revalidate), imageDigest = await adapter.build(id, archive);
        // Preserve actual image identity even if source verification or auth fails next.
        this.db.prepare('UPDATE recovery_deployments SET image_digest=? WHERE id=?').run(imageDigest,id);
        let source: Record<string, unknown> = { state: 'NOT_DECLARED', exactRecoveryAvailable: false };
        if (target.sourceMapping) {
          const mapped = mappedSourceEntries(record.manifest, target), root = target.sourceMapping.workspaceRoot;
          const verified = await adapter.verifyImageSource(imageDigest, mapped, name => this.r.assertSourcePath(root === '.' ? name : `${root}/${name}`));
          source = { state: 'VERIFIED', fileCount: verified.fileCount, bytes: verified.bytes, exactRecoveryAvailable: true };
        }
        await this.validate(id, planHash, actor, revalidate);
        this.db.transaction(() => {
          this.db.prepare('UPDATE recovery_deployments SET image_digest=? WHERE id=? AND workspace_id=?').run(imageDigest, id, this.s.workspaceId);
          this.outcome(id, 'BUILT', { archiveHash: sha256Bytes(archive), imageDigest, source, builtAt: Date.now(), deployed: false });
        }).immediate();
      } catch (error) {
        this.outcome(id, 'UNKNOWN', { errorCode: error instanceof DodoError ? error.code : 'INTERNAL_ERROR', stage: 'build', retryAllowed: false });
      }
      return { ...this.inspect(id, actor), replayed: false };
    });
  }
  async apply(id: string, planHash: string, imageDigest: string, ctx: ToolCtx) {
    const revalidate = this.authority(ctx), actor = { id: ctx.principal.grantId, owner: isOwner(ctx.principal) };
    return this.s.mutations!.run(async () => {
      revalidate(); const current = this.inspect(id, actor);
      if (current.retention.imageRetired) throw new DodoError('NOT_FOUND', 'recorded image was retired by the owner');
      if (current.planHash !== planHash || current.imageDigest !== imageDigest) throw new DodoError('PLAN_HASH_MISMATCH', 'review the recorded image digest and deployment plan');
      if (current.state !== 'BUILT') return { ...current, replayed: true };
      const record = await this.validate(id, planHash, actor, revalidate), target = record.target.definition;
      policyGate(ctx, { tool: 'deployment_apply', action: 'exec', approvalAction: { deploymentId: id, planHash, imageDigest }, summary: 'deploy the reviewed immutable image to its owner-registered service; no database migration or volume deletion' });
      const adapter = this.adapter(id, planHash, actor, target, revalidate);
      const previous = this.db.prepare('SELECT deployment_id,revision FROM recovery_production_pointers WHERE target_id=?').get(record.target.id) as { deployment_id: string; revision: number } | undefined;
      const prior = previous ? this.inspect(previous.deployment_id, { id: actor.id, owner: true }) : undefined;
      const actual = await adapter.containers();
      const oldIds = prior?.outcome?.['containerIds'];
      const differs = record.plan.rollback
        ? digestOf(actual) !== record.plan.rollback.observedContainersHash || (previous?.revision ?? 0) !== record.plan.rollback.pointerRevision
        : prior ? !Array.isArray(oldIds) || actual.length !== oldIds.length || actual.some(c => c.image !== prior.imageDigest || !oldIds.includes(c.id)) : actual.length > 0;
      if (differs)
        throw new DodoError('CONFLICT', 'running service provenance differs or is unknown; inspect external changes before deployment');
      await this.validate(id, planHash, actor, revalidate);
      this.outcome(id, 'DEPLOYING', { imageDigest, previousDeploymentId: previous?.deployment_id ?? null, intendedService: target.service, retryAllowed: false });
      try {
        await adapter.deploy(imageDigest);
        const observed = await adapter.containers();
        if (observed.length !== 1 || !observed[0]!.running || observed[0]!.image !== imageDigest) throw new DodoError('CONFLICT', 'deployed container identity/image or running state differs');
        this.outcome(id, 'HEALTH_CHECKING', { imageDigest, containerIds: observed.map(c => c.id), retryAllowed: false });
        const started = Date.now(); let samples = 0;
        let lastChecks: ReturnType<typeof evaluateHealth>[] = [];
        do {
          if (samples) await new Promise(resolve => setTimeout(resolve, target.intervalMs));
          revalidate(); lastChecks = [];
          for (const check of target.health) {
            const result = evaluateHealth(check, await readHealth(check, this.networkPolicy, revalidate)); lastChecks.push(result);
            if (!result.passed) {
              this.outcome(id, 'FAILED', { imageDigest, containerIds: observed.map(c => c.id), checks: lastChecks, reason: 'required_health_failed', previousKnownGoodUnchanged: true });
              return { ...this.inspect(id, actor), replayed: false };
            }
          }
          samples++;
        } while (samples < 2 || Date.now() - started < target.stabilizationMs);
        const final = await adapter.containers();
        if (digestOf(final) !== digestOf(observed)) throw new DodoError('CONFLICT', 'container state changed during stabilization');
        await this.validate(id, planHash, actor, revalidate);
        this.db.transaction(() => {
          const live = this.db.prepare('SELECT revision FROM recovery_production_pointers WHERE target_id=?').get(record.target.id) as { revision: number } | undefined;
          if ((live?.revision ?? 0) !== (previous?.revision ?? 0)) throw new DodoError('CONFLICT', 'known-good pointer changed while checking deployment');
          revalidate();
          this.outcome(id, 'KNOWN_GOOD', { imageDigest, containerIds: final.map(c => c.id), checks: lastChecks, samples, stabilizationMs: Date.now() - started,
            completedAt: Date.now(), coverage: 'recorded_source_build_required_tests_and_owner_health_checks', databaseChangedByAdapter: false });
          this.db.prepare(`INSERT INTO recovery_production_pointers VALUES (?,?,?,?,?) ON CONFLICT(target_id) DO UPDATE SET deployment_id=excluded.deployment_id,
            previous_id=excluded.previous_id,revision=excluded.revision,updated_at=excluded.updated_at`).run(record.target.id, id, previous?.deployment_id ?? null, (previous?.revision ?? 0) + 1, Date.now());
        }).immediate();
      } catch (error) { this.outcome(id, 'UNKNOWN', { imageDigest, errorCode: error instanceof DodoError ? error.code : 'INTERNAL_ERROR', stage: 'deploy_or_health', retryAllowed: false, previousKnownGoodUnchanged: true }); }
      return { ...this.inspect(id, actor), replayed: false };
    });
  }
  /** Owner-only maintenance; never registered as an MCP definition. */
  async maintenance(raw: unknown, ctx: ToolCtx) {
    if (!isOwner(ctx.principal) || ctx.principal.grantId !== 'local-config-owner') throw new DodoError('FORBIDDEN', 'private owner administration required');
    const input = DeploymentMaintenanceInput.parse(raw), revalidate = this.authority(ctx), actor = {id:ctx.principal.grantId,owner:true};
    return this.s.mutations!.run(async () => {
      revalidate();
      policyGate(ctx,{tool:'deployment.maintenance',action:input.action==='pin'?'plan':'exec',approvalAction:input,
        summary:'owner-reviewed deployment maintenance; no force removal, volume deletion or automatic uncertain retry'});
      const maintenance = new DeploymentMaintenance(this.s,revalidate,id=>this.inspect(id,actor),id=>this.target(id),
        (record,target)=>this.adapter(record.plan.deploymentId,record.planHash,actor,target.definition,revalidate));
      return maintenance.execute(input);
    });
  }
  /** Exclusive runtime lease only: never resume effects after restart. */
  reconcile() {
    this.db.prepare("UPDATE recovery_deployments SET state='UNKNOWN',result_json=? WHERE workspace_id=? AND state IN ('BUILDING','DEPLOYING','HEALTH_CHECKING')")
      .run(JSON.stringify({ reason: 'process_interrupted', retryAllowed: false }), this.s.workspaceId);
  }
}
