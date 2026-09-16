import { DodoError } from '../errors.js';
import type { Store } from '../store/store.js';
import { accessMode } from '../security/accessMode.js';
import {
  LEVEL_SUMMARY, levelForScopes, parseProjectAccessLevel, scopesForLevel,
  type ProjectAccessLevel,
} from '../security/projectAccess.js';
import { ProjectRegistry, type RegisteredProject } from './registry.js';

/**
 * The single owner-administration entry point for projects.
 *
 * Local Config (HTTP), `dodo project …` (CLI) and the owner IPC dispatcher all
 * call THIS module, so validation, confirmation rules and audit happen once
 * instead of being re-implemented per surface. It performs no authorization of
 * its own: every caller has already proven local owner identity (loopback +
 * capability token, or the private IPC socket).
 */

export interface ProjectView extends RegisteredProject {
  /** What this level permits, in the owner's language. */
  accessSummary: string;
  /** True when the installation still requires a per-project client ACL. */
  requiresClientAcl: boolean;
}

function view(store: Store, project: RegisteredProject): ProjectView {
  return {
    ...project,
    // Deliberately NOT serialising the underlying OAuth scope strings: the
    // owner UI shows the level and its summary, and the projects listing must
    // not read like a statement about any client's authority.
    accessSummary: LEVEL_SUMMARY[project.accessLevel],
    requiresClientAcl: accessMode(store) === 'managed',
  };
}

export interface AddProjectInput {
  path: string;
  name?: string;
  /** read | edit | full. Owner surfaces always send this explicitly. */
  access?: ProjectAccessLevel;
}

export class ProjectAdmin {
  private readonly registry: ProjectRegistry;
  constructor(private readonly store: Store) {
    this.registry = new ProjectRegistry(store);
  }

  list(): ProjectView[] {
    return this.registry.list().map((p) => view(this.store, p));
  }

  get(projectId: string): ProjectView {
    return view(this.store, this.registry.get(projectId));
  }

  /**
   * Register a project and set its access level in ONE transaction.
   *
   * `ProjectRegistry.add` commits path identity, name uniqueness and the level
   * together, so a rejected name or level can never leave a half-registered
   * project or a project with permissions the owner did not choose.
   */
  add(input: AddProjectInput): { changed: boolean; relocated: boolean; project: ProjectView } {
    const access = input.access === undefined ? undefined : parseProjectAccessLevel(input.access);
    const result = this.registry.add(input.path, input.name, access);
    return { changed: result.changed, relocated: result.relocated, project: view(this.store, result.project) };
  }

  /** Change only the access level of an existing project. */
  setAccess(projectId: string, access: ProjectAccessLevel): ProjectView {
    return view(this.store, this.registry.setAccessLevel(projectId, parseProjectAccessLevel(access)));
  }

  remove(projectId: string, confirmProjectId: string): ProjectView {
    if (projectId !== confirmProjectId) {
      throw new DodoError('INVALID_INPUT', 'project removal requires the exact reviewed project ID');
    }
    return view(this.store, this.registry.remove(projectId));
  }

  /**
   * Resolve an owner-typed project reference — an id OR a name — for CLI and
   * owner HTTP surfaces. The owner may address any registered project, so this
   * deliberately does not filter by principal; the MCP path has its own
   * principal-filtered resolver in src/tools/context.ts.
   */
  resolve(reference: string): ProjectView {
    const raw = typeof reference === 'string' ? reference.trim() : '';
    if (!raw) throw new DodoError('INVALID_INPUT', 'project name or ID is required');
    if (/^prj_/.test(raw)) return this.get(raw);
    const { match, candidates } = this.registry.findByName(raw);
    if (match) return view(this.store, match);
    if (candidates.length > 1) {
      throw new DodoError('CONFLICT', `"${raw}" matches ${candidates.length} registered projects`, {
        recovery: 'rename one of them, or pass the exact project ID',
        detail: { candidates: candidates.map((p) => ({ projectId: p.projectId, displayName: p.displayName, root: p.root })) },
      });
    }
    throw new DodoError('NOT_FOUND', `no registered project named "${raw}"`, {
      recovery: 'run `dodo project list` to see registered project names',
    });
  }

  /**
   * What a client with these token scopes could actually do in this project —
   * the intersection the owner sees in the UI, so the displayed capability is
   * the real one rather than the requested one.
   */
  effectiveFor(project: RegisteredProject, tokenScopes: readonly string[]): { scopes: string[]; level: ProjectAccessLevel | 'none' } {
    const ceiling = scopesForLevel(project.accessLevel);
    const scopes = ceiling.filter((s) => tokenScopes.includes(s));
    return { scopes, level: levelForScopes(scopes) };
  }
}
