import { pack, type Header } from 'tar-stream';
import { describe, expect, it } from 'vitest';
import { packDeploymentSource, verifySourceArchive } from '../../src/services/recovery/deploymentArchive.js';
import { sha256Bytes } from '../../src/util/hash.js';
import type { RecoveryEntry } from '../../src/services/recovery/contracts.js';

const bytes = Buffer.from([0, 255, 128, 13, 10, 65]);
const entry = (path = 'ภาพ/fixture.bin', data = bytes): RecoveryEntry => ({ path, kind: 'file', hash: sha256Bytes(data).slice(7), bytes: data.length, mode: 0o644 });
async function archive(rows: Array<{ header: Partial<Header> & { name: string }; data?: Buffer }>) {
  const stream = pack(), chunks: Buffer[] = [];
  const end = new Promise<Buffer>((resolve, reject) => { stream.on('data', (b: unknown) => chunks.push(Buffer.from(b as Uint8Array))); stream.on('error', reject); stream.on('end', () => resolve(Buffer.concat(chunks))); });
  for (const { header, data } of rows) await new Promise<void>((resolve, reject) => stream.entry({ mode: 0o644, mtime: new Date(0), ...header }, data ?? Buffer.alloc(0), e => e ? reject(e) : resolve()));
  stream.finalize(); return end;
}
const allow = () => {};
describe('R05 source archives are bounded, inert and manifest-verified', () => {
  it('preserves exact binary bytes/UTF-8 paths, canonicalizes archive output, and never reads live source', async () => {
    const entries = [entry(), entry('long/'.repeat(30) + 'file.txt')];
    const a = await packDeploymentSource(entries, async () => bytes, allow);
    const b = await packDeploymentSource([...entries].reverse(), async () => bytes, allow);
    expect(a).toEqual(b);
    const result = await verifySourceArchive(a, entries, allow);
    expect(result.complete).toBe(true); expect(result.files.get(entries[0]!.path)).toEqual(bytes); expect(result.fileCount).toBe(2);
  });
  it.each([
    ['../escape', 'file'], ['/absolute', 'file'], ['a/../../escape', 'file'], ['C:/escape', 'file'], ['a\\escape', 'file'],
    ['source', 'symlink'], ['source', 'link'], ['source', 'block-device'], ['source', 'fifo'],
  ])('refuses %s (%s) without filesystem extraction', async (name, type) => {
    const raw = await archive([{ header: { name, type: type as Header['type'], ...(type === 'symlink' || type === 'link' ? { linkname: '/secret' } : {}) }, ...(type === 'file' ? { data: bytes } : {}) }]);
    await expect(verifySourceArchive(raw, [entry(name)], allow)).rejects.toThrow();
  });
  it('requires exact hashes/modes/coverage; label claims, duplicates and undeclared secret paths cannot pass', async () => {
    const file = entry('a.txt');
    const bad = await archive([{ header: { name: 'a.txt' }, data: Buffer.from('WRONG!') }]);
    await expect(verifySourceArchive(bad, [file], allow)).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    const duplicate = await archive([{ header: { name: 'a.txt' }, data: bytes }, { header: { name: 'a.txt' }, data: bytes }]);
    await expect(verifySourceArchive(duplicate, [file], allow)).rejects.toMatchObject({ code: 'PATH_DENIED' });
    const mode = await archive([{ header: { name: 'a.txt', mode: 0o777 }, data: bytes }]);
    await expect(verifySourceArchive(mode, [file], allow)).rejects.toThrow();
    const missing = await archive([]); await expect(verifySourceArchive(missing, [file], allow)).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
    const extra = await archive([{ header: { name: '.env' }, data: bytes }]);
    await expect(verifySourceArchive(extra, [file], name => { if (name === '.env') throw Error('secret path denied'); })).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    await expect(packDeploymentSource([file], async () => Buffer.from('wrong'), allow)).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
  });
  it('handles only the declared Docker copy prefix, rejects malformed/truncated tar and uses no shell', async () => {
    const raw = await archive([{ header: { name: 'src/a.txt' }, data: bytes }]);
    expect((await verifySourceArchive(raw, [entry('a.txt')], allow, 'src')).files.get('a.txt')).toEqual(bytes);
    await expect(verifySourceArchive(raw, [entry('a.txt')], allow, 'other')).rejects.toThrow();
    await expect(verifySourceArchive(raw.subarray(0, 520), [entry('a.txt')], allow, 'src')).rejects.toThrow();
    const checksum = Buffer.from(raw); checksum[0] = 255;
    await expect(verifySourceArchive(checksum, [entry('a.txt')], allow)).rejects.toThrow();
  });
});
