import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DodoError } from '../errors.js';
import { assertPrivatePath, ensurePrivateDirectory } from '../platform/privateFs.js';
import { renameWithRetry } from '../platform/fsRetry.js';
import { legacyConfigDirs } from './paths.js';

/**
 * Only durable, owner-private state is eligible for an existing-state import.
 * Runtime IPC descriptors and lock files are deliberately excluded. A source
 * containing either is refused so a live Dodo process cannot be snapshotted.
 */
export const LEGACY_IMPORT_ENTRIES = [
  'config.json',
  'state.db',
  'state.db-wal',
  'state.db-shm',
  'keys',
  'audit',
  'backups',
  'journal',
  'jobs',
  'setup-receipts',
] as const;

const MAX_IMPORT_BYTES = 1024 * 1024 * 1024;
const MAX_IMPORT_FILES = 20_000;

export type LegacyMigrationState = 'not-needed' | 'available' | 'blocked';

export interface LegacyMigrationPlan {
  schemaVersion: 1;
  state: LegacyMigrationState;
  targetDir: string;
  sourceDir?: string;
  entries: string[];
  ignoredEntries: string[];
  bytes: number;
  reason?: string;
}

export interface LegacyMigrationResult {
  schemaVersion: 1;
  sourceDir: string;
  targetDir: string;
  entries: string[];
  bytes: number;
  receipt: string;
  sourcePreserved: true;
}

interface ScanResult {
  entries: string[];
  bytes: number;
}

function exists(target: string): boolean {
  try {
    fs.lstatSync(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function assertNotLink(target: string): fs.Stats {
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) throw new DodoError('PATH_DENIED', `legacy state contains a symbolic link: ${path.basename(target)}`);
  return stat;
}

function scanNode(source: string, relative: string, total: { bytes: number; files: number }): ScanResult {
  const stat = assertNotLink(source);
  if (stat.isDirectory()) {
    assertPrivatePath(source, true);
    const entries: string[] = [];
    for (const child of fs.readdirSync(source)) {
      const childResult = scanNode(path.join(source, child), path.join(relative, child), total);
      entries.push(...childResult.entries);
    }
    return { entries: entries.length ? entries : [relative], bytes: 0 };
  }
  if (!stat.isFile() || stat.nlink !== 1) throw new DodoError('PATH_DENIED', `legacy state contains a non-private file: ${relative}`);
  assertPrivatePath(source, false);
  total.files += 1;
  total.bytes += stat.size;
  if (total.files > MAX_IMPORT_FILES || total.bytes > MAX_IMPORT_BYTES) throw new DodoError('RESOURCE_LIMIT', 'legacy state exceeds the migration budget');
  return { entries: [relative], bytes: stat.size };
}

function inspectCandidate(sourceDir: string, targetDir: string): LegacyMigrationPlan {
  const ignoredEntries: string[] = [];
  try {
    const root = assertNotLink(sourceDir);
    if (!root.isDirectory()) return { schemaVersion: 1, state: 'blocked', targetDir, sourceDir, entries: [], ignoredEntries, bytes: 0, reason: 'legacy state path is not a directory' };
    assertPrivatePath(sourceDir, true);
    const rootEntries = fs.readdirSync(sourceDir);
    if (rootEntries.includes('setup.lock')) {
      return { schemaVersion: 1, state: 'blocked', targetDir, sourceDir, entries: [], ignoredEntries, bytes: 0, reason: 'setup.lock exists; stop the legacy process before importing' };
    }
    const ipc = path.join(sourceDir, 'ipc');
    if (exists(ipc)) {
      const ipcStat = assertNotLink(ipc);
      if (!ipcStat.isDirectory()) return { schemaVersion: 1, state: 'blocked', targetDir, sourceDir, entries: [], ignoredEntries, bytes: 0, reason: 'legacy IPC path is not a directory' };
      if (fs.readdirSync(ipc).length > 0) {
        return { schemaVersion: 1, state: 'blocked', targetDir, sourceDir, entries: [], ignoredEntries, bytes: 0, reason: 'IPC runtime markers exist; stop the legacy process and retry' };
      }
    }
    const selected = rootEntries.filter(entry => (LEGACY_IMPORT_ENTRIES as readonly string[]).includes(entry));
    ignoredEntries.push(...rootEntries.filter(entry => !selected.includes(entry)));
    if (!selected.length) return { schemaVersion: 1, state: 'not-needed', targetDir, sourceDir, entries: [], ignoredEntries, bytes: 0, reason: 'no importable legacy state was found' };
    const total = { bytes: 0, files: 0 };
    const entries: string[] = [];
    for (const entry of selected) entries.push(...scanNode(path.join(sourceDir, entry), entry, total).entries);
    return { schemaVersion: 1, state: 'available', targetDir, sourceDir, entries, ignoredEntries, bytes: total.bytes };
  } catch (error) {
    const reason = error instanceof DodoError ? error.message : `cannot inspect legacy state: ${(error as Error).message}`;
    return { schemaVersion: 1, state: 'blocked', targetDir, sourceDir, entries: [], ignoredEntries, bytes: 0, reason };
  }
}

/** Build a plan without creating directories, opening SQLite, or copying state. */
export function planLegacyMigration(targetDir: string, candidates = legacyConfigDirs()): LegacyMigrationPlan {
  const target = path.resolve(targetDir);
  if (path.parse(target).root === target) throw new DodoError('PATH_DENIED', 'Dodo state must use a dedicated directory');
  if (exists(target)) {
    const stat = assertNotLink(target);
    if (!stat.isDirectory()) throw new DodoError('PATH_DENIED', 'Dodo state path is not a directory');
    return { schemaVersion: 1, state: 'not-needed', targetDir: target, entries: [], ignoredEntries: [], bytes: 0, reason: 'Dodo state already exists; automatic merge is disabled' };
  }
  for (const candidate of candidates) {
    const source = path.resolve(candidate);
    if (source === target || !exists(source)) continue;
    const plan = inspectCandidate(source, target);
    if (plan.state === 'available' || plan.state === 'blocked') return plan;
  }
  return { schemaVersion: 1, state: 'not-needed', targetDir: target, entries: [], ignoredEntries: [], bytes: 0, reason: 'no legacy Dodo state was found' };
}

function copyNode(source: string, destination: string): void {
  const stat = assertNotLink(source);
  if (stat.isDirectory()) {
    ensurePrivateDirectory(destination);
    for (const child of fs.readdirSync(source)) copyNode(path.join(source, child), path.join(destination, child));
    return;
  }
  if (!stat.isFile() || stat.nlink !== 1) throw new DodoError('PATH_DENIED', `legacy state contains a non-private file: ${path.basename(source)}`);
  assertPrivatePath(source, false);
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  if (process.platform !== 'win32') fs.chmodSync(destination, 0o600);
  assertPrivatePath(destination, false);
}

/**
 * Import a previously planned legacy state into a new Dodo directory. The
 * source remains untouched and the destination appears in one atomic rename.
 */
export function importLegacyState(plan: LegacyMigrationPlan): LegacyMigrationResult {
  if (plan.state !== 'available' || !plan.sourceDir) throw new DodoError('CONFLICT', plan.reason ?? 'no importable legacy state is available');
  const sourceDir = path.resolve(plan.sourceDir);
  const targetDir = path.resolve(plan.targetDir);
  const parent = path.dirname(targetDir);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const parentStat = assertNotLink(parent);
  if (!parentStat.isDirectory()) throw new DodoError('PATH_DENIED', 'Dodo state parent is not a directory');
  const lock = `${targetDir}.migration.lock`;
  const lockBody = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
  try {
    fs.writeFileSync(lock, lockBody, { flag: 'wx', mode: 0o600 });
  } catch {
    throw new DodoError('CONFLICT', 'another Dodo migration may be running; inspect the migration lock locally');
  }
  const stage = `${targetDir}.migration-${randomUUID()}`;
  try {
    if (exists(targetDir)) throw new DodoError('FILE_CHANGED', 'Dodo state appeared during migration; source was preserved');
    // Revalidate immediately before copying: the plan is advisory and the
    // legacy process may have started after the initial inspection.
    const current = inspectCandidate(sourceDir, targetDir);
    if (current.state !== 'available') throw new DodoError('CONFLICT', current.reason ?? 'legacy state changed; migration was refused');
    ensurePrivateDirectory(stage);
    const selected = fs.readdirSync(sourceDir).filter(entry => (LEGACY_IMPORT_ENTRIES as readonly string[]).includes(entry));
    for (const entry of selected) copyNode(path.join(sourceDir, entry), path.join(stage, entry));
    const receipt = path.join(stage, 'migration.json');
    fs.writeFileSync(receipt, JSON.stringify({ schemaVersion: 1, kind: 'dodo-state-import', sourceDir, importedAt: new Date().toISOString(), entries: current.entries, bytes: current.bytes, sourcePreserved: true }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    assertPrivatePath(receipt, false);
    renameWithRetry(stage, targetDir);
    return { schemaVersion: 1, sourceDir, targetDir, entries: current.entries, bytes: current.bytes, receipt: path.join(targetDir, 'migration.json'), sourcePreserved: true };
  } finally {
    try { if (exists(stage)) fs.rmSync(stage, { recursive: true, force: true, maxRetries: 3, retryDelay: 40 }); } catch { /* preserve the recovery path if cleanup is blocked */ }
    try { if (fs.readFileSync(lock, 'utf8') === lockBody) fs.unlinkSync(lock); } catch { /* never remove a replaced lock */ }
  }
}
