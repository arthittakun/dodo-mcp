import { z } from 'zod';
import { defineTool, policyGate, type ToolCtx } from './context.js';
import { withIdempotency } from './changeTools.js';
import { DodoError } from '../errors.js';
import type { RestoreSelection } from '../services/recovery/history.js';

const id=z.string().min(1).max(128), key=z.string().min(8).max(128);
const page={cursor:z.number().int().min(0).max(1000000).default(0),limit:z.number().int().min(1).max(100).default(20)};
export const RECOVERY_INPUTS={
  restore_status:{planId:id.optional(),scan:z.boolean().default(false)},
  checkpoint_list:page,
  checkpoint_inspect:{checkpointId:id,...page},
  checkpoint_create:{idempotencyKey:key},
  recovery_session_list:page,
  recovery_session_inspect:{sessionId:id,...page},
  recovery_session_begin:{title:z.string().trim().min(1).max(160),idempotencyKey:key},
  recovery_session_end:{sessionId:id},
  restore_preview:{checkpointId:id.optional(),sessionId:id.optional(),paths:z.array(z.string().min(1).max(1024)).max(100).optional(),exactMirror:z.boolean().default(false)},
  restore_apply:{planId:id,planHash:z.string().regex(/^sha256:[a-f0-9]{64}$/),idempotencyKey:key},
};
export type RecoveryOperation=keyof typeof RECOVERY_INPUTS;
/** Shared validation/service for authenticated owner IPC and MCP; owner is never an input field. */
export async function performRecovery(name:RecoveryOperation,raw:Record<string,unknown>,ctx:ToolCtx,owner=false){
  const args=z.object(RECOVERY_INPUTS[name]).strict().parse(raw) as Record<string,unknown>;
  const r=ctx.services.recovery;if(!r)throw new DodoError('NOT_SUPPORTED','Recovery is unavailable');
  const h=r.history,a={id:ctx.principal.grantId,...(owner?{owner:true}:{})};
  const cursor=args['cursor'] as number,limit=args['limit'] as number;
  switch(name){
    case 'restore_status':if(args['scan'])await r.scanDrift();return {...h.status(a,args['planId'] as string|undefined),drift:r.drift.status(),git:r.git.status(),verification:r.evidence.summary(),evidence:r.evidence.list(a,0,5)};
    case 'checkpoint_list':return h.list(a,'checkpoints',cursor,limit);
    case 'recovery_session_list':return h.list(a,'sessions',cursor,limit);
    case 'checkpoint_inspect':return h.inspect(a,{checkpointId:args['checkpointId'] as string,cursor,limit});
    case 'recovery_session_inspect':return h.inspect(a,{sessionId:args['sessionId'] as string,cursor,limit});
    case 'restore_preview':return h.preview(a,args as RestoreSelection);
    case 'recovery_session_end':return h.end(args['sessionId'] as string,a);
    case 'checkpoint_create': {
      const result=await withIdempotency(ctx,name,args['idempotencyKey'] as string,{},async()=>{
        const checkpointId=await r.checkpoint('owner-checkpoint',a.id);
        if(!checkpointId)throw new DodoError('CONFLICT','register project and enable Recovery first');
        return {checkpointId,sourceOnly:true};
      });return {...result.result,replayed:result.replayed};
    }
    case 'recovery_session_begin':{
      const result=await withIdempotency(ctx,name,args['idempotencyKey'] as string,{title:args['title']},()=>h.begin(a,args['title'] as string));return {...result.result,replayed:result.replayed};
    }
    case 'restore_apply':{
      const payload={planId:args['planId'],planHash:args['planHash']};
      if(!owner)policyGate(ctx,{tool:name,action:'mutate-files',approvalAction:payload,summary:'apply exactly the reviewed source restore plan'});
      const result=await withIdempotency(ctx,name,args['idempotencyKey'] as string,payload,()=>h.apply(a,args['planId'] as string,args['planHash'] as string));return {...result.result,replayed:result.replayed};
    }
  }
}
const descriptions:Record<RecoveryOperation,string>={
 restore_status:'Read durable restore plan/journal outcomes after reconnect or uncertain delivery. Never automatically repeats apply.',
 checkpoint_list:'List your source checkpoints with bounded pagination. Private owner controls can inspect cross-caller history; IDs never grant access.',
 checkpoint_inspect:'Inspect allowed paths, hashes and coverage of your checkpoint; never returns raw secrets or private backup paths.',
 checkpoint_create:'Capture an independent source checkpoint before work. Includes allowed files only; never captures database/volume/secret data. Requires enabled owner policy.',
 recovery_session_list:'List caller-owned recovery sessions, separate from chat memory.',
 recovery_session_inspect:'Inspect session before-state metadata and ordered journal/job receipts. Shell authorship is unknown; never inferred as exclusive ownership.',
 recovery_session_begin:'Begin a caller-owned source recovery session. Pass returned sessionId as TOP-LEVEL recoverySessionId on subsequent mutations. Preserves pre-existing dirty/untracked source without changing Git index.',
 recovery_session_end:'Close your session; does not stop jobs or undo anything. Closed/interrupted sessions can still be previewed for recovery.',
 restore_preview:'Preview one checkpoint or session undo; no workspace writes. Return a bounded immutable plan/hash or conflicts. Default preserves extra/unrelated files. exactMirror explicitly includes extra source file deletions. Session undo refuses external/interleaved edits and unknown shell authorship.',
 restore_apply:'Apply exactly the reviewed restore plan/hash with a durable idempotency key. Rechecks caller, project, epoch, source policy and hashes under the mutation queue, snapshots pre-restore state and uses the journal. Inspect trust still needs owner approval. Never reruns interrupted effects.',
};
export const RECOVERY_TOOLS=(Object.keys(RECOVERY_INPUTS) as RecoveryOperation[]).map(name=>{
 const read=name.endsWith('_list')||name.endsWith('_inspect')||name==='restore_status';
 return defineTool({name,title:name.replaceAll('_',' '),description:descriptions[name],input:RECOVERY_INPUTS[name],output:z.looseObject({}),
   annotations:{readOnlyHint:read,destructiveHint:name==='restore_apply',idempotentHint:read||name==='restore_apply',openWorldHint:false},
   requiredScope:read?'dodo:read':'dodo:write',action:name==='restore_apply'?'mutate-files':read?'read':'plan',
   handler:async(args,ctx)=>{const clean=Object.fromEntries(Object.keys(RECOVERY_INPUTS[name]).map(k=>[k,(args as Record<string,unknown>)[k]]));return {data:await performRecovery(name,clean,ctx)};}});
});
