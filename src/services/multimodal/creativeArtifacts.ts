import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DodoError } from '../../errors.js';
import { ensurePrivateDirectory, assertPrivatePath } from '../../platform/privateFs.js';
import { renameWithRetry, removeWithRetry } from '../../platform/fsRetry.js';
import { sha256Bytes } from '../../util/hash.js';
import { ResourceMetadata, type ResourceMetadataData } from '../resources/contracts.js';

const Receipt = z.object({ version: z.literal(1), workspaceId: z.string(), owner: z.string(), jobId: z.string(), mimeType: z.enum(['image/png', 'video/mp4']), hash: z.string().regex(/^sha256:[a-f0-9]{64}$/), bytes: z.number().int().min(1).max(64 * 1024 * 1024), metadata: ResourceMetadata }).strict();

/** Private durable provider-output outbox. It never contains credentials, prompts or endpoint URLs. */
export class CreativeArtifacts {
  readonly root: string;
  constructor(configDir: string) { this.root = path.join(configDir, 'creative-output'); ensurePrivateDirectory(this.root); }
  private directory(id: string): string { if (!/^creative_[a-z0-9]{8,64}$/.test(id)) throw new DodoError('INVALID_INPUT', 'invalid creative artifact ID'); assertPrivatePath(this.root, true); return path.join(this.root, id); }
  private atomic(file: string, bytes: Buffer): void {
    const stage = `${file}.${process.pid}.${randomUUID()}.part`;
    if (fs.existsSync(file)) assertPrivatePath(file);
    try {
      const fd = fs.openSync(stage, 'wx', 0o600);
      try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      assertPrivatePath(stage); renameWithRetry(stage, file);
    } finally { if (fs.existsSync(stage)) removeWithRetry(stage); }
    if (process.platform !== 'win32') { const directory = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); } }
  }
  private readPrivate(file: string, maximum: number): Buffer {
    const before = assertPrivatePath(file);
    if (before.size > maximum) throw new DodoError('FILE_CHANGED', 'private creative output exceeds its budget');
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const opened = fs.fstatSync(fd);
      if (!opened.isFile() || opened.nlink !== 1 || before.dev !== opened.dev || before.ino !== opened.ino || before.size !== opened.size || before.mtimeMs !== opened.mtimeMs) throw new DodoError('FILE_CHANGED', 'private creative output changed before opening');
      const bytes = fs.readFileSync(fd), after = fs.fstatSync(fd);
      if (bytes.length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new DodoError('FILE_CHANGED', 'private creative output changed while reading');
      return bytes;
    } finally { fs.closeSync(fd); }
  }
  write(workspaceId: string, owner: string, jobId: string, bytes: Buffer, mimeType: 'image/png' | 'video/mp4', metadata: ResourceMetadataData): void {
    const directory = this.directory(jobId); ensurePrivateDirectory(directory);
    const value = Receipt.parse({ version: 1, workspaceId, owner, jobId, bytes: bytes.length, mimeType, hash: sha256Bytes(bytes), metadata });
    this.atomic(path.join(directory, 'output.bin'), bytes);
    this.atomic(path.join(directory, 'receipt.json'), Buffer.from(JSON.stringify(value)));
  }
  read(workspaceId: string, owner: string, jobId: string, expectedMime?: 'image/png' | 'video/mp4'): { bytes: Buffer; mimeType: 'image/png' | 'video/mp4'; metadata: ResourceMetadataData } | undefined {
    const directory = this.directory(jobId);
    if (!fs.existsSync(path.join(directory, 'receipt.json'))) {
      const binary = path.join(directory, 'output.bin');
      if (!expectedMime || !fs.existsSync(binary)) return undefined;
      // The caller has already resolved an owned durable job row. A complete
      // atomically published blob can precede its metadata during a crash.
      assertPrivatePath(directory, true); const stat = assertPrivatePath(binary);
      if (stat.size < 12 || stat.size > 64 * 1024 * 1024) throw new DodoError('FILE_CHANGED', 'incomplete creative output cannot be recovered');
      const bytes = this.readPrivate(binary, 64 * 1024 * 1024);
      const valid = expectedMime === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : bytes.subarray(4, 8).toString('ascii') === 'ftyp';
      if (!valid) throw new DodoError('FILE_CHANGED', 'creative output does not match the owned job type');
      const metadata = { format: expectedMime === 'image/png' ? 'png' : 'mp4' };
      this.atomic(path.join(directory, 'receipt.json'), Buffer.from(JSON.stringify(Receipt.parse({ version: 1, workspaceId, owner, jobId, bytes: bytes.length, mimeType: expectedMime, hash: sha256Bytes(bytes), metadata }))));
    }
    assertPrivatePath(directory, true);
    const file = path.join(directory, 'receipt.json'), stat = assertPrivatePath(file);
    if (stat.size > 4096) throw new DodoError('INTERNAL_ERROR', 'creative output receipt exceeds its budget');
    const value = Receipt.parse(JSON.parse(this.readPrivate(file, 4096).toString('utf8')));
    if (value.jobId !== jobId || value.workspaceId !== workspaceId || value.owner !== owner) throw new DodoError('FORBIDDEN', 'creative output receipt belongs to another caller');
    const binary = path.join(directory, 'output.bin'), before = assertPrivatePath(binary);
    if (before.size !== value.bytes) throw new DodoError('FILE_CHANGED', 'creative output size changed');
    const bytes = this.readPrivate(binary, 64 * 1024 * 1024);
    if (sha256Bytes(bytes) !== value.hash) throw new DodoError('FILE_CHANGED', 'creative output integrity check failed');
    return { bytes, mimeType: value.mimeType, metadata: value.metadata };
  }
  remove(jobId: string): void {
    const directory = this.directory(jobId); if (!fs.existsSync(directory)) return; assertPrivatePath(directory, true);
    for (const name of fs.readdirSync(directory)) {
      if (!/^(?:receipt\.json|output\.bin)(?:\.\d+(?:\.[a-f0-9-]{36})?\.part)?$/.test(name)) continue;
      const file = path.join(directory, name); assertPrivatePath(file); removeWithRetry(file);
    }
    if (fs.readdirSync(directory).length === 0) fs.rmdirSync(directory);
  }
}
