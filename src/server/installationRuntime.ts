import { Subagents } from '../services/ai/subagents.js';
import { openDatabase } from '../store/db.js';
import { Store } from '../store/store.js';
import { ProjectRegistry } from '../projects/registry.js';
import { DodoError } from '../errors.js';
import { bootstrapWorkspace, type BootstrappedWorkspace } from './bootstrap.js';
import { attachOptionalServices } from './optionalServices.js';
import { projectAuthority, isOwner } from '../security/projectAuthority.js';
import type { Principal, AppServices } from '../tools/context.js';
import type { WorkspaceResources } from './workspaceHost.js';

/** Explicit target runtimes never replace the legacy default workspace. */
export class InstallationRuntime {
  private readonly runtimes = new Map<string, BootstrappedWorkspace>();
  private readonly opening = new Map<string, Promise<BootstrappedWorkspace>>();
  private readonly closing = new Set<string>();
  private readonly resources = new Map<string, WorkspaceResources>();
  private readonly users = new Map<string, number>();
  private closed = false;
  defaultReady: () => boolean = () => true;
  private readonly registry: ProjectRegistry;
  readonly store: Store;
  readonly ai: Subagents;
  constructor(private readonly initial: BootstrappedWorkspace, private readonly current: () => BootstrappedWorkspace,
    private readonly resourceFactory: (ws: BootstrappedWorkspace) => Promise<WorkspaceResources>, private readonly log: (s: string) => void, ports: number[] = [21730, 21731]) {
    this.store = new Store(openDatabase(initial.paths.dbFile));
    this.registry = new ProjectRegistry(this.store);
    this.attach(initial);
    this.ai = new Subagents(this, ports);
  }
  attach(ws: BootstrappedWorkspace): void { ws.services.installation = this; }
  list(p: Principal) {
    return this.registry.list().filter(r => {
      try { return projectAuthority(this.store, p, r.workspaceId).scopes.includes('dodo:read'); } catch { return false; }
    });
  }
  private project(id: string, p: Principal) {
    const r = this.registry.list().find(r => r.projectId === id);
    if (!r) throw new DodoError('FORBIDDEN', 'project unavailable or not authorized');
    const authority = projectAuthority(this.store, p, r.workspaceId);
    if (authority.scopes.length === 0) throw new DodoError('WORKSPACE_ACCESS_REQUIRED', 'owner must allow access to the target project');
    if (!r.available) throw new DodoError('PATH_DENIED', 'registered project directory is not ready');
    return r;
  }
  async acquire(id: string, p: Principal): Promise<{ workspace: BootstrappedWorkspace; services: AppServices; release: () => void }> {
    if (this.closed) throw new DodoError('CONFLICT', 'runtime manager is closing');
    if (this.closing.has(id)) throw new DodoError('CONFLICT', 'project runtime is closing; retry after it closes');
    const r = this.project(id, p);
    let ws = this.current();
    if (ws.workspaceId === r.workspaceId && !this.defaultReady()) throw new DodoError('STALE_WORKSPACE','default project is changing; retry with fresh context');
    if (ws.workspaceId !== r.workspaceId) {
      const cached = this.runtimes.get(id);
      if (cached) ws = cached;
      else {
        let pending = this.opening.get(id);
        if (!pending) {
          if (this.runtimes.size + this.opening.size >= 16) throw new DodoError('RESOURCE_LIMIT', 'close an idle project before opening another runtime');
          pending = this.open(r.projectId, r.root);
          this.opening.set(id, pending);
        }
        try { ws = await pending; } finally { this.opening.delete(id); }
      }
    }
    this.project(id, p); // identity/ACL may have changed while preparing resources
    if (this.closing.has(id)) throw new DodoError('CONFLICT', 'project runtime is closing');
    if (this.closed) throw new DodoError('CONFLICT', 'runtime manager is closing');
    this.users.set(ws.workspaceId, (this.users.get(ws.workspaceId) ?? 0) + 1);
    let released = false;
    return { workspace: ws, services: ws.services, release: () => {
      if (released) return; released = true;
      this.users.set(ws.workspaceId, (this.users.get(ws.workspaceId) ?? 1) - 1);
    } };
  }
  private async open(id: string, root: string): Promise<BootstrappedWorkspace> {
    const ws = bootstrapWorkspace({ invokedCwd: root, configDir: { dir: this.initial.configDir, source: this.initial.configDirSource }, log: this.log });
    try {
      attachOptionalServices(ws, this.log);
      this.attach(ws);
      ws.services.listService.tree('.', { depth: 1, maxEntries: 5 });
      this.resources.set(id, await this.resourceFactory(ws));
      this.runtimes.set(id, ws);
      ws.services.schedules.start(() => !this.closed);
      return ws;
    } catch (err) { await ws.shutdownServices(); throw err; }
  }
  busy(workspaceId: string): boolean {
    if ((this.users.get(workspaceId) ?? 0) > 0) return true;
    return !this.closed && Boolean(this.store.db.prepare("SELECT 1 FROM ai_runs WHERE workspace_id=? AND status NOT IN ('completed','failed','canceled') LIMIT 1").get(workspaceId));
  }
  status() { return [...this.runtimes].map(([projectId, w]) => ({ projectId, state:this.closing.has(projectId)?'closing':'ready', workspaceId: w.workspaceId, workspaceEpoch: w.epoch, jobs: w.services.jobs.runningCount(), requests: this.users.get(w.workspaceId) ?? 0 })); }
  async closeProject(id: string): Promise<boolean> {
    if (this.opening.has(id)) throw new DodoError('CONFLICT', 'project is opening');
    if (this.closing.has(id)) throw new DodoError('CONFLICT', 'project is closing');
    const ws = this.runtimes.get(id);
    if (!ws) return false;
    if (this.busy(ws.workspaceId) || ws.services.jobs.runningCount() || ws.services.mutations?.busy) throw new DodoError('CONFLICT', 'project has active requests, jobs or agents');
    this.closing.add(id);
    await this.resources.get(id)?.close();
    await ws.shutdownServices(); this.resources.delete(id); this.runtimes.delete(id);
    this.closing.delete(id);
    return true;
  }
  async close(): Promise<void> {
    this.closed = true;
    this.ai.stop();
    await Promise.allSettled(this.opening.values());
    await Promise.all([this.current(), ...this.runtimes.values()].map(w => w.services.jobs.shutdown(3000)));
    await this.ai.close();
    while ([...this.users.values()].some(n => n > 0)) await new Promise(r => setTimeout(r, 25));
    for (const id of this.runtimes.keys()) await this.closeProject(id);
    this.store.db.close();
  }
  owner(): Principal { return { grantId: 'local-config-owner', clientId: 'local-config', sub: 'owner', scopes: ['dodo:read', 'dodo:write', 'dodo:exec'] }; }
  canManage(p: Principal): boolean { return isOwner(p); }
}
