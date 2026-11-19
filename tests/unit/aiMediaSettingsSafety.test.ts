import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/store/db.js';
import { Store } from '../../src/store/store.js';
import { AISettings } from '../../src/services/ai/settings.js';

const KEY = 'synthetic-media-settings-safety-key';
describe('partial media settings and bounded provider metadata', () => {
  let settings: AISettings;
  const servers: http.Server[] = [];
  beforeEach(() => { settings = new AISettings(new Store(openDatabase(':memory:')), []); });
  afterEach(async () => { for (const server of servers.splice(0)) await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); settings.credentials.close(); settings.store.db.close(); });
  async function connection(handler?: (url: URL) => unknown, protocol: 'responses' | 'gemini' = 'responses') {
    const calls: string[] = [];
    const server = http.createServer((request, response) => {
      calls.push(request.url!); response.setHeader('content-type', 'application/json');
      if ((protocol === 'gemini' ? request.headers['x-goog-api-key'] : request.headers.authorization) !== (protocol === 'gemini' ? KEY : `Bearer ${KEY}`)) { response.statusCode = 401; response.end('{}'); return; }
      response.end(JSON.stringify(handler?.(new URL(request.url!, 'http://fixture.invalid')) ?? { data: [{ id: 'fixture-image' }] }));
    });
    servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const c = await settings.saveConnection({ name: 'Synthetic metadata fixture', provider: 'custom', protocol, baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, allowPrivateNetwork: true }, KEY);
    return { c, calls };
  }
  it('preserves selected connection and video settings on a partial update and checks revisions atomically', async () => {
    const { c } = await connection();
    const initial = settings.saveMedia({ connectionId: c.id, imageModel: 'first-image', videoEnabled: true, videoModel: 'fixture-video' });
    const next = settings.saveMedia({ imageModel: 'second-image', expectedRevision: initial.revision }, { principal: 'test-owner' });
    expect(next).toMatchObject({ connectionId: c.id, imageModel: 'second-image', videoEnabled: true, videoModel: 'fixture-video', revision: initial.revision + 1 });
    expect(() => settings.saveMedia({ imageModel: 'stale-image', expectedRevision: initial.revision })).toThrow(/another session/);
    expect(settings.media()).toEqual(next);
    const rows = settings.store.db.prepare("SELECT principal,result FROM audit_events WHERE tool='settings.creative-media' ORDER BY ts,rowid").all() as Array<{ principal: string; result: string }>;
    expect(rows.at(-1)).toMatchObject({ principal: 'test-owner', result: `revision=${next.revision};fields=imageModel` });
    expect(JSON.stringify(rows)).not.toContain(KEY); expect(JSON.stringify(rows)).not.toContain(c.baseUrl); expect(JSON.stringify(rows)).not.toContain('second-image');
    const cleared = settings.saveMedia({ connectionId: null, expectedRevision: next.revision });
    expect(cleared).toMatchObject({ connectionId: null, enabled: false, videoEnabled: false, imageModel: 'second-image' });
  });
  it('rolls back configuration and revision when its audit record cannot be persisted', async () => {
    const { c } = await connection(); const original = settings.saveMedia({ connectionId: c.id });
    settings.store.db.exec("CREATE TRIGGER media_audit_fail BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END;");
    expect(() => settings.saveMedia({ imageModel: 'unsaved-image', expectedRevision: original.revision })).toThrow(/synthetic audit failure/);
    expect(settings.media()).toEqual(original);
  });
  it('returns valid model201 and follows provider after-cursors without clipping invalid IDs', async () => {
    const ids = Array.from({ length: 251 }, (_, index) => `image-${index}`);
    const { c, calls } = await connection(url => url.searchParams.get('after') ? { data: [{ id: ids[250] }], has_more: false } : { data: [...ids.slice(0, 250).map(id => ({ id })), { id: 'x'.repeat(201) }, { id: 'https://private.invalid/v1' }], has_more: true, last_id: ids[249] });
    const listing = await settings.modelsPage(c.id);
    expect(listing).toMatchObject({ pages: 2, truncated: false, rejectedIds: 2 });
    expect(listing.models.map(model => model.id)).toEqual(ids);
    expect(calls[1]).toContain('after=image-249'); expect(listing.models.some(model => model.id === 'x'.repeat(200))).toBe(false);
    expect(JSON.stringify(listing)).not.toContain('private.invalid'); expect(JSON.stringify(listing)).not.toContain(KEY);
  });
  it('follows native Gemini nextPageToken and strips only its models resource prefix', async () => {
    const { c, calls } = await connection(url => url.searchParams.get('pageToken') ? { models: [{ name: 'models/second-image' }] } : { models: [{ name: 'models/first-image' }], nextPageToken: 'next fixture page' }, 'gemini');
    expect((await settings.modelsPage(c.id)).models).toEqual([{ id: 'first-image' }, { id: 'second-image' }]);
    expect(calls[1]).toContain('pageToken=next+fixture+page');
  });
  it('marks repeated cursors and model count limits as truncated instead of claiming a complete list', async () => {
    const { c, calls } = await connection(() => ({ data: [{ id: 'fixture-image' }], next_cursor: 'same-cursor' }));
    expect(await settings.modelsPage(c.id)).toMatchObject({ models: [{ id: 'fixture-image' }], truncated: true, pages: 2 });
    expect(calls).toHaveLength(2);
    const large = await connection(() => ({ data: Array.from({ length: 2001 }, (_, index) => ({ id: `image-${index}` })) }));
    const bounded = await settings.modelsPage(large.c.id); expect(bounded.models).toHaveLength(2000); expect(bounded.truncated).toBe(true);
  });
  it('checks metadata without inference and reports authentication failures without leaking credentials', async () => {
    const { c, calls } = await connection();
    expect(await settings.checkMediaConnection(c.id)).toMatchObject({ credentialPresent: true, modelCount: 1, inferenceTested: false, billingVerified: false });
    expect(calls).toEqual(['/v1/models']);
    const bad = await settings.saveConnection({ ...c, id: undefined, name: 'Bad credential fixture' }, 'synthetic-wrong-key');
    await expect(settings.modelsPage(bad.id)).rejects.toMatchObject({ code: 'AUTH_REQUIRED', detail: { httpStatus: 401 } });
  });
});
