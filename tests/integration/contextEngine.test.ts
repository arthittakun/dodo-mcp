import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ContextQueryResult, ContextStatus, EvidenceRecord } from '../../src/services/context/contracts.js';
import { ProjectRegistry } from '../../src/projects/registry.js';
import { callToolLegacy, launch, mkTmpDir, obtainToken, wsArgs, type TestContext } from '../helpers/testServer.js';
import { assertOk, tool } from '../helpers/multimodal.js';

const owned: string[] = [];
afterEach(() => { for (const directory of owned.splice(0)) fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3 }); });

async function buildBrain(ctx: TestContext): Promise<void> {
  const brain = ctx.server.services.brain!;
  const initial = brain.status();
  if (initial.status === 'running' && initial.activeRunId) await brain.wait(initial.activeRunId, 10_000);
  const run = await brain.start('full');
  expect((await brain.wait(run.runId, 10_000)).status).toBe('completed');
}

describe('Phase 06 Context Engine over real HTTP + OAuth', () => {
  it('returns deterministic, budgeted evidence and caller-scoped L0-L6 metrics', async () => {
    const ctx = await launch({ toolSurface: 'full', fixtureFiles: {
      'src/login.ts': 'export function loginCallback(code: string) { return `token:${code}`; }\n',
      'tests/login.test.ts': "import { loginCallback } from '../src/login.js';\ntest('login callback', () => loginCallback('x'));\n",
      'docs/AUTH.md': 'The loginCallback validates the OAuth redirect code.\n',
      '.env': 'LOGIN_PRIVATE=must-not-appear\n',
    } });
    try {
      await buildBrain(ctx);
      const token = await obtainToken(ctx, { scope: 'dodo:read' });
      const invoke = (name: string, args: Record<string, unknown> = {}) => tool(ctx, token.accessToken, name, args);
      const first = ContextQueryResult.parse(assertOk(await invoke('context_query', { goal: 'Fix login callback', terms: ['loginCallback'], budget: 12_000, maxItems: 4 })));
      expect(first.projects).toEqual([expect.objectContaining({ active: true, workspaceId: ctx.server.workspaceId })]);
      expect(first.order.length).toBeGreaterThan(0);
      expect(first.evidence.FACT.length + first.evidence.OBSERVATION.length + first.evidence.INFERENCE.length).toBe(first.order.length);
      expect(first.evidence.MEMORY).toEqual([]);
      expect(first.evidence.HYPOTHESIS).toEqual([]);
      expect(first.sourceStatus).toEqual(expect.arrayContaining([
        expect.objectContaining({ source: 'memory', status: 'unavailable' }),
        expect.objectContaining({ source: 'runtime', status: 'unavailable' }),
      ]));
      expect(JSON.stringify(first)).not.toContain('LOGIN_PRIVATE');
      const all = [...first.evidence.FACT, ...first.evidence.OBSERVATION, ...first.evidence.INFERENCE];
      expect(all.every((item) => item.source.hash.match(/^sha256:[a-f0-9]{64}$/) && item.trust === 'untrusted_content')).toBe(true);

      const baseline = ContextQueryResult.parse(assertOk(await invoke('context_query', { goal: 'loginCallback', terms: ['loginCallback'], budget: 48 * 1024, maxItems: 100 })));
      const baselinePaths = Object.values(baseline.evidence).flat().flatMap((item) => item.source.path ? [item.source.path] : []);
      const expectedPaths = ['src/login.ts', 'tests/login.test.ts', 'docs/AUTH.md'];
      const recall = expectedPaths.filter((file) => baselinePaths.includes(file)).length / expectedPaths.length;
      const precision = baselinePaths.filter((file) => expectedPaths.includes(file)).length / Math.max(1, baselinePaths.length);
      expect({ precision, recall }).toEqual({ precision: 1, recall: 1 });
      expect(baseline.metrics.quality).toMatchObject({ matchedTerms: 1, totalTerms: 1, termCoverage: 1 });
      expect(baseline.metrics.latencyMs).toBeLessThan(5000);

      const second = ContextQueryResult.parse(assertOk(await invoke('context_query', { goal: 'Fix login callback', terms: ['loginCallback'], budget: 12_000, maxItems: 4 })));
      expect(second.cache).toMatchObject({ hit: true, hitLevel: 'L6' });
      expect(second.order).toEqual(first.order);
      expect(second.evidence.FACT.map((item) => item.ranking)).toEqual(first.evidence.FACT.map((item) => item.ranking));

      const page = ContextQueryResult.parse(assertOk(await invoke('context_query', { goal: 'Fix login callback', terms: ['loginCallback'], budget: 4096, maxItems: 1 })));
      expect(page.order).toHaveLength(1);
      if (page.nextCursor) {
        const next = ContextQueryResult.parse(assertOk(await invoke('context_query', { goal: 'Fix login callback', terms: ['loginCallback'], budget: 4096, maxItems: 1, cursor: page.nextCursor })));
        expect(next.order[0]).not.toBe(page.order[0]);
      }
      const status = ContextStatus.parse(assertOk(await invoke('context_status')));
      expect(status.cache.levels.map((entry) => entry.level)).toEqual(['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6']);
      expect(status.metrics.queries).toBeGreaterThanOrEqual(3);
      expect(status.metrics.cacheHits).toBeGreaterThanOrEqual(1);
      expect(status.metrics.lastTermCoverage).toBeGreaterThanOrEqual(0);
      const overview = await callToolLegacy(ctx, token.accessToken, 'project_overview', {});
      expect((overview.envelope.data as { contextEngine: { available: boolean } }).contextEngine.available).toBe(true);
    } finally { await ctx.cleanup(); }
  }, 120_000);

  it('marks prior evidence stale and rebuilds from the changed guarded source', async () => {
    const ctx = await launch({ toolSurface: 'full', fixtureFiles: { 'src/state.ts': 'export const phaseSixState = "alpha";\n' } });
    try {
      await buildBrain(ctx);
      const token = await obtainToken(ctx, { scope: 'dodo:read' });
      const invoke = (name: string, args: Record<string, unknown> = {}) => tool(ctx, token.accessToken, name, args);
      const first = ContextQueryResult.parse(assertOk(await invoke('context_query', { goal: 'phaseSixState alpha', terms: ['phaseSixState'], maxItems: 20 })));
      const source = [...first.evidence.FACT, ...first.evidence.OBSERVATION].find((item) => item.source.path === 'src/state.ts')!;
      expect(source).toBeDefined();
      fs.writeFileSync(path.join(ctx.fixtureDir, 'src/state.ts'), 'export const phaseSixState = "beta";\n');
      const refreshed = ContextQueryResult.parse(assertOk(await invoke('context_query', { goal: 'phaseSixState alpha', terms: ['phaseSixState'], maxItems: 20 })));
      expect(refreshed.cache.hit).toBe(false);
      expect(refreshed.freshnessTransitions.map((item) => item.evidenceId)).toContain(source.evidenceId);
      const stale = EvidenceRecord.parse(assertOk(await invoke('context_evidence', { evidenceId: source.evidenceId })));
      expect(stale.freshness).toBe('stale');
      const current = [...refreshed.evidence.FACT, ...refreshed.evidence.OBSERVATION].find((item) => item.source.path === 'src/state.ts');
      expect(current?.source.hash).not.toBe(source.source.hash);

      const absent = ContextQueryResult.parse(assertOk(await invoke('context_query', { goal: 'newlyIntroducedContextMarker', terms: ['newlyIntroducedContextMarker'] })));
      expect(absent.order).toEqual([]);
      fs.writeFileSync(path.join(ctx.fixtureDir, 'src/new.ts'), 'export const newlyIntroducedContextMarker = true;\n');
      const added = ContextQueryResult.parse(assertOk(await invoke('context_query', { goal: 'newlyIntroducedContextMarker', terms: ['newlyIntroducedContextMarker'] })));
      expect(added.cache.hit).toBe(false);
      expect(added.evidence.OBSERVATION.some((item) => item.source.path === 'src/new.ts')).toBe(true);
    } finally { await ctx.cleanup(); }
  }, 120_000);

  it('retrieves across authorized project names and reports unavailable sources as partial', async () => {
    const rootA = mkTmpDir('dodo-context-a-');
    const rootB = mkTmpDir('dodo-context-b-');
    owned.push(rootA, rootB);
    fs.writeFileSync(path.join(rootA, 'frontend.ts'), 'export const sharedContextNeedle = "frontend";\n');
    fs.writeFileSync(path.join(rootB, 'backend.ts'), 'export const sharedContextNeedle = "backend";\n');
    const ctx = await launch({ fixtureDir: rootA, toolSurface: 'compact' });
    owned.push(ctx.configDir);
    try {
      const token = await obtainToken(ctx, { scope: 'dodo:read' });
      const registry = new ProjectRegistry(ctx.server.services.store);
      const frontend = registry.add(rootA, 'Frontend').project;
      const backend = registry.add(rootB, 'Backend').project;
      ctx.server.services.store.setClientAccess(backend.workspaceId, token.clientId, ['dodo:read']);
      const query = ContextQueryResult.parse(assertOk(await tool(ctx, token.accessToken, 'dodo_assist_read', {
        operation: 'context_query', args: { goal: 'shared context', terms: ['sharedContextNeedle'], projects: ['Frontend', 'Backend'], maxItems: 20 },
      })));
      expect(query.projects.map((project) => project.workspaceId).sort()).toEqual([frontend.workspaceId, backend.workspaceId].sort());
      const observed = query.evidence.OBSERVATION.filter((item) => item.source.path?.endsWith('.ts'));
      expect(new Set(observed.map((item) => item.project.workspaceId))).toEqual(new Set([frontend.workspaceId, backend.workspaceId]));
      expect(ctx.server.workspaceId).toBe(frontend.workspaceId);

      fs.rmSync(rootB, { recursive: true });
      const partial = ContextQueryResult.parse(assertOk(await tool(ctx, token.accessToken, 'dodo_assist_read', {
        ...wsArgs(ctx), operation: 'context_query', args: { goal: 'new unavailable query', terms: ['sharedContextNeedle'], projects: ['Frontend', 'Backend'] },
      })));
      expect(partial.partial).toBe(true);
      expect(partial.limitations.join(' ')).toContain('Backend');
    } finally { await ctx.cleanup(); }
  }, 120_000);
});
