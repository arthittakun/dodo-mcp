import fs from 'node:fs';
import path from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DodoError } from '../errors.js';
import { TunnelCredentialRefSchema, type TunnelCredentialRef } from '../config/tunnelConfig.js';
import { assertPrivatePath } from '../platform/privateFs.js';
import { resolveTrustedExecutable } from '../platform/execResolve.js';
import { envValue, windowsSystemExecutable } from '../platform/system.js';

const KEYCHAIN_SERVICE = 'com.dodo-mcp.cloudflare-tunnel';
const MAX_TOKEN_BYTES = 8192;

function securityWorkspaceRoot(): string { return fs.realpathSync.native(process.cwd()); }

export function validateTunnelToken(raw: string): string {
  const token = raw.trim();
  const bytes = Buffer.byteLength(token, 'utf8');
  if (bytes < 20 || bytes > MAX_TOKEN_BYTES || !/^[\x21-\x7e]+$/.test(token)) {
    throw new DodoError('INVALID_INPUT', 'Cloudflare Tunnel token has an invalid format; no credential was saved');
  }
  return token;
}

export function osTunnelCredentialRef(configDir: string): TunnelCredentialRef {
  const identity = process.platform === 'win32' ? path.win32.resolve(configDir).toLowerCase() : path.resolve(configDir);
  return { provider: 'os', key: createHash('sha256').update(identity).digest('hex').slice(0, 24) };
}

export function envTunnelCredentialRef(name: string, env: NodeJS.ProcessEnv = process.env): TunnelCredentialRef {
  const ref = TunnelCredentialRefSchema.parse({ provider: 'env', name });
  if (ref.provider !== 'env') throw new DodoError('INTERNAL_ERROR', 'invalid tunnel credential reference');
  validateTunnelToken(envValue(env, ref.name) ?? '');
  return ref;
}

export function fileTunnelCredentialRef(file: string): TunnelCredentialRef {
  if (!path.isAbsolute(file)) throw new DodoError('INVALID_INPUT', 'tunnel token file must be an absolute path');
  const initial = fs.lstatSync(file);
  if (initial.isSymbolicLink()) throw new DodoError('PATH_DENIED', 'tunnel token file must not be a symbolic link');
  const canonical = fs.realpathSync.native(file);
  readTokenFile(canonical);
  return TunnelCredentialRefSchema.parse({ provider: 'file', path: canonical });
}

function readTokenFile(file: string): string {
  const before = assertPrivatePath(file, false);
  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
  const fd = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.size > MAX_TOKEN_BYTES + 2 || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new DodoError('PATH_DENIED', 'tunnel token file changed or is not a private regular file');
    }
    const bytes = Buffer.alloc(opened.size);
    const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
    return validateTunnelToken(bytes.subarray(0, count).toString('utf8'));
  } finally { fs.closeSync(fd); }
}

function linuxSecretTool(): string {
  try {
    return resolveTrustedExecutable('secret-tool', securityWorkspaceRoot(), { allowBatch: false });
  } catch {
    throw new DodoError('NOT_SUPPORTED', 'Linux Secret Service CLI is unavailable', {
      recovery: 'install libsecret-tools/secret-tool, or configure --token-env / --token-file',
    });
  }
}

function macSecurity(): string {
  const executable = '/usr/bin/security';
  if (!fs.existsSync(executable)) throw new DodoError('NOT_SUPPORTED', 'macOS Keychain CLI is unavailable');
  return executable;
}

const WIN_CREDENTIAL_TYPE = String.raw`
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class DodoTunnelCredential {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct Credential {
    public UInt32 Flags; public UInt32 Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public UInt32 CredentialBlobSize;
    public IntPtr CredentialBlob; public UInt32 Persist; public UInt32 AttributeCount; public IntPtr Attributes;
    public string TargetAlias; public string UserName;
  }
  [DllImport("Advapi32.dll", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool CredWrite(ref Credential credential, UInt32 flags);
  [DllImport("Advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool CredRead(string target, UInt32 type, UInt32 flags, out IntPtr credential);
  [DllImport("Advapi32.dll", EntryPoint="CredDeleteW", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool CredDelete(string target, UInt32 type, UInt32 flags);
  [DllImport("Advapi32.dll")] static extern void CredFree(IntPtr buffer);
  public static void Write(string target, string secret) {
    byte[] bytes=Encoding.Unicode.GetBytes(secret);
    if(bytes.Length==0 || bytes.Length>2560) throw new Exception("credential is too large for Windows Credential Manager");
    IntPtr blob=Marshal.AllocHGlobal(bytes.Length);
    try {
      Marshal.Copy(bytes,0,blob,bytes.Length);
      var c=new Credential { Type=1, TargetName=target, CredentialBlobSize=(UInt32)bytes.Length,
        CredentialBlob=blob, Persist=2, UserName="DODO" };
      if(!CredWrite(ref c,0)) throw new Win32Exception(Marshal.GetLastWin32Error());
    } finally {
      for(int i=0;i<bytes.Length;i++) { bytes[i]=0; Marshal.WriteByte(blob,i,0); }
      Marshal.FreeHGlobal(blob);
    }
  }
  public static string Read(string target) {
    IntPtr pointer;
    if(!CredRead(target,1,0,out pointer)) throw new Win32Exception(Marshal.GetLastWin32Error());
    try {
      var c=(Credential)Marshal.PtrToStructure(pointer,typeof(Credential));
      if(c.CredentialBlobSize==0 || c.CredentialBlobSize>2560) throw new Exception("invalid credential size");
      byte[] bytes=new byte[c.CredentialBlobSize]; Marshal.Copy(c.CredentialBlob,bytes,0,bytes.Length);
      try { return Encoding.Unicode.GetString(bytes); } finally { for(int i=0;i<bytes.Length;i++) bytes[i]=0; }
    } finally { CredFree(pointer); }
  }
  public static void Delete(string target) {
    if(!CredDelete(target,1,0)) { int code=Marshal.GetLastWin32Error(); if(code!=1168) throw new Win32Exception(code); }
  }
}
`;

function windowsCredentialTarget(key: string): string {
  return `DODO MCP/Cloudflare Tunnel/${key}`;
}

function powershell(script: string, key: string, inheritStdio = false): ReturnType<typeof spawnSync> {
  const env: NodeJS.ProcessEnv = {
    SYSTEMROOT: envValue(process.env, 'SystemRoot', 'win32'),
    WINDIR: envValue(process.env, 'windir', 'win32'),
    USERPROFILE: envValue(process.env, 'USERPROFILE', 'win32'),
    TEMP: envValue(process.env, 'TEMP', 'win32'),
    TMP: envValue(process.env, 'TMP', 'win32'),
    DODO_TUNNEL_CREDENTIAL_ID: windowsCredentialTarget(key),
  };
  return spawnSync(
    windowsSystemExecutable('WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoLogo', '-NoProfile', ...(inheritStdio ? [] : ['-NonInteractive']), '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { env, shell: false, windowsHide: true, timeout: 30_000, maxBuffer: MAX_TOKEN_BYTES * 2, encoding: 'utf8', stdio: inheritStdio ? 'inherit' : ['ignore', 'pipe', 'pipe'] },
  );
}

function powershellWithInput(script: string, key: string, input: Buffer): ReturnType<typeof spawnSync> {
  const env: NodeJS.ProcessEnv = {
    SYSTEMROOT: envValue(process.env, 'SystemRoot', 'win32'),
    WINDIR: envValue(process.env, 'windir', 'win32'),
    USERPROFILE: envValue(process.env, 'USERPROFILE', 'win32'),
    TEMP: envValue(process.env, 'TEMP', 'win32'),
    TMP: envValue(process.env, 'TMP', 'win32'),
    DODO_TUNNEL_CREDENTIAL_ID: windowsCredentialTarget(key),
  };
  return spawnSync(
    windowsSystemExecutable('WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { input, env, shell: false, windowsHide: true, timeout: 30_000, maxBuffer: 4096, encoding: 'utf8', stdio: ['pipe', 'ignore', 'pipe'] },
  );
}

export function osCredentialAvailability(): { available: boolean; provider: string; reason?: string } {
  try {
    if (process.platform === 'darwin') { macSecurity(); return { available: true, provider: 'macOS Keychain' }; }
    if (process.platform === 'win32') { windowsSystemExecutable('WindowsPowerShell/v1.0/powershell.exe'); return { available: true, provider: 'Windows Credential Manager' }; }
    if (process.platform === 'linux') { linuxSecretTool(); return { available: true, provider: 'Secret Service' }; }
    return { available: false, provider: process.platform, reason: 'no reviewed OS credential provider' };
  } catch (error) {
    return { available: false, provider: process.platform, reason: error instanceof Error ? error.message : 'credential provider unavailable' };
  }
}

/** The OS provider owns the prompt. No token is accepted in argv or config. */
export async function storeOsTunnelCredentialInteractive(ref: TunnelCredentialRef): Promise<void> {
  if (ref.provider !== 'os') throw new DodoError('INVALID_INPUT', 'OS credential storage requires an OS credential reference');
  let result: ReturnType<typeof spawnSync>;
  if (process.platform === 'darwin') {
    result = spawnSync(macSecurity(), ['add-generic-password', '-U', '-a', ref.key, '-s', KEYCHAIN_SERVICE, '-w'], {
      shell: false, windowsHide: true, timeout: 120_000, stdio: 'inherit',
    });
  } else if (process.platform === 'win32') {
    const script = `Add-Type -TypeDefinition @'\n${WIN_CREDENTIAL_TYPE}\n'@\n$s=Read-Host 'Cloudflare Tunnel token' -AsSecureString\n$b=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)\ntry{$p=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($b);[DodoTunnelCredential]::Write($env:DODO_TUNNEL_CREDENTIAL_ID,$p)}finally{if($b -ne [IntPtr]::Zero){[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b)};$p=$null}`;
    result = powershell(script, ref.key, true);
  } else if (process.platform === 'linux') {
    const token = await readHiddenToken('Cloudflare Tunnel token: ');
    result = spawnSync(linuxSecretTool(), ['store', '--label=DODO Cloudflare Tunnel', 'service', KEYCHAIN_SERVICE, 'account', ref.key], {
      input: token, shell: false, windowsHide: true, timeout: 30_000, maxBuffer: 4096, encoding: 'utf8', stdio: ['pipe', 'ignore', 'pipe'],
    });
  } else {
    throw new DodoError('NOT_SUPPORTED', `no reviewed OS credential provider for ${process.platform}`);
  }
  if (result.error || result.status !== 0) throw new DodoError('INTERNAL_ERROR', 'OS credential store refused the tunnel credential; no config reference was saved');
  try { await readTunnelCredential(ref); } // validates that the stored value is retrievable and well formed
  catch (error) {
    try { deleteOsTunnelCredential(ref); } catch { /* original store/read refusal remains authoritative */ }
    throw error;
  }
}

/**
 * Store a token received by the authenticated loopback owner UI. The token is
 * passed to the OS provider over child stdin only; it is never placed in argv,
 * environment variables, config, receipts, logs or error messages.
 */
export async function storeOsTunnelCredentialValue(refInput: TunnelCredentialRef, raw: string): Promise<void> {
  const ref = TunnelCredentialRefSchema.parse(refInput);
  if (ref.provider !== 'os') throw new DodoError('INVALID_INPUT', 'OS credential storage requires an OS credential reference');
  const token = validateTunnelToken(raw);
  // security(1)'s prompt asks for the new value twice, even with -U. Supplying
  // both copies over stdin keeps the value out of argv/env and allows the
  // authenticated browser flow to use the same Keychain boundary.
  const input = Buffer.from(process.platform === 'darwin' ? `${token}\n${token}\n` : `${token}\n`, 'utf8');
  let result: ReturnType<typeof spawnSync>;
  try {
    if (process.platform === 'darwin') {
      // `-w` as the final option asks security(1) to read the value instead of
      // exposing it as the next argv item.
      result = spawnSync(macSecurity(), ['add-generic-password', '-U', '-a', ref.key, '-s', KEYCHAIN_SERVICE, '-w'], {
        input, shell: false, windowsHide: true, timeout: 120_000, maxBuffer: 4096, stdio: ['pipe', 'ignore', 'pipe'],
      });
    } else if (process.platform === 'win32') {
      const script = `Add-Type -TypeDefinition @'\n${WIN_CREDENTIAL_TYPE}\n'@\n$p=[Console]::In.ReadLine()\ntry{[DodoTunnelCredential]::Write($env:DODO_TUNNEL_CREDENTIAL_ID,$p)}finally{$p=$null}`;
      result = powershellWithInput(script, ref.key, input);
    } else if (process.platform === 'linux') {
      result = spawnSync(linuxSecretTool(), ['store', '--label=DODO Cloudflare Tunnel', 'service', KEYCHAIN_SERVICE, 'account', ref.key], {
        input, shell: false, windowsHide: true, timeout: 30_000, maxBuffer: 4096, stdio: ['pipe', 'ignore', 'pipe'],
      });
    } else {
      throw new DodoError('NOT_SUPPORTED', `no reviewed OS credential provider for ${process.platform}`);
    }
  } finally {
    input.fill(0);
  }
  if (result.error || result.status !== 0) throw new DodoError('INTERNAL_ERROR', 'OS credential store refused the tunnel credential; no config reference was saved');
  try {
    const stored = Buffer.from(await readTunnelCredential(ref), 'utf8');
    const expected = Buffer.from(token, 'utf8');
    try {
      if (stored.length !== expected.length || !timingSafeEqual(stored, expected)) throw new Error('credential round-trip mismatch');
    } finally {
      stored.fill(0);
      expected.fill(0);
    }
  } catch (error) {
    try { deleteOsTunnelCredential(ref); } catch { /* original store/read refusal remains authoritative */ }
    if (error instanceof DodoError) throw error;
    throw new DodoError('INTERNAL_ERROR', 'OS credential store could not verify the tunnel credential; the new value was removed');
  }
}

export async function readTunnelCredential(refInput: TunnelCredentialRef, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const ref = TunnelCredentialRefSchema.parse(refInput);
  if (ref.provider === 'env') return validateTunnelToken(envValue(env, ref.name) ?? '');
  if (ref.provider === 'file') {
    if (!path.isAbsolute(ref.path)) throw new DodoError('PATH_DENIED', 'tunnel token file reference is not absolute');
    return readTokenFile(ref.path);
  }
  let output: string;
  if (process.platform === 'darwin') {
    const result = spawnSync(macSecurity(), ['find-generic-password', '-a', ref.key, '-s', KEYCHAIN_SERVICE, '-w'], {
      shell: false, windowsHide: true, timeout: 30_000, maxBuffer: MAX_TOKEN_BYTES * 2, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.error || result.status !== 0) throw new DodoError('NOT_FOUND', 'tunnel credential is missing from macOS Keychain');
    output = result.stdout;
  } else if (process.platform === 'win32') {
    const script = `Add-Type -TypeDefinition @'\n${WIN_CREDENTIAL_TYPE}\n'@\n[Console]::Out.Write([DodoTunnelCredential]::Read($env:DODO_TUNNEL_CREDENTIAL_ID))`;
    const result = powershell(script, ref.key);
    if (result.error || result.status !== 0) throw new DodoError('NOT_FOUND', 'tunnel credential is missing from Windows Credential Manager');
    output = Buffer.isBuffer(result.stdout) ? result.stdout.toString('utf8') : String(result.stdout ?? '');
  } else if (process.platform === 'linux') {
    const result = spawnSync(linuxSecretTool(), ['lookup', 'service', KEYCHAIN_SERVICE, 'account', ref.key], {
      shell: false, windowsHide: true, timeout: 30_000, maxBuffer: MAX_TOKEN_BYTES * 2, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.error || result.status !== 0 || !result.stdout) throw new DodoError('NOT_FOUND', 'tunnel credential is missing from Secret Service');
    output = result.stdout;
  } else throw new DodoError('NOT_SUPPORTED', `no reviewed OS credential provider for ${process.platform}`);
  return validateTunnelToken(output);
}

export function deleteOsTunnelCredential(refInput: TunnelCredentialRef): void {
  const ref = TunnelCredentialRefSchema.parse(refInput);
  if (ref.provider !== 'os') return;
  let result: ReturnType<typeof spawnSync>;
  if (process.platform === 'darwin') {
    result = spawnSync(macSecurity(), ['delete-generic-password', '-a', ref.key, '-s', KEYCHAIN_SERVICE], { shell: false, windowsHide: true, timeout: 30_000, stdio: 'ignore' });
    if (result.status === 44) return;
  } else if (process.platform === 'win32') {
    const script = `Add-Type -TypeDefinition @'\n${WIN_CREDENTIAL_TYPE}\n'@\n[DodoTunnelCredential]::Delete($env:DODO_TUNNEL_CREDENTIAL_ID)`;
    result = powershell(script, ref.key);
  } else if (process.platform === 'linux') {
    result = spawnSync(linuxSecretTool(), ['clear', 'service', KEYCHAIN_SERVICE, 'account', ref.key], { shell: false, windowsHide: true, timeout: 30_000, stdio: 'ignore' });
  } else throw new DodoError('NOT_SUPPORTED', `no reviewed OS credential provider for ${process.platform}`);
  if (result.error || result.status !== 0) throw new DodoError('INTERNAL_ERROR', 'OS credential store could not remove the tunnel credential');
}

export function parseTemporaryTunnelToken(raw: string): string | undefined {
  return raw.trim() === '' ? undefined : validateTunnelToken(raw);
}

/**
 * Read a run-scoped token without echoing it. An empty submission explicitly
 * selects local-only startup. The value is returned to the current process and
 * is never written to config or an OS credential provider.
 */
export function readTemporaryTunnelToken(prompt = 'Cloudflare Tunnel token (temporary; Enter = local only): '): Promise<string | undefined> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== 'function') {
    throw new DodoError('NOT_SUPPORTED', 'an interactive terminal is required for temporary Tunnel token entry', {
      recovery: 'run from a terminal, or use dodo start --no-tunnel for local-only startup',
    });
  }
  return new Promise((resolve, reject) => {
    let value = '';
    let done = false;
    const stdin = process.stdin;
    const restore = () => {
      if (done) return false;
      done = true;
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write('\n');
      return true;
    };
    const onData = (chunk: Buffer | string) => {
      for (const char of String(chunk)) {
        if (char === '\u0003') { if (restore()) reject(new DodoError('CONFLICT', 'credential entry canceled')); return; }
        if (char === '\r' || char === '\n') { if (restore()) { try { resolve(parseTemporaryTunnelToken(value)); } catch (error) { reject(error); } } return; }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else if (char >= '\u0021' && char <= '\u007e' && Buffer.byteLength(value, 'utf8') < MAX_TOKEN_BYTES) value += char;
      }
    };
    process.stdout.write(prompt);
    stdin.setRawMode(true); stdin.resume(); stdin.on('data', onData);
  });
}

function readHiddenToken(prompt: string): Promise<string> {
  return readTemporaryTunnelToken(prompt).then(token => {
    if (!token) throw new DodoError('INVALID_INPUT', 'Cloudflare Tunnel token is required for credential storage');
    return token;
  });
}
