import { z } from 'zod';
import { defineTool, type ToolCtx } from './context.js';
import { DodoError } from '../errors.js';
import { DeploymentHash } from '../services/recovery/deploymentContracts.js';

const id = z.string().min(1).max(128);
export const DEPLOYMENT_INPUTS = {
  deployment_targets: {},
  deployment_list: { cursor: z.number().int().min(0).max(1000000).default(0), limit: z.number().int().min(1).max(50).default(20) },
  deployment_inspect: { deploymentId: id },
  deployment_compare: { deploymentId: id },
  deployment_prepare: { targetId: id, expectedTargetRevision: z.number().int().positive(), verificationId: id, idempotencyKey: z.string().min(8).max(128) },
  deployment_build: { deploymentId: id, planHash: DeploymentHash },
  deployment_apply: { deploymentId: id, planHash: DeploymentHash, imageDigest: DeploymentHash },
  deployment_observe: { deploymentId: id },
  deployment_source_preview: { deploymentId: id },
  deployment_rollback_prepare: { deploymentId: id, idempotencyKey: z.string().min(8).max(128) },
} as const;
export type DeploymentOperation = keyof typeof DEPLOYMENT_INPUTS;
export async function performDeployment(name: DeploymentOperation, raw: Record<string, unknown>, ctx: ToolCtx, owner = false): Promise<unknown> {
  const args = z.object(DEPLOYMENT_INPUTS[name]).strict().parse(raw) as Record<string, unknown>;
  const d = ctx.services.recovery?.deployments;
  if (!d || !ctx.revalidate) throw new DodoError('NOT_SUPPORTED', 'deployment needs Recovery and live invocation authority');
  ctx.revalidate(); const actor = { id: ctx.principal.grantId, ...(owner ? { owner: true } : {}) };
  switch (name) {
    case 'deployment_targets': return { items: d.targets().map(t => ({ id: t.id, name: t.definition.name, revision: t.revision, enabled: t.enabled, requiredChecks: t.definition.requiredChecks })) };
    case 'deployment_list': return d.list(actor, args['cursor'] as number, args['limit'] as number);
    case 'deployment_inspect': return d.inspect(args['deploymentId'] as string, actor);
    case 'deployment_compare': return d.compare(args['deploymentId'] as string, actor);
    case 'deployment_prepare': return d.prepare(args, actor, ctx.revalidate);
    case 'deployment_build': return d.build(args['deploymentId'] as string, args['planHash'] as string, ctx);
    case 'deployment_apply': return d.apply(args['deploymentId'] as string, args['planHash'] as string, args['imageDigest'] as string, ctx);
    case 'deployment_observe': return d.observe(args['deploymentId'] as string, ctx);
    case 'deployment_source_preview': return d.observe(args['deploymentId'] as string, ctx, true);
    case 'deployment_rollback_prepare': return d.prepareRollback(args['deploymentId'] as string, args['idempotencyKey'] as string, ctx);
  }
}
const descriptions: Record<DeploymentOperation, string> = {
  deployment_targets: 'List owner-registered deployment target IDs, revisions and required verification recipes. Cannot register targets or grant Docker access.',
  deployment_list: 'List caller-owned deployment plans and recorded outcomes. Historical health is not proof that production is currently healthy.',
  deployment_inspect: 'Read a caller-owned immutable deployment plan, image digest and durable outcome after reconnect. Never repeats an uncertain command.',
  deployment_compare: 'Compare current allowed source with the reviewed source snapshot. Production remains unknown until inspected live.',
  deployment_prepare: 'Prepare a bounded immutable deployment plan from current VERIFIED evidence and an owner-registered target. No build or deployment; key retries return the same plan.',
  deployment_build: 'Build exactly the reviewed snapshot using the registered Docker adapter, existing exec policy and sandbox. Uses a sealed source archive, not repository Compose config. Same plan never repeats uncertain build effects.',
  deployment_apply: 'Deploy the exact reviewed image digest and verify owner health checks over a stabilization window. Requires exec approval and unchanged source/target. Never runs database migrations or deletes volumes; failures preserve the previous known-good pointer.',
  deployment_observe: 'Inspect actual registered Docker service IDs/image and verify declared source bytes without stopping containers. Requires exec policy for daemon access. Observation never silently retries or certifies health.',
  deployment_source_preview: 'Verify declared source bytes in the recorded running image, then create an R02 source restore preview. Does not apply, restart containers, copy mounts or alter DB data. Missing/compiled source fails closed.',
  deployment_rollback_prepare: 'Inspect the current registered service and prepare an immutable image-only rollback to a caller-owned recorded known-good deployment. Does not deploy or rebuild; use deployment_apply with the returned plan/hash/image. Original tests are historical, fresh health is required. Never rolls back database migrations or volumes.',
};
export const DEPLOYMENT_TOOLS = (Object.keys(DEPLOYMENT_INPUTS) as DeploymentOperation[]).map(name => {
  const effect = ['deployment_build', 'deployment_apply', 'deployment_observe', 'deployment_source_preview', 'deployment_rollback_prepare'].includes(name), prepare = name === 'deployment_prepare';
  return defineTool({ name, title: name.replaceAll('_', ' '), description: descriptions[name], input: DEPLOYMENT_INPUTS[name], output: z.looseObject({}),
    requiredScope: effect || prepare ? 'dodo:exec' : 'dodo:read', action: effect ? 'exec' : prepare ? 'plan' : 'read',
    annotations: { readOnlyHint: !effect && !prepare, destructiveHint: name === 'deployment_apply', idempotentHint: true, openWorldHint: effect },
    handler: async (args, ctx) => ({ data: await performDeployment(name, Object.fromEntries(Object.keys(DEPLOYMENT_INPUTS[name]).map(k => [k, (args as Record<string, unknown>)[k]])), ctx) }),
  });
});
