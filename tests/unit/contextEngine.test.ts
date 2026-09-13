import { describe, expect, it } from 'vitest';
import { ContextQueryResult, EvidenceRecord, CONTEXT_CACHE_LEVELS } from '../../src/services/context/contracts.js';
import { contextTerms } from '../../src/services/context/contextEngine.js';
import { TOOL_CATALOG } from '../../src/tools/catalog.js';
import { COMPACT_CATALOG, OPERATION_TO_GATEWAY } from '../../src/tools/surface.js';

describe('Phase 06 Context Engine contracts', () => {
  it('normalizes terms deterministically without losing Thai or identifiers', () => {
    const first = contextTerms('แก้ loginCallback ใน src/auth.ts', ['OAuth', 'loginCallback']);
    const second = contextTerms('แก้ loginCallback ใน src/auth.ts', ['OAuth', 'loginCallback']);
    expect(first).toEqual(second);
    expect(first).toEqual(expect.arrayContaining(['OAuth', 'loginCallback', 'แก้', 'src/auth.ts']));
    expect(first.filter((term) => term === 'loginCallback')).toHaveLength(1);
    expect(first.length).toBeLessThanOrEqual(12);
  });

  it('keeps all five evidence classes and seven cache levels explicit', () => {
    expect(EvidenceRecord.shape.kind.options).toEqual(['FACT', 'OBSERVATION', 'MEMORY', 'INFERENCE', 'HYPOTHESIS']);
    expect(CONTEXT_CACHE_LEVELS).toEqual(['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6']);
    expect(ContextQueryResult.shape.evidence).toBeDefined();
  });

  it('adds three full tools through the existing read gateway without changing compact size', () => {
    expect(TOOL_CATALOG.filter((tool) => tool.name.startsWith('context_')).map((tool) => tool.name)).toEqual(['context_for_task', 'context_query', 'context_evidence', 'context_status']);
    expect(COMPACT_CATALOG).toHaveLength(19);
    for (const operation of ['context_query', 'context_evidence', 'context_status']) {
      expect(OPERATION_TO_GATEWAY.get(operation)).toBe('dodo_assist_read');
    }
  });
});
