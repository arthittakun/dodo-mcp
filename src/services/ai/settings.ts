import type { Store } from '../../store/store.js';
import path from 'node:path';
import fs from 'node:fs';
import { digestOf, newId, sha256Bytes } from '../../util/hash.js';
import { DodoError } from '../../errors.js';
import { AICredentials, type CredentialStorage } from './credentials.js';
import { defaultEnvVariable, validateEnvVariable } from './envCredentials.js';
import { AILimits, PRESETS, ProviderInput, ProfileInput, ProjectAIInput, type Provider, type Profile, type ProjectAI } from './contracts.js';
import { validateEndpoint, providerRequest, waitForProvider } from './network.js';
import { generate } from './adapters.js';
import { CREATIVE_IMAGE_PRESETS, CREATIVE_MEDIA_DEFAULTS, CreativeSettingsInput, isCreativeConnection, supportsCreativeVideoConnection, type CreativeSettings } from '../multimodal/creativeSettings.js';
export class AISettings {
  readonly credentials: AICredentials;
  private readonly persistentEnvAvailable: boolean;
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
  constructor(readonly store: Store, readonly ports: number[]) {
    this.persistentEnvAvailable = store.db.name !== ':memory:' && store.db.name.length > 0;
    this.credentials = new AICredentials(this.persistentEnvAvailable ? path.join(fs.realpathSync.native(path.dirname(path.resolve(store.db.name))), 'credentials', 'ai') : undefined);
  }
  list<T>(kind: string): T[] { return (this.store.db.prepare('SELECT payload FROM ai_settings WHERE kind=? ORDER BY id LIMIT 1000').all(kind) as Array<{ payload: string }>).map(r => JSON.parse(r.payload) as T); }
  get<T>(kind: string, id: string): T | undefined { const r = this.store.db.prepare('SELECT payload FROM ai_settings WHERE kind=? AND id=?').get(kind, id) as { payload: string } | undefined; return r ? JSON.parse(r.payload) as T : undefined; }
  put(kind: string, id: string, payload: unknown): void { this.store.db.prepare('INSERT INTO ai_settings VALUES (?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at').run(kind, id, JSON.stringify(payload), Date.now()); }
  private credentialUpdatePending(id: string): boolean { return this.store.db.prepare("SELECT 1 FROM ai_settings WHERE kind='credential-update' AND id=?").get(id) !== undefined; }
  private credentialConfiguration(c: Provider): string { return digestOf({ id: c.id, baseUrl: c.baseUrl, protocol: c.protocol, storage: c.credentialStorage, envVar: c.credentialEnvVar ?? null }); }
  private credentialReentryRequired(): DodoError { return new DodoError('AUTH_REQUIRED', 'provider credentials need to be entered again before this connection can be used', { recovery: 'Edit the connection, confirm its settings and enter its API key again' }); }
  limits() { return AILimits.parse(this.get('settings','limits') ?? {}); }
  saveLimits(raw: unknown) { const value = AILimits.parse(raw); this.put('settings','limits',value); return value; }
  media(): CreativeSettings {
    const value = CreativeSettingsInput.parse(this.get('settings', 'creative-media') ?? {});
    return { ...value, enabled: Boolean(value.connectionId), allowImageUpload: true, projectIds: [] };
  }
  saveMedia(raw: unknown): CreativeSettings {
    const value = CreativeSettingsInput.parse(raw);
    if (value.enabled || value.connectionId || value.videoEnabled) {
      const connection = value.connectionId ? this.get<Provider>('connection', value.connectionId) : undefined;
      if (!connection || !isCreativeConnection(connection)) throw new DodoError('INVALID_INPUT', 'select an enabled image connection using OpenAI-compatible Images or Gemini Interactions');
      if (value.videoEnabled && !supportsCreativeVideoConnection(connection)) throw new DodoError('NOT_SUPPORTED', 'compatibility video requires an OpenAI-compatible video protocol; the official OpenAI Videos API is retired');
    }
    const normalized = { ...value, enabled: Boolean(value.connectionId), allowImageUpload: true, projectIds: [] };
    this.put('settings', 'creative-media', normalized); return normalized;
  }
  state() {
    const connections = this.list<Provider>('connection').map(c => {
      const binding = this.get<{ fingerprint: string }>('credential-binding', c.id);
      const present = c.credentialStorage === 'session' ? this.credentials.hasSession(c.id)
        : c.credentialStorage === 'env' ? Boolean(binding && this.credentials.hasEnv(c.id, c.credentialEnvVar, binding.fingerprint))
          : process.platform === 'darwin' && this.get('credential', c.id) === true;
      const credentialNeedsReentry = this.credentialUpdatePending(c.id) || (c.credentialStorage === 'env' && !present);
      return { ...c, credentialPresent: !credentialNeedsReentry && present, credentialNeedsReentry };
    });
    return { presets: PRESETS, connections, credentialStorageOptions: [{ id: 'session', available: true }, { id: 'env', available: this.persistentEnvAvailable }, { id: 'keychain', available: process.platform === 'darwin' }], metadata: this.list('metadata'), probes: this.list('probe'), profiles: this.list<Profile>('profile'), permissions: this.list<ProjectAI>('project'), limits: this.limits(), media: this.media(), mediaDefaults: CREATIVE_MEDIA_DEFAULTS, mediaPresets: CREATIVE_IMAGE_PRESETS };
  }
  async saveConnection(raw: unknown, key?: string): Promise<Provider> {
    const input = ProviderInput.parse(raw); const { credentialEnvVar, ...fields } = input;
    const id = input.id ?? newId('ai');
    const c: Provider = { ...fields, id, ...(input.credentialStorage === 'env' ? { credentialEnvVar: validateEnvVariable(credentialEnvVar ?? defaultEnvVariable(id)) } : {}) };
    const done = this.edit(c.id);
    let credentialUpdating = false;
    try {
    validateEndpoint(c, this.ports);
    const media = this.media();
    if (media.enabled && media.connectionId === c.id && !isCreativeConnection(c)) throw new DodoError('CONFLICT', 'disable creative media or select another connection before disabling/changing this provider protocol');
    if (media.videoEnabled && media.connectionId === c.id && !supportsCreativeVideoConnection(c)) throw new DodoError('CONFLICT', 'disable compatibility video before changing to a connection without video support');
    const previous = this.get<Provider>('connection', c.id);
    if (this.credentialUpdatePending(c.id) && !key) throw this.credentialReentryRequired();
    if (previous && (previous.baseUrl !== c.baseUrl || previous.protocol !== c.protocol || previous.credentialStorage !== c.credentialStorage || previous.credentialEnvVar !== c.credentialEnvVar) && !key) throw new DodoError('INVALID_INPUT', 'endpoint/protocol/storage/Env reference change requires entering credentials again; old keys are never forwarded');
    let confirmedKey: string | undefined;
    if (!key && c.credentialStorage === 'env' && c.enabled) {
      confirmedKey = await this.credentials.get(c.id, c.credentialStorage, c.credentialEnvVar);
      if (!confirmedKey) throw new DodoError('AUTH_REQUIRED', 'enter an API key to save permanently, or name an existing server environment variable');
    }
    if (key) {
      // Commit the quarantine before touching an external credential store. A crash
      // or later metadata failure must never pair the new key with the old URL.
      this.put('credential-update', c.id, { storage: c.credentialStorage, ...(c.credentialEnvVar ? { envVar: c.credentialEnvVar } : {}) });
      credentialUpdating = true;
      await this.credentials.set(c.id, c.credentialStorage, key, c.credentialEnvVar); confirmedKey = key;
    }
    this.store.db.transaction(() => {
      this.put('connection', c.id, c);
      if (confirmedKey !== undefined) {
        this.put('credential', c.id, true);
        this.put('credential-binding', c.id, { fingerprint: sha256Bytes(confirmedKey), configuration: this.credentialConfiguration(c) });
      }
    }).immediate();
    if (previous && key && previous.credentialStorage !== c.credentialStorage && this.get('credential',c.id)) await this.credentials.delete(c.id, previous.credentialStorage, previous.credentialEnvVar);
    if (credentialUpdating) this.store.db.prepare("DELETE FROM ai_settings WHERE kind='credential-update' AND id=?").run(c.id);
    return c;
    } catch (error) { if (credentialUpdating) throw this.credentialReentryRequired(); throw error; }
    finally { done(); }
  }
  saveProfile(raw: unknown): Profile { const v = ProfileInput.parse(raw); if (!this.get('connection', v.connectionId)) throw new DodoError('NOT_FOUND', 'unknown provider connection'); const p = { ...v, id: v.id ?? newId('profile') }; this.put('profile', p.id, p); return p; }
  savePermission(raw: unknown): ProjectAI { const p = ProjectAIInput.parse(raw); for (const id of p.profileIds) if (!this.get('profile', id)) throw new DodoError('NOT_FOUND', 'unknown profile'); this.put('project', p.projectId, p); return p; }
  async remove(kind: 'connection' | 'profile', id: string): Promise<void> {
    const done = kind === 'connection' ? this.edit(id) : () => undefined;
    try {
    if (kind === 'connection') {
      if (this.media().connectionId === id) throw new DodoError('CONFLICT', 'clear or change the creative media connection before removing it');
      if (this.list<Profile>('profile').some(p => p.connectionId === id)) throw new DodoError('CONFLICT', 'remove profiles using this connection first');
      const c = this.get<Provider>('connection', id);
      const pending = this.get<{ storage?: CredentialStorage; envVar?: string }>('credential-update', id);
      if (c?.credentialStorage === 'env' || pending?.storage === 'env') await this.credentials.deleteOwnedEnv(id);
      if (c && c.credentialStorage !== 'env' && this.get('credential', id)) await this.credentials.delete(id, c.credentialStorage, c.credentialEnvVar);
      if (pending?.storage && pending.storage !== 'env' && (!c || pending.storage !== c.credentialStorage)) await this.credentials.delete(id, pending.storage, pending.envVar);
    }
    this.store.db.transaction(() => {
      this.store.db.prepare('DELETE FROM ai_settings WHERE kind=? AND id=?').run(kind, id);
      if (kind === 'connection') {
        this.store.db.prepare("DELETE FROM ai_settings WHERE kind='credential' AND id=?").run(id);
        this.store.db.prepare("DELETE FROM ai_settings WHERE kind='credential-update' AND id=?").run(id);
        this.store.db.prepare("DELETE FROM ai_settings WHERE kind='credential-binding' AND id=?").run(id);
      }
    }).immediate();
    } finally { done(); }
  }
  connection(id: string): Provider { if (this.credentialUpdatePending(id)) throw this.credentialReentryRequired(); const c = this.get<Provider>('connection', id); if (!c?.enabled) throw new DodoError('NOT_SUPPORTED', 'provider connection is missing or disabled'); return c; }
  assertCredential(connection: Provider, key: string): void {
    if (digestOf(this.connection(connection.id)) !== digestOf(connection)) throw this.credentialReentryRequired();
    const binding = this.get<{ fingerprint: string; configuration: string }>('credential-binding', connection.id);
    if (connection.credentialStorage === 'env' && !binding) throw this.credentialReentryRequired();
    if (binding && (binding.fingerprint !== sha256Bytes(key) || binding.configuration !== this.credentialConfiguration(connection))) throw this.credentialReentryRequired();
  }
  async credential(connection: Provider): Promise<string> {
    const key = await this.credentials.get(connection.id, connection.credentialStorage, connection.credentialEnvVar);
    this.assertCredential(connection, key); return key;
  }
  async models(id: string, options: { signal?: AbortSignal | undefined; beforeSend?: (() => void) | undefined } = {}) {
    const release = this.lease(id);
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
    // An absolute metadata deadline includes credential lookup, DNS and a response
    // that keeps sending bytes; socket inactivity timeouts alone cannot bound it.
    const timeout = setTimeout(() => controller.abort(), 15000); timeout.unref();
    try {
    const c = this.connection(id); const key = await waitForProvider(this.credential(c), signal);
    const response = await providerRequest(c, c.protocol === 'ollama' ? 'tags' : 'models', key, undefined, this.ports, signal, undefined, () => { this.assertCredential(c, key); options.beforeSend?.(); });
    if ((response.status === 401 || response.status === 403) && !key) throw new DodoError('AUTH_REQUIRED', `model listing returned HTTP ${response.status}; edit the connection and enter its API key`);
    if (response.status >= 400) throw new DodoError('NOT_SUPPORTED', `model listing returned HTTP ${response.status}; enter a model ID manually`);
    if (key && response.text.includes(key)) throw new DodoError('FORBIDDEN', 'provider echoed credentials; response discarded');
    let parsed: { data?: unknown[]; models?: unknown[] };
    try { parsed = JSON.parse(response.text) as typeof parsed; } catch { throw new DodoError('NOT_SUPPORTED', 'model listing returned an unsupported response'); }
    if (key && JSON.stringify(parsed).includes(key)) throw new DodoError('FORBIDDEN','provider echoed credentials; response discarded');
    return (parsed.data ?? parsed.models ?? []).slice(0, 200).map(v => { const m = v as { id?: string; name?: string; model?: string }; const id = String(m.id ?? m.name ?? m.model ?? ''); return { id: (c.protocol === 'gemini' ? id.replace(/^models\//, '') : id).slice(0, 200) }; });
    } catch (error) {
      if (signal.aborted && error instanceof DodoError && error.code === 'CONFLICT') throw new DodoError('NOT_SUPPORTED', 'model listing timed out or was canceled; retry listing or enter a model ID manually');
      throw error;
    } finally { clearTimeout(timeout); release(); }
  }
  async inspectModel(profileId: string) {
    const p = this.get<Profile>('profile',profileId); if (!p) throw new DodoError('NOT_FOUND','unknown profile');
    const release = this.lease(p.connectionId);
    try {
      const c = this.connection(p.connectionId), key = await this.credential(c);
      if (c.protocol !== 'ollama') throw new DodoError('NOT_SUPPORTED','metadata inspection is available for Ollama; use model listing and explicit inference/tool tests for this protocol');
      const response = await providerRequest(c,'show',key,{model:p.model,verbose:false},this.ports, undefined, undefined, () => this.assertCredential(c, key));
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
    const c = this.connection(p.connectionId); const key = await this.credential(c);
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 60000);
    try {
      const first = await generate(c, { ...p, maxOutputTokens: 256 }, key, { task: mode === 'tools' ? 'Call dodo_probe once with value 1, then report its returned value.' : 'Reply with OK.', instructions: 'This is a synthetic connection test. No project data is supplied.', turns: [], tools: mode === 'tools' ? [{ name: 'dodo_probe', description: 'Returns the number 1.', parameters: { type: 'object', properties: { value: { type: 'integer', const: 1 } }, required: ['value'], additionalProperties: false } }] : [] }, this.ports, controller.signal, undefined, () => this.assertCredential(c, key));
      if (mode === 'tools') {
        if (first.calls.length !== 1 || first.calls[0]?.name !== 'dodo_probe' || first.calls[0].args.value !== 1) throw new DodoError('NOT_SUPPORTED', 'model did not complete the synthetic tool call');
        const second = await generate(c, { ...p, maxOutputTokens: 256 }, key, { task: 'Call dodo_probe once with value 1, then report its returned value.', instructions: 'Report the tool result.', tools: [], turns: [{ reply: first, results: [{ id: first.calls[0].id, name: 'dodo_probe', content: '1' }] }] }, this.ports, controller.signal, undefined, () => this.assertCredential(c, key));
        if (second.calls.length || !second.text) throw new DodoError('NOT_SUPPORTED', 'tool result continuation failed');
      }
      const result = { profileId, mode, passed: true, checkedAt: Date.now(), connection: c.id, model: p.model, configuration:digestOf({profile:p,connection:c}) };
      this.put('probe', `${profileId}:${mode}`, result); return result;
    } finally { clearTimeout(timeout); }
    } finally { release(); }
  }
}
