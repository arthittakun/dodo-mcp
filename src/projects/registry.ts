import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { DodoError } from '../errors.js';
import type { Store } from '../store/store.js';
import { newId } from '../util/hash.js';
import { mintWorkspaceId } from '../workspace/identity.js';
import { resolveWorkspaceRoot, type RootInfo } from '../workspace/root.js';
import { fileIdentityBigInt, parseFileIdentity, type FileIdentity } from '../platform/fileIdentity.js';
import { isProjectAccessLevel, parseProjectAccessLevel, type ProjectAccessLevel } from '../security/projectAccess.js';

export const PROJECT_METADATA_VERSION = 2;
const MAX_PROJECTS = 1000;
const PROJECT_ID = /^prj_[0-9a-hjkmnp-tv-z]{8,64}$/;
const WORKSPACE_ID = /^ws_[a-f0-9]{20}$/;

export type ProjectAvailability = 'ready' | 'missing' | 'symlinked' | 'replaced' | 'inaccessible' | 'invalid' | 'removed';

interface RegistryRow {
  id: unknown;
  workspace_id: unknown;
  canonical_root: unknown;
  display_name: unknown;
  root_dev: unknown;
  root_ino: unknown;
  root_birthtime_ns: unknown;
  access_level: unknown;
  metadata_version: unknown;
  created_at: unknown;
  updated_at: unknown;
  removed_at: unknown;
}

export interface RegisteredProject {
  schemaVersion: 1;
  projectId: string;
  workspaceId: string;
  root: string;
  displayName: string;
  accessLevel: ProjectAccessLevel;
  createdAt: number;
  updatedAt: number;
  removedAt: number | null;
  availability: ProjectAvailability;
  available: boolean;
  statusText: string;
  identity: { dev: FileIdentity; ino: FileIdentity; birthtimeNs: string };
}

export interface AddProjectResult {
  changed: boolean;
  relocated: boolean;
  project: RegisteredProject;
}

function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function asFiniteInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function asBirthtimeNs(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,30}$/.test(value)) return undefined;
  return value;
}

function safeDisplayName(input: string | undefined, root: string): string {
  const name = (input ?? path.basename(root)).trim();
  if (name.length < 1 || name.length > 120 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new DodoError('INVALID_INPUT', 'project display name must be 1..120 characters without control characters');
  }
  return name;
}

function validateProjectId(projectId: string): void {
  if (!PROJECT_ID.test(projectId)) throw new DodoError('INVALID_INPUT', 'invalid project ID');
}

/**
 * Omitting a level keeps the authority a project had before the Simple Project
 * Access Policy existed, so upgrading an install never revokes access the owner
 * did not ask to revoke. Owner-facing surfaces (Local Config, `dodo project
 * add`) always pass an explicit level instead of relying on this.
 */
export const DEFAULT_PROJECT_ACCESS_LEVEL: ProjectAccessLevel = 'full';

/** Display names address projects in tool calls, so they must not collide. */
function assertNameAvailable(db: Database.Database, name: string, exceptProjectId?: string): void {
  const clash = db.prepare(
    `SELECT id, display_name FROM project_registry
      WHERE removed_at IS NULL AND lower(display_name) = lower(?) ${exceptProjectId ? 'AND id != ?' : ''}
      LIMIT 1`,
  ).get(...(exceptProjectId ? [name, exceptProjectId] : [name])) as { id?: unknown; display_name?: unknown } | undefined;
  if (clash) {
    throw new DodoError('CONFLICT', `another registered project is already named "${String(clash.display_name)}"`, {
      recovery: 'choose a different project name; names are compared without case so AI clients can address a project by name',
    });
  }
}

function rawRows(db: Database.Database, includeRemoved: boolean): RegistryRow[] {
  return db.prepare(
    `SELECT id, workspace_id, canonical_root, display_name, access_level, root_dev, root_ino, root_birthtime_ns,
            metadata_version, created_at, updated_at, removed_at
       FROM project_registry
      ${includeRemoved ? '' : 'WHERE removed_at IS NULL'}
      ORDER BY updated_at DESC, id ASC
      LIMIT ?`,
  ).all(MAX_PROJECTS + 1) as RegistryRow[];
}

function inspectAvailability(root: string, dev: FileIdentity, ino: FileIdentity, birthtimeNs: string): { availability: ProjectAvailability; statusText: string } {
  let link: fs.Stats;
  try {
    link = fs.lstatSync(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { availability: 'missing', statusText: 'ไม่พบ path ที่บันทึกไว้' };
    return { availability: 'inaccessible', statusText: 'ไม่สามารถตรวจสอบ path ได้' };
  }
  if (link.isSymbolicLink()) return { availability: 'symlinked', statusText: 'path ที่บันทึกไว้ถูกแทนด้วย symbolic link' };
  let real: string;
  let stat: fs.BigIntStats;
  try {
    real = fs.realpathSync.native(root);
    stat = fs.statSync(real, { bigint: true });
  } catch {
    return { availability: 'inaccessible', statusText: 'ไม่สามารถตรวจสอบ directory identity ได้' };
  }
  if (
    !samePath(real, root) ||
    !stat.isDirectory() ||
    stat.dev !== fileIdentityBigInt(dev) ||
    stat.ino !== fileIdentityBigInt(ino) ||
    stat.birthtimeNs.toString() !== birthtimeNs
  ) {
    return { availability: 'replaced', statusText: 'path ชี้ไปยัง directory identity อื่น' };
  }
  return { availability: 'ready', statusText: 'พร้อมใช้งาน' };
}

function invalidProject(row: RegistryRow): RegisteredProject {
  const now = Date.now();
  return {
    schemaVersion: 1,
    projectId: typeof row.id === 'string' ? row.id : 'prj_invalid',
    workspaceId: typeof row.workspace_id === 'string' ? row.workspace_id : 'ws_invalid',
    root: typeof row.canonical_root === 'string' ? row.canonical_root : '(invalid path)',
    displayName: typeof row.display_name === 'string' ? row.display_name : '(invalid project)',
    accessLevel: isProjectAccessLevel(row.access_level) ? row.access_level : 'read',
    createdAt: asFiniteInteger(row.created_at) ?? now,
    updatedAt: asFiniteInteger(row.updated_at) ?? now,
    removedAt: row.removed_at === null ? null : asFiniteInteger(row.removed_at) ?? null,
    availability: 'invalid',
    available: false,
    statusText: 'registry metadata ไม่ถูกต้อง; ตรวจสอบและนำรายการนี้ออกก่อนใช้งาน',
    identity: {
      dev: parseFileIdentity(row.root_dev) ?? 0,
      ino: parseFileIdentity(row.root_ino) ?? 0,
      birthtimeNs: asBirthtimeNs(row.root_birthtime_ns) ?? '0',
    },
  };
}

function materialize(row: RegistryRow): RegisteredProject {
  const id = typeof row.id === 'string' && PROJECT_ID.test(row.id) ? row.id : undefined;
  const workspaceId = typeof row.workspace_id === 'string' && WORKSPACE_ID.test(row.workspace_id) ? row.workspace_id : undefined;
  const root = typeof row.canonical_root === 'string' && path.isAbsolute(row.canonical_root) ? row.canonical_root : undefined;
  const displayName = typeof row.display_name === 'string' && row.display_name.length >= 1 && row.display_name.length <= 120 && !/[\u0000-\u001f\u007f]/.test(row.display_name) ? row.display_name : undefined;
  // An unrecognised level is treated as the least authority, never as full.
  const accessLevel: ProjectAccessLevel = isProjectAccessLevel(row.access_level) ? row.access_level : 'read';
  const dev = parseFileIdentity(row.root_dev);
  const ino = parseFileIdentity(row.root_ino);
  const birthtimeNs = asBirthtimeNs(row.root_birthtime_ns);
  const createdAt = asFiniteInteger(row.created_at);
  const updatedAt = asFiniteInteger(row.updated_at);
  const removedAt = row.removed_at === null ? null : asFiniteInteger(row.removed_at);
  if (!id || !workspaceId || !root || !displayName || dev === undefined || ino === undefined || !birthtimeNs || createdAt === undefined || updatedAt === undefined || removedAt === undefined || row.metadata_version !== PROJECT_METADATA_VERSION) {
    return invalidProject(row);
  }
  const status = removedAt === null
    ? inspectAvailability(root, dev, ino, birthtimeNs)
    : { availability: 'removed' as const, statusText: 'นำออกจาก registry แล้ว; ไฟล์และประวัติไม่ได้ถูกลบ' };
  return {
    schemaVersion: 1,
    projectId: id,
    workspaceId,
    root,
    displayName,
    accessLevel,
    createdAt,
    updatedAt,
    removedAt,
    availability: status.availability,
    available: removedAt === null && status.availability === 'ready',
    statusText: status.statusText,
    identity: { dev, ino, birthtimeNs },
  };
}

function resolveInput(candidate: string): RootInfo & { birthtimeNs: string } {
  if (typeof candidate !== 'string' || candidate.length < 1 || candidate.length > 4096 || candidate.includes('\0') || !path.isAbsolute(candidate)) {
    throw new DodoError('INVALID_INPUT', 'project path must be an absolute path');
  }
  const root = resolveWorkspaceRoot(candidate, { allowUnsafe: false });
  if (!root.birthtimeNs) {
    throw new DodoError('NOT_SUPPORTED', 'project registry requires a filesystem with stable directory birth-time metadata', {
      recovery: 'move the project to a local APFS, ext4, NTFS, or another filesystem that exposes directory birth time',
    });
  }
  return { ...root, birthtimeNs: root.birthtimeNs };
}

/** Owner-only installation registry. It never changes workspace authority. */
export class ProjectRegistry {
  constructor(private readonly store: Store) {}

  list(options: { includeRemoved?: boolean } = {}): RegisteredProject[] {
    try {
      const rows = rawRows(this.store.db, options.includeRemoved ?? false);
      if (rows.length > MAX_PROJECTS) throw new DodoError('RESOURCE_LIMIT', `project registry exceeds ${MAX_PROJECTS} entries`);
      return rows.map(materialize);
    } catch (error) {
      if (error instanceof DodoError) throw error;
      throw registryFailure('read');
    }
  }

  get(projectId: string, options: { includeRemoved?: boolean } = {}): RegisteredProject {
    validateProjectId(projectId);
    let row: RegistryRow | undefined;
    try {
      row = this.store.db.prepare(
        `SELECT id, workspace_id, canonical_root, display_name, access_level, root_dev, root_ino, root_birthtime_ns,
                metadata_version, created_at, updated_at, removed_at
           FROM project_registry WHERE id = ? ${options.includeRemoved ? '' : 'AND removed_at IS NULL'}`,
      ).get(projectId) as RegistryRow | undefined;
    } catch {
      throw registryFailure('read');
    }
    if (!row) throw new DodoError('NOT_FOUND', `project not found: ${projectId}`);
    return materialize(row);
  }

  /**
   * Register (or re-register) a project. The whole operation runs in ONE
   * immediate transaction: path identity, name uniqueness and the access level
   * are committed together, so a rejected level never leaves a half-registered
   * project behind.
   */
  add(candidate: string, displayName?: string, accessLevel?: ProjectAccessLevel): AddProjectResult {
    const root = resolveInput(candidate);
    const name = safeDisplayName(displayName, root.root);
    const level = accessLevel === undefined ? undefined : parseProjectAccessLevel(accessLevel);
    const workspaceId = mintWorkspaceId(this.store.installSecret(), root.root);
    let result!: AddProjectResult;
    const tx = this.store.db.transaction(() => {
      const byRoot = this.store.db.prepare('SELECT * FROM project_registry WHERE canonical_root = ? AND removed_at IS NULL').get(root.root) as RegistryRow | undefined;
      if (byRoot) {
        const current = materialize(byRoot);
        if (current.availability === 'invalid') throw new DodoError('MIGRATION_REVIEW_REQUIRED', 'project registry row is invalid', { detail: { projectId: current.projectId } });
        if (current.identity.dev !== root.dev || current.identity.ino !== root.ino || current.identity.birthtimeNs !== root.birthtimeNs) {
          throw new DodoError('CONFLICT', 'registered project path now points to another directory identity', {
            recovery: `review ${current.projectId}, remove it explicitly, then add the replacement as a new project`,
            detail: { projectId: current.projectId, availability: current.availability },
          });
        }
        const renaming = displayName !== undefined && current.displayName !== name;
        const relevelling = level !== undefined && current.accessLevel !== level;
        if (renaming) assertNameAvailable(this.store.db, name, current.projectId);
        if (renaming || relevelling) {
          const now = Date.now();
          this.store.db.prepare('UPDATE project_registry SET display_name = ?, access_level = ?, updated_at = ? WHERE id = ?')
            .run(renaming ? name : current.displayName, relevelling ? level : current.accessLevel, now, current.projectId);
          result = { changed: true, relocated: false, project: this.get(current.projectId) };
          this.audit(result, 'updated');
        } else result = { changed: false, relocated: false, project: current };
        return;
      }

      const byIdentity = this.store.db.prepare('SELECT * FROM project_registry WHERE root_dev = ? AND root_ino = ? AND removed_at IS NULL').get(root.dev, root.ino) as RegistryRow | undefined;
      if (byIdentity) {
        const current = materialize(byIdentity);
        if (current.availability === 'invalid') throw new DodoError('MIGRATION_REVIEW_REQUIRED', 'project registry row is invalid', { detail: { projectId: current.projectId } });
        if (current.identity.birthtimeNs !== root.birthtimeNs) {
          throw new DodoError('CONFLICT', 'a filesystem inode was reused by another directory generation', {
            recovery: `review ${current.projectId}, remove it explicitly, then add the replacement as a new project`,
            detail: { projectId: current.projectId, availability: current.availability },
          });
        }
        if (samePath(current.root, root.root)) {
          result = { changed: false, relocated: false, project: current };
          return;
        }
        if (current.availability !== 'missing') {
          throw new DodoError('CONFLICT', 'the same directory identity is already registered at another active path', { detail: { projectId: current.projectId } });
        }
        if (displayName !== undefined && current.displayName !== name) assertNameAvailable(this.store.db, name, current.projectId);
        const now = Date.now();
        this.store.db.prepare('UPDATE project_registry SET workspace_id = ?, canonical_root = ?, display_name = ?, access_level = ?, root_birthtime_ns = ?, updated_at = ? WHERE id = ?')
          .run(workspaceId, root.root, displayName === undefined ? current.displayName : name, level ?? current.accessLevel, root.birthtimeNs, now, current.projectId);
        result = { changed: true, relocated: true, project: this.get(current.projectId) };
        this.audit(result, 'relocated');
        return;
      }

      const count = (this.store.db.prepare('SELECT COUNT(*) AS count FROM project_registry WHERE removed_at IS NULL').get() as { count: number }).count;
      if (count >= MAX_PROJECTS) throw new DodoError('RESOURCE_LIMIT', `project registry is limited to ${MAX_PROJECTS} active entries`);
      assertNameAvailable(this.store.db, name);
      const now = Date.now();
      const projectId = newId('prj', 12);
      this.store.db.prepare(
        `INSERT INTO project_registry
          (id, workspace_id, canonical_root, display_name, access_level, root_dev, root_ino, root_birthtime_ns, metadata_version, created_at, updated_at, removed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      ).run(projectId, workspaceId, root.root, name, level ?? DEFAULT_PROJECT_ACCESS_LEVEL, root.dev, root.ino, root.birthtimeNs, PROJECT_METADATA_VERSION, now, now);
      result = { changed: true, relocated: false, project: this.get(projectId) };
      this.audit(result, 'added');
    });
    try {
      tx.immediate();
    } catch (error) {
      if (error instanceof DodoError) throw error;
      const code = (error as { code?: string }).code;
      if (code === 'SQLITE_CONSTRAINT_UNIQUE') {
        const existing = this.store.db.prepare('SELECT * FROM project_registry WHERE canonical_root = ? AND removed_at IS NULL').get(root.root) as RegistryRow | undefined;
        if (existing) return { changed: false, relocated: false, project: materialize(existing) };
        throw new DodoError('CONFLICT', 'project registry changed concurrently; retry the command');
      }
      throw registryFailure('update');
    }
    return result;
  }

  /** Change only the Simple Project Access Policy level, atomically. */
  setAccessLevel(projectId: string, accessLevel: ProjectAccessLevel): RegisteredProject {
    validateProjectId(projectId);
    const level = parseProjectAccessLevel(accessLevel);
    try {
      const tx = this.store.db.transaction(() => {
        const changed = this.store.db
          .prepare('UPDATE project_registry SET access_level = ?, updated_at = ? WHERE id = ? AND removed_at IS NULL')
          .run(level, Date.now(), projectId);
        if (changed.changes !== 1) throw new DodoError('NOT_FOUND', `project not found: ${projectId}`);
      });
      tx.immediate();
    } catch (error) {
      if (error instanceof DodoError) throw error;
      throw registryFailure('update');
    }
    const project = this.get(projectId);
    this.store.audit({
      principal: 'local-project-owner', workspaceId: project.workspaceId, tool: 'local.project.access',
      paths: [project.root], refId: projectId, result: `level:${level}`,
    });
    return project;
  }

  /**
   * Resolve an owner-facing project NAME to exactly one registered project.
   *
   * Matching is case-insensitive and trimmed. Ambiguity is an error rather than
   * a guess: silently picking one of two same-named projects could route an
   * edit into the wrong repository. `candidates` is only ever populated by the
   * caller after it has filtered the list for the principal.
   */
  findByName(name: string): { match?: RegisteredProject; candidates: RegisteredProject[] } {
    const wanted = typeof name === 'string' ? name.trim().toLowerCase() : '';
    if (!wanted) throw new DodoError('INVALID_INPUT', 'project name must not be empty');
    const matches = this.list().filter((p) => p.displayName.trim().toLowerCase() === wanted);
    if (matches.length === 1) return { match: matches[0]!, candidates: matches };
    return { candidates: matches };
  }

  remove(projectId: string): RegisteredProject {
    validateProjectId(projectId);
    const current = this.get(projectId);
    try {
      const tx = this.store.db.transaction(() => {
        const job = this.store.db.prepare("SELECT 1 FROM jobs WHERE workspace_id=? AND status='running' LIMIT 1").get(current.workspaceId);
        const agent = this.store.db.prepare("SELECT 1 FROM ai_runs WHERE workspace_id=? AND status NOT IN ('completed','failed','canceled') LIMIT 1").get(current.workspaceId);
        if (job || agent) throw new DodoError('CONFLICT','project has unfinished jobs or agent runs; finish or cancel them before removal');
        const now = Date.now();
        const changed = this.store.db.prepare('UPDATE project_registry SET removed_at = ?, updated_at = ? WHERE id = ? AND removed_at IS NULL').run(now, now, projectId);
        if (changed.changes !== 1) throw new DodoError('CONFLICT', 'project registry changed concurrently; refresh and retry');
        this.store.audit({ principal: 'local-project-owner', workspaceId: current.workspaceId, tool: 'local.project.remove', paths: [current.root], refId: projectId, result: 'removed' });
      });
      tx.immediate();
    } catch (error) {
      if (error instanceof DodoError) throw error;
      throw registryFailure('update');
    }
    return this.get(projectId, { includeRemoved: true });
  }

  private audit(result: AddProjectResult, outcome: 'added' | 'updated' | 'relocated'): void {
    this.store.audit({
      principal: 'local-project-owner',
      workspaceId: result.project.workspaceId,
      tool: 'local.project.add',
      paths: [result.project.root],
      refId: result.project.projectId,
      result: outcome,
    });
  }
}

function registryFailure(operation: 'read' | 'update'): DodoError {
  return new DodoError('INTERNAL_ERROR', `project registry ${operation} failed`, {
    recovery: 'the registry was left unchanged; back up the Dodo state directory and run dodo doctor before repairing state.db',
  });
}
