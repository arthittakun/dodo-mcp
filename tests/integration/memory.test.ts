import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ipcSocketPath } from '../../src/config/paths.js';
import { ipcCall } from '../../src/ipc/client.js';
import { ContextQueryResult } from '../../src/services/context/contracts.js';
import { LearningProposalReceipt, MemoryProposalReceipt, MemoryRecord, MemorySearchResult } from '../../src/services/memory/contracts.js';
import { launch, obtainToken, type TestContext } from '../helpers/testServer.js';
import { assertOk, tool } from '../helpers/multimodal.js';

async function sourceEvidence(ctx: TestContext, accessToken: string, term: string, sourcePath: string): Promise<string> {
  const result = ContextQueryResult.parse(assertOk(await tool(ctx, accessToken, 'context_query', { goal: term, terms: [term], maxItems: 50 })));
  const evidence = Object.values(result.evidence).flat().find((item) => item.source.path === sourcePath);
  if (!evidence) throw new Error(`no evidence for ${sourcePath}`);
  return evidence.evidenceId;
}

function owner(ctx: TestContext, command: string, args: Record<string, unknown> = {}) {
  return ipcCall(ipcSocketPath(ctx.configDir, ctx.server.workspaceId), command, args);
}

describe('Phase 07 owner-reviewed memory over real HTTP + OAuth and private IPC', () => {
  it('keeps proposals non-permanent, approves the exact digest, retrieves memory in context, and marks changed evidence stale', async () => {
    const ctx = await launch({ toolSurface: 'full', fixtureFiles: { 'src/session.ts': 'export const durableMemoryNeedle = "alpha";\n' } });
    try {
      const token = await obtainToken(ctx, { scope: 'dodo:read dodo:write' });
      const evidenceId = await sourceEvidence(ctx, token.accessToken, 'durableMemoryNeedle', 'src/session.ts');
      const receipt = MemoryProposalReceipt.parse(assertOk(await tool(ctx, token.accessToken, 'memory_propose', {
        kind: 'decision', claim: 'Keep session state scoped to one workspace.', rationale: 'The current source defines the workspace session boundary.',
        affectedEntities: ['durableMemoryNeedle'], evidenceIds: [evidenceId], retentionDays: 90,
      })));
      expect(receipt).toMatchObject({ status: 'PENDING', permanent: false, evidenceCount: 1 });
      expect((await owner(ctx, 'memory.pending') as Array<{ proposalId: string }>).map((item) => item.proposalId)).toContain(receipt.proposalId);

      const before = MemorySearchResult.parse(assertOk(await tool(ctx, token.accessToken, 'memory_search', { query: 'session workspace' })));
      expect(before.memories).toEqual([]);
      const approved = MemoryRecord.parse(await owner(ctx, 'memory.approve', { id: receipt.proposalId, digest: receipt.digest, shareWith: [], allowConflict: false }));
      expect(approved).toMatchObject({ status: 'CURRENT', ownerReviewed: true, authority: 'evidence_only', trust: 'untrusted_content' });
      expect(ctx.server.services.store.recentAudit(ctx.server.workspaceId, 50)).toContainEqual(expect.objectContaining({
        principal: 'local-memory-owner', tool: 'local.memory.approve', result: 'approved',
      }));

      const searched = MemorySearchResult.parse(assertOk(await tool(ctx, token.accessToken, 'memory_search', { query: 'session workspace' })));
      expect(searched.memories.map((item) => item.memoryId)).toContain(approved.memoryId);
      expect(MemoryRecord.parse(assertOk(await tool(ctx, token.accessToken, 'memory_inspect', { memoryId: approved.memoryId }))).status).toBe('CURRENT');

      const context = ContextQueryResult.parse(assertOk(await tool(ctx, token.accessToken, 'context_query', { goal: 'session workspace durableMemoryNeedle', terms: ['workspace'] })));
      expect(context.sourceStatus).toContainEqual(expect.objectContaining({ source: 'memory', status: 'available' }));
      expect(context.evidence.MEMORY.some((item) => item.claim === approved.claim && item.source.resource === `dodo-memory://${approved.memoryId}`)).toBe(true);

      fs.writeFileSync(path.join(ctx.fixtureDir, 'src/session.ts'), 'export const durableMemoryNeedle = "beta";\n');
      const stale = MemorySearchResult.parse(assertOk(await tool(ctx, token.accessToken, 'memory_search', { query: 'session workspace', includeStale: true })));
      expect(stale.memories.find((item) => item.memoryId === approved.memoryId)).toMatchObject({ status: 'STALE', staleReason: expect.stringContaining('hash changed') });
      const currentOnly = MemorySearchResult.parse(assertOk(await tool(ctx, token.accessToken, 'memory_search', { query: 'session workspace' })));
      expect(currentOnly.memories.some((item) => item.memoryId === approved.memoryId)).toBe(false);
      await expect(owner(ctx, 'memory.reverify', { id: approved.memoryId, digest: approved.contentHash })).rejects.toThrow();
    } finally { await ctx.cleanup(); }
  }, 120_000);

  it('requires two current successful memories before creating a separately reviewed, non-executable learning proposal', async () => {
    const ctx = await launch({ toolSurface: 'full', fixtureFiles: {
      'src/fix-a.ts': 'export const repeatedFixAlpha = true;\n',
      'src/fix-b.ts': 'export const repeatedFixBeta = true;\n',
    } });
    try {
      const token = await obtainToken(ctx, { scope: 'dodo:read dodo:write' });
      const memoryIds: string[] = [];
      for (const [term, sourcePath] of [['repeatedFixAlpha', 'src/fix-a.ts'], ['repeatedFixBeta', 'src/fix-b.ts']] as const) {
        const evidenceId = await sourceEvidence(ctx, token.accessToken, term, sourcePath);
        const receipt = MemoryProposalReceipt.parse(assertOk(await tool(ctx, token.accessToken, 'memory_propose', {
          kind: 'successful-fix', claim: `Verify ${term} before applying the repeated repair.`, rationale: 'The guarded fixture records a successful repair prerequisite.',
          affectedEntities: [term], evidenceIds: [evidenceId],
        })));
        const memory = MemoryRecord.parse(await owner(ctx, 'memory.approve', { id: receipt.proposalId, digest: receipt.digest, shareWith: [], allowConflict: false }));
        memoryIds.push(memory.memoryId);
      }
      const receipt = LearningProposalReceipt.parse(assertOk(await tool(ctx, token.accessToken, 'memory_learning_propose', {
        kind: 'workflow', title: 'Repeated repair verification', summary: 'Check both guarded prerequisites before proposing the repair.',
        steps: ['Read the affected sources.', 'Run the relevant verification recipe.'], memoryIds,
      })));
      expect(receipt).toMatchObject({ status: 'PENDING', supportingMemoryCount: 2, activated: false });
      expect((await owner(ctx, 'memory.learning.pending') as Array<{ learningId: string }>).map((item) => item.learningId)).toContain(receipt.learningId);
      const reviewed = await owner(ctx, 'memory.learning.review', { id: receipt.learningId, digest: receipt.digest, approved: true, note: 'Reviewed as a suggestion.' }) as Record<string, unknown>;
      expect(reviewed).toMatchObject({ status: 'APPROVED', activated: false });
      expect(String(reviewed['note'])).toContain('did not install');
      expect(ctx.server.services.store.recentAudit(ctx.server.workspaceId, 100)).toContainEqual(expect.objectContaining({
        principal: 'local-memory-owner', tool: 'local.memory.learning.approve', result: 'approved',
      }));
    } finally { await ctx.cleanup(); }
  }, 120_000);

  it('prunes only reviewed stale state and records the owner action without deleting current memory', async () => {
    const ctx = await launch({ toolSurface: 'full', fixtureFiles: {
      'src/current.ts': 'export const currentMemoryNeedle = true;\n',
      'src/stale.ts': 'export const staleMemoryNeedle = true;\n',
      'src/shared.ts': 'export const sharedMemoryNeedle = true;\n',
      'src/rejected.ts': 'export const rejectedMemoryNeedle = true;\n',
    } });
    try {
      const token = await obtainToken(ctx, { scope: 'dodo:read dodo:write' });
      const approve = async (term: string, sourcePath: string, entity: string) => {
        const evidenceId = await sourceEvidence(ctx, token.accessToken, term, sourcePath);
        const receipt = MemoryProposalReceipt.parse(assertOk(await tool(ctx, token.accessToken, 'memory_propose', {
          kind: 'fact', claim: `${term} remains evidence-backed.`, rationale: 'Retention fixture.', affectedEntities: [entity], evidenceIds: [evidenceId],
        })));
        return MemoryRecord.parse(await owner(ctx, 'memory.approve', { id: receipt.proposalId, digest: receipt.digest, shareWith: [], allowConflict: false }));
      };
      const current = await approve('currentMemoryNeedle', 'src/current.ts', 'current-fixture');
      const stale = await approve('staleMemoryNeedle', 'src/stale.ts', 'stale-fixture');
      const sharedFromAnotherWorkspace = await approve('sharedMemoryNeedle', 'src/shared.ts', 'shared-fixture');
      const rejectedEvidence = await sourceEvidence(ctx, token.accessToken, 'rejectedMemoryNeedle', 'src/rejected.ts');
      const rejected = MemoryProposalReceipt.parse(assertOk(await tool(ctx, token.accessToken, 'memory_propose', {
        kind: 'failure', claim: 'The rejected fixture should not become memory.', rationale: 'Owner rejection fixture.',
        affectedEntities: ['rejected-fixture'], evidenceIds: [rejectedEvidence],
      })));
      await owner(ctx, 'memory.reject', { id: rejected.proposalId, note: 'Reviewed and rejected.' });

      ctx.server.services.store.db.prepare("UPDATE memories SET status='STALE',stale_reason='test stale',last_verified_at=0 WHERE id=?").run(stale.memoryId);
      ctx.server.services.store.db.prepare("UPDATE memories SET source_workspace_id='ws_foreign_fixture',status='STALE',stale_reason='shared test stale',last_verified_at=0 WHERE id=?").run(sharedFromAnotherWorkspace.memoryId);
      ctx.server.services.store.db.prepare('UPDATE memories SET last_verified_at=0 WHERE id=?').run(current.memoryId);
      ctx.server.services.store.db.prepare('UPDATE memory_proposals SET reviewed_at=0 WHERE id=?').run(rejected.proposalId);
      const result = await owner(ctx, 'memory.prune', { olderThanDays: 0 }) as { memories: number; proposals: number; currentMemoriesDeleted: number; projectFilesDeleted: number };
      expect(result).toMatchObject({ memories: 1, proposals: 1, currentMemoriesDeleted: 0, projectFilesDeleted: 0 });
      expect(ctx.server.services.store.db.prepare('SELECT id FROM memories WHERE id=?').get(current.memoryId)).toEqual({ id: current.memoryId });
      expect(ctx.server.services.store.db.prepare('SELECT id FROM memories WHERE id=?').get(stale.memoryId)).toBeUndefined();
      expect(ctx.server.services.store.db.prepare('SELECT id FROM memories WHERE id=?').get(sharedFromAnotherWorkspace.memoryId)).toEqual({ id: sharedFromAnotherWorkspace.memoryId });
      expect(fs.readFileSync(path.join(ctx.fixtureDir, 'src/current.ts'), 'utf8')).toContain('currentMemoryNeedle');
      expect(ctx.server.services.store.recentAudit(ctx.server.workspaceId, 100)).toContainEqual(expect.objectContaining({
        principal: 'local-memory-owner', tool: 'local.memory.prune', result: 'memories:1;proposals:1;learning:0',
      }));
    } finally { await ctx.cleanup(); }
  }, 120_000);
});
