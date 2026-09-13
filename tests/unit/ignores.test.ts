import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IgnoreEngine } from '../../src/workspace/ignores.js';
import { WorkspaceFS } from '../../src/workspace/fs.js';

/** FS-05, FS-09: secret deny vs ordinary ignores vs includeIgnored. */
describe('IgnoreEngine classification', () => {
  let root: string;
  let eng: IgnoreEngine;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dodo-ig-')));
    fs.writeFileSync(path.join(root, '.gitignore'), 'build/\n*.log\n');
    eng = new IgnoreEngine({ root, extraSecretPatterns: ['company-secret.txt'] });
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('FS-05: secret files are denied and NOT bypassable by includeIgnored', () => {
    for (const p of ['.env', '.env.local', 'config/.env.production', 'id_rsa', 'deploy.pem', '.npmrc', '.aws/credentials', 'company-secret.txt']) {
      expect(eng.isSecret(p), p).toBe(true);
      expect(eng.classify(p, false, true), `includeIgnored ${p}`).toBe('secret');
    }
  });

  it('.env.example is denied by default (secure default; explicit local policy may allow it)', () => {
    // Spec §10.2 flags .env.example as ambiguous. Applying the pack's conflict
    // rule ("choose the path that does not reduce security"), the .env* hard
    // deny covers it by default rather than guessing it is safe (ADR-011).
    expect(eng.isSecret('.env.example')).toBe(true);
  });

  it('FS-09: ordinary ignores are skipped by default and re-added by includeIgnored', () => {
    expect(eng.classify('build/out.js', false, false)).toBe('ignored');
    expect(eng.classify('build/out.js', false, true)).toBe('ok');
    expect(eng.classify('debug.log', false, false)).toBe('ignored');
    expect(eng.classify('debug.log', false, true)).toBe('ok');
  });

  it('.git internals are protected and never re-added', () => {
    expect(eng.classify('.git/config', false, true)).toBe('protected');
    expect(eng.isProtected('.git/HEAD')).toBe(true);
  });

  it('node_modules is an ordinary ignore', () => {
    expect(eng.classify('node_modules/pkg/index.js', false, false)).toBe('ignored');
    expect(eng.classify('node_modules/pkg/index.js', false, true)).toBe('ok');
  });

  it('nested .gitignore files are honored during walk', () => {
    fs.mkdirSync(path.join(root, 'pkg'));
    fs.writeFileSync(path.join(root, 'pkg', '.gitignore'), 'local-only.ts\n');
    fs.writeFileSync(path.join(root, 'pkg', 'local-only.ts'), '1');
    fs.writeFileSync(path.join(root, 'pkg', 'kept.ts'), '1');
    const wfs = new WorkspaceFS(root, eng);
    const files = [...wfs.walk({ includeIgnored: false })].map((f) => f.rel);
    expect(files).toContain('pkg/kept.ts');
    expect(files).not.toContain('pkg/local-only.ts');
  });
});
