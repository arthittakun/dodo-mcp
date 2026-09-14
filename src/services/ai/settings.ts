import type { Store } from '../../store/store.js';
import { digestOf, newId } from '../../util/hash.js';
import { DodoError } from '../../errors.js';
import { AICredentials } from './credentials.js';
import { AILimits, PRESETS, ProviderInput, ProfileInput, ProjectAIInput, type Provider, type Profile, type ProjectAI } from './contracts.js';
import { validateEndpoint, providerRequest } from './network.js';
import { generate } from './adapters.js';
export class AISettings {
  readonly credentials = new AICredentials();
  private readonly users = new Map<string, number>();
  private readonly editing = new Set<string>();
  lease(id: string): () => void {
    if (this.editing.has(id)) throw new DodoError('CONFLICT', 'provider credentials are being changed');
    this.users.set(id,(this.users.get(id) ?? 0)+1);
    let released = false;
    return () => { if (!released) { released = true; this.users.set(id,(this.users.get(id) ?? 1)-1); } };
  }
  private edit(id: string): () => void {
    if (this.editing.has(id) || this.users.get(id)) throw new DodoError('CONFLICT', 'provider is in use; pause or finish its runs before changing credentials');
    this.editing.add(id); return () => { this.editing.delete(id); };
  }
  constructor(readonly store: Store, readonly ports: number[]) {}
  list<T>(kind: string): T[] { return (this.store.db.prepare('SELECT payload FROM ai_settings WHERE kind=? ORDER BY id LIMIT 1000').all(kind) as Array<{ payload: string }>).map(r => JSON.parse(r.payload) as T); }
  get<T>(kind: string, id: string): T | undefined { const r = this.store.db.prepare('SELECT payload FROM ai_settings WHERE kind=? AND id=?').get(kind, id) as { payload: string } | undefined; return r ? JSON.parse(r.payload) as T : undefined; }
  put(kind: string, id: string, payload: unknown): void { this.store.db.prepare('INSERT INTO ai_settings VALUES (?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at').run(kind, id, JSON.stringify(payload), Date.now()); }
  limits() { return AILimits.parse(this.get('settings','limits') ?? {}); }
  saveLimits(raw: unknown) { const value = AILimits.parse(raw); this.put('settings','limits',value); return value; }
  state() { return { presets: PRESETS, connections: this.list<Provider>('connection').map(c => ({ ...c, credentialPresent: c.credentialStorage === 'session' ? this.credentials.hasSession(c.id) : this.get('credential', c.id) === true })), metadata: this.list('metadata'), probes: this.list('probe'), profiles: this.list<Profile>('profile'), permissions: this.list<ProjectAI>('project'), limits: this.limits() }; }
  async saveConnection(raw: unknown, key?: string): Promise<Provider> {
    const input = ProviderInput.parse(raw); const c = { ...input, id: input.id ?? newId('ai') };
    const done = this.edit(c.id);
    try {
    validateEndpoint(c, this.ports);
    const previous = this.get<Provider>('connection', c.id);
    if (previous && (previous.baseUrl !== c.baseUrl || previous.protocol !== c.protocol || previous.credentialStorage !== c.credentialStorage) && !key) throw new DodoError('INVALID_INPUT', 'endpoint/protocol/storage change requires entering credentials again; old keys are never forwarded');
    if (key) { await this.credentials.set(c.id, c.credentialStorage, key); this.put('credential', c.id, true); }
    if (previous && key && previous.credentialStorage !== c.credentialStorage && this.get('credential',c.id)) await this.credentials.delete(c.id, previous.credentialStorage);
    this.put('connection', c.id, c); return c;
    } finally { done(); }
  }
  saveProfile(raw: unknown): Profile { const v = ProfileInput.parse(raw); if (!this.get('connection', v.connectionId)) throw new DodoError('NOT_FOUND', 'unknown provider connection'); const p = { ...v, id: v.id ?? newId('profile') }; this.put('profile', p.id, p); return p; }
  savePermission(raw: unknown): ProjectAI { const p = ProjectAIInput.parse(raw); for (const id of p.profileIds) if (!this.get('profile', id)) throw new DodoError('NOT_FOUND', 'unknown profile'); this.put('project', p.projectId, p); return p; }
  async remove(kind: 'connection' | 'profile', id: string): Promise<void> {
    const done = kind === 'connection' ? this.edit(id) : () => undefined;
    try {
    if (kind === 'connection') {
      if (this.list<Profile>('profile').some(p => p.connectionId === id)) throw new DodoError('CONFLICT', 'remove profiles using this connection first');
      const c = this.get<Provider>('connection', id);
      if (c && this.get('credential', id)) await this.credentials.delete(id, c.credentialStorage);
    }
    this.store.db.prepare('DELETE FROM ai_settings WHERE kind=? AND id=?').run(kind, id);
    if (kind === 'connection') this.store.db.prepare("DELETE FROM ai_settings WHERE kind='credential' AND id=?").run(id);
    } finally { done(); }
  }
  connection(id: string): Provider { const c = this.get<Provider>('connection', id); if (!c?.enabled) throw new DodoError('NOT_SUPPORTED', 'provider connection is missing or disabled'); return c; }
  async models(id: string) {
    const release = this.lease(id);
    try {
    const c = this.connection(id); const key = await this.credentials.get(c.id, c.credentialStorage);
    const response = await providerRequest(c, c.protocol === 'ollama' ? 'tags' : 'models', key, undefined, this.ports);
    if ((response.status === 401 || response.status === 403) && !key) throw new DodoError('AUTH_REQUIRED', `model listing returned HTTP ${response.status}; edit the connection and enter its API key`);
    if (response.status >= 400) throw new DodoError('NOT_SUPPORTED', `model listing returned HTTP ${response.status}; enter a model ID manually`);
    if (key && response.text.includes(key)) throw new DodoError('FORBIDDEN', 'provider echoed credentials; response discarded');
    let parsed: { data?: unknown[]; models?: unknown[] };
    try { parsed = JSON.parse(response.text) as typeof parsed; } catch { throw new DodoError('NOT_SUPPORTED', 'model listing returned an unsupported response'); }
    if (key && JSON.stringify(parsed).includes(key)) throw new DodoError('FORBIDDEN','provider echoed credentials; response discarded');
    return (parsed.data ?? parsed.models ?? []).slice(0, 200).map(v => { const m = v as { id?: string; name?: string; model?: string }; return { id: String(m.id ?? m.name ?? m.model ?? '').slice(0, 200) }; });
    } finally { release(); }
  }
  async inspectModel(profileId: string) {
    const p = this.get<Profile>('profile',profileId); if (!p) throw new DodoError('NOT_FOUND','unknown profile');
    const release = this.lease(p.connectionId);
    try {
      const c = this.connection(p.connectionId), key = await this.credentials.get(c.id,c.credentialStorage);
      if (c.protocol !== 'ollama') throw new DodoError('NOT_SUPPORTED','metadata inspection is available for Ollama; use model listing and explicit inference/tool tests for this protocol');
      const response = await providerRequest(c,'show',key,{model:p.model,verbose:false},this.ports);
      if (response.status >= 400 || (key && response.text.includes(key))) throw new DodoError('NOT_SUPPORTED','model metadata unavailable');
      let m: {remote_host?:unknown;remote_model?:unknown;details?:{format?:string};model_info?:Record<string,unknown>;capabilities?:unknown[]};
      try { m = JSON.parse(response.text) as typeof m; } catch { throw new DodoError('NOT_SUPPORTED','invalid model metadata'); }
      const host = new URL(c.baseUrl).hostname;
      const local = ['127.0.0.1','localhost','[::1]'].includes(host) && !m.remote_host && !m.remote_model && !/-cloud(?::|$)/i.test(p.model) && m.details?.format === 'gguf' && Number(m.model_info?.['general.parameter_count']) > 0;
      const result = {profileId,model:p.model,location:local?'local':'remote-or-unknown',capabilities:(m.capabilities ?? []).filter(v=>typeof v==='string').slice(0,30),checkedAt:Date.now(),configuration:digestOf({profile:p,connection:c}),liveInferenceTested:false};
      this.put('metadata',p.id,result); return result;
    } finally { release(); }
  }
  localVerified(p: Profile, c: Provider): boolean {
    const m = this.get<{location:string;configuration:string;checkedAt:number}>('metadata',p.id);
    return p.inferenceLocation === 'local' && m?.location === 'local' && m.configuration === digestOf({profile:p,connection:c}) && m.checkedAt > Date.now()-300000;
  }
  async probe(profileId: string, mode: 'inference' | 'tools') {
    const p = this.get<Profile>('profile', profileId); if (!p) throw new DodoError('NOT_FOUND', 'unknown profile');
    const release = this.lease(p.connectionId);
    try {
    const c = this.connection(p.connectionId); const key = await this.credentials.get(c.id, c.credentialStorage);
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 60000);
    try {
      const first = await generate(c, { ...p, maxOutputTokens: 256 }, key, { task: mode === 'tools' ? 'Call dodo_probe once with value 1, then report its returned value.' : 'Reply with OK.', instructions: 'This is a synthetic connection test. No project data is supplied.', turns: [], tools: mode === 'tools' ? [{ name: 'dodo_probe', description: 'Returns the number 1.', parameters: { type: 'object', properties: { value: { type: 'integer', const: 1 } }, required: ['value'], additionalProperties: false } }] : [] }, this.ports, controller.signal);
      if (mode === 'tools') {
        if (first.calls.length !== 1 || first.calls[0]?.name !== 'dodo_probe' || first.calls[0].args.value !== 1) throw new DodoError('NOT_SUPPORTED', 'model did not complete the synthetic tool call');
        const second = await generate(c, { ...p, maxOutputTokens: 256 }, key, { task: 'Call dodo_probe once with value 1, then report its returned value.', instructions: 'Report the tool result.', tools: [], turns: [{ reply: first, results: [{ id: first.calls[0].id, name: 'dodo_probe', content: '1' }] }] }, this.ports, controller.signal);
        if (second.calls.length || !second.text) throw new DodoError('NOT_SUPPORTED', 'tool result continuation failed');
      }
      const result = { profileId, mode, passed: true, checkedAt: Date.now(), connection: c.id, model: p.model, configuration:digestOf({profile:p,connection:c}) };
      this.put('probe', `${profileId}:${mode}`, result); return result;
    } finally { clearTimeout(timeout); }
    } finally { release(); }
  }
}
