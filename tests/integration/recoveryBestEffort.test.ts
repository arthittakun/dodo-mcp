import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootstrapWorkspace, type BootstrappedWorkspace } from '../../src/server/bootstrap.js';
import { DodoError } from '../../src/errors.js';
import { ProjectRegistry } from '../../src/projects/registry.js';
import { RecoveryPolicySchema } from '../../src/services/recovery/contracts.js';
import { invokeToolDefinition, type Principal } from '../../src/tools/context.js';
import { TOOL_CATALOG } from '../../src/tools/catalog.js';
import { platformFixture } from '../helpers/platform.js';

describe('Recovery best-effort across runtime restart', () => {
  let fixture: ReturnType<typeof platformFixture> | undefined;
  let restarted: BootstrappedWorkspace | undefined;
  const principal: Principal = { grantId: 'local-stdio', clientId: 'stdio', sub: 'owner', scopes: ['dodo:read', 'dodo:write', 'dodo:exec'] };
  const current = () => restarted ?? fixture!.ws;

  afterEach(async () => {
    vi.restoreAllMocks();
    await restarted?.shutdownServices();
    restarted = undefined;
    await fixture?.close();
    fixture = undefined;
  });

  function setup(files: Record<string, string>) {
    fixture = platformFixture();
    for (const [rel, bytes] of Object.entries(files)) {
      const absolute = path.join(fixture.root, rel);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, bytes);
    }
    new ProjectRegistry(fixture.ws.store).add(fixture.root, 'Recovery restart fixture');
    return fixture.ws.services.recovery!;
  }

  async function restart() {
    await fixture!.ws.shutdownServices();
    restarted = bootstrapWorkspace({ invokedCwd: fixture!.root, configDir: { dir: fixture!.configDir, source: 'env' }, log: () => undefined });
    restarted.services.localPrincipal = principal;
    restarted.store.setTrustMode(restarted.workspaceId, 'trusted');
    // Let activation finish before asserting diagnostics or injecting a later failure.
    await restarted.services.mutations!.run(async () => undefined);
    return restarted.services.recovery!;
  }

  async function call(name: string, args: Record<string, unknown> = {}) {
    const ws = current();
    const def = TOOL_CATALOG.find(tool => tool.name === name)!;
    const result = await invokeToolDefinition({ services: ws.services, principal, def, args: def.noWorkspaceContext ? args : { ...args, workspaceId: ws.workspaceId, workspaceEpoch: ws.epoch } });
    if (!result.envelope.ok) throw new Error(`${result.envelope.error?.code}: ${result.envelope.error?.message}`);
    return result.envelope.data as Record<string, unknown>;
  }

  it('persists automatic secret skipping and reports the skipped test fixture after restart', async () => {
    const secretPath = 'tests/r2.test.ts';
    const recovery = setup({
      'source.txt': 'before',
      [secretPath]: `export const exampleAwsKey = "AKIA${'A'.repeat(16)}";\n`,
      'backups/example.sql': "INSERT INTO tb_file_user (password_hash, pin_hash) VALUES ('example-hash', 'example-pin-hash');\n",
    });
    await recovery.configure({ mode: 'snapshot', skipSecretContentFiles: true, strictEnforcement: false }, true);
    await recovery.checkpoint('owner-checkpoint', 'local-config-owner');
    expect(recovery.status().skippedSecretFiles).toContain(secretPath);
    const row = fixture!.ws.store.db.prepare('SELECT payload FROM recovery_policies WHERE workspace_id=?').get(fixture!.ws.workspaceId) as { payload: string };
    expect(JSON.parse(row.payload)).toMatchObject({ skipSecretContentFiles: true, strictEnforcement: false });

    const next = await restart();
    expect(next.policy()).toMatchObject({ skipSecretContentFiles: true, strictEnforcement: false });
    const overview = await call('project_overview');
    expect(overview.recovery).toMatchObject({ blockedPath: null, skippedSecretFiles: [secretPath] });
    const id = next.status().lastCheckpointId;
    expect(id).toBeTruthy();
    const manifest = await next.storage.readVerified(id!, current().workspaceId);
    expect(manifest.entries.map(entry => entry.path)).toContain('source.txt');
    expect(manifest.entries.map(entry => entry.path)).not.toContain(secretPath);
    await call('edit_file', { path: 'source.txt', edits: [{ find: 'before', replace: 'after' }] });
    expect(fs.readFileSync(path.join(fixture!.root, 'source.txt'), 'utf8')).toBe('after');
  });

  it.each(['default', 'legacy-strict', 'required-git', 'selected-git-directory'] as const)('keeps ordinary exec and edits available after restart and backup failure (%s)', async variant => {
    setup({ 'source.txt': 'before' });
    const policy = RecoveryPolicySchema.parse({
      mode: 'snapshot', strictEnforcement: variant === 'legacy-strict', skipSecretContentFiles: true,
      ...(variant === 'required-git' ? { gitRequired: true } : {}),
      ...(variant === 'selected-git-directory' ? { gitDirectory: path.join(fixture!.base, 'missing-backup-volume') } : {}),
    });
    fixture!.ws.store.db.prepare('INSERT INTO recovery_policies VALUES (?,?)').run(fixture!.ws.workspaceId, JSON.stringify(policy));
    const recovery = await restart();
    vi.spyOn(recovery.storage, 'reserve').mockImplementation(() => {
      throw new DodoError('RESOURCE_LIMIT', 'fixture recovery storage unavailable', { detail: { path: 'source.txt' } });
    });

    const command = await call('run_command', { command: 'echo ok', cwd: '.', waitMs: 10000 });
    expect(command).toMatchObject({ status: 'exited', exitCode: 0 });
    expect(String(command.stdout)).toContain('ok');
    await call('edit_file', { path: 'source.txt', edits: [{ find: 'before', replace: 'after' }] });
    expect(fs.readFileSync(path.join(fixture!.root, 'source.txt'), 'utf8')).toBe('after');
    expect((await call('project_overview')).recovery).toMatchObject({ errorCode: 'RESOURCE_LIMIT', blockedPath: 'source.txt' });
    // An explicit backup cannot claim success when no backup was written.
    await expect(recovery.checkpoint('owner-checkpoint', 'local-config-owner')).rejects.toThrow('source backup is blocked');
    // Recovery degradation must not weaken the independent secret path guard.
    await expect(call('write_file', { path: '.env', content: 'forbidden' })).rejects.toThrow('SECRET_PATH_DENIED');
  });

  it('includes the exact secret-content path in project_overview when an explicit checkpoint fails', async () => {
    const secretPath = 'tests/r2.test.ts';
    const recovery = setup({ 'source.txt': 'safe', [secretPath]: `export const example = "AKIA${'B'.repeat(16)}";\n` });
    fixture!.ws.store.db.prepare('INSERT INTO recovery_policies VALUES (?,?)').run(fixture!.ws.workspaceId, JSON.stringify(RecoveryPolicySchema.parse({ mode: 'snapshot', strictEnforcement: false, skipSecretContentFiles: false })));
    await expect(recovery.checkpoint('owner-checkpoint', 'local-config-owner')).rejects.toThrow('source backup is blocked');
    expect((await call('project_overview')).recovery).toMatchObject({ errorCode: 'SECRET_PATH_DENIED', blockedPath: secretPath });
    const command = await call('run_command', { command: 'echo ok', cwd: '.', waitMs: 10000 });
    expect(command).toMatchObject({ status: 'exited', exitCode: 0 });
    expect(String(command.stdout)).toContain('ok');
  });

  it('keeps bootstrap, overview, exec and edits available when persisted Recovery policy is corrupt', async () => {
    setup({ 'source.txt': 'before' });
    fixture!.ws.store.db.prepare('INSERT INTO recovery_policies VALUES (?,?)').run(fixture!.ws.workspaceId, '{invalid Recovery policy');
    await restart();
    expect((await call('project_overview')).recovery).toMatchObject({ state: 'BLOCKED', operationsBlocked: false });
    const command = await call('run_command', { command: 'echo ok', cwd: '.', waitMs: 10000 });
    expect(command).toMatchObject({ status: 'exited', exitCode: 0 });
    expect(String(command.stdout)).toContain('ok');
    await call('edit_file', { path: 'source.txt', edits: [{ find: 'before', replace: 'after' }] });
    expect(fs.readFileSync(path.join(fixture!.root, 'source.txt'), 'utf8')).toBe('after');
    expect((await call('project_overview')).recovery).toMatchObject({ state: 'BLOCKED', operationsBlocked: false });
  });

  it('does not let a corrupt prior snapshot block source work after restart under a legacy strict policy', async () => {
    const recovery = setup({ 'source.txt': 'before' });
    fixture!.ws.store.db.prepare('INSERT INTO recovery_policies VALUES (?,?)').run(fixture!.ws.workspaceId, JSON.stringify(RecoveryPolicySchema.parse({ mode: 'snapshot', strictEnforcement: true })));
    const checkpointId = await recovery.checkpoint('owner-checkpoint', 'local-config-owner');
    const manifest = await recovery.storage.readVerified(checkpointId!, fixture!.ws.workspaceId);
    const source = manifest.entries.find(entry => entry.path === 'source.txt')!;
    const objectPath = recovery.storage.objectPath(source.hash!);
    // Keep the size unchanged so verification must reject the content hash.
    fs.writeFileSync(objectPath, 'BROKEN');

    const next = await restart();
    expect((await call('project_overview')).recovery).toMatchObject({ state: 'BLOCKED', operationsBlocked: false });
    const command = await call('run_command', { command: 'echo ok', cwd: '.', waitMs: 10000 });
    expect(command).toMatchObject({ status: 'exited', exitCode: 0 });
    await call('edit_file', { path: 'source.txt', edits: [{ find: 'before', replace: 'after' }] });
    expect(fs.readFileSync(path.join(fixture!.root, 'source.txt'), 'utf8')).toBe('after');
    await expect(next.storage.readVerified(checkpointId!, current().workspaceId)).rejects.toThrow('integrity');
    expect(fs.readFileSync(objectPath, 'utf8')).toBe('BROKEN');
  });

  it('rechecks live authority after a failed optional backup before applying a source edit', async () => {
    const recovery = setup({ 'source.txt': 'before' });
    await recovery.checkpoint('owner-checkpoint', 'local-config-owner');
    let revoked = false;
    vi.spyOn(recovery.storage, 'reserve').mockImplementation(() => {
      revoked = true;
      throw new DodoError('RESOURCE_LIMIT', 'fixture recovery storage unavailable');
    });
    const ws = current();
    const result = await invokeToolDefinition({
      services: ws.services,
      def: TOOL_CATALOG.find(tool => tool.name === 'write_file')!,
      principal: () => ({ ...principal, scopes: revoked ? ['dodo:read'] : principal.scopes }),
      args: { workspaceId: ws.workspaceId, workspaceEpoch: ws.epoch, path: 'source.txt', content: 'must not be written' },
    });
    expect(revoked).toBe(true);
    expect(result.envelope.error?.code).toBe('FORBIDDEN');
    expect(fs.readFileSync(path.join(fixture!.root, 'source.txt'), 'utf8')).toBe('before');
  });

  it('still rejects a reviewed restore when its required before-image cannot be backed up', async () => {
    const recovery = setup({ 'source.txt': 'before' });
    const checkpoint = await call('checkpoint_create', { idempotencyKey: fixture!.key() });
    await call('write_file', { path: 'source.txt', content: 'after' });
    const plan = await call('restore_preview', { checkpointId: checkpoint.checkpointId, paths: ['source.txt'] });
    expect(plan.applicable).toBe(true);
    vi.spyOn(recovery.storage, 'reserve').mockImplementation(() => {
      throw new DodoError('RESOURCE_LIMIT', 'fixture recovery storage unavailable');
    });
    await expect(call('restore_apply', { planId: plan.planId, planHash: plan.planHash, idempotencyKey: fixture!.key() })).rejects.toThrow('RECOVERY_REQUIRED');
    expect(fs.readFileSync(path.join(fixture!.root, 'source.txt'), 'utf8')).toBe('after');
    expect(current().services.applier.recoveryBlocked()).toBeUndefined();
  });

  it('reports an unannotated nested source failure and clears that path for a later global storage failure', async () => {
    const blockedPath = 'nested/blocked.ts';
    const recovery = setup({ 'source.txt': 'safe', [blockedPath]: 'export const value = 1;\n' });
    const resolve = current().services.wfs.resolve.bind(current().services.wfs);
    const deniedSource = vi.spyOn(current().services.wfs, 'resolve').mockImplementation((input, options) => {
      if (input === blockedPath) throw new DodoError('SECRET_PATH_DENIED', 'fixture source path denied');
      return resolve(input, options);
    });
    await expect(recovery.checkpoint('owner-checkpoint', 'local-config-owner')).rejects.toThrow('source backup is blocked');
    deniedSource.mockRestore();
    expect((await call('project_overview')).recovery).toMatchObject({ errorCode: 'SECRET_PATH_DENIED', blockedPath });

    vi.spyOn(recovery.storage, 'reserve').mockImplementation(() => {
      throw new DodoError('RESOURCE_LIMIT', 'fixture global backup quota exhausted');
    });
    await expect(recovery.checkpoint('owner-checkpoint', 'local-config-owner')).rejects.toThrow('source backup is blocked');
    expect((await call('project_overview')).recovery).toMatchObject({ errorCode: 'RESOURCE_LIMIT', blockedPath: null });
  });
});
