import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertWindowsArgv } from '../../platform/shell.js';
import { signalOwnedProcess } from '../../platform/processTree.js';
import { renderSpeech } from '../../platform/speech.js';
import { WorkerSpec, WorkerResult, type WorkerSpecData, type WorkerResultData } from './contracts.js';

/** Runs as an OWNED JobManager subprocess. No URLs, shell strings, repository plugins or model downloads. */
const INPUT_FORMATS = 'mov,matroska,webm,wav,aiff,mp3,ogg,flac,aac,avi,mpegts,mpeg,gif';
const OUTPUT_CAP = 6 * 1024 * 1024;
async function command(program: string, args: string[], timeoutMs = 120000): Promise<string> {
  if (process.platform === 'win32') assertWindowsArgv(program, args);
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stop = () => { try { signalOwnedProcess(child, 'SIGKILL'); } catch { reject(new Error('owned media process termination failed')); } };
    let text = '', errors = '', size = 0, failure: Error | undefined;
    const timer = setTimeout(() => { failure = new Error('media decoder timed out'); stop(); }, timeoutMs);
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.stdout.on('data', (buffer: Buffer) => { size += buffer.length; if (size > 2 * 1024 * 1024) { failure = new Error('decoder stdout limit'); stop(); } else text += buffer.toString('utf8'); });
    child.stderr.on('data', (buffer: Buffer) => { errors = (errors + buffer.toString('utf8')).slice(-4000); });
    child.on('close', code => { clearTimeout(timer); if (failure) reject(failure); else if (code !== 0) reject(new Error(`media process exited ${code}: ${errors.slice(-1500)}`)); else resolve(text); });
  });
}
const inputArgs = (s: WorkerSpecData) => ['-protocol_whitelist', 'file,pipe', '-format_whitelist', INPUT_FORMATS, '-i', s.input];
const ffArgs = () => ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-max_alloc', '67108864', '-threads', '2', '-filter_threads', '1'];
async function probe(s: WorkerSpecData): Promise<NonNullable<WorkerResultData['metadata']>> {
  const raw = JSON.parse(await command(s.ffprobe, ['-v', 'error', '-max_alloc', '67108864', ...inputArgs(s), '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height', '-of', 'json'], 30000)) as { format?: { duration?: string }; streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number }> };
  const duration = Number(raw.format?.duration);
  const streams = (raw.streams ?? []).slice(0, 20).map(v => ({ type: v.codec_type ?? 'unknown', codec: v.codec_name ?? 'unknown', ...(v.width ? { width: v.width } : {}), ...(v.height ? { height: v.height } : {}) }));
  if (streams.some(v => (v.width ?? 0) * (v.height ?? 0) > 40_000_000)) throw new Error('decoded video frame exceeds 40 megapixels');
  return { durationSec: Number.isFinite(duration) && duration >= 0 ? duration : null, streams };
}
async function extractAudio(s: WorkerSpecData, output: string, seconds: number): Promise<void> {
  await command(s.ffmpeg, [...ffArgs(), '-ss', String(s.startSec), ...inputArgs(s), '-t', String(seconds), '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-fs', String(32 * 1024 * 1024), output]);
}
function checkFile(file: string, cap: number): void {
  const st = fs.lstatSync(file); if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size > cap || st.size === 0) throw new Error('missing, unsafe or oversized media output');
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600); // Windows files inherit the verified private directory DACL
}
export async function processMedia(s: WorkerSpecData): Promise<WorkerResultData> {
  const result: WorkerResultData = { operation: s.operation, files: [], notes: [] };
  if (s.operation === 'probe') result.metadata = await probe(s);
  else if (s.operation === 'frames') {
    const metadata = await probe(s); if (!metadata.streams.some(v => v.type === 'video')) throw new Error('media has no video stream');
    for (let i = 0; i < s.times.length; i++) {
      const at = s.times[i]!; if (metadata.durationSec !== null && at >= metadata.durationSec) throw new Error('requested frame is outside media duration');
      const name = `out-${i}.jpg`, out = path.join(s.directory, name);
      await command(s.ffmpeg, [...ffArgs(), '-ss', String(at), ...inputArgs(s), '-frames:v', '1', '-an', '-vf', `scale=${s.maxEdge}:${s.maxEdge}:force_original_aspect_ratio=decrease`, '-q:v', '4', '-fs', String(OUTPUT_CAP), out], 45000);
      checkFile(out, OUTPUT_CAP); result.files.push({ name, kind: 'image', mimeType: 'image/jpeg', timeSec: at });
    }
    result.notes.push('Frame timestamps are requested seek positions, not frame-perfect PTS guarantees. Unsampled intervals have not been seen.');
  } else if (s.operation === 'audio') {
    const name = 'out-0.wav', out = path.join(s.directory, name), duration = Math.min(120, s.durationSec);
    await extractAudio(s, out, duration); checkFile(out, OUTPUT_CAP);
    result.files.push({ name, kind: 'audio', mimeType: 'audio/wav', timeSec: s.startSec, endSec: s.startSec + duration });
    result.notes.push('PCM mono 16 kHz excerpt; endSec is requested interval, source may end earlier.');
  } else if (s.operation === 'transcribe') {
    if (!s.whisper || !s.model) throw new Error('local whisper.cpp executable and model are required');
    const wave = path.join(s.directory, 'transcription-input.wav'), prefix = path.join(s.directory, 'whisper-result');
    await extractAudio(s, wave, s.durationSec); checkFile(wave, 32 * 1024 * 1024);
    await command(s.whisper, ['-m', s.model, '-f', wave, '-l', s.language, '-oj', '-of', prefix, '-t', '4'], 480000);
    const jsonFile = `${prefix}.json`; checkFile(jsonFile, 4 * 1024 * 1024);
    const raw = JSON.parse(fs.readFileSync(jsonFile, 'utf8')) as { result?: { language?: string }; transcription?: Array<{ offsets?: { from?: number; to?: number }; text?: string }> };
    if (!Array.isArray(raw.transcription)) throw new Error('unrecognized whisper.cpp JSON output; no transcript claimed');
    const segments = raw.transcription.slice(0, 10000).map(item => ({ startSec: s.startSec + Number(item.offsets?.from ?? 0) / 1000, endSec: s.startSec + Number(item.offsets?.to ?? 0) / 1000, text: String(item.text ?? '').slice(0, 4000) }));
    if (segments.some(v => !Number.isFinite(v.startSec) || !Number.isFinite(v.endSec) || v.startSec < s.startSec || v.endSec < v.startSec || v.endSec > s.startSec + s.durationSec + 2)) throw new Error('invalid transcription timestamps');
    const name = 'out-0.json'; fs.writeFileSync(path.join(s.directory, name), JSON.stringify({ source: 'whisper.cpp', language: raw.result?.language ?? s.language, startSec: s.startSec, endSec: s.startSec + s.durationSec, segments, truncated: raw.transcription.length > 10000 }), { mode: 0o600, flag: 'wx' });
    result.files.push({ name, kind: 'transcript', mimeType: 'application/json', timeSec: s.startSec, endSec: s.startSec + s.durationSec });
    result.notes.push('Local ASR, not ground truth: timestamps/text may be wrong, especially music, noise, overlapping speakers or Thai mixed with English. No speaker identities inferred.');
  } else if (s.operation === 'speak') {
    const program = s.speechProgram ?? s.say;
    if (!program) throw new Error('a verified local speech engine is required; run dodo setup');
    const kind = s.speechKind ?? 'macos-say';
    const format = kind === 'macos-say' ? 'aiff' : 'wav';
    const rendered = path.join(s.directory, `speech.${format}`);
    await renderSpeech({ kind, program }, s.input, rendered, s.voice); checkFile(rendered, 32 * 1024 * 1024);
    const name = 'out-0.wav', out = path.join(s.directory, name);
    await command(s.ffmpeg, [...ffArgs(), '-protocol_whitelist', 'file,pipe', '-format_whitelist', format, '-i', rendered, '-t', '120', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-fs', String(OUTPUT_CAP), out]);
    checkFile(out, OUTPUT_CAP); result.files.push({ name, kind: 'audio', mimeType: 'audio/wav' });
    result.notes.push('Synthesized audio file, not played on speakers. Client audio-block support is required. Limited to the first 120 seconds.');
  }
  for (const file of result.files) checkFile(path.join(s.directory, file.name), OUTPUT_CAP);
  return WorkerResult.parse(result);
}
async function main() {
  const specFile = process.argv[2]; if (!specFile) throw new Error('private spec path required');
  const st = fs.lstatSync(specFile); if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size > 16384) throw new Error('invalid private spec');
  const spec = WorkerSpec.parse(JSON.parse(fs.readFileSync(specFile, 'utf8')));
  if (path.dirname(specFile) !== spec.directory) throw new Error('spec directory mismatch');
  const output = await processMedia(spec);
  fs.writeFileSync(path.join(spec.directory, 'result.json'), JSON.stringify(output), { flag: 'wx', mode: 0o600 });
  process.stdout.write(JSON.stringify({ operation: output.operation, outputs: output.files.length, status: 'completed' }) + '\n');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => { process.stderr.write(`Media processing failed: ${(err as Error).message}\n`); process.exitCode = 1; });
}
