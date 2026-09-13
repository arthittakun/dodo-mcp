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
const usage = 'Usage: dodo-media-setup [--check] [--install-browser] [--download-model]\nRuns from your chosen project directory. Model destination: ./models/ggml-tiny.bin\nNo flags/--check only reports readiness; downloads require explicit flags.\nDoes not change DODO permissions/configuration or start/restart any server.';
if (args.includes('--help') || args.includes('-h')) { console.log(usage); process.exit(0); }
if (args.some(a => !['--download-model', '--check', '--install-browser'].includes(a))) throw new Error(usage);
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
  const { resolveTrustedExecutable } = await import('../dist/platform/execResolve.js');
  const { buildChildEnv } = await import('../dist/security/env.js');
  nativeProbes = { resolveTrustedExecutable, env: buildChildEnv({ parentEnv: process.env, workspaceRoot: process.cwd(), extraAllowlist: [] }) };
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
console.log('No DODO permissions/configuration changed. Use modelFile: "models/ggml-tiny.bin" when this workspace is active.');
