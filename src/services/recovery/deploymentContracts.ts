import { z } from 'zod';

const name = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9_-]*$/);
export const DeploymentHash = z.string().regex(/^sha256:[a-f0-9]{64}$/);
// Additional filesystem/secret checks use the project's shared path policy.
const relative = z.string().min(1).max(1024).refine(p =>
  p === '.' || (!p.startsWith('/') && !/[\\:\x00-\x1f]/.test(p)
    && p.split('/').every(part => part !== '' && part !== '.' && part !== '..')),
  'use a canonical relative source path');
const operation = z.object({
  path: z.string().min(1).max(1024).startsWith('/'),
  method: z.enum(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']),
  responses: z.array(z.string().regex(/^(?:[1-5][0-9]{2}|default)$/)).min(1).max(20),
  // Exact hashes are deliberately conservative: uncertainty never proves compatibility.
  contractHash: DeploymentHash.optional(),
}).strict();
export const DeploymentHealthCheck = z.object({
  id: name,
  kind: z.enum(['http', 'openapi']),
  url: z.string().max(2048).url(),
  allowPrivateNetwork: z.boolean().default(false),
  expectedStatus: z.number().int().min(100).max(599).default(200),
  requiredOperations: z.array(operation).max(100).default([]),
}).strict().refine(c => c.kind === 'openapi' ? c.requiredOperations.length > 0 : c.requiredOperations.length === 0,
  'OpenAPI checks require explicit operations; HTTP checks do not accept a contract');

/** Owner-only input. No credential values, arbitrary argv, privileged flags or repo Compose hooks. */
export const DeploymentTargetSchema = z.object({
  name,
  adapter: z.literal('docker-compose'),
  dockerContext: name.default('default'),
  composeProject: name,
  service: name,
  contextRoot: relative.default('.'),
  dockerfile: relative.refine(p => p !== '.').default('Dockerfile'),
  buildNetwork: z.enum(['none', 'default']).default('none'),
  sourceMapping: z.object({
    workspaceRoot: relative.default('.'),
    containerRoot: z.string().min(2).max(1024).refine(p => /^\//.test(p) && !/[\\:\x00-\x1f]/.test(p)
      && p.slice(1).split('/').every(v => v !== '' && v !== '.' && v !== '..')
      && !/^\/(?:proc|sys|dev|run|var\/run)(?:\/|$)/.test(p), 'use a dedicated absolute container source directory'),
  }).strict().optional(),
  ports: z.array(z.object({
    host: z.enum(['127.0.0.1', '0.0.0.0', '::1']).default('127.0.0.1'),
    published: z.number().int().min(1024).max(65535),
    target: z.number().int().min(1).max(65535),
  }).strict()).max(20).default([]),
  // Only existing, explicitly named volumes; never bind mounts or automatic data deletion.
  volumes: z.array(z.object({ name, target: z.string().regex(/^\/[a-zA-Z0-9_/-]+$/).max(256) }).strict()).max(10).default([]),
  requiredChecks: z.array(z.object({ taskId: z.string().min(1).max(128), recipeDigest: DeploymentHash }).strict()).min(1).max(20),
  health: z.array(DeploymentHealthCheck).min(1).max(20),
  stabilizationMs: z.number().int().min(1000).max(300000).default(10000),
  intervalMs: z.number().int().min(250).max(10000).default(2000),
  commandTimeoutMs: z.number().int().min(1000).max(1800000).default(300000),
  retainedImages: z.number().int().min(2).max(100).default(5),
}).strict().superRefine((target, ctx) => {
  for (const [field, values] of [
    ['requiredChecks', target.requiredChecks.map(c => c.taskId)], ['health', target.health.map(c => c.id)],
    ['ports', target.ports.map(p => `${p.host}:${p.published}`)], ['volumes', target.volumes.map(v => v.target)],
  ] as const) if (new Set(values).size !== values.length) ctx.addIssue({ code: 'custom', path: [field], message: 'duplicate target entry' });
  if (target.intervalMs > target.stabilizationMs) ctx.addIssue({ code: 'custom', path: ['intervalMs'], message: 'interval must fit the stabilization window' });
  for (const v of target.volumes) {
    if (v.target.includes('//') || /^\/(?:proc|sys|dev|run)(?:\/|$)/.test(v.target)) ctx.addIssue({ code: 'custom', path: ['volumes'], message: 'invalid volume destination' });
    if(target.volumes.some(other=>other!==v&&(other.target.startsWith(v.target+'/')||v.target.startsWith(other.target+'/'))))
      ctx.addIssue({code:'custom',path:['volumes'],message:'nested volume destinations are not supported'});
    const source = target.sourceMapping?.containerRoot;
    if (source && (source === v.target || source.startsWith(v.target + '/') || v.target.startsWith(source + '/')))
      ctx.addIssue({ code: 'custom', path: ['volumes'], message: 'source recovery mapping must not overlap volume data' });
  }
});
export type DeploymentTarget = z.infer<typeof DeploymentTargetSchema>;
export type HealthCheck = z.infer<typeof DeploymentHealthCheck>;
export type DeploymentState = 'PREPARED' | 'BUILDING' | 'BUILT' | 'DEPLOYING' | 'HEALTH_CHECKING' | 'KNOWN_GOOD' | 'FAILED' | 'UNKNOWN';
export interface DeploymentPlan {
  version: 1;
  deploymentId: string;
  workspaceId: string;
  epoch: string;
  rootIdentity: string;
  actor: string;
  targetId: string;
  targetRevision: number;
  targetHash: string;
  checkpointId: string;
  manifestHash: string;
  sourceDigest: string;
  contextDigest: string;
  verificationId: string;
  verificationDigest: string;
  createdAt: number;
  expiresAt: number;
  rollback?: { fromDeploymentId: string; observedContainersHash: string; pointerRevision: number };
}
