import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, obtainToken, callToolLegacy, wsArgs, type TestContext, type TokenSet } from '../helpers/testServer.js';

/** D. Files/search/secret policy through real tool dispatch (FS-01..13). */
describe('FS: path traversal & secret policy via tools', () => {
  let ctx: TestContext;
  let tokens: TokenSet;
  let outsideDir: string;

  beforeAll(async () => {
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dodo-outside-'));
    fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'TOPSECRET-OUTSIDE');
    ctx = await launch({ toolSurface: 'full', 
      fixtureFiles: {
        'app.ts': 'export const x = 1;\n',
        'sub/mod.ts': 'export const y = 2;\n',
        '.env': 'API_KEY=sk-secret-value\n',
        'config/.env.production': 'DB_PASSWORD=hunter2\n',
        'id_rsa': '-----BEGIN PRIVATE KEY-----\n',
        'normal.md': '# doc\n',
        'tracked-secret.pem': 'PRIVATEKEYMATERIAL\n',
      },
      trust: 'edit',
    });
    // Add a symlink pointing outside the root.
    fs.symlinkSync(path.join(outsideDir, 'secret.txt'), path.join(ctx.fixtureDir, 'evil-link.txt'));
    tokens = await obtainToken(ctx);
  }, 120_000);

  afterAll(async () => {
    await ctx?.cleanup();
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  const errCode = (env: Record<string, unknown>): string | undefined => (env['error'] as Record<string, unknown> | null)?.['code'] as string | undefined;

  it('FS-01: traversal / absolute / prefix-sibling reads are PATH_DENIED', async () => {
    for (const p of ['../secret.txt', '../../etc/passwd', '/etc/passwd', 'sub/../../out']) {
      const res = await callToolLegacy(ctx, tokens.accessToken, 'read_files', { ...wsArgs(ctx), files: [{ path: p }] });
      const data = res.envelope['data'] as { files: unknown[]; errors: Array<{ error: { code: string } }> };
      expect(data.files).toHaveLength(0);
      expect(data.errors[0]?.error.code).toBe('PATH_DENIED');
    }
  });

  it('FS-02: reading through a symlink out of the root is denied', async () => {
    const res = await callToolLegacy(ctx, tokens.accessToken, 'read_files', { ...wsArgs(ctx), files: [{ path: 'evil-link.txt' }] });
    const data = res.envelope['data'] as { files: unknown[]; errors: Array<{ error: { code: string } }> };
    expect(data.files).toHaveLength(0);
    expect(data.errors[0]?.error.code).toBe('PATH_DENIED');
  });

  it('FS-05: secret files are denied with SECRET_PATH_DENIED', async () => {
    for (const p of ['.env', 'config/.env.production', 'id_rsa', 'tracked-secret.pem']) {
      const res = await callToolLegacy(ctx, tokens.accessToken, 'read_files', { ...wsArgs(ctx), files: [{ path: p }] });
      const data = res.envelope['data'] as { errors: Array<{ error: { code: string } }> };
      expect(data.errors[0]?.error.code, p).toBe('SECRET_PATH_DENIED');
    }
  });

  it('FS-05: secret files never appear in list_files, even with includeIgnored', async () => {
    const res = await callToolLegacy(ctx, tokens.accessToken, 'list_files', { ...wsArgs(ctx), path: '.', includeIgnored: true, depth: 5 });
    const blob = JSON.stringify(res.envelope['data']);
    expect(blob).not.toContain('.env');
    expect(blob).not.toContain('id_rsa');
    expect(blob).not.toContain('.pem');
    expect(blob).toContain('app.ts');
  });

  it('FS-05: secret content never appears in search results', async () => {
    const res = await callToolLegacy(ctx, tokens.accessToken, 'search_code', { ...wsArgs(ctx), query: 'secret', mode: 'literal', includeIgnored: true, maxResults: 100, caseSensitive: false });
    const matches = (res.envelope['data'] as { matches: Array<{ path: string }> }).matches;
    for (const m of matches) {
      expect(m.path).not.toContain('.env');
      expect(m.path).not.toContain('id_rsa');
      expect(m.path).not.toContain('.pem');
    }
    // Sanity: it CAN find matches in normal files.
    const res2 = await callToolLegacy(ctx, tokens.accessToken, 'search_code', { ...wsArgs(ctx), query: 'export', mode: 'literal', maxResults: 100 });
    expect((res2.envelope['data'] as { matches: unknown[] }).matches.length).toBeGreaterThan(0);
  });

  it('FS-13: a batch read mixing a secret + a normal file leaks no secret data', async () => {
    const res = await callToolLegacy(ctx, tokens.accessToken, 'read_files', {
      ...wsArgs(ctx),
      files: [{ path: 'normal.md' }, { path: '.env' }],
    });
    const data = res.envelope['data'] as { files: Array<{ path: string; content: string }>; errors: Array<{ path: string; error: { code: string } }> };
    expect(data.files.map((f) => f.path)).toEqual(['normal.md']);
    expect(data.errors.find((e) => e.path === '.env')?.error.code).toBe('SECRET_PATH_DENIED');
    expect(JSON.stringify(data)).not.toContain('sk-secret-value');
  });

  it('FS-01: writing (preview) outside the root or to a secret path is denied', async () => {
    const trav = await callToolLegacy(ctx, tokens.accessToken, 'preview_changes', {
      ...wsArgs(ctx),
      operations: [{ op: 'create', path: '../escape.txt', content: 'x' }],
    });
    expect(errCode(trav.envelope)).toBe('PATH_DENIED');

    const secret = await callToolLegacy(ctx, tokens.accessToken, 'preview_changes', {
      ...wsArgs(ctx),
      operations: [{ op: 'create', path: '.env.new', content: 'x' }],
    });
    expect(errCode(secret.envelope)).toBe('SECRET_PATH_DENIED');
  });

  it('FS-01: absolute paths are not an escape hatch in search', async () => {
    const res = await callToolLegacy(ctx, tokens.accessToken, 'search_code', {
      ...wsArgs(ctx),
      query: 'TOPSECRET',
      mode: 'literal',
      paths: [outsideDir],
      maxResults: 10,
    });
    expect(errCode(res.envelope)).toBe('PATH_DENIED');
  });
});
