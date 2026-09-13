import { DodoBenchAggregate, DodoBenchBaseline, DodoBenchCase, type DodoBenchAggregateData, type DodoBenchBaselineData, type DodoBenchCaseData } from './contracts.js';

function ratio(numerator: number, denominator: number, empty = 1): number {
  return denominator === 0 ? empty : numerator / denominator;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))]!;
}

/** Deterministic aggregate/threshold evaluator. Timing is observed locally; no model token estimate is fabricated. */
export function evaluateDodoBench(rawCases: DodoBenchCaseData[], rawBaseline: DodoBenchBaselineData): DodoBenchAggregateData {
  const cases = rawCases.map((item) => DodoBenchCase.parse(item));
  const baseline = DodoBenchBaseline.parse(rawBaseline);
  const byId = new Map(cases.map((item) => [item.id, item]));
  const eligible = cases.filter((item) => item.eligible);
  const passed = eligible.filter((item) => item.status === 'PASS');
  const skipped = cases.filter((item) => item.status === 'SKIPPED');
  const sum = (pick: (item: DodoBenchCaseData) => number): number => eligible.reduce((total, item) => total + pick(item), 0);
  const relevant = sum((item) => item.metrics.relevantRetrieved ?? 0);
  const retrieved = sum((item) => item.metrics.retrieved ?? 0);
  const expected = sum((item) => item.metrics.expectedRelevant ?? 0);
  const edits = sum((item) => item.metrics.edits ?? 0);
  const wrongEdits = sum((item) => item.metrics.wrongFileEdits ?? 0);
  const cacheHits = sum((item) => item.metrics.cacheHits ?? 0);
  const cacheLookups = sum((item) => item.metrics.cacheLookups ?? 0);
  const aggregate = {
    eligibleCases: eligible.length,
    passedCases: passed.length,
    skippedCases: skipped.length,
    successRate: ratio(passed.length, eligible.length, 0),
    wrongFileEditRate: ratio(wrongEdits, edits, 0),
    contextPrecision: ratio(relevant, retrieved),
    contextRecall: ratio(relevant, expected),
    cacheHitRate: ratio(cacheHits, cacheLookups),
    toolCalls: sum((item) => item.toolCalls),
    serializedRequestBytes: sum((item) => item.serializedRequestBytes),
    serializedResponseBytes: sum((item) => item.serializedResponseBytes),
    modelTokens: null,
    latencyMs: { total: sum((item) => item.latencyMs), p50: percentile(eligible.map((item) => item.latencyMs), 0.5), p95: percentile(eligible.map((item) => item.latencyMs), 0.95) },
    humanInterventions: sum((item) => item.humanInterventions),
    securityViolations: sum((item) => item.securityViolations),
    regressions: [] as string[],
  };
  for (const id of baseline.requiredCases) {
    const item = byId.get(id);
    if (!item) aggregate.regressions.push(`required case missing: ${id}`);
    else if (!item.eligible || item.status !== 'PASS') aggregate.regressions.push(`required case did not pass: ${id} (${item.status})`);
  }
  const t = baseline.thresholds;
  const checks: Array<[boolean, string]> = [
    [aggregate.successRate >= t.successRateMin, `successRate ${aggregate.successRate} < ${t.successRateMin}`],
    [aggregate.wrongFileEditRate <= t.wrongFileEditRateMax, `wrongFileEditRate ${aggregate.wrongFileEditRate} > ${t.wrongFileEditRateMax}`],
    [aggregate.contextPrecision >= t.contextPrecisionMin, `contextPrecision ${aggregate.contextPrecision} < ${t.contextPrecisionMin}`],
    [aggregate.contextRecall >= t.contextRecallMin, `contextRecall ${aggregate.contextRecall} < ${t.contextRecallMin}`],
    [aggregate.cacheHitRate >= t.cacheHitRateMin, `cacheHitRate ${aggregate.cacheHitRate} < ${t.cacheHitRateMin}`],
    [aggregate.securityViolations <= t.securityViolationsMax, `securityViolations ${aggregate.securityViolations} > ${t.securityViolationsMax}`],
    [aggregate.toolCalls <= t.toolCallsMax, `toolCalls ${aggregate.toolCalls} > ${t.toolCallsMax}`],
    [aggregate.latencyMs.p95 <= t.p95LatencyMsMax, `p95 latency ${aggregate.latencyMs.p95}ms > ${t.p95LatencyMsMax}ms`],
    [aggregate.humanInterventions <= t.humanInterventionsMax, `humanInterventions ${aggregate.humanInterventions} > ${t.humanInterventionsMax}`],
  ];
  for (const [ok, message] of checks) if (!ok) aggregate.regressions.push(message);
  return DodoBenchAggregate.parse(aggregate);
}
