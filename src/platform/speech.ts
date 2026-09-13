import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { DodoError } from '../errors.js';
import { resolveTrustedExecutable } from './execResolve.js';
import { windowsSystemExecutable } from './system.js';
import { signalOwnedProcess } from './processTree.js';

export type SpeechKind = 'macos-say' | 'windows-sapi' | 'espeak-ng';
export interface SpeechEngine { kind: SpeechKind; program: string }

/** Constant code: paths/voice are JSON on stdin, never interpolated PowerShell or SSML. */
export const WINDOWS_SPEECH_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Speech
$s = [System.Speech.Synthesis.SpeechSynthesizer]::new()
try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $voices = @($s.GetInstalledVoices() | Where-Object { $_.Enabled })
  if ($voices.Count -eq 0) { throw 'no installed speech voice' }
  if ($request.mode -eq 'probe') { [Console]::Write('ready'); exit 0 }
  if ($request.mode -ne 'speak') { throw 'invalid speech mode' }
  if ($request.voice) { $s.SelectVoice([string]$request.voice) }
  $text = [IO.File]::ReadAllText([string]$request.input, [Text.Encoding]::UTF8)
  if ($text.Length -gt 8000) { throw 'speech input too large' }
  if ([IO.File]::Exists([string]$request.output)) { throw 'speech output already exists' }
  $s.SetOutputToWaveFile([string]$request.output)
  $s.Speak($text)
  $s.SetOutputToNull()
  [Console]::Write('completed')
} finally { $s.Dispose() }
`;
export const windowsSpeechArgs = () => ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(WINDOWS_SPEECH_SCRIPT, 'utf16le').toString('base64')];

/** Availability is actually probed on Windows (a PowerShell binary alone is not a voice). */
export function findSpeechEngine(root: string): SpeechEngine | undefined {
  if (process.platform === 'darwin') {
    try { return { kind: 'macos-say', program: resolveTrustedExecutable('say', root, { allowBatch: false }) }; } catch { /* try portable engine */ }
  }
  if (process.platform === 'win32') {
    try {
      const program = windowsSystemExecutable('WindowsPowerShell/v1.0/powershell.exe');
      const probe = spawnSync(program, windowsSpeechArgs(), { shell: false, windowsHide: true, input: JSON.stringify({ mode: 'probe' }), encoding: 'utf8', timeout: 10000, maxBuffer: 16384 });
      if (!probe.error && probe.status === 0 && probe.stdout.trim() === 'ready') return { kind: 'windows-sapi', program };
    } catch { /* an absent voice needs eSpeak, not an invented capability */ }
  }
  try {
    const program = resolveTrustedExecutable('espeak-ng', root, { allowBatch: false });
    const probe = spawnSync(program, ['--version'], { shell: false, windowsHide: true, timeout: 5000, maxBuffer: 16384 });
    if (!probe.error && probe.status === 0) return { kind: 'espeak-ng', program };
  } catch { /* reported by setup */ }
  return undefined;
}

/** Render to a private file only. Never plays audio, opens a microphone or downloads a voice. */
export async function renderSpeech(engine: SpeechEngine, input: string, output: string, voice?: string): Promise<void> {
  const st = fs.lstatSync(input);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size > 32000) throw new DodoError('PATH_DENIED', 'invalid private speech input');
  if (fs.existsSync(output)) throw new DodoError('CONFLICT', 'speech output already exists');
  const args = engine.kind === 'windows-sapi' ? windowsSpeechArgs() : engine.kind === 'macos-say'
    ? [...(voice ? ['-v', voice] : []), '-f', input, '-o', output]
    : ['-b', '1', ...(voice ? ['-v', voice] : []), '-f', input, '-w', output];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(engine.program, args, { shell: false, windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    let ended = false, failure: Error | undefined;
    const timer = setTimeout(() => { failure = new DodoError('TIMEOUT', 'speech synthesis timed out'); try { signalOwnedProcess(child, 'SIGKILL'); } catch { /* report failure, never success */ } }, 90000);
    child.stderr.resume(); // Speech input and OS details must not leak in error text.
    child.stdin.on('error', () => undefined);
    child.on('error', () => { ended = true; clearTimeout(timer); reject(new DodoError('NOT_SUPPORTED', 'speech engine could not start')); });
    child.on('close', code => {
      clearTimeout(timer); if (ended) return;
      if (failure) reject(failure);
      else if (code !== 0) reject(new DodoError('NOT_SUPPORTED', 'speech engine failed; check the installed voice in dodo setup'));
      else resolve();
    });
    child.stdin.end(engine.kind === 'windows-sapi' ? JSON.stringify({ mode: 'speak', input, output, voice }) : undefined);
  });
  const result = fs.lstatSync(output);
  if (!result.isFile() || result.isSymbolicLink() || result.nlink !== 1 || result.size < 44 || result.size > 32 * 1024 * 1024) throw new DodoError('RESOURCE_LIMIT', 'speech output is missing, unsafe or oversized');
}
