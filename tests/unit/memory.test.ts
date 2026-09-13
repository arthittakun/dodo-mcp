import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MemoryEvidence, MemoryKind, MemoryRecord } from '../../src/services/memory/contracts.js';
import { MEMORY_TOOLS } from '../../src/tools/memoryTools.js';
import { toolInputShape } from '../../src/tools/context.js';

describe('Phase 07 memory contracts', () => {
  it('keeps the seven memory kinds explicit and every MCP input strict', () => {
    expect(MemoryKind.options).toEqual(['fact', 'decision', 'failure', 'successful-fix', 'workaround', 'convention', 'preference']);
    expect(MEMORY_TOOLS.map((tool) => tool.name)).toEqual(['memory_search', 'memory_inspect', 'memory_status', 'memory_propose', 'memory_learning_propose']);
    for (const tool of MEMORY_TOOLS) {
      const schema = z.object(toolInputShape(tool) as z.ZodRawShape).strict();
      expect(schema.safeParse({ workspaceId: 'ws', workspaceEpoch: 'boot', unexpected: true }).success).toBe(false);
    }
  });

  it('requires current source identity and owner-reviewed evidence-only records', () => {
    expect(MemoryEvidence.safeParse({
      evidenceId: 'evidence_0123456789abcdef0123456789abcdef', projectId: null, workspaceId: 'ws', sourceKind: 'source',
      resource: 'dodo-source://ws/id', path: 'src/a.ts', hash: `sha256:${'a'.repeat(64)}`, line: 1, endLine: 1, commit: null, freshness: 'stale',
    }).success).toBe(false);
    const base = {
      schemaVersion: 1, memoryId: 'memory_0123456789ab', kind: 'fact', claim: 'claim', rationale: 'reason', affectedEntities: [],
      sourceProjectId: null, sourceWorkspaceId: 'ws', evidence: [], confidence: { score: 0.8, reasons: ['owner reviewed'] }, status: 'CURRENT', staleReason: null,
      visibleTo: [{ projectId: null, workspaceId: 'ws', displayName: 'fixture' }], conflicts: [], contentHash: `sha256:${'b'.repeat(64)}`, revision: 1,
      createdAt: 1, approvedAt: 2, lastVerifiedAt: 3, expiresAt: null, ownerReviewed: true, authority: 'evidence_only', trust: 'untrusted_content',
    };
    expect(MemoryRecord.parse(base).authority).toBe('evidence_only');
    expect(MemoryRecord.safeParse({ ...base, authority: 'permission' }).success).toBe(false);
  });
});
