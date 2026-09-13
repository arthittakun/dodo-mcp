import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DodoError } from '../errors.js';
import { windowsSystemExecutable } from '../platform/system.js';

export interface DownloadPin { url: string; sha256: string; bytes: number }
export const MODEL_PIN: DownloadPin = {
  url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin',
  sha256: 'be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21', bytes: 77691713,
};
/** Pinned publisher release assets, researched 2026-09-10. No latest-at-install execution. */
export const WINDOWS_PINS: Record<'git' | 'ripgrep' | 'ffmpeg' | 'whisper', DownloadPin> = {
  git: { url: 'https://github.com/git-for-windows/git/releases/download/v2.55.0.windows.5/MinGit-2.55.0.5-64-bit.zip', sha256: '56d7b226b7693196cfc71fef26568f536c4a021ab6c37ff2db4287bed908e96e', bytes: 38989688 },
  ripgrep: { url: 'https://github.com/BurntSushi/ripgrep/releases/download/15.2.0/ripgrep-15.2.0-x86_64-pc-windows-msvc.zip', sha256: '71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5', bytes: 1789611 },
  ffmpeg: { url: 'https://github.com/GyanD/codexffmpeg/releases/download/9.0.1/ffmpeg-9.0.1-essentials_build.zip', sha256: 'fec81ae03971d9dd4be3ebe02e263bd2ec1d789483f931bdba5f5715e65da2e9', bytes: 111253802 },
  whisper: { url: 'https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.2/whisper-bin-x64.zip', sha256: '49dcc16de826f20bd53d44f947a1ae49dfa81f86cad67a64d80820cb192d674a', bytes: 8194445 },
};
const HOSTS = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'huggingface.co', 'cdn-lfs.huggingface.co', 'cdn-lfs-us-1.hf.co', 'cas-bridge.xethub.hf.co', 'us.aws.cdn.hf.co']);
export function validateDownloadUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !HOSTS.has(url.hostname)) throw new DodoError('PATH_DENIED', 'setup download host/protocol is not allowed');
  return url;
}
export async function hashFile(file: string): Promise<string> {
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1) throw new DodoError('PATH_DENIED', 'setup refuses linked or non-regular files');
  const hash = createHash('sha256'); for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}
export async function verifiedFile(file: string, pin: DownloadPin): Promise<boolean> {
  try { return fs.lstatSync(file).size === pin.bytes && await hashFile(file) === pin.sha256; }
  catch { return false; }
}

/** Bounded download, exact SHA256+size, validated redirects, exclusive final creation. */
export async function downloadVerified(pin: DownloadPin, target: string, fetcher: typeof fetch = fetch): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(pin.sha256) || !Number.isSafeInteger(pin.bytes) || pin.bytes < 1 || pin.bytes > 1024 * 1024 * 1024) throw new DodoError('INVALID_INPUT', 'invalid setup download pin');
  if (fs.existsSync(target)) {
    if (await verifiedFile(target, pin)) return;
    throw new DodoError('CONFLICT', 'existing download differs from its pin; it was not overwritten');
  }
  const temporary = `${target}.${randomUUID()}.part`;
  let url = validateDownloadUrl(pin.url), created = false;
  try {
    const signal = AbortSignal.timeout(300000);
    let response: Response | undefined;
    for (let hop = 0; hop <= 5; hop++) {
      response = await fetcher(url, { redirect: 'manual', signal, headers: { 'User-Agent': 'DODO-explicit-local-setup' } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location'); await response.body?.cancel();
        if (!location || hop === 5) throw new Error('invalid or excessive download redirects');
        url = validateDownloadUrl(new URL(location, url).href); continue;
      }
      break;
    }
    if (!response?.ok || !response.body) throw new Error(`download failed (${response?.status ?? 'no response'})`);
    const length = response.headers.get('content-length');
    if (length !== null && Number(length) !== pin.bytes) { await response.body.cancel(); throw new Error('download Content-Length differs from pin'); }
    const fd = fs.openSync(temporary, 'wx', 0o600); created = true; fs.closeSync(fd);
    let size = 0; const hash = createHash('sha256');
    const check = new Transform({ transform(chunk: Buffer, _encoding, callback) { size += chunk.length; if (size > pin.bytes) { callback(new Error('download exceeds pinned byte limit')); return; } hash.update(chunk); callback(null, chunk); } });
    await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), check, fs.createWriteStream(temporary, { flags: 'r+' }), { signal });
    if (size !== pin.bytes || hash.digest('hex') !== pin.sha256) throw new Error('download integrity verification failed');
    await fs.promises.link(temporary, target); // No overwrite, even if another setup completed meanwhile.
    await fs.promises.unlink(temporary); created = false;
  } finally { if (created && fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

/** Validate every ZIP entry BEFORE writing; reject zip-slip, links, ADS and case collisions. */
const ZIP_SCRIPT = String.raw`
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$root=[IO.Path]::GetFullPath($env:DODO_ZIP_DEST).TrimEnd('\')+'\'
$zip=[IO.Compression.ZipFile]::OpenRead($env:DODO_ZIP_SOURCE)
try {
  if($zip.Entries.Count -gt 30000){throw 'too many archive entries'}
  $seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  [long]$total=0
  foreach($e in $zip.Entries) {
    $name=$e.FullName.Replace('\','/').TrimEnd('/')
    if(-not $name){continue}
    if($name.StartsWith('/') -or $name -match '[<>:"|?*\x00-\x1f]'){throw 'unsafe archive path'}
    foreach($s in $name.Split('/')) {
      if(-not $s -or $s -eq '.' -or $s -eq '..' -or $s -match '[ .]$' -or $s -match '^(?i:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)'){throw 'ambiguous archive path'}
    }
    $mode=($e.ExternalAttributes -shr 16) -band 61440
    if($mode -ne 0 -and $mode -ne 32768 -and $mode -ne 16384){throw 'archive contains links or special files'}
    $dest=[IO.Path]::GetFullPath([IO.Path]::Combine($root,$name))
    if(-not $dest.StartsWith($root,[StringComparison]::OrdinalIgnoreCase) -or -not $seen.Add($dest)){throw 'archive escape or collision'}
    $total+=$e.Length
    if($total -gt 2147483648 -or $e.Length -gt 1073741824){throw 'archive expansion limit'}
  }
  foreach($e in $zip.Entries) {
    if(-not $e.FullName){continue}
    $dest=[IO.Path]::Combine($root,$e.FullName.Replace('/','\'))
    if($e.FullName.EndsWith('/') -or $e.FullName.EndsWith('\')){[IO.Directory]::CreateDirectory($dest)|Out-Null;continue}
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($dest))|Out-Null
    [IO.Compression.ZipFileExtensions]::ExtractToFile($e,$dest,$false)
  }
} finally {$zip.Dispose()}
[Console]::Write('extracted')
`;
export function extractWindowsZip(archive: string, emptyDirectory: string): void {
  if (fs.readdirSync(emptyDirectory).length !== 0 || fs.lstatSync(emptyDirectory).isSymbolicLink()) throw new DodoError('PATH_DENIED', 'ZIP destination must be a new empty private directory');
  const result = spawnSync(windowsSystemExecutable('WindowsPowerShell/v1.0/powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ZIP_SCRIPT, 'utf16le').toString('base64')], { env: { ...process.env, DODO_ZIP_SOURCE: path.resolve(archive), DODO_ZIP_DEST: path.resolve(emptyDirectory) }, shell: false, windowsHide: true, encoding: 'utf8', timeout: 180000, maxBuffer: 16384 });
  if (result.error || result.status !== 0 || result.stdout.trim() !== 'extracted') throw new DodoError('PATH_DENIED', 'verified archive could not be extracted safely; partial staging was not activated');
}
