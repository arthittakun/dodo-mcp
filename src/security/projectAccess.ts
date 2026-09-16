import { DodoError } from '../errors.js';
import type { Store } from '../store/store.js';
import { ALL_SCOPES, type OAuthScope } from './policy.js';

/**
 * Simple Project Access Policy.
 *
 * One owner-chosen level per registered project, expressed in the owner's
 * language rather than in OAuth scopes. It is a CEILING layered on top of the
 * existing model, never a grant:
 *
 *   effective scopes = token scopes
 *                    ∩ grant scopes
 *                    ∩ (personal ? grant scopes : per-workspace client ACL)
 *                    ∩ THIS level
 *
 * So a read-only OAuth token stays read-only even on a `full` project, and a
 * `read` project stays read-only even for a token that carries write/exec.
 * Nothing here can widen authority, and every downstream gate (trust mode,
 * local approvals, path/secret guards, expected hashes, sandbox, idempotency,
 * audit) still runs unchanged.
 */
export type ProjectAccessLevel = 'read' | 'edit' | 'full';

export const PROJECT_ACCESS_LEVELS: readonly ProjectAccessLevel[] = ['read', 'edit', 'full'] as const;

const LEVEL_SCOPES: Record<ProjectAccessLevel, readonly OAuthScope[]> = {
  read: ['dodo:read'],
  edit: ['dodo:read', 'dodo:write'],
  full: ['dodo:read', 'dodo:write', 'dodo:exec'],
};

/** Owner-facing Thai summary of what a level actually permits. */
export const LEVEL_SUMMARY: Record<ProjectAccessLevel, string> = {
  read: 'อ่านอย่างเดียว — อ่าน ค้นหา วิเคราะห์',
  edit: 'แก้ไข — อ่านและแก้ไฟล์',
  full: 'ทำงานเต็มรูปแบบ — อ่าน แก้ไฟล์ และรันคำสั่ง/ทดสอบ',
};

export function isProjectAccessLevel(value: unknown): value is ProjectAccessLevel {
  return typeof value === 'string' && (PROJECT_ACCESS_LEVELS as readonly string[]).includes(value);
}

export function parseProjectAccessLevel(value: unknown): ProjectAccessLevel {
  if (!isProjectAccessLevel(value)) {
    throw new DodoError('INVALID_INPUT', `project access level must be one of ${PROJECT_ACCESS_LEVELS.join(', ')}`);
  }
  return value;
}

export function scopesForLevel(level: ProjectAccessLevel): OAuthScope[] {
  return [...LEVEL_SCOPES[level]];
}

/** The level a set of scopes corresponds to, used to describe effective access. */
export function levelForScopes(scopes: readonly string[]): ProjectAccessLevel | 'none' {
  if (scopes.includes('dodo:exec')) return 'full';
  if (scopes.includes('dodo:write')) return 'edit';
  if (scopes.includes('dodo:read')) return 'read';
  return 'none';
}

/**
 * The scope ceiling for one workspace.
 *
 * A workspace with no active registry row — the launcher root, a stdio
 * workspace opened straight from a client's cwd, or a project removed from the
 * registry — is NOT narrowed here. Those paths are governed by the same gates
 * they always were; this policy only applies to projects the owner registered
 * and gave a level to.
 */
export function projectScopeCeiling(store: Store, workspaceId: string): OAuthScope[] {
  const level = storedProjectLevel(store, workspaceId);
  return level === undefined ? [...ALL_SCOPES] : scopesForLevel(level);
}

/** The stored level for a workspace, or undefined when it is not a registered project. */
export function storedProjectLevel(store: Store, workspaceId: string): ProjectAccessLevel | undefined {
  let row: { access_level?: unknown } | undefined;
  try {
    row = store.db
      .prepare('SELECT access_level FROM project_registry WHERE workspace_id = ? AND removed_at IS NULL LIMIT 1')
      .get(workspaceId) as { access_level?: unknown } | undefined;
  } catch {
    // A registry that cannot be read must not silently widen access. Falling
    // back to the most restrictive level would break unrelated workspaces, so
    // fail closed only for rows we know exist: an unreadable registry yields
    // `read`, the least authority any registered project can have.
    return 'read';
  }
  if (!row) return undefined;
  return isProjectAccessLevel(row.access_level) ? row.access_level : 'read';
}
