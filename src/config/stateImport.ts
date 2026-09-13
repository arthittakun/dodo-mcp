import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DodoError } from '../errors.js';
import { GlobalConfigSchema, type GlobalConfig } from './globalConfig.js';
import { assertPrivatePath, ensurePrivateDirectory } from '../platform/privateFs.js';
import { renameWithRetry } from '../platform/fsRetry.js';
import { existingConfigDirs } from './paths.js';

/**
 * Existing-state import intentionally carries only non-authority preferences.
 * OAuth material, grants, ACLs, trust, executable registrations, network
 * permissions and runtime data are never copied into a new installation.
 */
export const STATE_IMPORT_CONFIG_FIELDS = [
  'version',
  'port',
  'configPort',
  'limits',
  'searchBackend',
  'logRetentionDays',
  'toolSurface',
] as const satisfies readonly (keyof GlobalConfig)[];

const CONFIG_FILE = 'config.json';
const MAX_CONFIG_BYTES = 1024 * 1024;

export type StateImportState = 'not-needed' | 'available' | 'blocked';

export interface StateImportPlan {
  schemaVersion: 1;
  state: StateImportState;
  targetDir: string;
  sourceDir?: string;
  entries: string[];
  ignoredEntries: string[];
  importedConfigFields: string[];
  resetSecurity: string[];
  bytes: number;
  configSha256?: string;
  reason?: string;
}

export interface StateImportResult {
  schemaVersion: 1;
  sourceDir: string;
  targetDir: string;
  entries: string[];
  ignoredEntries: string[];
  importedConfigFields: string[];
  resetSecurity: string[];
  bytes: number;
  configSha256: string;
  receipt: string;
  sourcePreserved: true;
}

const RESET_SECURITY = [
  'OAuth signing keys, cookies, clients, grants, codes and tokens',
  'workspace client ACLs, trust modes, approvals and schedules',
  'public URL, Host/Origin allowlists and insecure-HTTP override',
  'web and desktop permissions',
  'LSP commands, environment allowlist and sandbox writable paths',
] as const;

interface InspectedConfig {
  clean: GlobalConfig;
  importedConfigFields: string[];
  droppedConfigFields: string[];
  bytes: number;
  configSha256: string;
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
  if (stat.isSymbolicLink()) throw new DodoError('PATH_DENIED', `state import contains a symbolic link: ${path.basename(target)}`);
  return stat;
}

function assertSafeDestinationParent(target: string): void {
  const stat = assertNotLink(target);
  if (!stat.isDirectory()) throw new DodoError('PATH_DENIED', 'Dodo state parent is not a directory');
  if (process.platform === 'win32') {
    assertPrivatePath(target, true);
    return;
  }
  if (stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0) {
    throw new DodoError('PATH_DENIED', 'Dodo state parent must be owned by the current user and not writable by group or others');
  }
}

function inspectConfig(file: string): InspectedConfig {
  const stat = assertNotLink(file);
  if (!stat.isFile() || stat.nlink !== 1) throw new DodoError('PATH_DENIED', 'state import config must be one regular, non-linked file');
  if (stat.size > MAX_CONFIG_BYTES) throw new DodoError('RESOURCE_LIMIT', 'state import config is oversized');
  assertPrivatePath(file, false);
  const bytes = fs.readFileSync(file);
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new DodoError('MIGRATION_REVIEW_REQUIRED', 'existing config is not valid JSON; source was preserved');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new DodoError('MIGRATION_REVIEW_REQUIRED', 'existing config must be a JSON object; source was preserved');
  }
  const parsed = GlobalConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new DodoError('MIGRATION_REVIEW_REQUIRED', 'existing config does not match the Dodo config schema; source was preserved', {
      detail: { issueCount: parsed.error.issues.length },
      recovery: 'review the source config locally; unknown or malformed fields are never imported automatically',
    });
  }
  const present = Object.keys(raw as Record<string, unknown>);
  const allowed = new Set<string>(STATE_IMPORT_CONFIG_FIELDS);
  const importedConfigFields = present.filter(key => allowed.has(key)).sort();
  const droppedConfigFields = present.filter(key => !allowed.has(key)).sort();
  const selected: Record<string, unknown> = { version: 1 };
  for (const key of importedConfigFields) selected[key] = parsed.data[key as keyof GlobalConfig];
  return {
    clean: GlobalConfigSchema.parse(selected),
    importedConfigFields,
    droppedConfigFields,
    bytes: bytes.byteLength,
    configSha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

function blocked(targetDir: string, sourceDir: string | undefined, reason: string): StateImportPlan {
  return {
    schemaVersion: 1,
    state: 'blocked',
    targetDir,
    ...(sourceDir ? { sourceDir } : {}),
    entries: [],
    ignoredEntries: [],
    importedConfigFields: [],
    resetSecurity: [...RESET_SECURITY],
    bytes: 0,
    reason,
  };
}

function inspectCandidate(sourceDir: string, targetDir: string): StateImportPlan {
  try {
    const root = assertNotLink(sourceDir);
    if (!root.isDirectory()) return blocked(targetDir, sourceDir, 'existing state path is not a directory');
    assertPrivatePath(sourceDir, true);
    const rootEntries = fs.readdirSync(sourceDir).sort();
    if (rootEntries.includes('setup.lock')) return blocked(targetDir, sourceDir, 'setup.lock exists; stop the existing setup process before importing');
    const ipc = path.join(sourceDir, 'ipc');
    if (exists(ipc)) {
      const ipcStat = assertNotLink(ipc);
      if (!ipcStat.isDirectory()) return blocked(targetDir, sourceDir, 'IPC runtime path is not a directory');
      if (fs.readdirSync(ipc).length > 0) return blocked(targetDir, sourceDir, 'IPC runtime markers exist; stop the existing Dodo process before importing');
    }
    if (!rootEntries.includes(CONFIG_FILE)) {
      return {
        schemaVersion: 1,
        state: 'not-needed',
        targetDir,
        sourceDir,
        entries: [],
        ignoredEntries: rootEntries,
        importedConfigFields: [],
        resetSecurity: [...RESET_SECURITY],
        bytes: 0,
        reason: 'no importable config was found; credentials and runtime state are never imported',
      };
    }
    const inspected = inspectConfig(path.join(sourceDir, CONFIG_FILE));
    return {
      schemaVersion: 1,
      state: 'available',
      targetDir,
      sourceDir,
      entries: [CONFIG_FILE],
      ignoredEntries: rootEntries.filter(entry => entry !== CONFIG_FILE),
      importedConfigFields: inspected.importedConfigFields,
      resetSecurity: [...RESET_SECURITY, ...inspected.droppedConfigFields.map(field => `config.${field}`)],
      bytes: inspected.bytes,
      configSha256: inspected.configSha256,
    };
  } catch (error) {
    const dodo = error instanceof DodoError ? error : new DodoError('MIGRATION_REVIEW_REQUIRED', 'existing state could not be inspected safely');
    return blocked(targetDir, sourceDir, dodo.message);
  }
}

/** Build a read-only plan. It never creates directories, opens SQLite or reads key/token files. */
export function planStateImport(targetDir: string, candidates = existingConfigDirs()): StateImportPlan {
  const target = path.resolve(targetDir);
  if (path.parse(target).root === target) throw new DodoError('PATH_DENIED', 'Dodo state must use a dedicated directory');
  if (exists(target)) {
    const stat = assertNotLink(target);
    if (!stat.isDirectory()) throw new DodoError('PATH_DENIED', 'Dodo state path is not a directory');
    return {
      schemaVersion: 1,
      state: 'not-needed',
      targetDir: target,
      entries: [],
      ignoredEntries: [],
      importedConfigFields: [],
      resetSecurity: [...RESET_SECURITY],
      bytes: 0,
      reason: 'Dodo state already exists; automatic merge is disabled',
    };
  }
  for (const candidate of candidates) {
    const source = path.resolve(candidate);
    if (source === target || !exists(source)) continue;
    const plan = inspectCandidate(source, target);
    if (plan.state === 'available' || plan.state === 'blocked') return plan;
  }
  return {
    schemaVersion: 1,
    state: 'not-needed',
    targetDir: target,
    entries: [],
    ignoredEntries: [],
    importedConfigFields: [],
    resetSecurity: [...RESET_SECURITY],
    bytes: 0,
    reason: 'no existing Dodo config was found',
  };
}

/**
 * Import only the reviewed preference allowlist into a fresh private directory.
 * The source remains untouched and the destination appears in one atomic rename.
 */
export function importState(plan: StateImportPlan): StateImportResult {
  if (plan.state === 'blocked') {
    throw new DodoError('MIGRATION_REVIEW_REQUIRED', plan.reason ?? 'state import needs local review', {
      recovery: 'inspect the source locally; Dodo did not create or modify the target',
    });
  }
  if (plan.state !== 'available' || !plan.sourceDir) throw new DodoError('CONFLICT', plan.reason ?? 'no importable Dodo state is available');
  const sourceDir = path.resolve(plan.sourceDir);
  const targetDir = path.resolve(plan.targetDir);
  const parent = path.dirname(targetDir);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  assertSafeDestinationParent(parent);
  const lock = `${targetDir}.migration.lock`;
  const lockBody = JSON.stringify({ schemaVersion: 1, kind: 'dodo-state-import-lock', pid: process.pid, startedAt: new Date().toISOString() });
  try {
    fs.writeFileSync(lock, lockBody, { flag: 'wx', mode: 0o600 });
  } catch {
    throw new DodoError('CONFLICT', 'another Dodo state import may be running; inspect the migration lock locally');
  }
  try {
    assertPrivatePath(lock, false);
  } catch (error) {
    try { if (fs.readFileSync(lock, 'utf8') === lockBody) fs.unlinkSync(lock); } catch { /* never remove a replaced lock */ }
    throw error;
  }
  const stage = `${targetDir}.migration-${randomUUID()}`;
  try {
    if (exists(targetDir)) throw new DodoError('FILE_CHANGED', 'Dodo state appeared during import; source was preserved');
    const current = inspectCandidate(sourceDir, targetDir);
    if (current.state !== 'available') {
      throw new DodoError(
        current.state === 'blocked' ? 'MIGRATION_REVIEW_REQUIRED' : 'CONFLICT',
        current.reason ?? 'existing state changed; import was refused',
      );
    }
    if (
      current.bytes !== plan.bytes
      || current.configSha256 !== plan.configSha256
      || JSON.stringify(current.importedConfigFields) !== JSON.stringify(plan.importedConfigFields)
      || JSON.stringify(current.ignoredEntries) !== JSON.stringify(plan.ignoredEntries)
    ) {
      throw new DodoError('FILE_CHANGED', 'existing state changed after planning; source was preserved');
    }
    const inspected = inspectConfig(path.join(sourceDir, CONFIG_FILE));
    ensurePrivateDirectory(stage);
    const configFile = path.join(stage, CONFIG_FILE);
    fs.writeFileSync(configFile, JSON.stringify(inspected.clean, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    assertPrivatePath(configFile, false);
    const receipt = path.join(stage, 'migration.json');
    const receiptBody = {
      schemaVersion: 1,
      kind: 'dodo-state-import',
      sourceDir,
      importedAt: new Date().toISOString(),
      entries: [CONFIG_FILE],
      ignoredEntries: current.ignoredEntries,
      importedConfigFields: current.importedConfigFields,
      resetSecurity: current.resetSecurity,
      bytes: current.bytes,
      configSha256: current.configSha256,
      sourcePreserved: true,
    };
    fs.writeFileSync(receipt, JSON.stringify(receiptBody, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    assertPrivatePath(receipt, false);
    renameWithRetry(stage, targetDir);
    return {
      schemaVersion: 1,
      sourceDir,
      targetDir,
      entries: [CONFIG_FILE],
      ignoredEntries: current.ignoredEntries,
      importedConfigFields: current.importedConfigFields,
      resetSecurity: current.resetSecurity,
      bytes: current.bytes,
      configSha256: current.configSha256!,
      receipt: path.join(targetDir, 'migration.json'),
      sourcePreserved: true,
    };
  } finally {
    try { if (exists(stage)) fs.rmSync(stage, { recursive: true, force: true, maxRetries: 3, retryDelay: 40 }); } catch { /* keep the explicit recovery path if cleanup is blocked */ }
    try { if (fs.readFileSync(lock, 'utf8') === lockBody) fs.unlinkSync(lock); } catch { /* never remove a replaced lock */ }
  }
}
