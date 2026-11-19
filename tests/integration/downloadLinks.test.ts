import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProjectRegistry } from '../../src/projects/registry.js';
import { assertOk, tool } from '../helpers/multimodal.js';
import { launch, mkTmpDir, obtainToken, rfetch, type TestContext, type TokenSet } from '../helpers/testServer.js';

interface Resource { resourceId: string; sha256: string }
interface Link { linkId: string; url: string; fileName: string; bytes: number; createdAt: number; expiresAt: number }

describe('temporary download links through real HTTP and OAuth tools', () => {
  let ctx: TestContext, token: TokenSet, other: TokenSet, reader: TokenSet;
  const content = 'immutable DODO download fixture\n';
  const call = (name: string, args: Record<string, unknown>, accessToken = token.accessToken) => tool(ctx, accessToken, name, args);
  async function resource(file = 'download.txt') {
    return assertOk(await call('resource_inspect', { path: file })) as Resource;
  }
  async function create(input: Record<string, unknown> = {}) {
    const source = await resource();
    return assertOk(await call('download_link_create', { resourceId: source.resourceId, expectedSha256: source.sha256, ...input })) as Link;
  }
  beforeAll(async () => {
    ctx = await launch({ trust: 'trusted', toolSurface: 'full', fixtureFiles: { 'download.txt': content, 'web.html': '<script>parent.postMessage("untrusted", "*")</script>' } });
    new ProjectRegistry(ctx.server.services.store).add(ctx.fixtureDir, 'Download fixture');
    token = await obtainToken(ctx); other = await obtainToken(ctx); reader = await obtainToken(ctx, { scope: 'dodo:read' });
  });
  afterAll(async () => ctx?.cleanup());

  it.each([1, 2, 7, 14, 30])('issues a %i-day link on the actual running origin', async expiresInDays => {
    const link = await create({ expiresInDays, fileName: 'ภาพตัวอย่าง.txt' });
    expect(link.expiresAt - link.createdAt).toBe(expiresInDays * 86_400_000);
    const url = new URL(link.url);
    expect(url.origin).toBe(ctx.baseUrl);
    expect(url.pathname).toMatch(/^\/file\/[A-Za-z0-9_-]{43}\//);
    expect(decodeURIComponent(url.pathname.split('/').at(-1)!)).toBe('ภาพตัวอย่าง.txt');
    expect(url.search).toBe(''); expect(url.hash).toBe('');
  });

  it('downloads the original snapshot, HEAD and one byte range without OAuth', async () => {
    const link = await create({ fileName: 'snapshot.txt' });
    fs.writeFileSync(path.join(ctx.fixtureDir, 'download.txt'), 'changed after publication');
    try {
      const response = await rfetch(link.url);
      expect(response.status).toBe(200); expect(await response.text()).toBe(content);
      expect(response.headers.get('content-disposition')).toContain('attachment;');
      expect(response.headers.get('cache-control')).toContain('no-store');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      const head = await rfetch(link.url, { method: 'HEAD' });
      expect(head.status).toBe(200); expect(await head.text()).toBe('');
      expect(head.headers.get('content-length')).toBe(String(Buffer.byteLength(content)));
      const range = await rfetch(link.url, { headers: { Range: 'bytes=0-8' } });
      expect(range.status).toBe(206); expect(await range.text()).toBe(content.slice(0, 9));
      expect(range.headers.get('content-range')).toBe(`bytes 0-8/${Buffer.byteLength(content)}`);
      const suffix = await rfetch(link.url, { headers: { Range: 'bytes=-7' } });
      expect(suffix.status).toBe(206); expect(await suffix.text()).toBe(content.slice(-7));
      for (const value of ['bytes=9999-', 'bytes=5-1', 'bytes=0-1,4-5', 'bytes=-0']) {
        const invalid = await rfetch(link.url, { headers: { Range: value } });
        expect(invalid.status).toBe(416); await invalid.text();
      }
      const wrongName = new URL(link.url); wrongName.pathname = wrongName.pathname.replace('snapshot.txt', 'other.txt');
      expect((await rfetch(wrongName)).status).toBe(404);
      expect((await rfetch(`${ctx.baseUrl}/file/${'A'.repeat(43)}/download.txt`)).status).toBe(404);
      const malformed = await rfetch(`${ctx.baseUrl}/file/%ZZ/download.txt`);
      expect(malformed.status).toBe(404); expect(await malformed.json()).toEqual({ error: 'not_found' });
      const badFilename = await rfetch(`${link.url.slice(0, link.url.lastIndexOf('/') + 1)}%E0%A4%A`);
      expect(badFilename.status).toBe(404); expect(await badFilename.json()).toEqual({ error: 'not_found' });
    } finally { fs.writeFileSync(path.join(ctx.fixtureDir, 'download.txt'), content); }
  });

  it('keeps active document content as an attachment and never publishes an arbitrary path', async () => {
    const source = await resource('web.html');
    const link = assertOk(await call('download_link_create', { resourceId: source.resourceId, expectedSha256: source.sha256, fileName: 'page.html' })) as Link;
    const response = await rfetch(link.url);
    expect(response.status).toBe(200); expect(await response.text()).toContain('<script>');
    expect(response.headers.get('content-security-policy')).toContain('sandbox');
    expect(response.headers.get('content-disposition')).toContain('attachment;');
    expect((await rfetch(`${ctx.baseUrl}/file/download.txt`)).status).toBe(404);
    expect((await rfetch(`${ctx.baseUrl}/file/${'A'.repeat(43)}/.env`)).status).toBe(404);
  });

  it('enforces client ownership, read/write scopes, exact hashes and revocation', async () => {
    const source = await resource();
    const args = { resourceId: source.resourceId, expectedSha256: source.sha256 };
    const link = assertOk(await call('download_link_create', args)) as Link;
    expect(link.expiresAt - link.createdAt).toBe(7 * 86_400_000);
    const listing = assertOk(await call('download_link_list', {})) as { links: unknown[] };
    expect(JSON.stringify(listing)).toContain(link.linkId);
    expect(JSON.stringify(listing)).not.toContain(new URL(link.url).pathname.split('/')[2]);
    expect(JSON.stringify(listing)).not.toContain('"url"');
    expect(assertOk(await call('download_link_list', {}, other.accessToken))).toEqual({ links: [] });
    expect((await call('download_link_create', args, other.accessToken)).isError).toBe(true);
    expect((await call('download_link_create', args, reader.accessToken)).isError).toBe(true);
    expect((await call('download_link_revoke', { linkId: link.linkId }, reader.accessToken)).isError).toBe(true);
    expect((await call('download_link_revoke', { linkId: link.linkId }, other.accessToken)).isError).toBe(true);
    expect((await call('download_link_create', { ...args, expectedSha256: `sha256:${'0'.repeat(64)}` })).isError).toBe(true);
    const revoked = assertOk(await call('download_link_revoke', { linkId: link.linkId }));
    expect(assertOk(await call('download_link_revoke', { linkId: link.linkId }))).toEqual(revoked);
    expect((await rfetch(link.url)).status).toBe(404);
  });

  it('requires a serving origin and follows the existing execution approval policy', async () => {
    const source = await resource();
    const args = { resourceId: source.resourceId, expectedSha256: source.sha256 };
    const services = ctx.server.services, origin = services.downloadOrigin;
    delete services.downloadOrigin;
    try {
      expect((await call('download_link_create', args)).envelope.error).toMatchObject({ code: 'NOT_SUPPORTED' });
    } finally { if (origin) services.downloadOrigin = origin; }
    services.store.setTrustMode(ctx.server.workspaceId, 'edit');
    try {
      expect((await call('download_link_create', args)).envelope.error).toMatchObject({ code: 'APPROVAL_REQUIRED' });
    } finally { services.store.setTrustMode(ctx.server.workspaceId, 'trusted'); }
  });

  it('pins a snapshot beyond resource expiry and stops serving at link expiry', async () => {
    fs.writeFileSync(path.join(ctx.fixtureDir, 'expiring.txt'), 'unique expiring snapshot');
    const source = await resource('expiring.txt');
    const link = assertOk(await call('download_link_create', { resourceId: source.resourceId, expectedSha256: source.sha256, expiresInDays: 30 })) as Link;
    const db = ctx.server.services.store.db, resources = ctx.server.services.resources!;
    db.prepare('UPDATE resource_refs SET expires_at=? WHERE id=?').run(Date.now() - 1, source.resourceId);
    db.prepare('UPDATE resource_objects SET verified_at=? WHERE hash=?').run(Date.now() - 7_200_000, source.sha256);
    resources.gc();
    expect(await (await rfetch(link.url)).text()).toBe('unique expiring snapshot');
    expect((await call('resource_read', { resourceId: source.resourceId })).isError).toBe(true);
    db.prepare('UPDATE resource_download_links SET expires_at=? WHERE id=?').run(Date.now() - 1, link.linkId);
    expect((await rfetch(link.url)).status).toBe(404);
    db.prepare('UPDATE resource_objects SET verified_at=? WHERE hash=?').run(Date.now() - 7_200_000, source.sha256);
    resources.gc();
    expect(db.prepare('SELECT 1 FROM resource_objects WHERE hash=?').get(source.sha256)).toBeUndefined();
  });

  it('retains issued and revoked links through a workspace switch and process restart', async () => {
    const active = await create(), revoked = await create();
    assertOk(await call('download_link_revoke', { linkId: revoked.linkId }));
    const originalRoot = ctx.fixtureDir, configDir = ctx.configDir, port = ctx.port;
    const anotherRoot = mkTmpDir('dodo-download-target-');
    fs.writeFileSync(path.join(anotherRoot, 'target.txt'), 'target');
    new ProjectRegistry(ctx.server.services.store).add(anotherRoot, 'Other download project');
    await ctx.server.switchWorkspace({ path: anotherRoot });
    expect(ctx.server.services.downloadOrigin).toBe(ctx.baseUrl);
    expect(await (await rfetch(active.url)).text()).toBe(content);
    expect((await rfetch(revoked.url)).status).toBe(404);
    await ctx.cleanup();
    ctx = await launch({ fixtureDir: originalRoot, configDir, port, trust: 'trusted', toolSurface: 'full' });
    expect(await (await rfetch(active.url)).text()).toBe(content);
    expect((await rfetch(revoked.url)).status).toBe(404);
    const links = assertOk(await call('download_link_list', {})) as { links: Array<{ linkId: string }> };
    expect(links.links.some(item => item.linkId === active.linkId)).toBe(true);
  });
});
