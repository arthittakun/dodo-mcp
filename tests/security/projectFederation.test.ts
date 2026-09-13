import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectRegistry } from '../../src/projects/registry.js';
import { callToolLegacy, launch, mkTmpDir, obtainToken, wsArgs } from '../helpers/testServer.js';

const owned: string[] = [];

afterEach(() => {
  for (const directory of owned.splice(0)) fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
});

function errorCode(call: Awaited<ReturnType<typeof callToolLegacy>>): string | undefined {
  return (call.envelope['error'] as { code?: string } | null)?.code;
}

describe('multi-project federation security boundary', () => {
  it('enforces target ACL/revocation, active epoch and read-only operation schemas', async () => {
    const rootA = mkTmpDir('dodo-fed-sec-a-');
    const rootB = mkTmpDir('dodo-fed-sec-b-');
    owned.push(rootA, rootB);
    fs.writeFileSync(path.join(rootA, 'a.txt'), 'A');
    fs.writeFileSync(path.join(rootB, 'b.txt'), 'B');
    const ctx = await launch({ fixtureDir: rootA, trust: 'trusted', toolSurface: 'compact' });
    owned.push(ctx.configDir);
    try {
      const allowed = await obtainToken(ctx, { scope: 'dodo:read dodo:write' });
      const denied = await obtainToken(ctx, { scope: 'dodo:read' });
      const registry = new ProjectRegistry(ctx.server.services.store);
      registry.add(rootA, 'A');
      const b = registry.add(rootB, 'B').project;
      ctx.server.services.store.setClientAccess(b.workspaceId, allowed.clientId, ['dodo:read']);

      const noAcl = await callToolLegacy(ctx, denied.accessToken, 'dodo_read', {
        ...wsArgs(ctx), operation: 'read_files', args: { projectId: b.projectId, files: [{ path: 'b.txt' }] },
      });
      expect(noAcl.isError).toBe(true);
      expect(errorCode(noAcl)).toBe('FORBIDDEN');
      expect(JSON.stringify(noAcl.envelope)).not.toContain(rootB);
      const deniedOverview = await callToolLegacy(ctx, denied.accessToken, 'project_overview', {});
      const visible = ((deniedOverview.envelope['data'] as { federation: { projects: Array<{ projectId: string }> } }).federation.projects);
      expect(visible.some((project) => project.projectId === b.projectId)).toBe(false);

      const stale = await callToolLegacy(ctx, allowed.accessToken, 'dodo_read', {
        workspaceId: ctx.server.workspaceId, workspaceEpoch: 'stale', operation: 'read_files',
        args: { projectId: b.projectId, files: [{ path: 'b.txt' }] },
      });
      expect(errorCode(stale)).toBe('STALE_WORKSPACE');

      const crossWrite = await callToolLegacy(ctx, allowed.accessToken, 'dodo_write', {
        ...wsArgs(ctx), operation: 'write_file', args: { projectId: b.projectId, path: 'blocked.txt', content: 'blocked' },
      });
      expect(crossWrite.isError).toBe(true);
      expect(errorCode(crossWrite)).toBe('INVALID_INPUT');
      expect(fs.existsSync(path.join(rootB, 'blocked.txt'))).toBe(false);

      // A legacy workspace-bound grant remains valid for the active project,
      // but it must never become an installation-wide federation identity.
      ctx.server.services.store.setMeta(`identity-grant:${allowed.grantId}`, '1');
      const legacyGrant = await callToolLegacy(ctx, allowed.accessToken, 'dodo_read', {
        ...wsArgs(ctx), operation: 'read_files', args: { projectId: b.projectId, files: [{ path: 'b.txt' }] },
      });
      expect(errorCode(legacyGrant)).toBe('FORBIDDEN');
      ctx.server.services.store.setMeta(`identity-grant:${allowed.grantId}`, '2');

      ctx.server.services.store.setClientAccess(b.workspaceId, allowed.clientId, []);
      const revoked = await callToolLegacy(ctx, allowed.accessToken, 'dodo_read', {
        ...wsArgs(ctx), operation: 'read_files', args: { projectId: b.projectId, files: [{ path: 'b.txt' }] },
      });
      expect(errorCode(revoked)).toBe('FORBIDDEN');
    } finally {
      await ctx.cleanup();
    }
  }, 60_000);

  it('keeps secret, traversal and directory-identity guards authoritative in the target project', async () => {
    const rootA = mkTmpDir('dodo-fed-guard-a-');
    const rootB = mkTmpDir('dodo-fed-guard-b-');
    owned.push(rootA, rootB);
    fs.writeFileSync(path.join(rootB, 'safe.txt'), 'safe');
    fs.writeFileSync(path.join(rootB, '.env'), 'DODO_PRIVATE=never');
    const ctx = await launch({ fixtureDir: rootA, toolSurface: 'compact' });
    owned.push(ctx.configDir);
    try {
      const token = await obtainToken(ctx, { scope: 'dodo:read' });
      const project = new ProjectRegistry(ctx.server.services.store).add(rootB, 'Guarded').project;
      ctx.server.services.store.setClientAccess(project.workspaceId, token.clientId, ['dodo:read']);

      const guarded = await callToolLegacy(ctx, token.accessToken, 'dodo_read', {
        ...wsArgs(ctx), operation: 'read_files', args: { projectId: project.projectId, files: [{ path: '.env' }, { path: '../outside.txt' }, { path: 'safe.txt' }] },
      });
      expect(guarded.isError).toBe(false);
      const data = guarded.envelope['data'] as { files: Array<{ path: string; content: string }>; errors: Array<{ error: { code: string } }> };
      expect(data.files).toEqual([expect.objectContaining({ path: 'safe.txt', content: 'safe' })]);
      expect(data.errors.map((entry) => entry.error.code).sort()).toEqual(['PATH_DENIED', 'SECRET_PATH_DENIED']);
      expect(JSON.stringify(guarded.envelope)).not.toContain('DODO_PRIVATE=never');

      fs.rmSync(rootB, { recursive: true });
      fs.mkdirSync(rootB);
      fs.writeFileSync(path.join(rootB, 'replacement.txt'), 'replacement');
      const replaced = await callToolLegacy(ctx, token.accessToken, 'dodo_read', {
        ...wsArgs(ctx), operation: 'read_files', args: { projectId: project.projectId, files: [{ path: 'replacement.txt' }] },
      });
      expect(errorCode(replaced)).toBe('NOT_FOUND');
      expect((replaced.envelope['error'] as { detail: { availability: string } }).detail.availability).toBe('replaced');
    } finally {
      await ctx.cleanup();
    }
  }, 60_000);
});
