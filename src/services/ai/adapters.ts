import { DodoError } from '../../errors.js';
import { providerRequest } from './network.js';
import type { Provider, Profile, ModelInput, ModelReply, ToolCall } from './contracts.js';
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {};
const list = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const str = (v: unknown): string => typeof v === 'string' ? v : '';
const count = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
function args(v: unknown): Obj {
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { throw new DodoError('INVALID_INPUT', 'model returned invalid tool arguments'); } }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new DodoError('INVALID_INPUT', 'model tool arguments must be an object');
  return v as Obj;
}
export function requestBody(c: Provider, p: Profile, input: ModelInput): { suffix: string; body: Obj } {
  const tools = input.tools;
  const messages: unknown[] = [{ role: 'system', content: input.instructions }, { role: 'user', content: input.task }];
  for (const turn of input.turns) {
    messages.push(turn.reply.continuation);
    for (const r of turn.results) messages.push({ role: 'tool', ...(c.protocol === 'ollama' ? {tool_name:r.name} : {tool_call_id:r.id}), content: r.content });
  }
  if (c.protocol === 'responses') {
    const user = [{ type: 'input_text', text: input.task }, ...(input.images ?? []).map(i => ({ type: 'input_image', image_url: `data:${i.mimeType};base64,${i.data}` }))];
    const history: unknown[] = [{ role: 'user', content: user }];
    for (const t of input.turns) { history.push(...list(t.reply.continuation)); history.push(...t.results.map(r => ({ type: 'function_call_output', call_id: r.id, output: r.content }))); }
    return { suffix: 'responses', body: { model: p.model, instructions: input.instructions, input: history, store: false, include:['reasoning.encrypted_content'], stream: true, max_output_tokens: p.maxOutputTokens,
      tools: tools.map(t => ({ type: 'function', ...t, strict: false })) } };
  }
  if (c.protocol === 'anthropic') {
    const content = [{ type: 'text', text: input.task }, ...(input.images ?? []).map(i => ({ type: 'image', source: { type: 'base64', media_type: i.mimeType, data: i.data } }))];
    const history: unknown[] = [{ role: 'user', content }];
    for (const t of input.turns) { history.push({ role: 'assistant', content: t.reply.continuation }); if (t.results.length) history.push({ role: 'user', content: t.results.map(r => ({ type: 'tool_result', tool_use_id: r.id, content: r.content })) }); }
    return { suffix: 'messages', body: { model: p.model, system: input.instructions, messages: history, stream: true, max_tokens: p.maxOutputTokens,
      tools: tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters })) } };
  }
  if (c.protocol === 'gemini') {
    const history: unknown[] = [{ type: 'user_input', content: [{ type: 'text', text: input.task }, ...(input.images ?? []).map(i => ({ type: 'image', mime_type: i.mimeType, data: i.data }))] }];
    for (const t of input.turns) { history.push(...list(t.reply.continuation)); history.push(...t.results.map(r => ({ type: 'function_result', name: r.name, call_id: r.id, result: [{ type: 'text', text: r.content }] }))); }
    return { suffix: 'interactions', body: { model: p.model, system_instruction: input.instructions, input: history, store: false, stream: true,
      generation_config: { max_output_tokens: p.maxOutputTokens }, tools: tools.map(t => ({ type: 'function', ...t })) } };
  }
  if (input.images?.length) messages[1] = c.protocol === 'ollama'
    ? { role: 'user', content: input.task, images: input.images.map(i => i.data) }
    : { role: 'user', content: [{ type: 'text', text: input.task }, ...input.images.map(i => ({ type: 'image_url', image_url: { url: `data:${i.mimeType};base64,${i.data}` } }))] };
  const common = { model: p.model, messages, stream: true, tools: tools.map(t => ({ type: 'function', function: t })) };
  return c.protocol === 'ollama'
    ? { suffix: 'chat', body: { ...common, options: { num_predict: p.maxOutputTokens, num_ctx: p.maxInputTokens + p.maxOutputTokens } } }
    : { suffix: 'chat/completions', body: { ...common, max_tokens: p.maxOutputTokens, stream_options: { include_usage: true } } };
}
/** SSE/NDJSON reducer keeps private provider continuation blocks verbatim where required. */
export function decodeReply(c: Provider, text: string): ModelReply {
  let direct: Obj | undefined;
  try { direct = obj(JSON.parse(text)); } catch { /* streaming body */ }
  const events: Obj[] = direct ? [direct] : text.split(/\r?\n/).flatMap(line => {
    const value = line.startsWith('data:') ? line.slice(5).trim() : line.trim();
    if (!value || value === '[DONE]' || value.startsWith('event:') || value.startsWith(':')) return [];
    try { return [obj(JSON.parse(value))]; } catch { throw new DodoError('CONFLICT', 'incomplete provider stream; not replayed'); }
  });
  if (!events.length || events.some(e => e.type === 'error' || e.error)) throw new DodoError('CONFLICT', 'provider did not complete a valid response');
  let content = ''; let calls: ToolCall[] = []; let continuation: unknown; let usage: Obj = {};
  if (c.protocol === 'responses') {
    const final = direct?.output ? direct : obj(events.find(e => e.type === 'response.completed')?.response);
    if (!Array.isArray(final.output)) throw new DodoError('CONFLICT', 'Responses stream did not complete');
    continuation = final.output; usage = obj(final.usage);
    for (const item of final.output) { const i = obj(item); if (i.type === 'function_call') calls.push({ id: str(i.call_id), name: str(i.name), args: args(i.arguments) }); else if (i.type === 'message') content += list(i.content).map(x => str(obj(x).text)).join(''); }
  } else if (c.protocol === 'anthropic') {
    let blocks: Obj[] = list(direct?.content).map(obj); const fragments = new Map<number, string>();
    if (!direct) {
      if (!events.some(e => e.type === 'message_stop')) throw new DodoError('CONFLICT', 'Messages stream did not complete');
      blocks = [];
      for (const e of events) {
        if (e.type === 'message_start') usage = obj(obj(e.message).usage);
        if (e.type === 'content_block_start') blocks[Number(e.index)] = obj(e.content_block);
        if (e.type === 'content_block_delta') {
          const index = Number(e.index), d = obj(e.delta), b = blocks[index]; if (!b) throw new DodoError('INVALID_INPUT', 'invalid content block order');
          if (d.type === 'input_json_delta') fragments.set(index, (fragments.get(index) ?? '') + str(d.partial_json));
          else for (const k of ['text', 'thinking', 'signature']) if (typeof d[k] === 'string') b[k] = str(b[k]) + str(d[k]);
        }
        if (e.type === 'message_delta') usage = { ...usage, ...obj(e.usage) };
      }
      for (const [i, value] of fragments) blocks[i]!.input = args(value);
    } else usage = obj(direct.usage);
    continuation = blocks;
    for (const b of blocks) if (b.type === 'text') content += str(b.text); else if (b.type === 'tool_use') calls.push({ id: str(b.id), name: str(b.name), args: args(b.input) });
  } else if (c.protocol === 'gemini') {
    const final = direct?.steps ? direct : obj(events.findLast(e => e.event_type === 'interaction.completed')?.interaction);
    let steps: Obj[] = list(final.steps).map(obj);
    if (!direct) {
      if (!['completed','requires_action'].includes(str(final.status))) throw new DodoError('CONFLICT', 'Gemini stream did not complete');
      const opened = new Map<number, Obj>(), stopped = new Set<number>(), fragments = new Map<number,string>();
      for (const e of events) {
        if (!['step.start','step.delta','step.stop'].includes(str(e.event_type))) continue;
        const i = Number(e.index);
        if (!Number.isSafeInteger(i) || i < 0 || i > 127) throw new DodoError('INVALID_INPUT', 'invalid Gemini step index');
        if (e.event_type === 'step.start') {
          if (opened.has(i)) throw new DodoError('INVALID_INPUT', 'duplicate Gemini step');
          opened.set(i, {...obj(e.step)}); continue;
        }
        const step = opened.get(i);
        if (!step || stopped.has(i)) throw new DodoError('INVALID_INPUT', 'invalid Gemini step order');
        if (e.event_type === 'step.stop') { stopped.add(i); continue; }
        const d = obj(e.delta);
        if (step.type === 'function_call' && d.type === 'arguments_delta') fragments.set(i,(fragments.get(i) ?? '') + str(d.arguments));
        else if (step.type === 'thought' && d.type === 'thought_signature') step.signature = str(step.signature) + str(d.signature);
        else if (step.type === 'thought' && d.type === 'thought_summary') step.summary = [...list(step.summary),d.content];
        else if (step.type === 'model_output' && ['text','image','audio'].includes(str(d.type))) {
          const parts = list(step.content).map(obj), previous = parts.at(-1);
          if (d.type === 'text' && previous?.type === 'text') previous.text = str(previous.text) + str(d.text);
          else parts.push(d);
          step.content = parts;
        } else throw new DodoError('NOT_SUPPORTED', 'unsupported Gemini continuation delta; no tools executed');
      }
      if (opened.size !== stopped.size) throw new DodoError('CONFLICT', 'Gemini stream has unfinished steps');
      for (const [i,fragment] of fragments) opened.get(i)!.arguments = args(fragment);
      steps = [...opened.entries()].sort(([a],[b])=>a-b).map(([,step])=>step);
    }
    if (!steps.length) throw new DodoError('CONFLICT', 'Gemini stream did not supply completed steps');
    continuation = steps; usage = obj(final.usage);
    for (const item of steps) { const s = obj(item); if (s.type === 'function_call') calls.push({ id: str(s.id), name: str(s.name), args: args(s.arguments) }); else if (s.type === 'model_output') content += list(s.content).map(v => str(obj(v).text)).join(''); }
  } else {
    const assistant: Obj = { role: 'assistant', content: '' }; const pending = new Map<number, { id: string; name: string; args: string | Obj }>();
    let complete = false;
    for (const event of events) {
      const choice = obj(list(event.choices)[0]);
      const delta = c.protocol === 'ollama' ? obj(event.message) : obj(choice.message ?? choice.delta);
      content += str(delta.content);
      if (typeof delta.reasoning_content === 'string') assistant.reasoning_content = str(assistant.reasoning_content) + delta.reasoning_content;
      if (typeof delta.thinking === 'string') assistant.thinking = str(assistant.thinking) + delta.thinking;
      for (const [index, raw] of list(delta.tool_calls).entries()) {
        const call = obj(raw), fn = obj(call.function), i = typeof call.index === 'number' ? call.index : index;
        const value = pending.get(i) ?? { id: str(call.id) || `call_${i}`, name: '', args: '' };
        if (call.id) value.id = str(call.id);
        value.name += str(fn.name);
        value.args = typeof fn.arguments === 'string' ? str(value.args) + fn.arguments : fn.arguments === undefined ? value.args : obj(fn.arguments);
        pending.set(i, value);
      }
      if (event.done === true || choice.finish_reason) complete = true;
      if (event.usage) usage = obj(event.usage);
      if (c.protocol === 'ollama' && event.done) usage = { input_tokens: event.prompt_eval_count, output_tokens: event.eval_count };
    }
    if (!complete) throw new DodoError('CONFLICT', 'chat stream did not complete');
    calls = [...pending.values()].map(v => ({ id: v.id, name: v.name, args: args(v.args || '{}') }));
    assistant.content = content;
    if (calls.length) assistant.tool_calls = calls.map(v => ({ ...(c.protocol === 'ollama' ? {} : {id:v.id,type:'function'}), function: { name: v.name, arguments: c.protocol === 'ollama' ? v.args : JSON.stringify(v.args) } }));
    continuation = assistant;
  }
  if (calls.length > 16 || calls.some(c => !c.id || !c.name) || new Set(calls.map(c => c.id)).size !== calls.length) throw new DodoError('INVALID_INPUT', 'invalid or duplicate model tool call IDs');
  return { text: content, calls, continuation, usage: {
    input: count(usage.input_tokens ?? usage.prompt_tokens ?? usage.total_input_tokens), output: count(usage.output_tokens ?? usage.completion_tokens ?? usage.total_output_tokens),
  } };
}
export async function generate(c: Provider, p: Profile, key: string, input: ModelInput, ports: number[], signal: AbortSignal, onText?: (text: string) => void, onDispatch?: () => void): Promise<ModelReply> {
  if (!key && !['custom','ollama'].includes(c.provider)) throw new DodoError('AUTH_REQUIRED','enter provider credentials before inference',{detail:{outcome:'not_started'}});
  if (input.images?.length && !p.imageInput) throw new DodoError('NOT_SUPPORTED', 'this profile does not allow image input');
  const request = requestBody(c, p, input);
  // Conservative UTF-8 byte bound, also safe for tokenizers without a local implementation.
  if (Buffer.byteLength(JSON.stringify(request.body, (name, value: unknown) => name === 'images' && Array.isArray(value) ? value.map(() => '[image]') : value).replace(/data:[^;]+;base64,[A-Za-z0-9+/=]+/g, '[image]').replace(/"data":"[A-Za-z0-9+/=]{100,}"/g, '"data":"[image]"')) + (input.images?.length ?? 0) * 2048 > p.maxInputTokens) throw new DodoError('RESOURCE_LIMIT', 'model input budget exhausted; start a new task with a smaller context');
  let held = '', unsafe = false;
  const publish = (chunk: string, flush = false) => {
    held += chunk;
    if (key && held.includes(key)) { unsafe = true; return; }
    const n = flush ? held.length : Math.max(0, held.length - Math.max(key.length, 64));
    if (!unsafe && n) { onText?.(held.slice(0,n)); held = held.slice(n); }
  };
  const response = await providerRequest(c, request.suffix, key, request.body, ports, signal, line => {
    try {
      const e = obj(JSON.parse(line.replace(/^data:\s*/, ''))); const delta = obj(e.delta);
      const token = e.type === 'response.output_text.delta' ? str(e.delta) : delta.type === 'text_delta' || (e.event_type === 'step.delta' && delta.type === 'text') ? str(delta.text) : str(obj(obj(list(e.choices)[0]).delta).content) || str(obj(e.message).content);
      if (token) publish(token);
    } catch { /* final decoder validates the complete stream */ }
  }, onDispatch);
  if (response.status >= 400) throw new DodoError(response.status === 401 || response.status === 403 ? 'AUTH_REQUIRED' : 'NOT_SUPPORTED', `provider returned HTTP ${response.status}; response body hidden, request not retried`,{detail:{outcome:response.status===401||response.status===403||response.status===429?'rejected':'uncertain'}});
  const reply = decodeReply(c, response.text);
  if (unsafe || (key && JSON.stringify(reply).includes(key))) throw new DodoError('FORBIDDEN', 'provider response contained a credential; result discarded');
  publish('', true);
  return reply;
}
