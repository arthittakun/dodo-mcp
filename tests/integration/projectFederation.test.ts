import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectRegistry } from '../../src/projects/registry.js';
import { callToolLegacy, launch, mkTmpDir, obtainToken, wsArgs } from '../helpers/testServer.js';

const owned: string[] = [];

afterEach(() => {
  for (const directory of owned.splice(0)) fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
});

function dataOf(call: Awaited<ReturnType<typeof callToolLegacy>>): Record<string, unknown> {
  expect(call.isError, JSON.stringify(call.envelope)).toBe(false);
  expect(call.envelope['ok']).toBe(true);
  return call.envelope['data'] as Record<string, unknown>;
}

describe('multi-project read federation over HTTP + OAuth', () => {
  it('reads and searches registered A/B concurrently without changing the active workspace', async () => {
    const rootA = mkTmpDir('dodo-fed-a-');
    const rootB = mkTmpDir('dodo-fed-b-');
    owned.push(rootA, rootB);
    fs.writeFileSync(path.join(rootA, 'frontend.ts'), 'export const sharedNeedle = "frontend";\n');
    fs.writeFileSync(path.join(rootB, 'backend.ts'), 'export const sharedNeedle = "backend";\n');
    const ctx = await launch({ fixtureDir: rootA, trust: 'trusted', toolSurface: 'compact' });
    owned.push(ctx.configDir);
    try {
      const token = await obtainToken(ctx);
      const registry = new ProjectRegistry(ctx.server.services.store);
      const projectA = registry.add(rootA, 'Frontend').project;
      const projectB = registry.add(rootB, 'Backend').project;
      ctx.server.services.store.setClientAccess(projectB.workspaceId, token.clientId, ['dodo:read']);
      const activeBefore = { root: ctx.server.root, workspaceId: ctx.server.workspaceId, epoch: ctx.server.epoch };

      const overview = dataOf(await callToolLegacy(ctx, token.accessToken, 'project_overview', {}));
      const federation = overview['federation'] as { mode: string; projects: Array<{ projectId: string }> };
      expect(federation.mode).toBe('read-only');
      expect(federation.projects.map((project) => project.projectId).sort()).toEqual([projectA.projectId, projectB.projectId].sort());

      const targetOverview = dataOf(await callToolLegacy(ctx, token.accessToken, 'project_overview', { projectId: projectB.projectId }));
      expect((targetOverview['project'] as { projectId: string; workspaceId: string; readOnly: boolean }).projectId).toBe(projectB.projectId);
      expect((targetOverview['project'] as { workspaceId: string }).workspaceId).toBe(projectB.workspaceId);
      expect((targetOverview['project'] as { readOnly: boolean }).readOnly).toBe(true);
      expect((targetOverview['federation'] as { requestContext: { workspaceId: string; workspaceEpoch: string } }).requestContext).toEqual({
        workspaceId: ctx.server.workspaceId,
        workspaceEpoch: ctx.server.epoch,
      });
      expect(targetOverview['instructions']).toContain('keep using the ACTIVE workspaceId/workspaceEpoch');

      const [readA, readB] = await Promise.all([
        callToolLegacy(ctx, token.accessToken, 'dodo_read', {
          ...wsArgs(ctx), operation: 'read_files', args: { projectId: projectA.projectId, files: [{ path: 'frontend.ts' }] },
        }),
        callToolLegacy(ctx, token.accessToken, 'dodo_read', {
          ...wsArgs(ctx), operation: 'read_files', args: { projectId: projectB.projectId, files: [{ path: 'backend.ts' }] },
        }),
      ]);
      const aData = dataOf(readA);
      const bData = dataOf(readB);
      expect(((aData['files'] as Array<{ content: string }>)[0]?.content)).toContain('frontend');
      expect(((bData['files'] as Array<{ content: string }>)[0]?.content)).toContain('backend');
      expect((aData['project'] as { sourceHash: string }).sourceHash).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect((bData['project'] as { sourceHash: string }).sourceHash).toMatch(/^sha256:[a-f0-9]{64}$/);

      const searched = dataOf(await callToolLegacy(ctx, token.accessToken, 'dodo_read', {
        ...wsArgs(ctx), operation: 'search_code', args: { projectIds: [projectA.projectId, projectB.projectId], query: 'sharedNeedle', maxResults: 10 },
      }));
      const projects = searched['projects'] as Array<{ project: { projectId: string }; totalMatches: number; sources: Array<{ hash: string }> }>;
      expect(projects.map((entry) => entry.project.projectId)).toEqual([projectA.projectId, projectB.projectId]);
      expect(projects.every((entry) => entry.totalMatches === 1)).toBe(true);
      expect(projects.every((entry) => entry.sources[0]?.hash.match(/^sha256:[a-f0-9]{64}$/))).toBe(true);
      expect(searched['failures']).toEqual([]);

      expect({ root: ctx.server.root, workspaceId: ctx.server.workspaceId, epoch: ctx.server.epoch }).toEqual(activeBefore);
      const targetAudits = ctx.server.services.store.db.prepare(
        "SELECT workspace_id, tool FROM audit_events WHERE workspace_id = ? AND tool LIKE 'federation.%' ORDER BY id",
      ).all(projectB.workspaceId) as Array<{ workspace_id: string; tool: string }>;
      expect(targetAudits.map((row) => row.tool)).toEqual(expect.arrayContaining(['federation.project_overview', 'federation.read_files', 'federation.search_code']));
      expect(targetAudits.every((row) => row.workspace_id === projectB.workspaceId)).toBe(true);
    } finally {
      await ctx.cleanup();
    }
  }, 60_000);

  it('reports an authorized unavailable project as partial without stopping a ready project', async () => {
    const rootA = mkTmpDir('dodo-fed-partial-a-');
    const rootB = mkTmpDir('dodo-fed-partial-b-');
    owned.push(rootA, rootB);
    fs.writeFileSync(path.join(rootA, 'a.txt'), 'needle\n');
    fs.writeFileSync(path.join(rootB, 'b.txt'), 'needle\n');
    const ctx = await launch({ fixtureDir: rootA, toolSurface: 'full' });
    owned.push(ctx.configDir);
    try {
      const token = await obtainToken(ctx, { scope: 'dodo:read' });
      const registry = new ProjectRegistry(ctx.server.services.store);
      const a = registry.add(rootA, 'A').project;
      const b = registry.add(rootB, 'B').project;
      ctx.server.services.store.setClientAccess(b.workspaceId, token.clientId, ['dodo:read']);
      fs.rmSync(rootB, { recursive: true });

      const call = await callToolLegacy(ctx, token.accessToken, 'search_code', {
        ...wsArgs(ctx), projectIds: [a.projectId, b.projectId], query: 'needle', maxResults: 10,
      });
      const data = dataOf(call);
      expect(call.envelope['truncated']).toBe(true);
      expect((data['projects'] as Array<{ project: { projectId: string } }>).map((entry) => entry.project.projectId)).toEqual([a.projectId]);
      expect(data['failures']).toEqual([{ projectId: b.projectId, code: 'NOT_FOUND', message: 'registered project is unavailable (missing)', retryable: false }]);
      expect(ctx.server.root).toBe(fs.realpathSync.native(rootA));
    } finally {
      await ctx.cleanup();
    }
  }, 60_000);
});
