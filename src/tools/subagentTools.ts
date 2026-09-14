import { z } from 'zod';
import { defineTool, policyGate, type ToolCtx } from './context.js';
import { DodoError } from '../errors.js';
const data = z.looseObject({});
const service = (ctx: ToolCtx) => { const ai = ctx.services.installation?.ai; if (!ai) throw new DodoError('NOT_SUPPORTED', 'AI runtime is unavailable'); return ai; };
const runService = (ctx: ToolCtx, runId: string) => { const ai = service(ctx); const run = ai.status(runId,ctx.principal); const project = ai.installation.list(ctx.principal).find(p => p.projectId === run.projectId); if (project?.workspaceId !== ctx.services.workspaceId) throw new DodoError('WORKSPACE_MISMATCH', 'run belongs to a different target project'); return ai; };
const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
export const SUBAGENT_TOOLS = [
  defineTool({ name: 'subagent_spawn', title: 'Spawn a bounded AI coding agent', description: 'Run an enabled owner-configured AI profile on this target project. Requires exec scope; managed mode also requires explicit project/profile/client permission. Returns a durable run ID; it never approves actions, widens scopes, or disables guards.',
    input: { profileId: z.string().min(1), task: z.string().min(1).max(16000), idempotencyKey: z.string().min(8).max(128) }, output: data,
    requiredScope: 'dodo:exec', action: 'exec', annotations: { ...read, readOnlyHint: false, idempotentHint: false, openWorldHint: true },
    handler: async (args, ctx) => {
      const ai = service(ctx); const project = ai.installation.list(ctx.principal).find(p => p.workspaceId === ctx.services.workspaceId);
      if (!project) throw new DodoError('FORBIDDEN', 'register and authorize this project before spawning an agent');
      policyGate(ctx, { tool: 'subagent_spawn', action: 'exec', approvalAction: args, summary: 'Use a paid/local AI profile for a bounded coding task' });
      return { data: await ai.spawn({ projectId: project.projectId, profileId: args.profileId, task: args.task, idempotencyKey: args.idempotencyKey }, ctx.principal, ctx.services) };
    },
  }),
  ...(['subagent_status', 'subagent_result'] as const).map(name => defineTool({ name, title: name === 'subagent_status' ? 'AI run status' : 'AI run result', description: 'Inspect an owned AI run and its actual tool/test results. Does not expose provider secrets or private reasoning.',
    input: { runId: z.string().min(1), after:z.number().int().nonnegative().default(0) }, output: data, requiredScope: 'dodo:read', action: 'read', annotations: read,
    handler: async (args, ctx) => ({ data: name==='subagent_result' ? runService(ctx,args.runId).result(args.runId, ctx.principal,args.after) : runService(ctx,args.runId).status(args.runId, ctx.principal) }),
  })),
  defineTool({ name: 'subagent_control', title: 'Control an owned AI run', description: 'Pause, cancel, or explicitly resume an owned run. Resume re-checks live authority and cannot replay an uncertain outcome.',
    input: { runId: z.string().min(1), action: z.enum(['pause', 'resume', 'cancel']) }, output: data, requiredScope: 'dodo:exec', action: 'job-control', annotations: { ...read, readOnlyHint: false },
    handler: async (args, ctx) => ({ data: await runService(ctx,args.runId).control(args.runId, args.action, ctx.principal) }),
  }),
];
