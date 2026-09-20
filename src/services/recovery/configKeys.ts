import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { DodoError } from '../../errors.js';
import { resolveTrustedExecutable } from '../../platform/execResolve.js';
import { envValue, windowsSystemExecutable } from '../../platform/system.js';
import { WIN_CREDENTIAL_TYPE } from '../../tunnel/credentials.js';

/** Injection is for isolated crypto fixtures. Production always uses the OS store. */
export interface RecoveryKeyStore { get(reference: string): Promise<Buffer>; put(reference: string, key: Buffer): Promise<void>; delete(reference: string): Promise<void> }
const SERVICE = 'com.dodo-mcp.recovery-config';
const ref = (s: string) => {
  if (!/^recoverykey_[a-f0-9]{32}$/.test(s)) throw new DodoError('INVALID_INPUT', 'invalid recovery key reference'); return s;
};
export class OSRecoveryKeys implements RecoveryKeyStore {
  constructor(private readonly trustedRoot: string) {}
  private async command(operation: 'get' | 'put' | 'delete', reference: string, input?: Buffer) {
    ref(reference);
    let program: string, args: string[], env: NodeJS.ProcessEnv = Object.fromEntries(['HOME','USER','LOGNAME','LANG','DBUS_SESSION_BUS_ADDRESS','XDG_RUNTIME_DIR'].flatMap(name=>process.env[name]===undefined?[]:[[name,process.env[name]]]));
    if (process.platform === 'darwin') {
      program = '/usr/bin/security';
      args = [operation === 'get' ? 'find-generic-password' : operation === 'put' ? 'add-generic-password' : 'delete-generic-password',
        ...(operation === 'put' ? ['-U'] : []), '-a', reference, '-s', SERVICE, ...(operation !== 'delete' ? ['-w'] : [])];
    } else if (process.platform === 'linux') {
      try { program = resolveTrustedExecutable('secret-tool', this.trustedRoot, { allowBatch: false }); }
      catch { throw new DodoError('NOT_SUPPORTED', 'Secret Service is unavailable; encrypted configuration backup requires an OS key store'); }
      args = [operation === 'get' ? 'lookup' : operation === 'put' ? 'store' : 'clear',
        ...(operation === 'put' ? ['--label=DODO encrypted configuration recovery'] : []), 'service', SERVICE, 'account', reference];
    } else if (process.platform === 'win32') {
      program = windowsSystemExecutable('WindowsPowerShell/v1.0/powershell.exe');
      const effect = operation === 'get' ? '[Console]::Out.Write([DodoTunnelCredential]::Read($env:DODO_RECOVERY_KEY_REF))'
        : operation === 'delete' ? '[DodoTunnelCredential]::Delete($env:DODO_RECOVERY_KEY_REF)'
          : '$v=[Console]::In.ReadLine();try{[DodoTunnelCredential]::Write($env:DODO_RECOVERY_KEY_REF,$v)}finally{$v=$null}';
      const script = `$ErrorActionPreference='Stop'\nAdd-Type -TypeDefinition @'\n${WIN_CREDENTIAL_TYPE}\n'@\n${effect}`;
      args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
      env = { SYSTEMROOT: envValue(process.env, 'SystemRoot'), WINDIR: envValue(process.env, 'windir'),
        TEMP: envValue(process.env, 'TEMP'), TMP: envValue(process.env, 'TMP'), USERPROFILE: envValue(process.env, 'USERPROFILE'),
        DODO_RECOVERY_KEY_REF: `DODO MCP/Encrypted Recovery/${reference}` };
    } else throw new DodoError('NOT_SUPPORTED', 'no reviewed OS recovery key provider on this platform');
    return new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = []; let bytes = 0, expired = false;
      const child = spawn(program, args, { env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
      const timer = setTimeout(() => { expired = true; child.kill(); }, 30000);
      child.stdout.on('data', (b: Buffer) => { bytes += b.length; if (bytes > 4096) child.kill(); else chunks.push(b); });
      child.stdin.on('error', () => {}); child.stdin.end(input);
      child.on('error', () => { clearTimeout(timer); for (const b of chunks) b.fill(0); reject(new DodoError('NOT_SUPPORTED', 'OS recovery key store unavailable')); });
      child.on('close', code => {
        clearTimeout(timer);
        const output = Buffer.concat(chunks); for (const b of chunks) b.fill(0);
        if (code !== 0 || expired || bytes > 4096) {
          output.fill(0); reject(new DodoError('AUTH_REQUIRED', 'OS recovery key store refused access; unlock it locally; no plaintext fallback'));
        } else resolve(output);
      });
    });
  }
  async get(reference: string) {
    const output = await this.command('get', reference);
    try {
      const text = output.toString('utf8').trim();
      if (!/^[A-Za-z0-9+/]{43}=$/.test(text)) throw new DodoError('RECOVERY_REQUIRED', 'recovery key is unavailable or invalid');
      const key = Buffer.from(text, 'base64');
      if (key.length !== 32) { key.fill(0); throw new DodoError('RECOVERY_REQUIRED', 'invalid recovery key'); }
      return key;
    } finally { output.fill(0); }
  }
  async put(reference: string, key: Buffer) {
    if (key.length !== 32) throw new DodoError('INVALID_INPUT', 'recovery requires a 256-bit key');
    const text = key.toString('base64'), input = Buffer.from(process.platform === 'darwin' ? `${text}\n${text}\n` : `${text}\n`);
    try {
      const ignored = await this.command('put', reference, input); ignored.fill(0);
      const actual = await this.get(reference);
      try { if (!timingSafeEqual(key, actual)) throw new DodoError('RECOVERY_REQUIRED', 'OS recovery key verification failed'); }
      finally { actual.fill(0); }
    } finally { input.fill(0); }
  }
  async delete(reference: string) { const output = await this.command('delete', reference); output.fill(0); }
}
