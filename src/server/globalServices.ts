import path from 'node:path';
import { ensurePrivateDirectory } from '../platform/privateFs.js';
import { MutationQueue } from '../security/mutationQueue.js';
import { MultimodalService } from '../services/multimodal/multimodalService.js';
import { ResourceService } from '../services/resources/resourceService.js';
import type { AppServices } from '../tools/context.js';
import { WorkspaceFS } from '../workspace/fs.js';
import { IgnoreEngine } from '../workspace/ignores.js';
import { mintEpoch, mintWorkspaceId } from '../workspace/identity.js';
import { resolveWorkspaceRoot } from '../workspace/root.js';
import type { BootstrappedWorkspace } from './bootstrap.js';
import type { InstallationRuntime } from './installationRuntime.js';

/** A private installation namespace; it never registers or opens a user project. */
export function createGlobalServices(installation: InstallationRuntime, initial: BootstrappedWorkspace, current: () => BootstrappedWorkspace): AppServices {
  const root = path.join(initial.configDir, 'global-workspace');
  ensurePrivateDirectory(root);
  const identity = resolveWorkspaceRoot(root);
  const store = installation.store, secret = store.installSecret();
  // A reserved namespace cannot collide with a project registered by its path.
  const workspaceId = mintWorkspaceId(secret, 'installation:global-media:v1'), epoch = mintEpoch();
  store.upsertWorkspace({ id: workspaceId, root: identity.root, dev: identity.dev, ino: identity.ino, epoch });
  store.setMeta('installation-workspace-id', workspaceId);
  const { recovery: _recovery, beginTool: _beginTool, multimodal: _multimodal, resources: _resources, ...base } = initial.services;
  const services: AppServices = {
    ...base,
    installation,
    installationScoped: true,
    workspaceId,
    epoch,
    store,
    get config() { return current().services.config; },
    get desktop() { return current().services.desktop; },
    mutations: new MutationQueue(),
    wfs: new WorkspaceFS(identity.root, new IgnoreEngine({ root: identity.root, secretPolicyMode: initial.config.secretPolicyMode, extraSecretPatterns: initial.config.secretDeny })),
    trustMode: () => 'trusted',
  };
  // The active listener can change independently of the project/runtime.
  Object.defineProperty(services, 'downloadOrigin', { configurable: true, enumerable: true, get: () => current().services.downloadOrigin });
  services.multimodal = new MultimodalService(services, initial.configDir);
  try {
    services.resources = new ResourceService(services, initial.configDir, initial.paths.resourceStoreDir, initial.paths.resourceStagingDir, secret);
  } catch (error) {
    void services.multimodal.close();
    throw error;
  }
  return services;
}
