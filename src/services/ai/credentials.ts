import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { DodoError } from '../../errors.js';
const SERVICE = 'DODO AI Providers';
export class AICredentials {
  private readonly session = new Map<string, Buffer>();
  private command(args: string[], input?: Buffer): Promise<Buffer> {
    if (process.platform !== 'darwin') return Promise.reject(new DodoError('NOT_SUPPORTED', 'Keychain storage requires macOS; use session credentials on this platform'));
    return new Promise((resolve, reject) => {
      const child = spawn('/usr/bin/security', args, { shell: false, stdio: ['pipe', 'pipe', 'ignore'] });
      const chunks: Buffer[] = []; let bytes = 0;
      const timer = setTimeout(() => child.kill(), 30000);
      child.stdout.on('data', (b: Buffer) => { bytes += b.length; if (bytes > 16384) child.kill(); else chunks.push(b); });
      child.on('error', () => { clearTimeout(timer); reject(new DodoError('NOT_SUPPORTED', 'Keychain unavailable')); });
      child.on('close', code => { clearTimeout(timer); if (code !== 0 || bytes > 16384) reject(new DodoError('AUTH_REQUIRED', 'Keychain refused access; unlock it locally or use a session key')); else resolve(Buffer.concat(chunks)); });
      child.stdin.on('error', () => undefined); child.stdin.end(input);
    });
  }
  hasSession(id: string): boolean { return this.session.has(id); }
  async get(id: string, storage: 'session' | 'keychain'): Promise<string> {
    if (storage === 'session') return this.session.get(id)?.toString('utf8') ?? '';
    const value = await this.command(['find-generic-password', '-a', id, '-s', SERVICE, '-w']);
    try { return value.toString('utf8').replace(/\r?\n$/, ''); } finally { value.fill(0); }
  }
  async set(id: string, storage: 'session' | 'keychain', key: string): Promise<void> {
    if (key.length < 1 || key.length > 4096 || /[\x00-\x20\x7f]/.test(key)) throw new DodoError('INVALID_INPUT', 'API key must be a single nonempty credential without whitespace');
    if (storage === 'session') { this.session.get(id)?.fill(0); this.session.set(id, Buffer.from(key)); return; }
    const input = Buffer.from(`${key}\n${key}\n`);
    try {
      await this.command(['add-generic-password', '-U', '-a', id, '-s', SERVICE, '-w'], input);
      const roundtrip = Buffer.from(await this.get(id, storage)); const expected = Buffer.from(key);
      try { if (roundtrip.length !== expected.length || !timingSafeEqual(roundtrip, expected)) throw new DodoError('INTERNAL_ERROR', 'Keychain verification failed'); }
      finally { roundtrip.fill(0); expected.fill(0); }
    } finally { input.fill(0); }
  }
  async delete(id: string, storage: 'session' | 'keychain'): Promise<void> {
    if (storage === 'session') { this.session.get(id)?.fill(0); this.session.delete(id); }
    if (storage === 'keychain') await this.command(['delete-generic-password', '-a', id, '-s', SERVICE]);
  }
  close(): void { for (const b of this.session.values()) b.fill(0); this.session.clear(); }
}
