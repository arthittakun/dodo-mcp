import { pack, extract } from 'tar-stream';
import { DodoError } from '../../errors.js';
import { sha256Bytes } from '../../util/hash.js';
import type { RecoveryEntry } from './contracts.js';

export const DEPLOYMENT_ARCHIVE_BYTES = 32 * 1024 * 1024;
const safeName = (name: string) => name.length <= 1024 && !/[\\:\x00-\x1f]/.test(name)
  && name.split('/').every(p => p !== '' && p !== '.' && p !== '..');

/** Deterministic, bounded bytes from the verified CAS, not a walk of the live workspace. */
export async function packDeploymentSource(entries: RecoveryEntry[], read: (entry: RecoveryEntry) => Promise<Buffer>, assertPath: (path: string) => void): Promise<Buffer> {
  if (entries.length > 100000) throw new DodoError('RESOURCE_LIMIT', 'build context entry budget exceeded');
  if (entries.reduce((sum, e) => sum + Math.ceil(e.bytes / 512) * 512 + 4096, 1024) > DEPLOYMENT_ARCHIVE_BYTES)
    throw new DodoError('RESOURCE_LIMIT', 'build context archive reservation exceeds 32 MiB');
  const stream = pack(), chunks: Buffer[] = [];
  let total = 0;
  const completed = new Promise<Buffer>((resolve, reject) => {
    stream.on('data', (raw: unknown) => {
      const chunk = Buffer.from(raw as Uint8Array);
      total += chunk.length;
      if (total > DEPLOYMENT_ARCHIVE_BYTES) { reject(new DodoError('RESOURCE_LIMIT', 'build context archive exceeds 32 MiB')); stream.destroy(); }
      else chunks.push(chunk);
    });
    stream.on('error', () => reject(new DodoError('RECOVERY_REQUIRED', 'build context archive failed')));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
  });
  void completed.catch(() => {});
  try {
    const names = new Set<string>();
    for (const e of [...entries].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
      assertPath(e.path);
      if (!safeName(e.path) || names.has(e.path.toLowerCase()) || e.kind === 'absent') throw new DodoError('PATH_DENIED', 'build context contains an ambiguous path');
      names.add(e.path.toLowerCase());
      if (!Number.isSafeInteger(e.bytes) || e.bytes < 0 || total + e.bytes > DEPLOYMENT_ARCHIVE_BYTES) throw new DodoError('RESOURCE_LIMIT', 'build context archive exceeds 32 MiB');
      const bytes = e.kind === 'file' ? await read(e) : Buffer.alloc(0);
      if (e.kind === 'file' && (bytes.length !== e.bytes || sha256Bytes(bytes).slice(7) !== e.hash)) throw new DodoError('RECOVERY_REQUIRED', 'build context source hash differs');
      await new Promise<void>((resolve, reject) => stream.entry({ name: e.path, type: e.kind === 'file' ? 'file' : 'directory', size: bytes.length,
        mode: (e.mode ?? (e.kind === 'file' ? 0o644 : 0o755)) & 0o777, uid: 0, gid: 0, mtime: new Date(0), uname: '', gname: '' }, bytes,
      error => error ? reject(new DodoError('RECOVERY_REQUIRED', 'build context entry failed')) : resolve()));
    }
    stream.finalize();
    return await completed;
  } catch (error) { stream.destroy(); throw error; }
}

/** No filesystem extraction: untrusted container tar is checked before any source bytes can be used. */
export async function verifySourceArchive(archive: Buffer, expected: RecoveryEntry[], assertPath: (path: string) => void, prefix = '') {
  if (archive.length > DEPLOYMENT_ARCHIVE_BYTES) throw new DodoError('RESOURCE_LIMIT', 'container source archive exceeds 32 MiB');
  if (prefix && !safeName(prefix)) throw new DodoError('INVALID_INPUT', 'invalid archive prefix');
  const wanted = new Map(expected.filter(e => e.kind !== 'absent').map(e => [e.path, e]));
  if (!expected.some(e => e.kind === 'file')) throw new DodoError('NOT_SUPPORTED', 'no declared source manifest is available');
  const seen = new Set<string>(), seenFolded = new Set<string>(), files = new Map<string, Buffer>();
  const parser = extract(); let count = 0, extracted = 0;
  const checked = new Promise<void>((resolve, reject) => {
    const fail = (error: unknown) => { reject(error instanceof DodoError ? error : new DodoError('RECOVERY_REQUIRED', 'invalid container source archive')); parser.destroy(); };
    parser.on('error', fail);
    parser.on('finish', () => resolve());
    parser.on('entry', (header, stream, next) => {
      stream.on('error', fail);
      void (async () => {
        if (++count > 100000 || !['file', 'directory'].includes(header.type) || header.linkname)
          throw new DodoError('PATH_DENIED', 'container source links, devices and unsupported entries are refused');
        if (header.name.startsWith('/')) throw new DodoError('PATH_DENIED', 'absolute archive path refused');
        if (header.pax && Object.keys(header.pax).some(key => !['path', 'size', 'mtime', 'atime', 'ctime', 'uid', 'gid', 'uname', 'gname'].includes(key)))
          throw new DodoError('PATH_DENIED', 'unsupported source archive metadata');
        let name = header.name.replace(/^\.\//, '').replace(/\/$/, '');
        if ((name === '.' || name === '' || prefix && name === prefix) && header.type === 'directory') {
          if (header.size !== 0) throw new DodoError('PATH_DENIED', 'invalid archive root');
          stream.resume(); stream.on('end', () => next()); return;
        }
        if (prefix) {
          if (!name.startsWith(prefix + '/')) throw new DodoError('PATH_DENIED', 'entry is outside the declared container source mapping');
          name = name.slice(prefix.length + 1);
        }
        if (!safeName(name) || seenFolded.has(name.toLowerCase())) throw new DodoError('PATH_DENIED', 'archive traversal, duplicate or ambiguous path refused');
        assertPath(name); seenFolded.add(name.toLowerCase()); seen.add(name);
        const expectedEntry = wanted.get(name);
        if (!expectedEntry || header.type !== (expectedEntry.kind === 'directory' ? 'directory' : 'file'))
          throw new DodoError('RECOVERY_REQUIRED', 'image source coverage differs from its recorded manifest');
        if (!Number.isSafeInteger(header.size) || header.size < 0 || header.size !== expectedEntry.bytes
          || (header.mode & 0o7777) !== expectedEntry.mode) throw new DodoError('RECOVERY_REQUIRED', 'image source size or mode differs from its recorded manifest');
        extracted += header.size;
        if (extracted > DEPLOYMENT_ARCHIVE_BYTES) throw new DodoError('RESOURCE_LIMIT', 'container source budget exceeded');
        const chunks: Buffer[] = []; let bytes = 0;
        for await (const raw of stream) { const chunk = Buffer.from(raw as Uint8Array); bytes += chunk.length;
          if (bytes > expectedEntry.bytes) throw new DodoError('RESOURCE_LIMIT', 'archive entry exceeds declared bytes'); chunks.push(chunk); }
        const data = Buffer.concat(chunks);
        if (bytes !== expectedEntry.bytes || header.type === 'file' && sha256Bytes(data).slice(7) !== expectedEntry.hash)
          throw new DodoError('RECOVERY_REQUIRED', 'image source hash differs; image labels are not proof');
        if (header.type === 'file') files.set(name, data);
        next();
      })().catch(fail);
    });
  });
  parser.end(archive);
  await checked;
  if ([...wanted.keys()].some(name => !seen.has(name))) throw new DodoError('NOT_SUPPORTED', 'image source is missing or partial; exact recovery is unavailable');
  return { files, fileCount: files.size, bytes: extracted, complete: true as const };
}
