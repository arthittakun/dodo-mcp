import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceFS } from '../../src/workspace/fs.js';
import { IgnoreEngine } from '../../src/workspace/ignores.js';
import { DodoError } from '../../src/errors.js';

/** FS-01, FS-02, FS-03: lexical + filesystem path policy. */
describe('WorkspaceFS path policy', () => {
  let root: string;
  let wfs: WorkspaceFS;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dodo-pp-')));
    fs.writeFileSync(path.join(root, 'ok.txt'), 'hello');
    fs.mkdirSync(path.join(root, 'sub'));
    fs.writeFileSync(path.join(root, 'sub', 'nested.txt'), 'nested');
    wfs = new WorkspaceFS(root, new IgnoreEngine({ root }));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('FS-01: rejects traversal, absolute, NUL, drive, UNC, and prefix-sibling paths', () => {
    const denied = ['../escape', '../../etc/passwd', '/etc/passwd', 'a/../../b', '\0evil', 'C:\\win', '\\\\server\\share', '~/secrets', 'sub/../../out'];
    for (const p of denied) {
      expect(() => wfs.normalizeRel(p), p).toThrow(DodoError);
    }
    // A path that only shares a string prefix with the root must not pass
    // (startsWith would wrongly allow "/root2" against "/root").
    expect(() => wfs.normalizeRel('/repo2/file')).toThrow(/rejected/);
  });

  it('FS-01: normalizes valid relative paths and "." to the root', () => {
    expect(wfs.normalizeRel('.')).toBe('.');
    expect(wfs.normalizeRel('./ok.txt')).toBe('ok.txt');
    expect(wfs.normalizeRel('sub//nested.txt')).toBe('sub/nested.txt');
  });

  it('FS-02: never follows a symlink that points outside the root', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dodo-outside-'));
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'TOPSECRET');
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
    fs.symlinkSync(outside, path.join(root, 'linkdir'));
    expect(() => wfs.resolve('link.txt')).toThrow(/symlink/);
    expect(() => wfs.resolve('linkdir/secret.txt')).toThrow(/symlink/);
    expect(() => wfs.readFileBytes('link.txt', 1024)).toThrow(/symlink/);
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('FS-02: rejects a symlink loop instead of hanging', () => {
    fs.symlinkSync(path.join(root, 'loopb'), path.join(root, 'loopa'));
    fs.symlinkSync(path.join(root, 'loopa'), path.join(root, 'loopb'));
    expect(() => wfs.resolve('loopa/x')).toThrow(DodoError);
  });

  it('FS-03: refuses hardlinked regular files for direct access', () => {
    fs.linkSync(path.join(root, 'ok.txt'), path.join(root, 'hard.txt'));
    expect(() => wfs.readFileBytes('hard.txt', 1024)).toThrow(/hardlink/);
  });

  it('reads a normal file and computes a raw-byte SHA-256', () => {
    const r = wfs.readTextFile('ok.txt', 1024);
    expect(r.text).toBe('hello');
    expect(r.hash).toBe('sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });

  it('walk() yields only in-root non-symlink files in deterministic order', () => {
    const files = [...wfs.walk({ includeIgnored: false })].map((f) => f.rel).sort();
    expect(files).toEqual(['ok.txt', 'sub/nested.txt']);
  });

  it('resolveForCreate detects existing targets and missing parents', () => {
    expect(() => wfs.resolveForCreate('ok.txt', false)).toThrow(/already exists/);
    expect(() => wfs.resolveForCreate('newdir/file.txt', false)).toThrow(/parent directory/);
    const r = wfs.resolveForCreate('newdir/file.txt', true);
    expect(r.missingParents).toEqual(['newdir']);
  });
});
