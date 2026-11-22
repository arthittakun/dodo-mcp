#!/usr/bin/env node
/** Explicit, opt-in local dependency/model preparation. Never an npm install hook. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const MODEL = {
  url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin',
  sha256: 'be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21',
  bytes: 77691713,
};
const args = process.argv.slice(2);
// Pinned, wheel-only dependencies of the bundled Gift animation engine (engines/animation).
const ANIMATION_PACKAGES = ['Pillow==13.0.0', 'pydantic==2.14.4', 'uharfbuzz==0.57.0'];
const usage = 'Usage: dodo-media-setup [--check] [--install-browser] [--download-model] [--install-animation]\nRuns from your chosen project directory. Model destination: ./models/ggml-tiny.bin\n--install-animation creates a private Python venv in the DODO config directory (animation/venv) with ' + ANIMATION_PACKAGES.join(', ') + ' for the animation_* tools.\nNo flags/--check only reports readiness; downloads require explicit flags.\nDoes not change DODO permissions/configuration or start/restart any server.';
if (args.includes('--help') || args.includes('-h')) { console.log(usage); process.exit(0); }
if (args.some(a => !['--download-model', '--check', '--install-browser', '--install-animation'].includes(a))) throw new Error(usage);
if (args.includes('--check') && args.length !== 1) throw new Error('--check is read-only and cannot be combined with installation flags');
if (args.includes('--install-browser')) {
  // Resolve the CLI belonging to this installed DODO, never an unpinned npx package.
  const require = createRequire(import.meta.url);
  const cli = path.join(path.dirname(require.resolve('playwright/package.json')), 'cli.js');
  const installed = spawnSync(process.execPath, [cli, 'install', 'chromium'], { stdio: 'inherit', timeout: 300000 });
  if (installed.error || installed.status !== 0) throw new Error('Chromium installation failed; no DODO configuration changed');
}
// Windows searches cwd for bare executables. Even a readiness probe must not
// execute a repository-planted ffmpeg.exe/whisper-cli.exe. Published packages
// ship these helpers; an unbuilt checkout reports not-checked, never falls back.
let nativeProbes;
try {
  const { resolveTrustedExecutable, trustedExecutable } = await import('../dist/platform/execResolve.js');
  const { buildChildEnv } = await import('../dist/security/env.js');
  const { ensurePrivateDirectory, assertPrivatePath } = await import('../dist/platform/privateFs.js');
  const { isWithinPath } = await import('../dist/platform/pathPolicy.js');
  nativeProbes = { resolveTrustedExecutable, trustedExecutable, ensurePrivateDirectory, assertPrivatePath, isWithinPath,
    env: buildChildEnv({ parentEnv: process.env, workspaceRoot: process.cwd(), extraAllowlist: [] }) };
} catch { /* source checkout must be built before native dependency probes */ }
for (const [name, argv] of [['ffmpeg', ['-version']], ['ffprobe', ['-version']], ['whisper-cli', ['--help']]]) {
  if (!nativeProbes) { console.log(`${name}: not checked (build DODO first; trusted resolver unavailable)`); continue; }
  try {
    const executable = nativeProbes.resolveTrustedExecutable(name, process.cwd(), { allowBatch: false });
    const probe = spawnSync(executable, argv, { env: nativeProbes.env, shell: false, windowsHide: true, encoding: 'utf8', timeout: 10000, maxBuffer: 128 * 1024 });
    console.log(`${name}: ${!probe.error && probe.status === 0 ? 'available' : 'probe failed'}`);
  } catch { console.log(`${name}: missing from trusted PATH or denied by path policy`); }
}
try { const { chromium } = await import('playwright'); console.log(`Chromium: ${fs.existsSync(chromium.executablePath()) ? 'installed' : 'run dodo-media-setup --install-browser'}`); }
catch { console.log('Playwright: run npm install first'); }
if (args.includes('--download-model')) {
  const directory = path.resolve('models');
  if (fs.existsSync(directory)) { const st = fs.lstatSync(directory); if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('models must be a real directory'); }
  else fs.mkdirSync(directory, { mode: 0o700 });
  const target = path.join(directory, 'ggml-tiny.bin');
  const hashFile = async file => { const hash = createHash('sha256'); for await (const chunk of fs.createReadStream(file)) hash.update(chunk); return hash.digest('hex'); };
  if (fs.existsSync(target)) {
    const st = fs.lstatSync(target); if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size !== MODEL.bytes || await hashFile(target) !== MODEL.sha256) throw new Error('existing model does not match the pinned SHA256; refusing to overwrite');
    console.log('Whisper tiny multilingual model: already verified');
  } else {
    const temporary = path.join(directory, `.ggml-tiny-${process.pid}.part`);
    try {
      const response = await fetch(MODEL.url, { signal: AbortSignal.timeout(180000) });
      if (!response.ok || !response.body) throw new Error(`model fetch failed: ${response.status}`);
      let bytes = 0; const hash = createHash('sha256');
      const verify = new Transform({ transform(chunk, _encoding, callback) { bytes += chunk.length; if (bytes > MODEL.bytes) return callback(new Error('model size exceeds pin')); hash.update(chunk); callback(null, chunk); } });
      await pipeline(Readable.fromWeb(response.body), verify, fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
      if (bytes !== MODEL.bytes || hash.digest('hex') !== MODEL.sha256) throw new Error('model integrity verification failed');
      await fs.promises.link(temporary, target); await fs.promises.unlink(temporary);
      console.log(`Whisper model verified: models/ggml-tiny.bin (${bytes} bytes)`);
    } catch (err) { try { fs.unlinkSync(temporary); } catch { /* no partial file */ } throw err; }
  }
}
// Local animation engine: a private venv under the DODO config directory, never the workspace.
let animationVenv;
try { const { resolveConfigDir } = await import('../dist/config/paths.js'); animationVenv = path.join(resolveConfigDir().dir, 'animation', 'venv'); }
catch { /* source checkout must be built before the config directory can be resolved */ }
const venvPython = venv => path.join(venv, ...(process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python3']));
const samePath = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
const existsEntry = target => { try { fs.lstatSync(target); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
function assertCanonicalParents(target) {
  const absolute = path.resolve(target), root = path.parse(absolute).root;
  for (let item = absolute; item !== root; item = path.dirname(item)) {
    if (!existsEntry(item)) continue;
    if (fs.lstatSync(item).isSymbolicLink() || !samePath(fs.realpathSync.native(item), item)) throw new Error('animation setup paths must not contain links or noncanonical directories');
  }
}
/** Validate the private state boundary before running an existing interpreter.
 * POSIX venv entries may themselves link to a trusted system Python; directory
 * links are never admitted. The private boundary keeps ordinary 0755 venv
 * subdirectories private without changing a working user's environment.
 */
function animationPaths(create = false) {
  if (!nativeProbes || !animationVenv) throw new Error('build DODO first so animation setup can verify private paths');
  const directory = path.dirname(animationVenv), config = path.dirname(directory);
  // A read-only check of an absent installation cannot execute its Python or
  // create anything, even when the caller selected a location under cwd.
  if (!create && !existsEntry(config)) return false;
  if (nativeProbes.isWithinPath(process.cwd(), config)) throw new Error('animation setup state must be outside the workspace');
  for (const boundary of [config, directory]) {
    assertCanonicalParents(boundary);
    if (!existsEntry(boundary)) { if (!create) return false; nativeProbes.ensurePrivateDirectory(boundary); }
    nativeProbes.assertPrivatePath(boundary, true);
  }
  for (const child of [animationVenv, path.dirname(venvPython(animationVenv))]) {
    assertCanonicalParents(child);
    if (!existsEntry(child)) continue;
    const stat = fs.lstatSync(child);
    if (!stat.isDirectory()) throw new Error('animation venv directories must be regular owner directories');
    if (process.platform === 'win32') nativeProbes.assertPrivatePath(child, true);
    else if (stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0) throw new Error('animation venv directories must not be writable by other users');
  }
  const python = venvPython(animationVenv);
  if (!existsEntry(python)) return false;
  const configFile = path.join(animationVenv, 'pyvenv.cfg');
  if (!existsEntry(configFile)) throw new Error('animation Python is not a complete private venv (pyvenv.cfg missing); refusing to install into a global Python');
  const configStat = fs.lstatSync(configFile);
  if (!configStat.isFile() || configStat.isSymbolicLink() || configStat.nlink !== 1) throw new Error('animation venv configuration must be an unlinked owner file');
  if (process.platform === 'win32') nativeProbes.assertPrivatePath(configFile);
  else if (configStat.uid !== process.getuid?.() || (configStat.mode & 0o022) !== 0) throw new Error('animation venv configuration must not be writable by other users');
  const entry = fs.lstatSync(python);
  if (process.platform === 'win32') nativeProbes.assertPrivatePath(python);
  else if (!entry.isSymbolicLink() && (!entry.isFile() || entry.nlink !== 1 || entry.uid !== process.getuid?.() || (entry.mode & 0o022) !== 0)) throw new Error('animation Python must be an owner file or a trusted system-Python symlink');
  if (!nativeProbes.trustedExecutable(python, process.cwd(), false)) throw new Error('animation Python must be a trusted executable outside the workspace');
  return true;
}
const VENV_CHECK = 'import os, sys; assert sys.version_info >= (3, 11), "Python 3.11 or newer is required"; expected = os.path.normcase(os.path.realpath(sys.argv[1])); assert os.path.normcase(os.path.realpath(sys.prefix)) == expected and sys.prefix != sys.base_prefix, "not the requested private venv"';
const probeAnimation = python => {
  animationPaths();
  const probe = spawnSync(python, ['-I', '-c', `${VENV_CHECK}; import PIL, pydantic, uharfbuzz; print(PIL.__version__, pydantic.VERSION, uharfbuzz.__version__)`, animationVenv], { env: nativeProbes.env, shell: false, windowsHide: true, encoding: 'utf8', timeout: 30000 });
  return !probe.error && probe.status === 0 ? probe.stdout.trim() : undefined;
};
if (args.includes('--install-animation')) {
  if (!nativeProbes || !animationVenv) throw new Error('build DODO first (npm run build) so the trusted Python resolver and config directory are available');
  const existingVenv = animationPaths(true);
  let base;
  for (const name of process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python']) {
    try {
      const candidate = nativeProbes.resolveTrustedExecutable(name, process.cwd(), { allowBatch: false });
      const version = spawnSync(candidate, ['-I', '-c', 'import sys; print(int(sys.version_info >= (3, 11)))'], { env: nativeProbes.env, shell: false, windowsHide: true, encoding: 'utf8', timeout: 30000 });
      if (!version.error && version.status === 0 && version.stdout.trim() === '1') { base = candidate; break; }
    } catch { /* try the next name */ }
  }
  if (!base) throw new Error('Python 3.11 or newer was not found on the trusted PATH; install it outside this project first');
  if (!existingVenv) {
    const created = spawnSync(base, ['-I', '-m', 'venv', animationVenv], { env: nativeProbes.env, stdio: 'inherit', shell: false, windowsHide: true, timeout: 300000 });
    if (created.error || created.status !== 0) throw new Error('creating the animation venv failed; no DODO configuration changed');
  }
  if (!animationPaths()) throw new Error('creating the animation venv did not produce a trusted Python');
  const activeVenv = spawnSync(venvPython(animationVenv), ['-I', '-c', VENV_CHECK, animationVenv], { env: nativeProbes.env, shell: false, windowsHide: true, timeout: 30000 });
  if (activeVenv.error || activeVenv.status !== 0) throw new Error('animation Python did not activate the requested private venv; no packages were installed');
  // Wheels only: no package build scripts run on this machine.
  const installed = spawnSync(venvPython(animationVenv), ['-I', '-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '--only-binary=:all:', ...ANIMATION_PACKAGES], { env: nativeProbes.env, stdio: 'inherit', shell: false, windowsHide: true, timeout: 600000 });
  if (installed.error || installed.status !== 0) throw new Error('installing the animation packages failed; no DODO configuration changed');
}
if (animationVenv && animationPaths()) {
  const versions = probeAnimation(venvPython(animationVenv));
  console.log(`Animation engine: ${versions ? `ready (Pillow/pydantic/uharfbuzz ${versions})` : 'venv present but packages missing; rerun --install-animation'}`);
} else console.log('Animation engine: run dodo-media-setup --install-animation (or set DODO_ANIMATION_PYTHON)');
console.log('No DODO permissions/configuration changed. Use modelFile: "models/ggml-tiny.bin" when this workspace is active.');
