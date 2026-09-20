import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
const fake = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: fake.spawn }));
vi.mock('../../src/platform/execResolve.js', () => ({ resolveTrustedExecutable: () => '/usr/bin/secret-tool' }));
vi.mock('../../src/platform/system.js', () => ({ windowsSystemExecutable: () => 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', envValue: () => undefined }));
import { OSRecoveryKeys } from '../../src/services/recovery/configKeys.js';
const nativePlatform = process.platform;
afterEach(() => { Object.defineProperty(process, 'platform', { value: nativePlatform }); vi.clearAllMocks(); });
function fixture(platform: string, fail = false) {
  Object.defineProperty(process, 'platform', { value: platform });
  let stored = Buffer.alloc(0);
  fake.spawn.mockImplementation((program: string, args: string[], options: { env: Record<string,string>; shell: boolean; stdio: string[] }) => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), kill: vi.fn() });
    const input: Buffer[] = []; child.stdin.on('data', (chunk: Buffer) => input.push(Buffer.from(chunk)));
    child.stdin.on('finish', () => queueMicrotask(() => {
      const bytes = Buffer.concat(input);
      if (bytes.length) stored = Buffer.from(bytes.toString().trim().split('\n')[0]!);
      if (!bytes.length && !args.includes('clear') && !args.includes('delete-generic-password')) child.stdout.write(Buffer.from(stored));
      child.emit('close', fail ? 1 : 0);
      bytes.fill(0); for (const b of input) b.fill(0);
    }));
    expect(options.shell).toBe(false); expect(options.stdio).toEqual(['pipe','pipe','ignore']);
    expect(program).not.toContain('secret-value'); return child;
  });
}
describe('OS recovery key transport never puts key material in argv, env or errors', () => {
  it.each(['darwin','linux','win32'])('uses protected stdin/readback on %s with fixed locators and no plaintext fallback', async platform => {
    fixture(platform); const key = randomBytes(32), store = new OSRecoveryKeys('/fixture'), reference = 'recoverykey_'+'a'.repeat(32);
    try {
      await store.put(reference,key); const read = await store.get(reference);
      expect(timingSafeEqual(read,key)).toBe(true); read.fill(0);
      const commands = JSON.stringify(fake.spawn.mock.calls); expect(commands.includes(key.toString('base64'))).toBe(false);
      expect(commands).not.toContain('NODE_OPTIONS'); expect(commands).not.toContain('api_key');
      await store.delete(reference);
      const count = fake.spawn.mock.calls.length; await expect(store.get('../arbitrary')).rejects.toMatchObject({code:'INVALID_INPUT'}); expect(fake.spawn.mock.calls).toHaveLength(count);
    } finally { key.fill(0); }
  });
  it('refuses OS store failure instead of persisting a key in project/private JSON', async () => {
    fixture('darwin',true); const store = new OSRecoveryKeys('/fixture'), key=randomBytes(32);
    try { await expect(store.put('recoverykey_'+'b'.repeat(32),key)).rejects.toMatchObject({code:'AUTH_REQUIRED',message:expect.stringContaining('no plaintext fallback')}); }
    finally { key.fill(0); }
  });
});
