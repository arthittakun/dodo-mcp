import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { DodoError } from '../errors.js';
import { assertPrivatePath, ensurePrivateDirectory } from '../platform/privateFs.js';
import { removeWithRetry, renameWithRetry } from '../platform/fsRetry.js';
import { DODO_VERSION } from '../server/version.js';

const DIRECTORY = 'state-checkpoints';
const RETAIN = 5;
const FILE_CAP = 1024 * 1024 * 1024;
const JSON_CAP = 4 * 1024 * 1024;
const LOCK_TIMEOUT = 15000;
const activeLocks = new Map<string, number>();
const Id = z.string().regex(/^state_[a-z0-9]+_[a-f0-9]{12}$/);
const FileEntry = z.object({ path: z.string(), bytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const Manifest = z.object({
  version: z.literal(1), id: Id, createdAt: z.number().int(), runtimeVersion: z.string(), previousRuntimeVersion: z.string().nullable(),
  reason: z.enum(['manual', 'before-migration', 'before-version-open', 'before-config-change', 'before-restore']),
  databaseSchemaVersion: z.number().int().nonnegative().nullable(), targetSchemaVersion: z.number().int().nonnegative().nullable(),
  files: z.array(FileEntry).max(2048), ownedCredentialFiles: z.array(z.string().regex(/^ai_[a-z0-9_-]{8,64}\.env$/)).max(1000),
  note: z.string(),
}).strict();
const RestoreJournal = z.object({ version: z.literal(1), checkpointId: Id, manifestHash: z.string().regex(/^[a-f0-9]{64}$/), emergencyCheckpointId: Id, createdAt: z.number().int() }).strict();
export type StateCheckpointManifest = z.infer<typeof Manifest>;
export interface StateCheckpointInfo extends Omit<StateCheckpointManifest, 'files'> { files: z.infer<typeof FileEntry>[]; manifestHash: string }

function digest(bytes: Buffer | string): string { return createHash('sha256').update(bytes).digest('hex'); }
function samePath(left: string, right: string): boolean { return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right; }
function existsEntry(file: string): boolean { try { fs.lstatSync(file); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }
function assertCanonical(target: string): void {
  const absolute = path.resolve(target), root = path.parse(absolute).root;
  for (let item = absolute; item !== root; item = path.dirname(item)) {
    try { if (fs.lstatSync(item).isSymbolicLink()) throw new DodoError('PATH_DENIED', 'state paths must not contain links'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  if (fs.existsSync(absolute) && !samePath(fs.realpathSync.native(absolute), absolute)) throw new DodoError('PATH_DENIED', 'state paths must be canonical');
}
function privateDirectory(directory: string): void { assertCanonical(directory); ensurePrivateDirectory(directory); assertPrivatePath(directory, true); }
function safeFile(file: string, cap = FILE_CAP): fs.Stats {
  assertCanonical(file);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > cap || (process.platform !== 'win32' && stat.uid !== process.getuid?.())) throw new DodoError('PATH_DENIED', 'state file must be a bounded regular owner file');
  return stat;
}
function syncDirectory(directory: string): void {
  if (process.platform === 'win32') return;
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}
function readFile(file: string, cap = FILE_CAP): Buffer {
  const before = safeFile(file, cap), descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(descriptor);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size || opened.nlink !== 1) throw new DodoError('FILE_CHANGED', 'state file changed while opening');
    const value = fs.readFileSync(descriptor), after = fs.fstatSync(descriptor);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new DodoError('FILE_CHANGED', 'state file changed while reading');
    return value;
  } finally { fs.closeSync(descriptor); }
}
function hashFile(file: string): { bytes: number; sha256: string } {
  const before = safeFile(file), descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(descriptor);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1) throw new DodoError('FILE_CHANGED', 'state file changed while hashing');
    const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024); let offset = 0;
    while (offset < before.size) { const amount = fs.readSync(descriptor, buffer, 0, Math.min(buffer.length, before.size - offset), offset); if (!amount) throw new DodoError('FILE_CHANGED', 'state file ended while hashing'); hash.update(buffer.subarray(0, amount)); offset += amount; }
    const after = fs.fstatSync(descriptor);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new DodoError('FILE_CHANGED', 'state file changed while hashing');
    return { bytes: offset, sha256: hash.digest('hex') };
  } finally { fs.closeSync(descriptor); }
}

/** Same-directory staged writes: a failed pre-commit operation leaves the old file intact. */
export function atomicPrivateWrite(file: string, data: string | Buffer): void {
  const target = path.resolve(file), directory = path.dirname(target);
  privateDirectory(directory);
  if (existsEntry(target)) safeFile(target);
  const stage = path.join(directory, `.${path.basename(target)}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(stage, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    fs.writeFileSync(descriptor, data); fs.fsyncSync(descriptor);
    assertPrivatePath(stage);
    fs.closeSync(descriptor); descriptor = undefined;
    assertCanonical(directory); if (existsEntry(target)) safeFile(target);
    renameWithRetry(stage, target); syncDirectory(directory);
    assertPrivatePath(target);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(stage)) { safeFile(stage); removeWithRetry(stage); }
  }
}
function atomicPrivateCopy(source: string, target: string): void {
  const before = safeFile(source), directory = path.dirname(target); privateDirectory(directory);
  if (existsEntry(target)) safeFile(target);
  const stage = path.join(directory, `.${path.basename(target)}.${randomUUID()}.tmp`);
  const input = fs.openSync(source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)); let output: number | undefined;
  try {
    const opened = fs.fstatSync(input);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1) throw new DodoError('FILE_CHANGED', 'checkpoint changed before copying');
    output = fs.openSync(stage, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    const buffer = Buffer.allocUnsafe(1024 * 1024); let offset = 0;
    while (offset < before.size) {
      const amount = fs.readSync(input, buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      if (!amount) throw new DodoError('FILE_CHANGED', 'checkpoint ended while copying');
      let written = 0; while (written < amount) { const count = fs.writeSync(output, buffer, written, amount - written); if (!count) throw new Error('short checkpoint write'); written += count; }
      offset += amount;
    }
    const after = fs.fstatSync(input);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new DodoError('FILE_CHANGED', 'checkpoint changed while copying');
    fs.fsyncSync(output); fs.closeSync(output); output = undefined; assertPrivatePath(stage);
    if (existsEntry(target)) safeFile(target);
    renameWithRetry(stage, target); syncDirectory(directory); assertPrivatePath(target);
  } finally {
    fs.closeSync(input); if (output !== undefined) fs.closeSync(output);
    if (fs.existsSync(stage)) { safeFile(stage); removeWithRetry(stage); }
  }
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
export function liveStateRuntimePids(configDir: string, includeCurrent = false): number[] {
  const directory = path.join(path.resolve(configDir), 'runtime-leases'), result = new Set<number>();
  if (!fs.existsSync(directory)) return [];
  assertCanonical(directory);
  for (const name of fs.readdirSync(directory)) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    let value: { pid?: unknown };
    try { value = JSON.parse(readFile(path.join(directory, name), 1024).toString('utf8')) as { pid?: unknown }; }
    catch { throw new DodoError('CONFLICT', 'cannot establish whether an installation runtime is still using state'); }
    if (!Number.isSafeInteger(value.pid) || Number(value.pid) <= 0) throw new DodoError('CONFLICT', 'invalid runtime lease prevents an offline state operation');
    const pid = Number(value.pid);
    if ((includeCurrent || pid !== process.pid) && processAlive(pid)) result.add(pid);
  }
  return [...result];
}
function requireOffline(configDir: string, includeCurrent = false): void {
  if (liveStateRuntimePids(configDir, includeCurrent).length) throw new DodoError('CONFLICT', 'stop all DODO processes using this configuration directory before upgrading or restoring installation state', { recovery: 'run dodo kill with this DODO_CONFIG_DIR, then retry the owner operation' });
}

/** SQLite owns this separate installation file lock, including crash-safe release. */
export function withInstallationStateLock<T>(configDir: string, operation: () => T): T {
  const directory = path.resolve(configDir), key = process.platform === 'win32' ? directory.toLowerCase() : directory;
  if (activeLocks.has(key)) {
    activeLocks.set(key, activeLocks.get(key)! + 1);
    try { return operation(); } finally { activeLocks.set(key, activeLocks.get(key)! - 1); }
  }
  privateDirectory(directory);
  const file = path.join(directory, 'installation-state.lock.db');
  for (const candidate of [file, file + '-journal', file + '-wal', file + '-shm']) {
    if (existsEntry(candidate)) { safeFile(candidate, 128 * 1024); assertPrivatePath(candidate); }
  }
  const lock = new Database(file, { timeout: LOCK_TIMEOUT });
  try {
    if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
    safeFile(file, 128 * 1024); assertPrivatePath(file);
    // This empty file stores no data; memory journals avoid transient sidecar ACL races.
    lock.pragma('journal_mode = MEMORY');
    lock.pragma('synchronous = FULL');
    // SQLite locks empty files too; writing a table would race another process's ACL/content verification.
    lock.exec('BEGIN EXCLUSIVE');
    activeLocks.set(key, 1);
    try { return operation(); } finally { activeLocks.delete(key); }
  } catch (error) {
    if ((error as { code?: string }).code === 'SQLITE_BUSY' || (error as { code?: string }).code === 'SQLITE_LOCKED') {
      throw new DodoError('CONFLICT', 'another process is preparing installation state; retry after it finishes', { retryable: true });
    }
    throw error;
  } finally {
    try { if (lock.inTransaction) lock.exec('ROLLBACK'); } finally { lock.close(); }
  }
}

export function assertNoPendingStateRestore(configDir: string): void {
  const file = path.join(configDir, 'state-restore.json');
  if (!existsEntry(file)) return;
  let recovery = 'inspect the owner state restore journal and resume the exact checkpoint restore before starting DODO';
  try {
    const journal = RestoreJournal.parse(JSON.parse(readFile(file, 4096).toString('utf8')));
    recovery = `resume dodo state restore ${journal.checkpointId} --hash ${journal.manifestHash} --yes with every DODO process stopped`;
  } catch { /* a damaged journal must never allow mixed installation state to boot */ }
  throw new DodoError('RECOVERY_REQUIRED', 'installation restore is incomplete; refusing to open or change mixed DB/config/credential state', { recovery });
}

export function databaseSchemaVersion(db: Database.Database): number {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
  if (!exists) return 0;
  return Number((db.prepare('SELECT COALESCE(MAX(version),0) AS version FROM schema_migrations').get() as { version: number }).version);
}
export function recordedRuntimeVersion(configDir: string, db?: Database.Database): string | null {
  try {
    if (db?.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta'").get()) {
      const row = db.prepare("SELECT value FROM meta WHERE key='dodo-runtime-version'").get() as { value: string } | undefined;
      if (row?.value) return row.value;
    }
    const file = path.join(configDir, 'state-runtime-version.json');
    if (fs.existsSync(file)) return String((JSON.parse(readFile(file, 4096).toString('utf8')) as { version: string }).version);
  } catch { /* unknown previous runtime is recorded honestly in the checkpoint */ }
  return null;
}
export function recordStateRuntimeVersion(configDir: string, db?: Database.Database): void {
  if (db?.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta'").get()) db.prepare("INSERT INTO meta(key,value) VALUES('dodo-runtime-version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(DODO_VERSION);
  const target = path.join(configDir, 'state-runtime-version.json');
  if (recordedRuntimeVersion(configDir) !== DODO_VERSION) atomicPrivateWrite(target, JSON.stringify({ version: DODO_VERSION }) + '\n');
}
function allowedEntry(value: string): boolean {
  return ['state.db', 'config.json', 'keys/jwks.json', 'keys/cookies.json'].includes(value) || /^credentials\/ai\/ai_[a-z0-9_-]{8,64}\.env$/.test(value);
}
function checkpointRoot(configDir: string): string { return path.join(path.resolve(configDir), DIRECTORY); }
function directoryFor(configDir: string, id: string): string { return path.join(checkpointRoot(configDir), Id.parse(id)); }
function relativeFile(directory: string, relative: string): string {
  if (!allowedEntry(relative)) throw new DodoError('INVALID_INPUT', 'unexpected checkpoint file');
  return path.join(directory, ...relative.split('/'));
}
function verifyDirectory(configDir: string, id: string): StateCheckpointInfo {
  const directory = directoryFor(configDir, id); assertCanonical(directory); assertPrivatePath(directory, true);
  const raw = readFile(path.join(directory, 'manifest.json'), JSON_CAP);
  const manifestHash = digest(raw), storedHash = readFile(path.join(directory, 'manifest.sha256'), 128).toString('utf8').trim();
  if (manifestHash !== storedHash) throw new DodoError('FILE_CHANGED', 'checkpoint manifest integrity check failed');
  const manifest = Manifest.parse(JSON.parse(raw.toString('utf8')));
  if (manifest.id !== id || new Set(manifest.files.map(file => file.path)).size !== manifest.files.length) throw new DodoError('INVALID_INPUT', 'invalid checkpoint identity or file list');
  const credentialNames = manifest.files.filter(file => file.path.startsWith('credentials/ai/')).map(file => path.posix.basename(file.path)).sort();
  if (JSON.stringify(credentialNames) !== JSON.stringify([...new Set(manifest.ownedCredentialFiles)].sort())) throw new DodoError('INVALID_INPUT', 'checkpoint credential manifest does not match its files');
  for (const entry of manifest.files) {
    const file = relativeFile(directory, entry.path); assertPrivatePath(file);
    const actual = hashFile(file);
    if (actual.bytes !== entry.bytes || actual.sha256 !== entry.sha256) throw new DodoError('FILE_CHANGED', 'checkpoint file integrity check failed');
  }
  if (manifest.files.some(file => file.path === 'state.db')) {
    const db = new Database(path.join(directory, 'state.db'), { readonly: true, fileMustExist: true });
    try {
      if (db.pragma('quick_check', { simple: true }) !== 'ok' || databaseSchemaVersion(db) !== manifest.databaseSchemaVersion) throw new DodoError('FILE_CHANGED', 'checkpoint database verification failed');
    } finally { db.close(); }
  } else if (manifest.databaseSchemaVersion !== null) throw new DodoError('INVALID_INPUT', 'checkpoint database metadata does not match its files');
  return { ...manifest, manifestHash };
}
export function inspectStateCheckpoint(configDir: string, id: string): StateCheckpointInfo { return verifyDirectory(configDir, id); }
export function listStateCheckpoints(configDir: string): StateCheckpointInfo[] {
  const directory = checkpointRoot(configDir);
  if (!fs.existsSync(directory)) return [];
  assertCanonical(directory); assertPrivatePath(directory, true);
  return fs.readdirSync(directory).filter(name => Id.safeParse(name).success).map(id => verifyDirectory(configDir, id)).sort((left, right) => right.createdAt - left.createdAt);
}
function prune(configDir: string, keepId: string, preserveIds: readonly string[] = []): void {
  const all = listStateCheckpoints(configDir);
  for (const item of all.slice(RETAIN)) {
    if (item.id === keepId || preserveIds.includes(item.id)) continue;
    const target = directoryFor(configDir, item.id);
    // Every final target has been parsed, checked under the dedicated root and fully verified.
    if (path.dirname(target) !== checkpointRoot(configDir)) throw new DodoError('PATH_DENIED', 'invalid checkpoint pruning target');
    removeWithRetry(target, true);
  }
}

export function createStateCheckpoint(configDir: string, options: { db?: Database.Database; reason?: StateCheckpointManifest['reason']; targetSchemaVersion?: number; offline?: boolean; preserveIds?: readonly string[] } = {}): StateCheckpointInfo {
  return withInstallationStateLock(configDir, () => {
    assertNoPendingStateRestore(configDir);
    if (options.offline !== false) requireOffline(configDir);
    const root = checkpointRoot(configDir); privateDirectory(root);
    const id = `state_${Date.now().toString(36)}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const stage = path.join(root, `.staging-${randomUUID()}`), final = directoryFor(configDir, id); privateDirectory(stage);
    const files: StateCheckpointManifest['files'] = [], ownedCredentialFiles: string[] = [];
    let opened: Database.Database | undefined;
    let db = options.db;
    try {
      const dbFile = path.join(configDir, 'state.db');
      if (!db && fs.existsSync(dbFile)) { safeFile(dbFile); db = opened = new Database(dbFile, { readonly: true, fileMustExist: true, timeout: 10000 }); }
      const schema = db ? databaseSchemaVersion(db) : null;
      if (db) {
        // VACUUM INTO is a SQLite-consistent snapshot and includes committed WAL rows.
        // It runs before the migration transaction; copying only state.db would lose WAL data.
        const dest = path.join(stage, 'state.db'); db.prepare('VACUUM INTO ?').run(dest);
        if (process.platform !== 'win32') fs.chmodSync(dest, 0o600);
        const descriptor = fs.openSync(dest, fs.constants.O_RDWR); try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
        assertPrivatePath(dest);
        files.push({ path: 'state.db', ...hashFile(dest) });
      }
      const copy = (relative: string) => {
        const source = relativeFile(configDir, relative);
        if (!fs.existsSync(source)) return;
        const bytes = readFile(source, relative === 'config.json' ? JSON_CAP : 128 * 1024);
        const target = relativeFile(stage, relative); atomicPrivateWrite(target, bytes);
        files.push({ path: relative, bytes: bytes.length, sha256: digest(bytes) });
      };
      for (const relative of ['config.json', 'keys/jwks.json', 'keys/cookies.json']) copy(relative);
      const credentials = path.join(configDir, 'credentials', 'ai');
      if (fs.existsSync(credentials)) {
        assertCanonical(credentials); assertPrivatePath(credentials, true);
        for (const name of fs.readdirSync(credentials)) {
          if (!/^ai_[a-z0-9_-]{8,64}\.env$/.test(name)) continue;
          if (ownedCredentialFiles.length >= 1000) throw new DodoError('RESOURCE_LIMIT', 'too many owned credential files for a bounded state checkpoint');
          copy(`credentials/ai/${name}`); ownedCredentialFiles.push(name);
        }
      }
      const manifest: StateCheckpointManifest = { version: 1, id, createdAt: Date.now(), runtimeVersion: DODO_VERSION, previousRuntimeVersion: recordedRuntimeVersion(configDir, db),
        reason: options.reason ?? 'manual', databaseSchemaVersion: schema, targetSchemaVersion: options.targetSchemaVersion ?? null, files, ownedCredentialFiles,
        note: 'Installation database/config/owned Env/signing-key checkpoint. External Env and OS-vault values are not exported. Project files and generated-media bytes are not copied. Restoring reverts database state, including authentication and settings, to this point.' };
      const raw = JSON.stringify(Manifest.parse(manifest), null, 2) + '\n';
      atomicPrivateWrite(path.join(stage, 'manifest.json'), raw); atomicPrivateWrite(path.join(stage, 'manifest.sha256'), digest(raw) + '\n');
      syncDirectory(stage); renameWithRetry(stage, final); syncDirectory(root);
      const verified = verifyDirectory(configDir, id);
      // Retention must not make a completed checkpoint or its required migration fail.
      try { prune(configDir, id, options.preserveIds); } catch { /* retain additional private checkpoints when pruning is not possible */ }
      return verified;
    } catch (error) {
      throw error instanceof DodoError ? error : new DodoError('INTERNAL_ERROR', 'installation checkpoint failed; no migration or restore was started', { recovery: 'fix free space, permissions or checkpoint integrity, then retry' });
    } finally {
      opened?.close();
      if (fs.existsSync(stage) && path.dirname(stage) === root) { try { assertPrivatePath(stage, true); removeWithRetry(stage, true); } catch { /* uncertain cleanup never bypasses private path validation */ } }
    }
  });
}

/** Protect every content-changing config save, even releases with no SQL migration. */
export function checkpointBeforeConfigWrite(configFile: string, next: string): void {
  const directory = path.dirname(path.resolve(configFile));
  assertNoPendingStateRestore(directory);
  if (!fs.existsSync(configFile)) return;
  const previous = readFile(configFile, JSON_CAP);
  if (previous.equals(Buffer.from(next))) return;
  if (recordedRuntimeVersion(directory) !== DODO_VERSION) createStateCheckpoint(directory, { reason: 'before-config-change' });
  const history = path.join(directory, 'config-history'); privateDirectory(history);
  atomicPrivateWrite(path.join(history, `config-${Date.now()}-${randomUUID().slice(0, 8)}.json`), previous);
  const names = fs.readdirSync(history).filter(name => /^config-[0-9]+-[a-f0-9-]+\.json$/.test(name)).sort().reverse();
  for (const name of names.slice(RETAIN)) { const file = path.join(history, name); safeFile(file, JSON_CAP); removeWithRetry(file); }
}

export function restoreStateCheckpoint(configDir: string, id: string, options: { confirm: true; expectedManifestHash: string }): { restored: string; emergencyCheckpointId: string; databaseSchemaVersion: number | null; note: string } {
  return withInstallationStateLock(configDir, () => {
    requireOffline(configDir, true);
    const checkpoint = verifyDirectory(configDir, id);
    if (options.confirm !== true || checkpoint.manifestHash !== options.expectedManifestHash) throw new DodoError('INVALID_INPUT', 'inspect this checkpoint and confirm its exact manifest hash before restoring');
    const journalFile = path.join(configDir, 'state-restore.json');
    let emergencyId: string;
    if (fs.existsSync(journalFile)) {
      const journal = RestoreJournal.parse(JSON.parse(readFile(journalFile, 4096).toString('utf8')));
      if (journal.checkpointId !== id || journal.manifestHash !== options.expectedManifestHash) throw new DodoError('RECOVERY_REQUIRED', 'resume the original installation restore before selecting another checkpoint');
      verifyDirectory(configDir, journal.emergencyCheckpointId); emergencyId = journal.emergencyCheckpointId;
    } else {
      emergencyId = createStateCheckpoint(configDir, { reason: 'before-restore', preserveIds: [id] }).id;
      atomicPrivateWrite(journalFile, JSON.stringify(RestoreJournal.parse({ version: 1, checkpointId: id, manifestHash: checkpoint.manifestHash, emergencyCheckpointId: emergencyId, createdAt: Date.now() })) + '\n');
    }
    requireOffline(configDir, true);
    const sourceRoot = directoryFor(configDir, id), database = checkpoint.files.find(file => file.path === 'state.db');
    const copy = (relative: string) => {
      const entry = checkpoint.files.find(file => file.path === relative), target = relativeFile(configDir, relative);
      if (entry) { if (relative === 'state.db') atomicPrivateCopy(relativeFile(sourceRoot, relative), target); else atomicPrivateWrite(target, readFile(relativeFile(sourceRoot, relative))); }
      else if (fs.existsSync(target)) { safeFile(target); removeWithRetry(target); }
    };
    // Refuse live runtimes before touching any file. Preserve a complete emergency checkpoint first.
    for (const suffix of ['-wal', '-shm']) { const sidecar = path.join(configDir, 'state.db' + suffix); if (fs.existsSync(sidecar)) { safeFile(sidecar); removeWithRetry(sidecar); } }
    if (database) copy('state.db');
    else if (fs.existsSync(path.join(configDir, 'state.db'))) { safeFile(path.join(configDir, 'state.db')); removeWithRetry(path.join(configDir, 'state.db')); }
    for (const relative of ['config.json', 'keys/jwks.json', 'keys/cookies.json']) copy(relative);
    const credentials = path.join(configDir, 'credentials', 'ai');
    if (fs.existsSync(credentials)) for (const name of fs.readdirSync(credentials)) {
      if (/^ai_[a-z0-9_-]{8,64}\.env$/.test(name) && !checkpoint.ownedCredentialFiles.includes(name)) { const file = path.join(credentials, name); safeFile(file); removeWithRetry(file); }
    }
    for (const name of checkpoint.ownedCredentialFiles) copy(`credentials/ai/${name}`);
    if (database) {
      const restored = new Database(path.join(configDir, 'state.db'), { timeout: 10000 });
      try {
        restored.pragma('synchronous = FULL');
        restored.transaction(() => {
          if (restored.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='grants'").get()) restored.prepare('UPDATE grants SET revoked_at=COALESCE(revoked_at,?)').run(Date.now());
          if (restored.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='oauth_models'").get()) restored.exec("DELETE FROM oauth_models WHERE model IN ('Grant','RefreshToken','AccessToken','Session','AuthorizationCode','DeviceCode','Interaction','BackchannelAuthenticationRequest')");
        }).immediate();
      } finally { restored.close(); }
    }
    atomicPrivateWrite(path.join(configDir, 'state-runtime-version.json'), JSON.stringify({ version: checkpoint.previousRuntimeVersion ?? 'unknown' }) + '\n');
    syncDirectory(configDir);
    safeFile(journalFile, 4096); removeWithRetry(journalFile); syncDirectory(configDir);
    try { prune(configDir, emergencyId); } catch { /* keep private recovery evidence when pruning fails */ }
    return { restored: id, emergencyCheckpointId: emergencyId, databaseSchemaVersion: checkpoint.databaseSchemaVersion,
      note: 'Restored installation state. Use a binary compatible with the restored schema/config and sign in again: restored grants/tokens/sessions were revoked to avoid resurrecting withdrawn access. Changes after this checkpoint remain only in the emergency checkpoint. External Env was not changed; OS-vault keys may require reentry.' };
  });
}
