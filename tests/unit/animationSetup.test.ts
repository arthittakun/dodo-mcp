import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { ensurePrivateDirectory } from '../../src/platform/privateFs.js';
import { resolveTrustedExecutable } from '../../src/platform/execResolve.js';
import { buildChildEnv } from '../../src/security/env.js';
import { windowsSystemExecutable } from '../../src/platform/system.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPT = path.join(ROOT, 'scripts', 'setup-multimodal.mjs');
const owned: string[] = [];
const pythonFile = (venv: string) => path.join(venv, ...(process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python3']));
function fixture() {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dodo-animation-setup-'))); owned.push(base);
  const project = path.join(base, 'workspace'), config = path.join(base, 'state'); fs.mkdirSync(project);
  return { base, project, config, animation: path.join(config, 'animation'), venv: path.join(config, 'animation', 'venv') };
}
function run(f: ReturnType<typeof fixture>, args = ['--check'], extra: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: f.project, windowsHide: true, encoding: 'utf8', timeout: 45000,
    env: { ...process.env, DODO_CONFIG_DIR: f.config, ...extra }, maxBuffer: 128 * 1024 });
}
function privateState(f: ReturnType<typeof fixture>) { ensurePrivateDirectory(f.config); ensurePrivateDirectory(f.animation); }
afterAll(() => { for (const base of owned) fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 }); });

describe('animation dependency setup private paths and child environment', () => {
  it('checks an absent installation without creating state', () => {
    const f = fixture(), result = run(f);
    expect(result.status, result.stderr).toBe(0); expect(result.stdout).toContain('Animation engine: run');
    expect(fs.existsSync(f.config)).toBe(false);
  });
  it('reports an absent in-workspace installation as unavailable without creating it, but refuses an existing one', () => {
    const f = fixture(); f.config = path.join(f.project, 'state');
    const result = run(f); expect(result.status, result.stderr).toBe(0); expect(result.stdout).toContain('Animation engine: run');
    expect(fs.existsSync(f.config)).toBe(false);
    ensurePrivateDirectory(f.config);
    const existing = run(f); expect(existing.status).not.toBe(0); expect(existing.stderr).toContain('outside the workspace');
    expect(fs.readdirSync(f.config)).toEqual([]);
  });
  it('refuses installation inside the workspace before looking for Python or creating state', () => {
    const f = fixture(); f.config = path.join(f.project, 'state');
    const emptyPath = path.join(f.base, 'empty-path'); fs.mkdirSync(emptyPath);
    const result = run(f, ['--install-animation'], { PATH: emptyPath });
    expect(result.status).not.toBe(0); expect(result.stderr).toContain('outside the workspace');
    expect(result.stderr).not.toContain('Python 3.11 or newer was not found'); expect(fs.existsSync(f.config)).toBe(false);
  });
  it('refuses a linked animation directory before inspecting or executing its interpreter', () => {
    const f = fixture(), outside = path.join(f.base, 'outside'); ensurePrivateDirectory(f.config); ensurePrivateDirectory(outside);
    fs.symlinkSync(outside, f.animation, process.platform === 'win32' ? 'junction' : 'dir');
    const result = run(f); expect(result.status).not.toBe(0); expect(result.stderr).toContain('must not contain links');
    expect(fs.readdirSync(outside)).toEqual([]);
  });
  it('refuses a linked venv directory without following it', () => {
    const f = fixture(), outside = path.join(f.base, 'outside'); privateState(f); ensurePrivateDirectory(outside);
    fs.symlinkSync(outside, f.venv, process.platform === 'win32' ? 'junction' : 'dir');
    const result = run(f); expect(result.status).not.toBe(0); expect(result.stderr).toContain('must not contain links');
    expect(fs.readdirSync(outside)).toEqual([]);
  });
  it('refuses a permissive existing state boundary without repairing its permissions', () => {
    const f = fixture(); privateState(f);
    if (process.platform === 'win32') {
      const changed = spawnSync(windowsSystemExecutable('icacls.exe'), [f.config, '/grant', '*S-1-1-0:(RX)', '/q'], { windowsHide: true, encoding: 'utf8' });
      expect(changed.status, changed.stderr).toBe(0);
    } else fs.chmodSync(f.config, 0o755);
    const before = fs.statSync(f.config).mode, result = run(f);
    expect(result.status).not.toBe(0); expect(result.stderr).toMatch(/private|ACL/);
    if (process.platform !== 'win32') expect(fs.statSync(f.config).mode).toBe(before);
  });
  it('refuses an incomplete existing interpreter instead of invoking global pip', () => {
    const f = fixture(); privateState(f); ensurePrivateDirectory(f.venv); ensurePrivateDirectory(path.dirname(pythonFile(f.venv)));
    const sentinel = 'incomplete-private-venv'; fs.writeFileSync(pythonFile(f.venv), sentinel, { mode: 0o700 });
    const result = run(f); expect(result.status).not.toBe(0); expect(result.stderr).toContain('pyvenv.cfg missing');
    expect(fs.readFileSync(pythonFile(f.venv), 'utf8')).toBe(sentinel);
  });
  it('checks a real private venv with sanitized environment and preserves valid POSIX entry symlinks', context => {
    let basePython: string | undefined;
    for (const name of process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python']) {
      try {
        const candidate = resolveTrustedExecutable(name, ROOT, { allowBatch: false });
        const version = spawnSync(candidate, ['-I', '-c', 'import sys; print(int(sys.version_info >= (3, 11)))'], { env: buildChildEnv({ parentEnv: process.env, workspaceRoot: ROOT, extraAllowlist: [] }), windowsHide: true, encoding: 'utf8', timeout: 10000 });
        if (version.status === 0 && version.stdout.trim() === '1') { basePython = candidate; break; }
      } catch { /* next trusted name */ }
    }
    if (!basePython) { context.skip(); return; }
    const f = fixture(); privateState(f);
    const env = buildChildEnv({ parentEnv: process.env, workspaceRoot: f.project, extraAllowlist: [] });
    const created = spawnSync(basePython, ['-I', '-m', 'venv', '--without-pip', f.venv], { env, windowsHide: true, encoding: 'utf8', timeout: 45000 });
    expect(created.status, created.stderr).toBe(0);
    const located = spawnSync(pythonFile(f.venv), ['-I', '-c', 'import sysconfig; print(sysconfig.get_path("purelib"))'], { env, windowsHide: true, encoding: 'utf8' });
    expect(located.status, located.stderr).toBe(0);
    const libraries = located.stdout.trim();
    for (const name of ['PIL', 'pydantic', 'uharfbuzz']) {
      const directory = path.join(libraries, name); fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, '__init__.py'), 'import os\nassert "DODO_SETUP_SYNTHETIC_SECRET" not in os.environ and "OPENAI_API_KEY" not in os.environ, "server credentials reached Python"\n__version__ = "setup-fixture"\nVERSION = __version__\n');
    }
    const entry = fs.lstatSync(pythonFile(f.venv)), before = fs.readFileSync(path.join(f.venv, 'pyvenv.cfg'));
    const result = run(f, ['--check'], { DODO_SETUP_SYNTHETIC_SECRET: 'synthetic-only', OPENAI_API_KEY: 'synthetic-only' });
    expect(result.status, result.stderr).toBe(0); expect(result.stdout).toContain('ready (Pillow/pydantic/uharfbuzz setup-fixture setup-fixture setup-fixture)');
    expect(fs.readFileSync(path.join(f.venv, 'pyvenv.cfg'))).toEqual(before);
    expect(fs.lstatSync(pythonFile(f.venv)).isSymbolicLink()).toBe(entry.isSymbolicLink());
  }, 60000);
});
