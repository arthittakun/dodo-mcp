import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { downloadVerified, type DownloadPin } from './download.js';
import { registerManagedPath, activateManagedTools, assertSetupPrivatePaths } from './managedTools.js';
import { ensurePrivateDirectory } from '../platform/privateFs.js';
import { windowsSystemExecutable } from '../platform/system.js';
import { removeWithRetry, renameWithRetry } from '../platform/fsRetry.js';
import { buildChildEnv } from '../security/env.js';
import { renderSpeech } from '../platform/speech.js';

/** Official 1.52.0 release artifact, fetched and hashed during implementation. */
export const ESPEAK_WINDOWS_PIN: DownloadPin = {
  url: 'https://github.com/espeak-ng/espeak-ng/releases/download/1.52.0/espeak-ng.msi',
  sha256: '7f673c709ea5dd579d3b5ebb98688cc575328a6ab7438d2bc405b88cedaeafb9',
  bytes: 12765862,
};

/** Owner-invoked administrative-image extraction, not a global SAPI registration. */
export async function installWindowsSpeech(configDir: string, root: string): Promise<void> {
  if (process.platform !== 'win32') throw new Error('Windows speech installer called on another OS');
  const tools = path.join(configDir, 'tools'), downloads = path.join(tools, 'downloads');
  ensurePrivateDirectory(downloads);
  const pin = ESPEAK_WINDOWS_PIN, archive = path.join(downloads, `espeak-${pin.sha256}.msi`);
  await downloadVerified(pin, archive);
  const directory = path.join(tools, `espeak-${pin.sha256.slice(0, 16)}`);
  if (!fs.existsSync(directory)) {
    const stage = fs.mkdtempSync(path.join(tools, '.stage-espeak-')); ensurePrivateDirectory(stage);
    try {
      const installer = path.join(path.dirname(windowsSystemExecutable('cmd.exe')), 'msiexec.exe');
      const result = spawnSync(installer, ['/a', archive, '/qn', '/norestart', `TARGETDIR=${stage}`], {
        cwd: tools, shell: false, windowsHide: true, timeout: 180000, maxBuffer: 65536,
        env: buildChildEnv({ parentEnv: process.env, workspaceRoot: root, extraAllowlist: [] }),
      });
      if (result.error || result.status !== 0) throw new Error(`eSpeak administrative extraction failed (${result.status ?? 'spawn failure'}); no global voice registration or automatic reboot was requested`);
      renameWithRetry(stage, directory);
    } finally { if (fs.existsSync(stage)) removeWithRetry(stage, true); }
  }
  assertSetupPrivatePaths([directory]);
  const candidates: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 8) throw new Error('unexpected eSpeak archive depth');
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      if (item.isSymbolicLink()) throw new Error('eSpeak installation contains a directory link');
      const file = path.join(dir, item.name);
      if (item.isDirectory()) walk(file, depth + 1);
      else if (item.isFile() && item.name.toLowerCase() === 'espeak-ng.exe') candidates.push(file);
    }
  };
  walk(directory, 0);
  if (candidates.length !== 1) throw new Error('eSpeak extraction did not produce one unambiguous CLI executable');
  const selected = candidates[0]!;
  const probe = spawnSync(selected, ['--version'], {
    cwd: path.dirname(selected), shell: false, windowsHide: true, timeout: 10000, maxBuffer: 16384,
    env: buildChildEnv({ parentEnv: process.env, workspaceRoot: root, extraAllowlist: [] }),
  });
  if (probe.error || probe.status !== 0) throw new Error('extracted eSpeak executable did not pass its native version probe');
  const verify = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dodo-espeak-probe-'))); ensurePrivateDirectory(verify);
  try {
    const input = path.join(verify, 'input.txt'), output = path.join(verify, 'output.wav');
    fs.writeFileSync(input, 'DODO setup speech verification.', { flag: 'wx', mode: 0o600 });
    await renderSpeech({ kind: 'espeak-ng', program: selected }, input, output);
    const bytes = fs.readFileSync(output);
    if (bytes.length < 100 || bytes.subarray(0, 4).toString('ascii') !== 'RIFF') throw new Error('extracted eSpeak did not render a valid WAV file');
  } finally { removeWithRetry(verify, true); }
  registerManagedPath(configDir, path.dirname(selected)); activateManagedTools(configDir, root);
}
