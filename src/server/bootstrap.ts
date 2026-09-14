import { acquireProjectLease } from './projectLease.js';
import { MutationQueue } from '../security/mutationQueue.js';
import { isPersonalMode, setAccessMode } from '../security/accessMode.js';
import { MultimodalService } from '../services/multimodal/multimodalService.js';
import { ResourceService } from '../services/resources/resourceService.js';
import { ProjectBrainService } from '../services/brain/brainService.js';
import { ContextEngineService } from '../services/context/contextEngine.js';
import { MemoryService } from '../services/memory/memoryService.js';
import { RuntimeService } from '../services/runtime/runtimeService.js';
import { AgentRuntimeService } from '../services/agent/agentService.js';
import { ScheduleService } from '../services/schedules/scheduleService.js';
import { DesktopService } from '../services/desktop/desktopService.js';
import { NativeDesktopBackend } from '../services/desktop/nativeBackend.js';
import type Database from 'better-sqlite3';
import { resolveConfigDir, ensureConfigDir, statePaths, type ConfigDirResolution, type StatePaths } from '../config/paths.js';
import { loadGlobalConfig, type GlobalConfig } from '../config/globalConfig.js';
import { loadProjectConfig, type ProjectConfigResult } from '../config/projectConfig.js';
import { resolveWorkspaceRoot, type RootInfo } from '../workspace/root.js';
import { mintWorkspaceId, mintEpoch } from '../workspace/identity.js';
import { IgnoreEngine } from '../workspace/ignores.js';
import { WorkspaceFS } from '../workspace/fs.js';
import { openDatabase } from '../store/db.js';
import { Store } from '../store/store.js';
import { ReadService, ListService } from '../services/files/readService.js';
import { SearchService } from '../services/search/searchService.js';
import { Planner } from '../services/changes/planner.js';
import { Applier } from '../services/changes/applier.js';
import { JobManager } from '../services/jobs/jobManager.js';
import { GitService } from '../services/git/gitService.js';
import { IntelService } from '../services/intelligence/intelService.js';
import { OverviewService } from '../services/overview.js';
import { sandboxWrapperFromConfig } from '../services/jobs/sandboxWiring.js';
import type { AppServices } from '../tools/context.js';
import { DODO_VERSION } from './version.js';
import { FederationService } from '../projects/federation.js';

/**
 * Workspace bootstrap shared by every serving entry (`dodo start` over HTTP,
 * `dodo stdio` for local clients): config, durable store, workspace identity,
 * shared path policy and all tool services. Transport-specific concerns
 * (OAuth, HTTP, stdio) are layered on top by the callers.
 */
export interface BootstrapOptions {
  invokedCwd: string;
  rootOverride?: string;
  allowUnsafeRoot?: boolean;
  log: (line: string) => void;
  runMode?: 'allow-all' | 'bypass';
  /**
   * Use this state directory instead of resolving it from process.env — a
   * runtime workspace switch must stay in the directory the server booted
   * with, whatever the environment looks like later.
   */
  configDir?: Pick<ConfigDirResolution, 'dir' | 'source' | 'envVar'>;
}

export interface BootstrappedWorkspace {
  configDir: string;
  configDirSource: 'env' | 'platform';
  configDirEnvVar?: 'DODO_CONFIG_DIR';
  paths: StatePaths;
  config: GlobalConfig;
  db: Database.Database;
  store: Store;
  rootInfo: RootInfo;
  workspaceId: string;
  epoch: string;
  projectConfig: ProjectConfigResult;
  services: AppServices;
  /** Stops jobs/workers and closes the store (best effort, bounded). */
  shutdownServices(): Promise<void>;
}

import { activateManagedTools } from '../setup/managedTools.js';

export function bootstrapWorkspace(opts: BootstrapOptions): BootstrappedWorkspace {
  const { log } = opts;
  const configResolution = opts.configDir ?? resolveConfigDir(process.env);
  const { dir: configDir, source: configDirSource, envVar: configDirEnvVar } = configResolution;
  ensureConfigDir(configDir);
  const paths = statePaths(configDir);
  const config = loadGlobalConfig(paths.configFile);
  if (opts.runMode) config.allowWebFetch = true;
  if (opts.runMode === 'bypass') config.commandSandbox = 'off';
  const limits = config.limits;

  const rootInfo = resolveWorkspaceRoot(opts.rootOverride ?? opts.invokedCwd, { allowUnsafe: opts.allowUnsafeRoot ?? false });
  const releaseLease = acquireProjectLease(configDir, rootInfo.root);
  let openedDb: Database.Database | undefined;
  try {
  activateManagedTools(configDir, rootInfo.root);
  const db = openDatabase(paths.dbFile); openedDb = db;
  const store = new Store(db);
  // Global config is the owner-controlled source for this installation-wide
  // choice. Mirror it into private state so authorization helpers that only
  // receive Store can make the same decision for every target runtime.
  setAccessMode(store, config.accessMode);
  const installSecret = store.installSecret();
  const workspaceId = mintWorkspaceId(installSecret, rootInfo.root);
  const epoch = mintEpoch();
  const existingWs = store.getWorkspace(workspaceId);
  if (existingWs && (existingWs.dev !== rootInfo.dev || existingWs.ino !== rootInfo.ino)) {
    // The path now points at a DIFFERENT directory identity (replaced root):
    // epoch-based trust survives, but note it loudly (spec §6).
    store.db.prepare('DELETE FROM workspace_clients WHERE workspace_id=?').run(workspaceId);
    store.setTrustMode(workspaceId, 'inspect');
    log('[dodo] workspace directory identity changed: client access and saved trust reset');
  }
  store.upsertWorkspace({ id: workspaceId, root: rootInfo.root, dev: rootInfo.dev, ino: rootInfo.ino, epoch });
  const interrupted = store.markInterruptedJobs(epoch, workspaceId);
  if (interrupted > 0) log(`[dodo] ${interrupted} job(s) from a previous run marked interrupted_on_restart`);

  const projectConfig = loadProjectConfig(rootInfo.root);
  const ignores = new IgnoreEngine({
    root: rootInfo.root,
    extraSecretPatterns: config.secretDeny,
    secretAllow: config.secretAllow,
    projectExcludes: projectConfig.config.exclude,
  });
  const wfs = new WorkspaceFS(rootInfo.root, ignores);

  const applier = new Applier(wfs, limits, store, paths.backupsDir, workspaceId);
  const recon = applier.reconcileOnBoot();
  if (recon.recoveryRequired.length > 0) {
    log(`[dodo] WARNING: ${recon.recoveryRequired.length} changeset(s) need manual recovery (dodo recover); mutations are blocked until resolved`);
  }

  const git = new GitService(wfs, limits);
  const listService = new ListService(wfs, limits);
  const jobs = new JobManager(wfs, limits, store, paths.jobsDir, config.envAllowlist, sandboxWrapperFromConfig(config, rootInfo.root, configDir));
  const intel = new IntelService(
    {
      root: rootInfo.root,
      extraSecretPatterns: config.secretDeny,
      projectExcludes: projectConfig.config.exclude,
      semanticFilesMax: limits.semanticFilesMax,
      maxSnapshotBytes: Math.min(limits.readFileBytes, 512 * 1024),
    },
    limits,
  );
  const mutations = new MutationQueue();
  jobs.mutations = mutations;
  const services: AppServices = {
    mutations,
    federation: new FederationService(store, config, limits),
    schedules: new ScheduleService({store,workspaceId,epoch,wfs,jobs,config,limits}),
    version: DODO_VERSION,
    config,
    limits,
    store,
    wfs,
    readService: new ReadService(wfs, limits),
    listService,
    search: new SearchService(wfs, limits, config.searchBackend),
    planner: new Planner(wfs, limits, store),
    applier,
    jobs,
    git,
    intel,
    overview: new OverviewService(wfs, limits, listService, git),
    desktop: new DesktopService(store, workspaceId, epoch, new NativeDesktopBackend(configDir)),
    projectConfig,
    workspaceId,
    epoch,
    trustMode: () => opts.runMode || isPersonalMode(store) ? 'trusted' : store.trustMode(workspaceId),
  };

  services.multimodal = new MultimodalService(services, configDir);
  services.resources = new ResourceService(services, configDir, paths.resourceStoreDir, paths.resourceStagingDir, installSecret);
  services.brain = new ProjectBrainService(services, installSecret);
  services.runtime = new RuntimeService(services);
  services.agentRuntime = new AgentRuntimeService(services);
  services.contextEngine = new ContextEngineService(services, installSecret);
  services.memory = new MemoryService(services, installSecret);

  let closed = false;
  return {
    configDir,
    configDirSource,
    ...(configDirEnvVar ? { configDirEnvVar } : {}),
    paths,
    config,
    db,
    store,
    rootInfo,
    workspaceId,
    epoch,
    projectConfig,
    services,
    async shutdownServices() {
      if (closed) return;
      closed = true;
      services.schedules.stop();
      services.memory?.close();
      services.contextEngine?.close();
      services.agentRuntime?.close();
      services.runtime?.close();
      await services.brain?.close();
      await services.multimodal?.close();
      services.resources?.close();
      await services.desktop.close();
      try {
        await services.jobs.shutdown(3000);
        await services.intel.shutdown();
        await services.lsp?.shutdown();
      } catch {
        /* best effort */
      }
      try {
        db.close();
        releaseLease();
      } catch {
        /* already closed */
      }
    },
  };
  } catch (error) { try { openedDb?.close(); } finally { releaseLease(); } throw error; }
}
