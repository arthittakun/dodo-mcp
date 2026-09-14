import { isOwner, projectAuthority } from '../security/projectAuthority.js';
import { DodoError, toDodoError } from '../errors.js';
import type { GlobalConfig } from '../config/globalConfig.js';
import type { Limits } from '../config/limits.js';
import { loadProjectConfig, type ProjectConfigResult } from '../config/projectConfig.js';
import { GitService } from '../services/git/gitService.js';
import { ReadService, ListService, type ReadItemRequest } from '../services/files/readService.js';
import { OverviewService } from '../services/overview.js';
import { SearchService, type SearchQuery, type SearchResult } from '../services/search/searchService.js';
import type { Store } from '../store/store.js';
import type { Principal } from '../tools/context.js';
import { digestOf } from '../util/hash.js';
import { mintEpoch } from '../workspace/identity.js';
import { WorkspaceFS } from '../workspace/fs.js';
import { IgnoreEngine } from '../workspace/ignores.js';
import { ProjectRegistry, type RegisteredProject } from './registry.js';

const MAX_VISIBLE_PROJECTS = 100;
export const MAX_FEDERATED_PROJECTS = 8;
const MAX_CACHED_RUNTIMES = 16;

export interface FederatedProjectSummary {
  projectId: string;
  displayName: string;
  workspaceId: string;
  availability: RegisteredProject['availability'];
  available: boolean;
  statusText: string;
}

export interface FederatedProjectScope extends FederatedProjectSummary {
  workspaceEpoch: string;
  readOnly: true;
  sourceHash: string;
}

interface ProjectRuntime {
  cacheKey: string;
  project: RegisteredProject;
  epoch: string;
  projectConfig: ProjectConfigResult;
  wfs: WorkspaceFS;
  read: ReadService;
  list: ListService;
  search: SearchService;
  overview: OverviewService;
}

export interface FederatedSearchResult {
  project: FederatedProjectScope;
  result: SearchResult;
  sources: Array<{ path: string; hash: string }>;
}

export interface FederatedSearchFailure {
  projectId: string;
  code: string;
  message: string;
  retryable: boolean;
}

/**
 * Read-only, owner-curated multi-project federation (Phase 03).
 *
 * A registered path is metadata, never authority. Every access re-reads the
 * registry, checks its directory identity/readiness, and evaluates the live
 * target authority. Personal mode uses the approved grant scopes; managed mode
 * intersects them with the TARGET workspace ACL. The active process workspace
 * is never switched and process.cwd() is never touched.
 */
export class FederationService {
  private readonly registry: ProjectRegistry;
  private readonly runtimes = new Map<string, ProjectRuntime>();

  constructor(
    private readonly store: Store,
    private readonly config: GlobalConfig,
    private readonly limits: Limits,
  ) {
    this.registry = new ProjectRegistry(store);
  }

  listAuthorized(principal: Principal): { projects: FederatedProjectSummary[]; truncated: boolean } {
    const authorized = this.registry.list()
      .filter((project) => this.canRead(project, principal))
      .map((project) => summary(project));
    return { projects: authorized.slice(0, MAX_VISIBLE_PROJECTS), truncated: authorized.length > MAX_VISIBLE_PROJECTS };
  }

  async overview(
    projectId: string,
    principal: Principal,
    activeRequestContext: { workspaceId: string; workspaceEpoch: string },
  ): Promise<{ data: Record<string, unknown>; warnings: string[]; truncated: boolean }> {
    const runtime = this.runtime(projectId, principal);
    const started = Date.now();
    try {
      const data = await runtime.overview.build({
        workspaceId: runtime.project.workspaceId,
        epoch: runtime.epoch,
        trustMode: this.store.trustMode(runtime.project.workspaceId),
        modeDescription: 'federated read-only access; switch this project into the active workspace before any write or command',
        projectConfig: runtime.projectConfig,
        searchBackend: runtime.search.rgAvailable() ? 'ripgrep' : 'js',
        semanticAvailable: false,
      });
      const sourceHash = digestOf(data);
      this.audit(runtime.project, principal, 'federation.project_overview', 'ok', started, sourceHash);
      return {
        data: {
          ...data,
          instructions:
            'This is a federated read-only overview. The project.workspaceId/project.workspaceEpoch identify the target evidence only. ' +
            'For the next MCP call, keep using the ACTIVE workspaceId/workspaceEpoch from this response envelope and pass projectId inside the selected read operation. ' +
            'For an edit or command, call project_overview with targetProjectId and use that returned workspace context on later target-routed calls.',
          project: scope(runtime, sourceHash),
          federation: { mode: 'read-only', activeWorkspaceChanged: false, requestContext: activeRequestContext },
        },
        warnings: ['This projectId access is read-only. Use explicit targetProjectId routing for edits or commands.'],
        truncated: data.treeTruncated,
      };
    } catch (error) {
      this.auditFailure(runtime.project, principal, 'federation.project_overview', error, started);
      throw error;
    }
  }

  listFiles(projectId: string, principal: Principal, startPath: string, options: { depth?: number; includeIgnored?: boolean; maxEntries?: number }): { tree: unknown; entryCount: number; project: FederatedProjectScope; truncated: boolean } {
    const runtime = this.runtime(projectId, principal);
    const started = Date.now();
    try {
      const result = runtime.list.tree(startPath, options);
      const sourceHash = digestOf({ tree: result.root, entryCount: result.entryCount });
      this.audit(runtime.project, principal, 'federation.list_files', 'ok', started, sourceHash);
      return { tree: result.root, entryCount: result.entryCount, project: scope(runtime, sourceHash), truncated: result.truncated };
    } catch (error) {
      this.auditFailure(runtime.project, principal, 'federation.list_files', error, started);
      throw error;
    }
  }

  readFiles(projectId: string, principal: Principal, files: ReadItemRequest[]): { files: unknown[]; errors: unknown[]; project: FederatedProjectScope; truncated: boolean } {
    const runtime = this.runtime(projectId, principal);
    const started = Date.now();
    try {
      const result = runtime.read.readBatch(files);
      const sourceHash = digestOf(result.files.map((file) => ({ path: file.path, hash: file.hash })));
      this.audit(runtime.project, principal, 'federation.read_files', 'ok', started, sourceHash);
      return { ...result, project: scope(runtime, sourceHash) };
    } catch (error) {
      this.auditFailure(runtime.project, principal, 'federation.read_files', error, started);
      throw error;
    }
  }

  /** Bounded metadata fingerprint used only to invalidate derived read caches. */
  manifest(projectId: string, principal: Principal): { workspaceId: string; hash: string; truncated: boolean } {
    const runtime = this.runtime(projectId, principal);
    const started = Date.now();
    try {
      const limit = Math.min(10_000, this.limits.semanticFilesMax * 4);
      const files: Array<{ path: string; bytes: number; mtimeMs: number; ctimeMs: number }> = [];
      for (const entry of runtime.wfs.walk({ maxEntries: limit + 1, maxDepth: 64 })) {
        if (!entry.stat.isFile()) continue;
        files.push({ path: entry.rel, bytes: entry.stat.size, mtimeMs: entry.stat.mtimeMs, ctimeMs: entry.stat.ctimeMs });
        if (files.length > limit) break;
      }
      const truncated = files.length > limit;
      const hash = digestOf(files.slice(0, limit));
      this.audit(runtime.project, principal, 'federation.context_manifest', 'ok', started, hash);
      return { workspaceId: runtime.project.workspaceId, hash, truncated };
    } catch (error) {
      this.auditFailure(runtime.project, principal, 'federation.context_manifest', error, started);
      throw error;
    }
  }

  async searchMany(
    projectIds: string[],
    principal: Principal,
    query: SearchQuery,
    cursor?: string,
  ): Promise<{ results: FederatedSearchResult[]; failures: FederatedSearchFailure[]; truncated: boolean; nextCursor?: string }> {
    if (projectIds.length < 1 || projectIds.length > MAX_FEDERATED_PROJECTS) {
      throw new DodoError('INVALID_INPUT', `projectIds must contain 1..${MAX_FEDERATED_PROJECTS} registered project IDs`);
    }
    const unique = [...new Set(projectIds)];
    if (unique.length !== projectIds.length) throw new DodoError('INVALID_INPUT', 'projectIds must not contain duplicates');
    if (cursor !== undefined && unique.length !== 1) {
      throw new DodoError('INVALID_INPUT', 'cursor is supported only when searching one federated project');
    }

    // Authorize every named project before returning any result. This keeps an
    // unauthorized target from becoming a partial-result existence oracle.
    const projects = unique.map((projectId) => this.authorizedProject(projectId, principal));
    const ready: Array<{ index: number; runtime: ProjectRuntime }> = [];
    const failures: FederatedSearchFailure[] = [];
    for (let index = 0; index < projects.length; index += 1) {
      const project = projects[index] as RegisteredProject;
      if (!project.available) {
        this.audit(project, principal, 'federation.search_code', 'NOT_FOUND', Date.now());
        failures.push({ projectId: project.projectId, code: 'NOT_FOUND', message: `registered project is unavailable (${project.availability})`, retryable: project.availability === 'inaccessible' });
      } else {
        ready.push({ index, runtime: this.runtimeFor(project) });
      }
    }

    const base = Math.floor(query.maxResults / Math.max(1, ready.length));
    let remainder = query.maxResults % Math.max(1, ready.length);
    const searched = await Promise.all(ready.map(async ({ index, runtime }) => {
      const started = Date.now();
      const allocation = Math.max(1, base + (remainder-- > 0 ? 1 : 0));
      try {
        const result = await runtime.search.search({ ...query, maxResults: allocation }, {
          principal: principal.grantId,
          epoch: runtime.epoch,
          ...(cursor !== undefined ? { cursor } : {}),
        });
        const sources = this.sourceHashes(runtime, result);
        const sourceHash = digestOf(sources);
        this.audit(runtime.project, principal, 'federation.search_code', 'ok', started, sourceHash);
        return { index, value: { project: scope(runtime, sourceHash), result, sources } satisfies FederatedSearchResult };
      } catch (error) {
        this.auditFailure(runtime.project, principal, 'federation.search_code', error, started);
        const err = toDodoError(error);
        return { index, failure: { projectId: runtime.project.projectId, code: err.code, message: err.message, retryable: err.retryable } satisfies FederatedSearchFailure };
      }
    }));
    const ordered = searched.sort((a, b) => a.index - b.index);
    const results = ordered.flatMap((entry) => entry.value ? [entry.value] : []);
    failures.push(...ordered.flatMap((entry) => entry.failure ? [entry.failure] : []));
    const nextCursor = unique.length === 1 ? results[0]?.result.nextCursor : undefined;
    return {
      results,
      failures,
      truncated: failures.length > 0 || results.some((entry) => entry.result.truncated),
      ...(nextCursor !== undefined ? { nextCursor } : {}),
    };
  }

  private authorizedProject(projectId: string, principal: Principal): RegisteredProject {
    let project: RegisteredProject;
    try {
      project = this.registry.get(projectId);
    } catch (error) {
      if (isLocalOwner(principal)) throw error;
      throw new DodoError('FORBIDDEN', 'project is not authorized for this client');
    }
    if (!this.canRead(project, principal)) throw new DodoError('FORBIDDEN', 'project is not authorized for this client');
    return project;
  }

  private runtime(projectId: string, principal: Principal): ProjectRuntime {
    const project = this.authorizedProject(projectId, principal);
    if (!project.available) {
      throw new DodoError('NOT_FOUND', `registered project is unavailable (${project.availability})`, {
        retryable: project.availability === 'inaccessible',
        detail: { projectId: project.projectId, availability: project.availability },
      });
    }
    return this.runtimeFor(project);
  }

  private runtimeFor(project: RegisteredProject): ProjectRuntime {
    const cacheKey = `${project.workspaceId}:${project.updatedAt}:${project.identity.dev}:${project.identity.ino}:${project.identity.birthtimeNs}`;
    const cached = this.runtimes.get(project.projectId);
    if (cached?.cacheKey === cacheKey) {
      // Refresh insertion order for the bounded LRU cache.
      this.runtimes.delete(project.projectId);
      this.runtimes.set(project.projectId, cached);
      return cached;
    }
    const projectConfig = loadProjectConfig(project.root);
    const ignores = new IgnoreEngine({
      root: project.root,
      extraSecretPatterns: this.config.secretDeny,
      secretAllow: this.config.secretAllow,
      projectExcludes: projectConfig.config.exclude,
    });
    const wfs = new WorkspaceFS(project.root, ignores);
    const list = new ListService(wfs, this.limits);
    const runtime: ProjectRuntime = {
      cacheKey,
      project,
      epoch: mintEpoch(),
      projectConfig,
      wfs,
      read: new ReadService(wfs, this.limits),
      list,
      search: new SearchService(wfs, this.limits, this.config.searchBackend),
      overview: new OverviewService(wfs, this.limits, list, new GitService(wfs, this.limits)),
    };
    this.runtimes.set(project.projectId, runtime);
    while (this.runtimes.size > MAX_CACHED_RUNTIMES) {
      const oldest = this.runtimes.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.runtimes.delete(oldest);
    }
    return runtime;
  }

  private canRead(project: RegisteredProject, principal: Principal): boolean {
    try {
      return projectAuthority(this.store, principal, project.workspaceId).scopes.includes('dodo:read');
    } catch {
      return false;
    }
  }

  private sourceHashes(runtime: ProjectRuntime, result: SearchResult): Array<{ path: string; hash: string }> {
    const paths = new Set<string>([
      ...result.matches.map((match) => match.path),
      ...result.files.map((file) => file.path),
    ]);
    const sources: Array<{ path: string; hash: string }> = [];
    for (const file of paths) {
      try {
        const read = runtime.wfs.readTextFile(file, this.limits.readFileBytes);
        sources.push({ path: read.rel, hash: read.hash });
      } catch {
        // Search already enforced path/secret policy. A file may disappear
        // between the search and this freshness read; omit its hash rather
        // than pretending the source is stable.
      }
    }
    return sources.sort((a, b) => a.path.localeCompare(b.path));
  }

  private audit(project: RegisteredProject, principal: Principal, tool: string, result: string, started: number, sourceHash?: string): void {
    try {
      this.store.audit({
        principal: principal.grantId,
        workspaceId: project.workspaceId,
        tool,
        ...(sourceHash !== undefined ? { inputDigest: sourceHash.slice(0, 24) } : {}),
        refId: project.projectId,
        durationMs: Date.now() - started,
        result,
      });
    } catch {
      throw new DodoError('INTERNAL_ERROR', 'federation audit write failed; the read result was discarded', { retryable: true });
    }
  }

  private auditFailure(project: RegisteredProject, principal: Principal, tool: string, error: unknown, started: number): void {
    const err = toDodoError(error);
    this.audit(project, principal, tool, err.code, started);
  }
}

function summary(project: RegisteredProject): FederatedProjectSummary {
  return {
    projectId: project.projectId,
    displayName: project.displayName,
    workspaceId: project.workspaceId,
    availability: project.availability,
    available: project.available,
    statusText: project.statusText,
  };
}

function scope(runtime: ProjectRuntime, sourceHash: string): FederatedProjectScope {
  return { ...summary(runtime.project), workspaceEpoch: runtime.epoch, readOnly: true, sourceHash };
}

function isLocalOwner(principal: Principal): boolean {
  return isOwner(principal);
}
