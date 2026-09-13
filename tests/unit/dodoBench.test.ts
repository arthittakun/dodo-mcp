import { describe, expect, it } from 'vitest';
import baselineJson from '../../benchmarks/dodobench-core-v1.json' with { type: 'json' };
import { DodoBenchBaseline, DodoBenchCase, type DodoBenchCaseData } from '../../src/evaluation/contracts.js';
import { evaluateDodoBench } from '../../src/evaluation/dodoBench.js';

const baseline = DodoBenchBaseline.parse(baselineJson);

function passingCases(): DodoBenchCaseData[] {
  return baseline.requiredCases.map((id, index) => DodoBenchCase.parse({
    id,
    domain: index === 0 ? 'code_retrieval'
      : index === 1 ? 'bug_diagnosis_refactor'
        : index === 2 ? 'runtime_browser_visual'
          : index === 3 ? 'resource_multimodal'
            : index === 4 ? 'recovery_memory_cache'
              : 'security_authorization',
    status: 'PASS', eligible: true, latencyMs: (index + 1) * 10, toolCalls: 2,
    serializedRequestBytes: 100, serializedResponseBytes: 200,
    humanInterventions: 0, securityViolations: 0,
    metrics: index === 0
      ? { relevantRetrieved: 2, retrieved: 2, expectedRelevant: 2 }
      : index === 1
        ? { edits: 1, wrongFileEdits: 0 }
        : index === 4
          ? { cacheHits: 1, cacheLookups: 2 }
          : {},
    notes: [],
  }));
}

describe('DodoBench deterministic evaluator', () => {
  it('passes a complete baseline and never fabricates model token usage', () => {
    const result = evaluateDodoBench(passingCases(), baseline);
    expect(result.regressions).toEqual([]);
    expect(result).toMatchObject({
      eligibleCases: 6, passedCases: 6, successRate: 1,
      wrongFileEditRate: 0, contextPrecision: 1, contextRecall: 1,
      cacheHitRate: 0.5, toolCalls: 12, modelTokens: null,
      latencyMs: { total: 210, p50: 30, p95: 60 },
    });
  });

  it('flags missing, failed and skipped required cases', () => {
    const missing = passingCases().slice(1);
    expect(evaluateDodoBench(missing, baseline).regressions).toContain(`required case missing: ${baseline.requiredCases[0]}`);
    const failed = passingCases();
    failed[1] = { ...failed[1]!, status: 'FAIL' };
    expect(evaluateDodoBench(failed, baseline).regressions).toContain(`required case did not pass: ${failed[1]!.id} (FAIL)`);
    const skipped = passingCases();
    skipped[2] = { ...skipped[2]!, status: 'SKIPPED', eligible: false };
    expect(evaluateDodoBench(skipped, baseline).regressions).toContain(`required case did not pass: ${skipped[2]!.id} (SKIPPED)`);
  });

  it('excludes optional skips and reports threshold regressions independently', () => {
    const cases = passingCases();
    cases.push(DodoBenchCase.parse({
      id: 'browser-visual', domain: 'runtime_browser_visual', status: 'SKIPPED', eligible: false,
      latencyMs: 0, toolCalls: 0, serializedRequestBytes: 0, serializedResponseBytes: 0,
      humanInterventions: 0, securityViolations: 0, metrics: {}, notes: ['Chromium unavailable'],
    }));
    cases[0] = { ...cases[0]!, securityViolations: 1, toolCalls: 100 };
    const result = evaluateDodoBench(cases, baseline);
    expect(result.skippedCases).toBe(1);
    expect(result.eligibleCases).toBe(6);
    expect(result.regressions).toEqual(expect.arrayContaining([
      expect.stringContaining('securityViolations'), expect.stringContaining('toolCalls'),
    ]));
  });

  it('rejects malformed case and baseline contracts', () => {
    expect(() => DodoBenchCase.parse({ id: 'bad', extra: true })).toThrow();
    expect(() => evaluateDodoBench(passingCases(), { ...baseline, thresholds: { ...baseline.thresholds, successRateMin: 2 } })).toThrow();
  });
});
