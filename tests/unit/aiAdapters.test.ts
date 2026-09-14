import { describe,it,expect } from 'vitest';
import { decodeReply,requestBody } from '../../src/services/ai/adapters.js';
import { ProfileInput,ProviderInput,PRESETS } from '../../src/services/ai/contracts.js';
import { validateEndpoint } from '../../src/services/ai/network.js';
import { MutationQueue } from '../../src/security/mutationQueue.js';
const provider=(protocol:'responses'|'chat-completions'|'anthropic'|'gemini'|'ollama')=>({...ProviderInput.parse({name:'fixture',provider:'custom',protocol,baseUrl:'https://example.com/v1'}),id:'ai_fixture01'});
const profile={...ProfileInput.parse({name:'Test',connectionId:'ai_fixture01',model:'model'}),id:'profile_fixture01'};
describe('AI protocol and concurrency contracts',()=>{
  it('has all seven presets, explicit protocols and stateless model bodies',()=>{
    expect(PRESETS.map(p=>p.provider)).toEqual(['openai','gemini','claude','minimax','glm','kimi','ollama']);
    for(const protocol of ['responses','gemini'] as const)expect(requestBody(provider(protocol),profile,{task:'test',instructions:'test',turns:[],tools:[]}).body.store).toBe(false);
  });
  it('preserves Anthropic opaque thinking/signatures and assembles split tool JSON',()=>{
    const events=[{type:'message_start',message:{usage:{input_tokens:1}}},{type:'content_block_start',index:0,content_block:{type:'thinking',thinking:'',signature:''}},{type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:'private'}},{type:'content_block_delta',index:0,delta:{type:'signature_delta',signature:'opaque'}},{type:'content_block_start',index:1,content_block:{type:'tool_use',id:'c1',name:'read_files',input:{}}},{type:'content_block_delta',index:1,delta:{type:'input_json_delta',partial_json:'{"files":'}},{type:'content_block_delta',index:1,delta:{type:'input_json_delta',partial_json:'[]}'}},{type:'message_delta',usage:{output_tokens:3}},{type:'message_stop'}];
    const reply=decodeReply(provider('anthropic'),events.map(e=>`data: ${JSON.stringify(e)}\n\n`).join(''));
    expect(reply.text).toBe('');expect(reply.calls[0]?.args).toEqual({files:[]});expect(reply.continuation).toContainEqual({type:'thinking',thinking:'private',signature:'opaque'});
  });
  it('handles Kimi/GLM-style reasoning continuation, Ollama tools and Gemini steps',()=>{
    const reply=decodeReply(provider('chat-completions'),JSON.stringify({choices:[{message:{content:'hello',reasoning_content:'opaque',tool_calls:[{id:'c1',function:{name:'read_files',arguments:'{"files":[]}'}}]},finish_reason:'tool_calls'}],usage:{prompt_tokens:5,completion_tokens:3}}));
    expect(reply.calls[0]?.name).toBe('read_files');expect(reply.continuation).toMatchObject({reasoning_content:'opaque'});
    const ollama=decodeReply(provider('ollama'),JSON.stringify({message:{content:'done',tool_calls:[{function:{name:'read_files',arguments:{files:[]}}}]},done:true,prompt_eval_count:4,eval_count:2}));expect(ollama.usage.input).toBe(4);
    const gemini=decodeReply(provider('gemini'),JSON.stringify({steps:[{type:'thought',text:'opaque'},{type:'function_call',id:'c1',name:'read_files',arguments:{files:[]}}],usage:{total_input_tokens:4,total_output_tokens:2}}));expect(gemini.calls[0]?.args).toEqual({files:[]});expect(gemini.text).toBe('');
  });
  it('rejects incomplete streams, malformed tool JSON, redirects and admin endpoints',()=>{
    expect(()=>decodeReply(provider('responses'),'data: {"type":"response.output_text.delta","delta":"partial"}\n')).toThrow();
    expect(()=>decodeReply(provider('chat-completions'),JSON.stringify({choices:[{message:{tool_calls:[{id:'x',function:{name:'read_files',arguments:'{'}}]},finish_reason:'tool_calls'}]}))).toThrow();
    expect(()=>validateEndpoint({...provider('responses'),baseUrl:'http://127.0.0.1:21731/api',allowPrivateNetwork:true},[21731])).toThrow();
    expect(()=>validateEndpoint({...provider('responses'),baseUrl:'https://secret@example.com'},[])).toThrow();
    for(const suffix of ['models','responses','messages','chat/completions'])expect(()=>validateEndpoint({...provider('responses'),baseUrl:`https://example.com/v1/${suffix}`},[])).toThrow(/API base/);
  });
  it('serializes mutations across nested calls and retains background job ownership',async()=>{
    const q=new MutationQueue(),order:string[]=[];let release:()=>void=()=>undefined;
    await q.run(async()=>{order.push('a');release=q.retainJob();await q.run(async()=>{order.push('nested');});});
    const b=q.run(async()=>{order.push('b');});const c=q.run(async()=>{order.push('c');});expect(order).toEqual(['a','nested']);expect(q.pending).toBe(2);release();await Promise.all([b,c]);expect(order).toEqual(['a','nested','b','c']);expect(q.busy).toBe(false);
  });
});
