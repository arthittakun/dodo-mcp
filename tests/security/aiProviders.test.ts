import http from 'node:http';
import dns from 'node:dns/promises';
import { describe, it, expect, vi } from 'vitest';
import { generate } from '../../src/services/ai/adapters.js';
import { providerRequest } from '../../src/services/ai/network.js';
import { PRESETS, ProfileInput, ProviderInput, type Provider } from '../../src/services/ai/contracts.js';
const profile = { ...ProfileInput.parse({ name:'fixture',connectionId:'ai_fixture01',model:'fixture-model',toolCalling:true }),id:'profile_fixture01' };
const key='synthetic-provider-credential-123456';
const sse=(events:unknown[])=>events.map(e=>`data: ${JSON.stringify(e)}\n\n`).join('');
function reply(protocol:string, second=false):string {
  const call={id:'c1',name:'test_tool',args:{value:1}};
  if(protocol==='responses')return sse([{type:'response.completed',response:{output:second?[{type:'message',content:[{type:'output_text',text:'OK'}]}]:[{type:'reasoning',encrypted_content:'opaque-response-state'},{type:'function_call',call_id:call.id,name:call.name,arguments:JSON.stringify(call.args)}],usage:{input_tokens:3,output_tokens:2}}}]);
  if(protocol==='anthropic')return sse([{type:'message_start',message:{usage:{input_tokens:3}}},{type:'content_block_start',index:0,content_block:second?{type:'text',text:''}:{type:'tool_use',id:call.id,name:call.name,input:{}}},{type:'content_block_delta',index:0,delta:second?{type:'text_delta',text:'OK'}:{type:'input_json_delta',partial_json:'{"value":'}},...(!second?[{type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:'1}'}}]:[]),{type:'content_block_stop',index:0},{type:'message_delta',usage:{output_tokens:2}},{type:'message_stop'}]);
  if(protocol==='gemini')return sse([{event_type:'step.start',index:0,step:{type:'thought'}},{event_type:'step.delta',index:0,delta:{type:'thought_signature',signature:'opaque-gemini-signature'}},{event_type:'step.stop',index:0},{event_type:'step.start',index:1,step:second?{type:'model_output'}:{type:'function_call',id:call.id,name:call.name,arguments:{}}},{event_type:'step.delta',index:1,delta:second?{type:'text',text:'OK'}:{type:'arguments_delta',arguments:'{"value":'}},...(!second?[{event_type:'step.delta',index:1,delta:{type:'arguments_delta',arguments:'1}'}}]:[]),{event_type:'step.stop',index:1},{event_type:'interaction.completed',interaction:{status:second?'completed':'requires_action',usage:{total_input_tokens:3,total_output_tokens:2}}}]);
  if(protocol==='ollama')return JSON.stringify({message:second?{role:'assistant',content:'OK'}:{role:'assistant',content:'',thinking:'private-continuation',tool_calls:[{function:{name:call.name,arguments:call.args}}]},done:true,prompt_eval_count:3,eval_count:2})+'\n';
  return sse([{choices:[{delta:second?{content:'OK'}:{reasoning_content:'private-continuation',tool_calls:[{index:0,id:call.id,function:{name:call.name,arguments:'{"value":'}}]},finish_reason:null}]},...(!second?[{choices:[{delta:{tool_calls:[{index:0,function:{arguments:'1}'}}]},finish_reason:null}]}]:[]),{choices:[{delta:{},finish_reason:second?'stop':'tool_calls'}],usage:{prompt_tokens:3,completion_tokens:2}}]);
}
async function fixture(handle:(req:http.IncomingMessage,res:http.ServerResponse)=>void|Promise<void>) {
  const server=http.createServer((req,res)=>{void handle(req,res);});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const baseUrl=`http://127.0.0.1:${(server.address() as {port:number}).port}/v1`;
  return {baseUrl,close:()=>new Promise<void>(r=>{server.close(()=>r());server.closeAllConnections();})};
}
const connection=(baseUrl:string):Provider=>({...ProviderInput.parse({name:'fixture',provider:'custom',protocol:'responses',baseUrl,allowPrivateNetwork:true}),id:'ai_fixture01'});
describe('provider protocol transport and secret boundaries',()=>{
  it.each(PRESETS)('$provider: fragmented stream, IDs, continuation and tool-result round trip',async preset=>{
    const bodies:Record<string,unknown>[]=[];let calls=0;
    const f=await fixture(async(req,res)=>{let raw='';for await(const b of req)raw+=String(b);bodies.push(JSON.parse(raw) as Record<string,unknown>);const body=reply(preset.protocol,calls++>0);res.setHeader('content-type',preset.protocol==='ollama'?'application/x-ndjson':'text/event-stream');res.write(body.slice(0,17));setTimeout(()=>res.end(body.slice(17)),5);});
    try {
      const c={...connection(f.baseUrl),protocol:preset.protocol,provider:preset.provider};
      const input={task:'call test_tool',instructions:'fixture',turns:[],tools:[{name:'test_tool',description:'fixture',parameters:{type:'object',properties:{value:{type:'integer'}},required:['value'],additionalProperties:false}}]};
      const first=await generate(c,profile,key,input,[],new AbortController().signal);
      expect(first.calls).toHaveLength(1);expect(first.calls[0]?.args).toEqual({value:1});expect(first.text).not.toContain('private');
      const second=await generate(c,profile,key,{...input,turns:[{reply:first,results:[{id:first.calls[0]!.id,name:'test_tool',content:'verified-result'}]}]},[],new AbortController().signal);
      expect(second.text).toBe('OK');expect(second.usage).toEqual({input:3,output:2});expect(second.calls).toEqual([]);
      expect(JSON.stringify(bodies[1])).toContain('verified-result');expect(JSON.stringify(bodies)).not.toContain(key);
      if(preset.protocol==='responses'||preset.protocol==='gemini')expect(bodies[0]?.store).toBe(false);
      if(preset.protocol==='gemini')expect(JSON.stringify(bodies[1])).toContain('opaque-gemini-signature');
    } finally {await f.close();}
  });
  it('refuses redirects without forwarding a credential and denies metadata/private/admin destinations',async()=>{
    let destinationCalls=0;const dest=await fixture((_q,r)=>{destinationCalls++;r.end('{}');});const src=await fixture((_q,r)=>{r.writeHead(307,{location:dest.baseUrl});r.end();});
    try {
      await expect(providerRequest(connection(src.baseUrl),'responses',key,{},[])).rejects.toMatchObject({code:'FORBIDDEN'});expect(destinationCalls).toBe(0);
      for(const baseUrl of ['http://169.254.169.254','http://100.100.100.200','http://[::ffff:169.254.169.254]'])await expect(providerRequest(connection(baseUrl),'responses',key,{},[])).rejects.toMatchObject({code:'FORBIDDEN'});
      await expect(providerRequest({...connection(dest.baseUrl),baseUrl:dest.baseUrl.replace('http:','https:'),allowPrivateNetwork:false},'responses',key,{},[])).rejects.toMatchObject({code:'FORBIDDEN'});
      await expect(providerRequest(connection(dest.baseUrl),'responses',key,{},[Number(new URL(dest.baseUrl).port)])).rejects.toMatchObject({code:'FORBIDDEN'});expect(destinationCalls).toBe(0);
      const lookup=vi.spyOn(dns,'lookup').mockResolvedValue([{address:'169.254.169.254',family:4}] as never);
      try {await expect(providerRequest({...connection('https://provider.invalid'),allowPrivateNetwork:true},'responses',key,{},[])).rejects.toMatchObject({code:'FORBIDDEN'});}finally{lookup.mockRestore();}
    } finally {await src.close();await dest.close();}
  });
  it('pins a reviewed DNS address using the Node all-address lookup contract',async()=>{
    const f=await fixture((_q,r)=>{r.setHeader('content-type','application/json');r.end(JSON.stringify({data:[{id:'fixture-model'}]}));});
    const port=new URL(f.baseUrl).port;
    const lookup=vi.spyOn(dns,'lookup').mockResolvedValue([{address:'127.0.0.1',family:4}] as never);
    try {
      const c=connection(`http://provider.fixture:${port}/v1`);
      const response=await providerRequest(c,'models',key,undefined,[]);
      expect(response.status).toBe(200);expect(JSON.parse(response.text)).toEqual({data:[{id:'fixture-model'}]});
    } finally {lookup.mockRestore();await f.close();}
  });
  it('does not leak a credential echoed across text deltas or in continuation',async()=>{
    const f=await fixture((_q,r)=>{r.end(sse([{type:'response.output_text.delta',delta:key.slice(0,13)},{type:'response.output_text.delta',delta:key.slice(13)},{type:'response.completed',response:{output:[{type:'message',content:[{type:'output_text',text:key}]}]}}]));});
    const chunks:string[]=[];
    try{await expect(generate(connection(f.baseUrl),profile,key,{task:'test',instructions:'test',turns:[],tools:[]},[],new AbortController().signal,t=>chunks.push(t))).rejects.toMatchObject({code:'FORBIDDEN'});expect(chunks.join('')).toBe('');}finally{await f.close();}
  });
  it('does not retry 429, malformed JSON, incomplete streams or canceled requests',async()=>{
    let calls=0;const f=await fixture((_q,r)=>{calls++;if(calls===1){r.writeHead(429);r.end(key);}else if(calls===2){r.end('data: {"type":');}else {r.write('data: ');}});
    const run=(signal:AbortSignal)=>generate(connection(f.baseUrl),profile,key,{task:'test',instructions:'test',turns:[],tools:[]},[],signal);
    try {
      await expect(run(new AbortController().signal)).rejects.toThrow('HTTP 429');expect(calls).toBe(1);
      await expect(run(new AbortController().signal)).rejects.toBeDefined();expect(calls).toBe(2);
      const abort=new AbortController();const pending=run(abort.signal);setTimeout(()=>abort.abort(),50);await expect(pending).rejects.toMatchObject({code:'CONFLICT'});expect(calls).toBe(3);
    }finally{await f.close();}
  });
});
