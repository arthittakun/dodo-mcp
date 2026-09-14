import fs from 'node:fs';
import path from 'node:path';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { assertPrivatePath } from '../platform/privateFs.js';
import { renameWithRetry } from '../platform/fsRetry.js';

export interface IpcCredential { version: 1; nonce: string; token: string; endpoint: string; transport?: 'stable' }
export const IPC_FRAME_BYTES = 1024 * 1024;
export function credentialPath(locator: string): string { return `${locator}.auth`; }

/** Public APIs keep a filesystem locator, not a named-pipe pseudo-file.
 * Windows uses a fresh pipe per listener, so another stdio client's root alias
 * can replace the descriptor without taking over the old instance endpoint. */
export function ipcTransportPath(locator: string, nonce: string, platform: NodeJS.Platform = process.platform, stable = false): string {
  if (platform !== 'win32') return locator;
  const digest = createHash('sha256').update(path.win32.resolve(locator).toLowerCase()).digest('hex').slice(0, 24);
  return stable ? `\\\\.\\pipe\\dodo-${digest}-singleton` : `\\\\.\\pipe\\dodo-${digest}-${nonce}`;
}
export function newIpcCredential(locator: string, options: { stableWindowsEndpoint?: boolean } = {}): IpcCredential {
  const nonce = randomBytes(16).toString('hex');
  const stable = options.stableWindowsEndpoint === true;
  return { version: 1, nonce, token: randomBytes(32).toString('hex'), endpoint: ipcTransportPath(locator, nonce, process.platform, stable), ...(stable ? { transport: 'stable' as const } : {}) };
}
export function loadIpcCredential(locator: string): IpcCredential {
  assertPrivatePath(path.dirname(locator), true);
  const file = credentialPath(locator);
  const stat = assertPrivatePath(file);
  if (stat.size > 2048) throw new Error('invalid IPC authentication descriptor');
  const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!value || typeof value !== 'object') throw new Error('invalid IPC authentication descriptor');
  const c = value as IpcCredential;
  if (c.version !== 1 || !/^[a-f0-9]{32}$/.test(c.nonce ?? '') || !/^[a-f0-9]{64}$/.test(c.token ?? '') || (c.transport !== undefined && c.transport !== 'stable') || c.endpoint !== ipcTransportPath(locator, c.nonce, process.platform, c.transport === 'stable')) throw new Error('invalid IPC authentication descriptor');
  return c;
}
export function publishIpcCredential(locator: string, credential: IpcCredential): void {
  const target = credentialPath(locator), temporary = `${target}.${credential.nonce}.tmp`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(credential)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  try { renameWithRetry(temporary, target); }
  catch (error) { try { fs.unlinkSync(temporary); } catch { /* owned temporary file */ } throw error; }
}
export function removeIpcCredential(locator: string, credential: IpcCredential): void {
  try {
    const current = loadIpcCredential(locator);
    if (current.nonce === credential.nonce && current.token === credential.token) fs.unlinkSync(credentialPath(locator));
  } catch { /* absent or replaced: never remove another server's descriptor */ }
}
export function ipcEndpointPresent(locator: string): boolean { return fs.existsSync(credentialPath(locator)) || fs.existsSync(locator); }
export function ipcIdentity(locator: string): string | undefined {
  if (!ipcEndpointPresent(locator)) return undefined;
  // Keep Unix socket ownership checks, in addition to the new authentication.
  let socketIdentity = '';
  if (process.platform !== 'win32') {
    let st: fs.Stats;
    try { st = fs.lstatSync(locator); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    if (!st.isSocket() || st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0) throw new Error('refusing non-private or unexpected IPC path');
    socketIdentity = `${st.dev}:${st.ino}:${st.ctimeMs}:`;
  }
  let c: IpcCredential;
  try { c = loadIpcCredential(locator); }
  catch (error) {
    // The owner may finish closing while this process validates the private
    // descriptor (Windows ACL probes can take longer than shutdown). Treat it
    // as absent only after rechecking both paths; malformed or non-private
    // endpoints that still exist must continue to fail closed.
    if (!ipcEndpointPresent(locator)) return undefined;
    throw error;
  }
  return socketIdentity + createHash('sha256').update(c.token + c.nonce).digest('hex');
}
export function ipcMac(token: string, domain: string, ...parts: string[]): string {
  return createHmac('sha256', Buffer.from(token, 'hex')).update(JSON.stringify([domain, ...parts])).digest('hex');
}
export function validMac(actual: unknown, expected: string): boolean {
  return typeof actual === 'string' && /^[a-f0-9]{64}$/.test(actual) && timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}
