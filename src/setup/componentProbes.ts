import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { resolveTrustedExecutable } from '../platform/execResolve.js';
import { batchInvocation } from '../platform/shell.js';
import { ensurePrivateDirectory } from '../platform/privateFs.js';
import { removeWithRetry } from '../platform/fsRetry.js';
import { signalOwnedProcess } from '../platform/processTree.js';
import { buildChildEnv } from '../security/env.js';
import { findSpeechEngine, renderSpeech } from '../platform/speech.js';
import { loadGlobalConfig, type GlobalConfig } from '../config/globalConfig.js';
import { processMedia } from '../services/multimodal/mediaWorker.js';
import { WorkerSpec } from '../services/multimodal/contracts.js';
import { MODEL_PIN, verifiedFile } from './download.js';

export const SETUP_LSP_LANGUAGES = ['python', 'html', 'css', 'json', 'yaml', 'bash'] as const;

/** Readiness is not inferred from an installed package name. Each LSP must answer initialize AND shutdown. */
export async function probeLanguageServer(server: GlobalConfig['lsp'][string], root: string, cwd: string, timeoutMs = 30000): Promise<void> {
  const program = resolveTrustedExecutable(server.command, root, { allowAbsolute: true, allowBatch: false });
  await new Promise<void>((resolve, reject) => {
    const child = spawn(program, server.args, { cwd, env: buildChildEnv({ parentEnv: process.env, workspaceRoot: root, extraAllowlist: [] }), shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = Buffer.alloc(0), total = 0, initialized = false, shutdown = false, failure: Error | undefined, settled = false;
    const send = (message: unknown) => {
      const content = Buffer.from(JSON.stringify(message));
      child.stdin.write(`Content-Length: ${content.length}\r\n\r\n`); child.stdin.write(content);
    };
    const fail = (message: string) => { if (failure) return; failure = new Error(message); try { signalOwnedProcess(child, 'SIGKILL'); } catch { /* close/error is handled below */ } };
    const timer = setTimeout(() => fail('language server did not complete the initialize/shutdown probe'), timeoutMs);
    child.stderr.resume(); child.stdin.on('error', () => undefined);
    child.on('error', () => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error('language server could not start')); } });
    child.stdout.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > 2 * 1024 * 1024) { fail('language server output exceeds the setup probe budget'); return; }
      buffer = Buffer.concat([buffer, chunk]);
      try {
        while (!failure) {
          const end = buffer.indexOf('\r\n\r\n'); if (end < 0) break;
          const header = buffer.subarray(0, end).toString('ascii'), match = /^Content-Length:\s*(\d+)\s*$/im.exec(header);
          if (!match) throw new Error('invalid LSP framing');
          const size = Number(match[1]); if (!Number.isSafeInteger(size) || size < 2 || size > 1024 * 1024) throw new Error('invalid LSP content length');
          if (buffer.length < end + 4 + size) break;
          const message = JSON.parse(buffer.subarray(end + 4, end + 4 + size).toString('utf8')) as { id?: string | number; method?: string; error?: unknown; result?: unknown };
          buffer = buffer.subarray(end + 4 + size);
          if (message.id === 1 && !message.method) {
            if (message.error || !message.result || typeof message.result !== 'object' || !('capabilities' in message.result)) throw new Error('language server initialization failed');
            initialized = true;
            send({ jsonrpc: '2.0', method: 'initialized', params: {} });
            send({ jsonrpc: '2.0', id: 2, method: 'shutdown', params: null });
          } else if (message.id === 2 && !message.method) {
            if (!initialized || message.error) throw new Error('language server shutdown failed');
            shutdown = true; send({ jsonrpc: '2.0', method: 'exit' }); child.stdin.end();
          } else if (message.method && message.id !== undefined) {
            send({ jsonrpc: '2.0', id: message.id, result: message.method === 'workspace/configuration' ? [] : null });
          }
        }
      } catch { fail('language server returned an invalid or failed protocol response'); }
    });
    child.once('close', code => {
      clearTimeout(timer); if (settled) return; settled = true;
      if (failure) reject(failure);
      else if (!initialized || !shutdown || code !== 0) reject(new Error(`language server protocol probe was incomplete (exit ${code})`));
      else resolve();
    });
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { processId: process.pid, rootUri: pathToFileURL(cwd).href, capabilities: {}, clientInfo: { name: 'DODO setup probe' }, workspaceFolders: null } });
  });
}

function binary(root: string, name: string): string { return resolveTrustedExecutable(name, root, { allowBatch: false }); }
function run(root: string, program: string, args: string[], cwd: string, additions: NodeJS.ProcessEnv = {}): string {
  const invocation = process.platform === 'win32' && /\.(cmd|bat)$/i.test(program) ? batchInvocation(program, args, root) : { program, args, windowsVerbatimArguments: false };
  const result = spawnSync(invocation.program, invocation.args, { cwd, env: { ...buildChildEnv({ parentEnv: process.env, workspaceRoot: root, extraAllowlist: [] }), ...additions }, shell: false, windowsHide: true, windowsVerbatimArguments: invocation.windowsVerbatimArguments, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`native ${path.basename(program)} probe failed (exit ${result.status ?? 'spawn failure'})`);
  return result.stdout;
}
function silence(file: string, seconds = 1): void {
  const samples = 16000 * seconds, data = Buffer.alloc(44 + samples * 2);
  data.write('RIFF', 0); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(16000, 24); data.writeUInt32LE(32000, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
  data.write('data', 36); data.writeUInt32LE(samples * 2, 40);
  fs.writeFileSync(file, data, { flag: 'wx', mode: 0o600 });
}

/** Explicit local setup only: fixtures are private and removed; no project code is executed. */
export async function verifyInstalledComponent(component: string, root: string, configDir: string): Promise<string | undefined> {
  if (!['git', 'ripgrep', 'adb', 'cloudflared', 'speech', 'lsp', 'chromium', 'ffmpeg', 'whisper'].includes(component)) return undefined;
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dodo-setup-probe-'))); ensurePrivateDirectory(directory);
  try {
    if (component === 'git') {
      const git = binary(root, 'git'), empty = path.join(directory, 'empty-config');
      fs.writeFileSync(empty, '', { flag: 'wx', mode: 0o600 });
      const templates = path.join(directory, 'empty-templates'); fs.mkdirSync(templates);
      const repository = path.join(directory, 'repository'); fs.mkdirSync(repository);
      const env = { GIT_CONFIG_GLOBAL: empty, GIT_CONFIG_NOSYSTEM: '1' };
      const options = ['-c', `core.hooksPath=${templates}`, '-c', 'core.quotepath=false'];
      run(root, git, [...options, 'init', '--quiet', `--template=${templates}`], repository, env);
      const file = 'DODO ไทย space.txt'; fs.writeFileSync(path.join(repository, file), 'DODO_GIT_PROBE\n', { flag: 'wx' });
      run(root, git, [...options, 'add', '--', file], repository, env);
      const diff = run(root, git, [...options, 'diff', '--cached', '--no-ext-diff', '--no-textconv', '--', file], repository, env);
      if (!diff.includes('+DODO_GIT_PROBE')) throw new Error('Git did not stage and diff the disposable UTF-8 fixture');
      return 'native Git initialized a disposable repository and staged/diffed a Thai/spaced filename; no commits/hooks/global config changes';
    }
    if (component === 'ripgrep') {
      const file = path.join(directory, 'ไทย space.txt'); fs.writeFileSync(file, 'DODO_RG_PROBE\n', { flag: 'wx' });
      const output = run(root, binary(root, 'rg'), ['--no-config', '--fixed-strings', '--json', '--', 'DODO_RG_PROBE', file], directory);
      if (!output.split(/\r?\n/).filter(Boolean).some(line => (JSON.parse(line) as { type?: string }).type === 'match')) throw new Error('ripgrep did not return a real fixture match');
      return 'native ripgrep found the exact token in a Thai/spaced fixture path';
    }
    if (component === 'adb') {
      const output = run(root, binary(root, 'adb'), ['version'], directory);
      if (!/Android Debug Bridge version/i.test(output)) throw new Error('adb did not return its version identity');
      return 'Android SDK Platform-Tools adb started and returned its version; no device connection, pairing or command was attempted';
    }
    if (component === 'cloudflared') {
      const output = run(root, binary(root, 'cloudflared'), ['--version'], directory);
      if (!/cloudflared version/i.test(output)) throw new Error('cloudflared did not return its version identity');
      return 'cloudflared executable started and returned its version; no tunnel, network connection or credential was used';
    }
    if (component === 'speech') {
      const engine = findSpeechEngine(root); if (!engine) throw new Error('no native speech engine passed its readiness probe');
      const input = path.join(directory, 'input.txt'), output = path.join(directory, engine.kind === 'macos-say' ? 'output.aiff' : 'output.wav');
      fs.writeFileSync(input, 'DODO setup verifies local speech.', { mode: 0o600, flag: 'wx' });
      await renderSpeech(engine, input, output);
      const bytes = fs.readFileSync(output), header = bytes.subarray(0, 4).toString('ascii');
      if (bytes.length < 100 || !['FORM', 'RIFF'].includes(header)) throw new Error('speech engine did not produce an audio file');
      return `${engine.kind} rendered a real local audio file (${bytes.length} bytes); no playback or microphone access`;
    }
    if (component === 'lsp') {
      const config = loadGlobalConfig(path.join(configDir, 'config.json'));
      for (const language of SETUP_LSP_LANGUAGES) {
        const server = config.lsp[language]; if (!server) throw new Error(`language server is not registered: ${language}`);
        try { await probeLanguageServer(server, root, directory); }
        catch (error) { throw new Error(`${language}: ${(error as Error).message}`); }
      }
      return 'Python/HTML/CSS/JSON/YAML/Bash each answered LSP initialize and shutdown and exited successfully';
    }
    if (component === 'chromium') {
      const { chromium } = await import('playwright');
      const executable = chromium.executablePath();
      if (!fs.existsSync(executable)) throw new Error('Playwright-matched Chromium executable is missing');
      const browser = await chromium.launch({ executablePath: executable, headless: true, chromiumSandbox: true, timeout: 15000 });
      try {
        const page = await browser.newPage();
        await page.setContent('<title>DODO setup fixture</title><button id="probe">Probe</button>');
        await page.click('#probe');
        const image = await page.screenshot({ type: 'jpeg', quality: 70 });
        if (await page.title() !== 'DODO setup fixture' || image.length < 100) throw new Error('Chromium did not complete the local page/click/screenshot probe');
      } finally { await browser.close(); }
      return 'Playwright-matched Chromium launched with its browser sandbox, rendered/clicked a local page and returned a screenshot';
    }
    const ffmpeg = binary(root, 'ffmpeg'), ffprobe = binary(root, 'ffprobe'), input = path.join(directory, 'fixture.wav'); silence(input);
    if (component === 'ffmpeg') {
      const spec = WorkerSpec.parse({ operation: 'probe', input, directory, ffmpeg, ffprobe, startSec: 0, durationSec: 1, times: [], maxEdge: 320, language: 'en' });
      const metadata = await processMedia(spec);
      if (!metadata.metadata?.streams.some(stream => stream.type === 'audio')) throw new Error('ffprobe failed to identify generated audio');
      const excerpt = await processMedia({ ...spec, operation: 'audio' });
      if (!excerpt.files.some(file => file.kind === 'audio')) throw new Error('audio extraction did not produce output');
      const videoDir = path.join(directory, 'video'); fs.mkdirSync(videoDir);
      const video = path.join(videoDir, 'fixture.mp4');
      run(root, ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:r=1:d=1', '-c:v', 'mpeg4', '-y', video], videoDir);
      const frames = await processMedia({ ...spec, operation: 'frames', input: video, directory: videoDir, times: [0] });
      if (!frames.files.some(file => file.kind === 'image')) throw new Error('video frame extraction did not produce output');
      return 'DODO media worker probed generated audio, extracted PCM audio and decoded a generated video frame';
    }
    const model = path.join(configDir, 'models', 'ggml-tiny.bin');
    if (!await verifiedFile(model, MODEL_PIN)) throw new Error('Whisper inference probe requires the verified default model; include model in setup components');
    let whisper: string;
    try { whisper = binary(root, 'whisper-cli'); } catch { whisper = binary(root, 'whisper-cpp'); }
    // whisper.cpp emits a canonical 10-second [BLANK_AUDIO] segment for short
    // silence. Give the inference probe a matching 10-second bounded fixture so
    // DODO's timestamp validator is exercised rather than falsely rejecting it.
    const whisperInput = path.join(directory, 'whisper-fixture.wav'); silence(whisperInput, 10);
    const spec = WorkerSpec.parse({ operation: 'transcribe', input: whisperInput, directory, ffmpeg, ffprobe, whisper, model, startSec: 0, durationSec: 10, times: [], maxEdge: 320, language: 'en' });
    const result = await processMedia(spec);
    const transcript = result.files.find(file => file.kind === 'transcript'); if (!transcript) throw new Error('Whisper returned no transcription result');
    const value = JSON.parse(fs.readFileSync(path.join(directory, transcript.name), 'utf8')) as { segments?: unknown };
    if (!Array.isArray(value.segments)) throw new Error('Whisper output did not contain a valid segment array');
    return 'whisper.cpp loaded the pinned model and completed inference on synthetic silent audio; this is not an ASR accuracy assessment';
  } finally { removeWithRetry(directory, true); }
}
