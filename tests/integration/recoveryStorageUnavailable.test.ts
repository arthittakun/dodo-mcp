import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bootstrapWorkspace, type BootstrappedWorkspace } from '../../src/server/bootstrap.js';
import { ProjectRegistry } from '../../src/projects/registry.js';
import { RecoveryPolicySchema } from '../../src/services/recovery/contracts.js';
import { isWithinPath } from '../../src/platform/pathPolicy.js';
import { TOOL_CATALOG } from '../../src/tools/catalog.js';
import { invokeToolDefinition, type Principal } from '../../src/tools/context.js';
import { platformFixture } from '../helpers/platform.js';

describe('Recovery-only storage failure during restart', () => {
  let fixture: ReturnType<typeof platformFixture> | undefined;
  let restarted: BootstrappedWorkspace | undefined;
  afterEach(async () => {
    await restarted?.shutdownServices();
    restarted = undefined;
    await fixture?.close();
    fixture = undefined;
  });

  it('boots and permits normal source work when only the Recovery directory is occupied by a file', async () => {
    fixture = platformFixture();
    fs.writeFileSync(path.join(fixture.root, 'source.txt'), 'before');
    new ProjectRegistry(fixture.ws.store).add(fixture.root, 'Persisted storage fixture');
    fixture.ws.store.db.prepare('INSERT INTO recovery_policies VALUES (?,?)').run(fixture.ws.workspaceId, JSON.stringify(RecoveryPolicySchema.parse({ mode: 'snapshot', strictEnforcement: true })));
    const initial = fixture.ws.services.recovery!;
    const checkpointId = await initial.checkpoint('owner-checkpoint', 'local-config-owner');
    const manifest = await initial.storage.readVerified(checkpointId!, fixture.ws.workspaceId);
    const source = manifest.entries.find(entry => entry.path === 'source.txt')!;
    const directory = initial.storage.directory;
    const offlineDirectory = `${directory}-offline`;
    await fixture.ws.shutdownServices();
    // The moved directory and its replacement are both inside this disposable fixture.
    expect(path.isAbsolute(directory) && isWithinPath(fixture.base, directory)).toBe(true);
    expect(path.isAbsolute(offlineDirectory) && isWithinPath(fixture.base, offlineDirectory)).toBe(true);
    fs.renameSync(directory, offlineDirectory);
    const marker = 'unrelated file occupying the optional Recovery directory';
    fs.writeFileSync(directory, marker, { mode: 0o600 });

    restarted = bootstrapWorkspace({ invokedCwd: fixture.root, configDir: { dir: fixture.configDir, source: 'env' }, log: () => undefined });
    const principal: Principal = { grantId: 'local-stdio', clientId: 'stdio', sub: 'owner', scopes: ['dodo:read', 'dodo:write', 'dodo:exec'] };
    restarted.services.localPrincipal = principal;
    restarted.store.setTrustMode(restarted.workspaceId, 'trusted');
    await restarted.services.mutations!.run(async () => undefined);
    const ws = restarted;
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const def = TOOL_CATALOG.find(tool => tool.name === name)!;
      const result = await invokeToolDefinition({ services: ws.services, principal, def, args: def.noWorkspaceContext ? args : { ...args, workspaceId: ws.workspaceId, workspaceEpoch: ws.epoch } });
      if(!result.envelope.ok)throw new Error(`${result.envelope.error?.code}: ${result.envelope.error?.message}`);
      return result.envelope.data as Record<string, unknown>;
    };
    expect((await call('project_overview')).recovery).toMatchObject({ state: 'BLOCKED', operationsBlocked: false, errorCode: expect.any(String) });
    const command = await call('run_command', { command: 'echo ok', cwd: '.', waitMs: 10000 });
    expect(command).toMatchObject({ status: 'exited', exitCode: 0 });
    expect(String(command.stdout)).toContain('ok');
    await call('edit_file', { path: 'source.txt', edits: [{ find: 'before', replace: 'after' }] });
    expect(fs.readFileSync(path.join(fixture.root, 'source.txt'), 'utf8')).toBe('after');
    await expect(ws.services.recovery!.checkpoint('owner-checkpoint', 'local-config-owner')).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    expect((await call('project_overview')).recovery).toMatchObject({ state: 'BLOCKED', operationsBlocked: false, errorCode: expect.any(String) });
    expect(fs.lstatSync(directory).isFile()).toBe(true);
    expect(fs.readFileSync(directory, 'utf8')).toBe(marker);
    expect(fs.readFileSync(path.join(offlineDirectory, 'objects', source.hash!), 'utf8')).toBe('before');
  }, 60000);

  it('keeps the pinned storage identity after lazy initialization instead of adopting a replacement directory', () => {
    fixture = platformFixture();
    const storage = fixture.ws.services.recovery!.storage;
    const directory = storage.directory;
    const originalDirectory = `${directory}-original`;
    expect(fs.readdirSync(directory).sort()).toEqual(['manifests', 'objects', 'staging']);
    expect(path.isAbsolute(directory) && isWithinPath(fixture.base, directory)).toBe(true);
    expect(path.isAbsolute(originalDirectory) && isWithinPath(fixture.base, originalDirectory)).toBe(true);
    fs.renameSync(directory, originalDirectory);
    fs.mkdirSync(directory, { mode: 0o700 });
    expect(() => storage.stagePath()).toThrow('recovery storage directory changed');
    expect(() => storage.objectPath('a'.repeat(64))).toThrow('recovery storage directory changed');
    expect(fs.readdirSync(directory)).toEqual([]);
    expect(fs.readdirSync(originalDirectory).sort()).toEqual(['manifests', 'objects', 'staging']);
  });
});
