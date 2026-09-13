import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { platformFixture } from '../helpers/platform.js';
import { resolveTrustedExecutable } from '../../src/platform/execResolve.js';
import { isWithinPath } from '../../src/platform/pathPolicy.js';

// Deliberately NOT emulated on POSIX. A skipped result on macOS is not Windows
// security evidence; windows.yml runs this entire suite on native runners.
describe.skipIf(process.platform !== 'win32')('native NTFS and Windows executable boundaries', () => {
  let f: ReturnType<typeof platformFixture>;
  beforeAll(() => { f = platformFixture(); }, 120000);
  afterAll(async () => { if (f) await f.close(); }, 120000);

  it.each(['public.txt:stream', '.env::$DATA', 'CON.txt', 'NUL', 'COM1.log', 'LPT¹', 'file.', 'file ', 'GIT~1/config', 'CREDE~1.JSON'])('rejects ambiguous path %j before access', file => {
    expect(() => f.ws.services.wfs.resolve(file, { allowMissing: true })).toThrow();
    expect(() => f.ws.services.wfs.resolveForCreate(file, true)).toThrow();
  });

  it('refuses a real NTFS alternate data stream, not only a parser fixture', () => {
    fs.writeFileSync(path.join(f.root, 'visible.txt'), 'ordinary');
    fs.writeFileSync(path.join(f.root, 'visible.txt:hidden'), 'synthetic stream evidence');
    expect(fs.readFileSync(path.join(f.root, 'visible.txt:hidden'), 'utf8')).toBe('synthetic stream evidence');
    expect(() => f.ws.services.wfs.readTextFile('visible.txt:hidden', 1024)).toThrow();
  });

  it('applies secret and protected rules without a case bypass', () => {
    fs.writeFileSync(path.join(f.root, '.ENV'), 'synthetic test secret');
    fs.mkdirSync(path.join(f.root, '.git'));
    fs.writeFileSync(path.join(f.root, '.git', 'config'), 'synthetic protected content');
    for (const file of ['.env', '.EnV', '.GIT/config', '.git/CONFIG']) expect(() => f.ws.services.wfs.readTextFile(file, 1024)).toThrow();
    fs.writeFileSync(path.join(f.root, 'ordinary.txt'), 'ordinary');
    expect(f.ws.services.wfs.readTextFile('ORDINARY.TXT', 1024).text).toBe('ordinary');
  });

  it('refuses an actual directory junction to a sibling outside the workspace', () => {
    const outside = path.join(f.base, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'outside.txt'), 'outside fixture');
    fs.symlinkSync(outside, path.join(f.root, 'escape'), 'junction');
    expect(() => f.ws.services.wfs.readTextFile('escape/outside.txt', 1024)).toThrow();
    expect(() => f.ws.services.wfs.resolveForCreate('escape/new.txt', false)).toThrow();
  });

  it('refuses hardlinked files on the native filesystem', () => {
    fs.writeFileSync(path.join(f.root, 'hardlink-source.txt'), 'hardlink fixture');
    fs.linkSync(path.join(f.root, 'hardlink-source.txt'), path.join(f.root, 'hardlink-copy.txt'));
    expect(() => f.ws.services.wfs.readTextFile('hardlink-copy.txt', 1024)).toThrow(/hardlink/i);
  });

  it('rejects case-colliding files in one immutable change plan', async () => {
    await expect(f.call('preview_changes', { operations: [
      { op: 'create', path: 'CaseCollision.txt', content: 'first' },
      { op: 'create', path: 'casecollision.TXT', content: 'second' },
    ] })).rejects.toThrow('CONFLICT');
    expect(fs.existsSync(path.join(f.root, 'CaseCollision.txt'))).toBe(false);
  });

  it('does not clear a native read-only attribute to force an overwrite', async () => {
    const file = path.join(f.root, 'readonly.txt');
    fs.writeFileSync(file, 'preserve original');
    fs.chmodSync(file, 0o444);
    try {
      await expect(f.call('edit_file', { path: 'readonly.txt', edits: [{ find: 'original', replace: 'changed' }] })).rejects.toThrow();
      expect(fs.readFileSync(file, 'utf8')).toBe('preserve original');
    } finally { fs.chmodSync(file, 0o666); }
  });

  it('requires explicit unsandboxed schedule consent rather than downgrading the default', () => {
    const spec = { name: 'Windows schedule fixture', command: 'echo scheduled', cron: '* * * * *', expiresAt: Date.now() + 3600000 };
    expect(() => f.ws.services.schedules.propose(spec)).toThrow(/sandbox:false/);
    const proposed = f.ws.services.schedules.propose({ ...spec, sandbox: false });
    expect(proposed.status).toBe('pending');
    expect(f.ws.services.jobs.runningCount()).toBe(0);
  });

  it('does not resolve repository-planted executables through cwd or PATH', () => {
    fs.writeFileSync(path.join(f.root, 'git.exe'), 'not a trusted executable');
    fs.writeFileSync(path.join(f.root, 'dodo-cwd-hijack.exe'), 'not a trusted executable');
    let git: string | undefined;
    try { git = resolveTrustedExecutable('git', f.root, { allowBatch: false }); }
    catch (error) { expect(error).toMatchObject({ code: 'NOT_FOUND' }); }
    if (git) {
      expect(path.isAbsolute(git)).toBe(true);
      expect(isWithinPath(f.root, git)).toBe(false);
    }
    expect(() => resolveTrustedExecutable('dodo-cwd-hijack', f.root, { env: { ...process.env, PATH: f.root }, allowBatch: false })).toThrow();
  });
});
