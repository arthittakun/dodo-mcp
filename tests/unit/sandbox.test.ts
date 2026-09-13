import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DodoError } from '../../src/errors.js';
import {
  bwrapArgs,
  sandboxAvailability,
  seatbeltProfile,
  wrapInSandbox,
  type SandboxRequest,
  type WrappedSpawn,
} from '../../src/services/jobs/sandbox.js';

const isDarwin = process.platform === 'darwin';

function req(workspaceRoot: string, extra: Partial<SandboxRequest> = {}): SandboxRequest {
  return { workspaceRoot, writablePaths: [], allowNetwork: true, ...extra };
}

function mkRoot(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dodo-sbx-')));
}

/** Run a builder under a fake platform/PATH (both restored afterwards). */
function withPlatform<T>(platform: NodeJS.Platform, pathEnv: string, fn: () => T): T {
  const realPlatform = process.platform;
  const realPath = process.env['PATH'];
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  process.env['PATH'] = pathEnv;
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
    if (realPath === undefined) delete process.env['PATH'];
    else process.env['PATH'] = realPath;
  }
}

function run(w: WrappedSpawn, cwd: string): Promise<{ code: number | string | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(w.program, w.args, { cwd, timeout: 20_000 }, (err, stdout, stderr) => {
      resolve({ code: err === null ? 0 : (err.code ?? null), stdout, stderr });
    });
  });
}

describe('seatbeltProfile', () => {
  it('allows writes only under the workspace, temp dirs and /dev, after a global deny', () => {
    const root = mkRoot();
    const profile = seatbeltProfile(req(root));
    const lines = profile.trimEnd().split('\n');
    expect(lines[0]).toBe('(version 1)');
    expect(lines[1]).toBe('(allow default)');
    expect(lines[2]).toBe('(deny file-write*)');
    expect(lines).toContain(`(allow file-write* (subpath "${root}"))`);
    expect(lines).toContain('(allow file-write* (subpath "/private/tmp"))');
    expect(lines).toContain('(allow file-write* (subpath "/tmp"))');
    expect(lines).toContain(`(allow file-write* (subpath "${fs.realpathSync(os.tmpdir())}"))`);
    expect(lines).toContain('(allow file-write* (subpath "/dev"))');
    expect(lines).toContain('(allow file-write* (literal "/dev/null"))');
    // The blanket deny must precede every allow (later rules win in SBPL).
    const firstAllow = lines.findIndex((l) => l.startsWith('(allow file-write*'));
    expect(firstAllow).toBeGreaterThan(lines.indexOf('(deny file-write*)'));
  });

  it('denies network only when allowNetwork is false', () => {
    const root = mkRoot();
    expect(seatbeltProfile(req(root, { allowNetwork: false }))).toContain('(deny network*)');
    expect(seatbeltProfile(req(root, { allowNetwork: true }))).not.toContain('network');
  });

  it('escapes double quotes and backslashes inside path literals', () => {
    const base = mkRoot();
    const weird = path.join(base, 'we"ird\\back');
    fs.mkdirSync(weird);
    const profile = seatbeltProfile(req(weird));
    expect(profile).toContain(`(allow file-write* (subpath "${base}/we\\"ird\\\\back"))`);
  });

  it('realpaths existing writable paths and skips missing ones', () => {
    const root = mkRoot();
    const cache = mkRoot();
    const link = path.join(root, 'cache-link');
    fs.symlinkSync(cache, link);
    const missing = path.join(root, 'does-not-exist');
    const profile = seatbeltProfile(req(root, { writablePaths: [link, missing] }));
    expect(profile).toContain(`(allow file-write* (subpath "${cache}"))`);
    expect(profile).not.toContain('cache-link');
    expect(profile).not.toContain('does-not-exist');
  });

  it('rejects relative writable paths and a missing workspace root', () => {
    const root = mkRoot();
    expect(() => seatbeltProfile(req(root, { writablePaths: ['relative/cache'] }))).toThrow(DodoError);
    try {
      seatbeltProfile(req(path.join(root, 'nope')));
      expect.unreachable('missing root must throw');
    } catch (err) {
      expect((err as DodoError).code).toBe('NOT_FOUND');
    }
  });
});

describe('bwrapArgs', () => {
  it('binds the tree read-only with rw binds for the workspace, /tmp and existing writable paths', () => {
    const root = mkRoot();
    const cache = mkRoot();
    const missing = path.join(root, 'nope');
    const argv = bwrapArgs(req(root, { writablePaths: [cache, missing], allowNetwork: false }), '/bin/bash', ['-c', 'true']);
    expect(argv.slice(0, 15)).toEqual([
      '--ro-bind', '/', '/',
      '--bind', root, root,
      '--bind', '/tmp', '/tmp',
      '--dev', '/dev',
      '--proc', '/proc',
      '--tmpfs', '/run',
    ]);
    expect(argv.join(' ')).toContain(`--bind ${cache} ${cache}`);
    expect(argv).not.toContain(missing);
    expect(argv).toContain('--unshare-net');
    const sep = argv.indexOf('--');
    expect(argv[sep - 1]).toBe('--die-with-parent');
    expect(argv.slice(sep + 1)).toEqual(['/bin/bash', '-c', 'true']);
  });

  it('keeps the network namespace when allowNetwork is true', () => {
    const argv = bwrapArgs(req(mkRoot(), { allowNetwork: true }), '/bin/true', []);
    expect(argv).not.toContain('--unshare-net');
    expect(argv).toContain('--die-with-parent');
  });
});

describe('sandboxAvailability / wrapInSandbox', () => {
  it.skipIf(!isDarwin)('reports seatbelt on macOS and wraps with sandbox-exec -p <profile>', () => {
    expect(sandboxAvailability()).toEqual({ available: true, kind: 'macos-seatbelt' });
    const root = mkRoot();
    const r = req(root, { allowNetwork: false });
    const w = wrapInSandbox('/bin/bash', ['-c', 'echo hi'], r);
    expect(w.kind).toBe('macos-seatbelt');
    expect(w.program).toBe('/usr/bin/sandbox-exec');
    expect(w.args[0]).toBe('-p');
    expect(w.args[1]).toBe(seatbeltProfile(r));
    expect(w.profile).toBe(w.args[1]);
    expect(w.args.slice(2)).toEqual(['/bin/bash', '-c', 'echo hi']);
  });

  it('on linux, finds bwrap on the trusted PATH (absolute entries only) and wraps with it', () => {
    const bin = mkRoot();
    const fakeBwrap = path.join(bin, 'bwrap');
    fs.writeFileSync(fakeBwrap, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const root = mkRoot();
    withPlatform('linux', `relative/bin:${bin}`, () => {
      expect(sandboxAvailability()).toEqual({ available: true, kind: 'linux-bwrap' });
      const w = wrapInSandbox('/bin/bash', ['-c', 'true'], req(root));
      expect(w.kind).toBe('linux-bwrap');
      expect(w.program).toBe(fakeBwrap);
      expect(w.profile).toBeUndefined();
      expect(w.args).toEqual(bwrapArgs(req(root), '/bin/bash', ['-c', 'true']));
    });
    // PATH without bwrap (an empty dir; never the system default list).
    withPlatform('linux', mkRoot(), () => {
      const avail = sandboxAvailability();
      expect(avail.available).toBe(false);
      expect(avail.kind).toBeUndefined();
      expect(avail.reason).toMatch(/bwrap/);
      try {
        wrapInSandbox('/bin/true', [], req(root));
        expect.unreachable('must throw when bwrap is absent');
      } catch (err) {
        expect(err).toBeInstanceOf(DodoError);
        expect((err as DodoError).code).toBe('NOT_SUPPORTED');
      }
    });
  });

  it('is unavailable on unimplemented platforms and wrapInSandbox throws NOT_SUPPORTED', () => {
    const root = mkRoot();
    withPlatform('aix', process.env['PATH'] ?? '', () => {
      const avail = sandboxAvailability();
      expect(avail).toEqual({ available: false, reason: 'no OS sandbox adapter for platform aix' });
      try {
        wrapInSandbox('/bin/true', [], req(root));
        expect.unreachable('must throw');
      } catch (err) {
        expect((err as DodoError).code).toBe('NOT_SUPPORTED');
        expect((err as DodoError).message).toContain('aix');
      }
    });
  });
});

describe.skipIf(!isDarwin)('seatbelt enforcement (macOS, real sandbox-exec)', () => {
  // os.tmpdir() is itself writable under the profile, so the "outside" dir
  // must live somewhere else: a throwaway dir under $HOME, removed afterwards.
  const base = path.join(os.homedir(), `.dodo-sandbox-test-${crypto.randomBytes(6).toString('hex')}`);
  const root = path.join(base, 'root');
  const outside = path.join(base, 'outside');

  beforeAll(() => {
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
  });
  afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

  it('allows writes inside the workspace root', async () => {
    const target = path.join(root, 'inside.txt');
    const res = await run(wrapInSandbox('/bin/bash', ['-c', `touch '${target}'`], req(root)), root);
    expect(res.stderr).toBe('');
    expect(res.code).toBe(0);
    expect(fs.existsSync(target)).toBe(true);
  });

  it('denies writes outside the writable set', async () => {
    const target = path.join(outside, 'outside.txt');
    const res = await run(wrapInSandbox('/bin/bash', ['-c', `touch '${target}'`], req(root)), root);
    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/Operation not permitted/);
    expect(fs.existsSync(target)).toBe(false);
  });

  it('denies outbound network when allowNetwork is false', async () => {
    const script =
      "require('net').connect(80,'1.1.1.1')" +
      ".on('error',e=>{console.log('ERR',e.code);process.exit(0)})" +
      ".on('connect',()=>{console.log('CONNECTED');process.exit(2)})";
    const res = await run(wrapInSandbox(process.execPath, ['-e', script], req(root, { allowNetwork: false })), root);
    expect(res.stdout).toContain('ERR');
    expect(res.stdout).not.toContain('CONNECTED');
    expect(res.code).toBe(0);
  });
});
