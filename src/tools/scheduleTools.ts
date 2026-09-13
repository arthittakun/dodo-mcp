import { z } from 'zod';
import { defineTool } from './context.js';
import { ScheduleInput } from '../services/schedules/scheduleService.js';
const output = z.looseObject({});
export const scheduleProposeTool = defineTool({
  name:'schedule_propose',title:'Propose scheduled command',description:'Create an immutable PENDING scheduled command. Does not execute or authorize it. Owner must inspect and approve the exact digest locally, with its own local approval. Runs only while HTTP DODO serves this workspace; saved trusted mode required. Current project code/dependencies are not pinned. Default requires OS sandbox, network disabled.',
  input:ScheduleInput.shape,output,annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false},requiredScope:'dodo:exec',action:'exec',
  handler:async(args,ctx)=>({data:ctx.services.schedules.propose(Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'workspaceId' && key !== 'workspaceEpoch')),ctx.principal)}),
});
