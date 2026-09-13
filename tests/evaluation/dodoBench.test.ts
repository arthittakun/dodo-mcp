import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import baselineJson from '../../benchmarks/dodobench-core-v1.json' with { type: 'json' };
import { DodoBenchBaseline, DodoBenchCase, DodoBenchReport, type DodoBenchCaseData } from '../../src/evaluation/contracts.js';
import { evaluateDodoBench } from '../../src/evaluation/dodoBench.js';
import { ProjectRegistry } from '../../src/projects/registry.js';
import { ContextQueryResult } from '../../src/services/context/contracts.js';
import { AgentRun } from '../../src/services/agent/contracts.js';
import { RuntimeDiagnosis, RuntimeSession } from '../../src/services/runtime/contracts.js';
import { ResourceInfo, ResourcePreview } from '../../src/services/resources/contracts.js';
import { launch, mcpRaw, obtainToken, rpc } from '../helpers/testServer.js';
import { assertOk, blocks, BROWSER_FIXTURE, tool } from '../helpers/multimodal.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const baseline = DodoBenchBaseline.parse(baselineJson);

function sha256(bytes: string | Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function safeNote(error: unknown, roots: string[]): string {
  let note = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  for (const root of roots) note = note.replaceAll(root, '<fixture>');
  return note.replace(/Bearer\s+\S+/gi, 'Bearer <redacted>').slice(0, 500);
}

interface CaseStats { started: number; calls: number; requestBytes: number; responseBytes: number }
function stats(): CaseStats { return { started: Date.now(), calls: 0, requestBytes: 0, responseBytes: 0 }; }
class SecurityViolationError extends Error {
  constructor(readonly count: number) { super(`${count} security boundary assertion(s) unexpectedly accepted`); }
}

describe('DodoBench core dataset over real HTTP + OAuth', () => {
  it('runs isolated capability and security fixtures and writes a revision-bound report', async () => {
    const roots: string[] = [];
    let ctx = await launch({ toolSurface: 'compact', trust: 'trusted', fixtureFiles: {
      'src/alpha.ts': 'export function dodoBenchNeedle() { return "alpha"; }\n',
      'src/distractor.ts': 'export const untouched = true;\n',
      'report.json': JSON.stringify({ success: true, numTotalTests: 2, numPassedTests: 2, numFailedTests: 0, numPendingTests: 0 }),
      '.env': 'DODO_BENCH_SECRET=never-report-this\n',
      'index.html': BROWSER_FIXTURE,
    } });
    roots.push(ctx.fixtureDir, ctx.configDir);
    const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'dodo-bench-b-'));
    roots.push(rootB);
    fs.writeFileSync(path.join(rootB, 'beta.ts'), 'export const dodoBenchNeedle = "beta";\n');
    fs.writeFileSync(path.join(ctx.fixtureDir, 'picture.png'), await sharp({ create: { width: 96, height: 64, channels: 3, background: '#345678' } }).png().toBuffer());
    const token = await obtainToken(ctx);
    const registry = new ProjectRegistry(ctx.server.services.store);
    const projectA = registry.add(ctx.fixtureDir, 'Bench A').project;
    const projectB = registry.add(rootB, 'Bench B').project;
    ctx.server.services.store.setClientAccess(projectB.workspaceId, token.clientId, ['dodo:read']);
    const cases: DodoBenchCaseData[] = [];

    const measured = async (s: CaseStats, gateway: string, operation: string, args: Record<string, unknown> = {}, accessToken = token.accessToken) => {
      const request = { gateway, operation, args };
      s.calls += 1; s.requestBytes += jsonBytes(request);
      const result = await tool(ctx, accessToken, gateway, { operation, args });
      s.responseBytes += jsonBytes(result.raw);
      return result;
    };
    const record = async (
      id: string, domain: DodoBenchCaseData['domain'],
      work: (s: CaseStats) => Promise<Partial<DodoBenchCaseData['metrics']>>,
    ) => {
      const s = stats();
      try {
        const metrics = await work(s);
        cases.push(DodoBenchCase.parse({ id, domain, status: 'PASS', eligible: true, latencyMs: Date.now() - s.started,
          toolCalls: s.calls, serializedRequestBytes: s.requestBytes, serializedResponseBytes: s.responseBytes,
          humanInterventions: 0, securityViolations: 0, metrics, notes: [] }));
      } catch (error) {
        cases.push(DodoBenchCase.parse({ id, domain, status: 'FAIL', eligible: true, latencyMs: Date.now() - s.started,
          toolCalls: s.calls, serializedRequestBytes: s.requestBytes, serializedResponseBytes: s.responseBytes,
          humanInterventions: 0, securityViolations: error instanceof SecurityViolationError ? error.count : 0,
          metrics: {}, notes: [safeNote(error, roots)] }));
      }
    };

    try {
      await record('retrieval-cross-project', 'code_retrieval', async (s) => {
        const args = { goal: 'find dodoBenchNeedle in both projects', terms: ['dodoBenchNeedle'], projects: [projectA.projectId, projectB.projectId], maxItems: 20 };
        const first = ContextQueryResult.parse(assertOk(await measured(s, 'dodo_assist_read', 'context_query', args)));
        const second = ContextQueryResult.parse(assertOk(await measured(s, 'dodo_assist_read', 'context_query', args)));
        expect(second.cache.hit).toBe(true);
        const expected = new Set(['src/alpha.ts', 'beta.ts']);
        const retrieved = new Set(Object.values(first.evidence).flat().flatMap((item) => item.source.path ? [item.source.path] : []).filter((item) => item.endsWith('.ts')));
        const relevant = [...retrieved].filter((item) => expected.has(item)).length;
        expect(relevant).toBe(2);
        return { relevantRetrieved: relevant, retrieved: retrieved.size, expectedRelevant: expected.size, cacheHits: 1, cacheLookups: 2 };
      });

      await record('diagnosis-refactor-safety', 'bug_diagnosis_refactor', async (s) => {
        const distractorBefore = sha256(fs.readFileSync(path.join(ctx.fixtureDir, 'src/distractor.ts')));
        const read = assertOk(await measured(s, 'dodo_read', 'read_files', { files: [{ path: 'src/alpha.ts' }] })) as { files: Array<{ hash: string; content: string }> };
        const current = read.files[0]!;
        assertOk(await measured(s, 'dodo_assist_read', 'analyze_impact', { files: ['src/alpha.ts'] }));
        assertOk(await measured(s, 'dodo_write', 'edit_file', { path: 'src/alpha.ts', expectedHash: current.hash, edits: [{ find: 'return "alpha"', replace: 'return "fixed"' }] }));
        const after = assertOk(await measured(s, 'dodo_read', 'read_files', { files: [{ path: 'src/alpha.ts' }] })) as { files: Array<{ content: string }> };
        expect(after.files[0]?.content).toContain('return "fixed"');
        expect(sha256(fs.readFileSync(path.join(ctx.fixtureDir, 'src/distractor.ts')))).toBe(distractorBefore);
        return { edits: 1, wrongFileEdits: 0 };
      });

      await record('runtime-debugging', 'runtime_browser_visual', async (s) => {
        const session = RuntimeSession.parse(assertOk(await measured(s, 'dodo_assist_change', 'runtime_session_open', { label: 'DodoBench runtime' })));
        const started = assertOk(await measured(s, 'dodo_exec', 'runtime_task_start', {
          sessionId: session.sessionId, kind: 'test', program: 'node', args: ['-e', 'process.exit(0)'], idempotencyKey: 'dodobench-runtime-001',
        })) as { task: { taskId: string; jobId: string } };
        assertOk(await measured(s, 'dodo_read', 'job_wait', { jobId: started.task.jobId, waitMs: 10_000 }));
        const observed = assertOk(await measured(s, 'dodo_assist_read', 'runtime_task_observe', { sessionId: session.sessionId, taskId: started.task.taskId, reportPath: 'report.json' })) as { evidence: { evidenceId: string }; task: { exitCode: number } };
        expect(observed.task.exitCode).toBe(0);
        const diagnosis = RuntimeDiagnosis.parse(assertOk(await measured(s, 'dodo_assist_read', 'runtime_diagnose', { sessionId: session.sessionId, evidenceIds: [observed.evidence.evidenceId] })));
        expect(diagnosis.facts.length).toBeGreaterThan(0);
        return {};
      });

      await record('resource-multimodal', 'resource_multimodal', async (s) => {
        const resource = ResourceInfo.parse(assertOk(await measured(s, 'dodo_media', 'resource_inspect', { path: 'picture.png', expectedMimeType: 'image/png' })));
        const previewCall = await measured(s, 'dodo_media', 'resource_preview', { resourceId: resource.resourceId, maxEdge: 64, expectedSha256: resource.sha256 });
        const preview = ResourcePreview.parse(assertOk(previewCall));
        expect(preview.previewKind).toBe('image');
        expect(blocks(previewCall).some((block) => block.type === 'image')).toBe(true);
        return {};
      });

      let durableRunId = '';
      await record('recovery-memory-cache', 'recovery_memory_cache', async (s) => {
        const run = AgentRun.parse(assertOk(await measured(s, 'dodo_assist_change', 'agent_run_open', {
          goal: 'Verify durable benchmark recovery', completionCriteria: ['run remains reconnectable'],
          capabilities: { allowedProjectIds: [], writablePaths: [], allowedPrograms: [], allowNetwork: false, allowBrowser: false, allowDesktop: false, allowMedia: false, allowWorkflow: false, secretAccess: false, maxHypotheses: 1, maxActions: 10, maxRunningJobs: 1, maxWallMinutes: 10 },
        })));
        durableRunId = run.runId;
        const saved = { fixtureDir: ctx.fixtureDir, configDir: ctx.configDir, port: ctx.port };
        await ctx.cleanup();
        ctx = await launch({ ...saved, toolSurface: 'compact', trust: 'trusted' });
        const status = assertOk(await measured(s, 'dodo_assist_read', 'agent_run_status', { runId: durableRunId })) as { run: { runId: string; status: string } };
        expect(status.run.runId).toBe(durableRunId);
        expect(['ACTIVE', 'RECOVERY_REQUIRED']).toContain(status.run.status);
        if (status.run.status === 'RECOVERY_REQUIRED') {
          const recovered = assertOk(await measured(s, 'dodo_assist_change', 'agent_run_control', { runId: durableRunId, action: 'recover' })) as { run: { status: string } };
          expect(recovered.run.status).toBe('ACTIVE');
        }
        return { cacheHits: 1, cacheLookups: 2 };
      });

      await record('security-authorization', 'security_authorization', async (s) => {
        let violations = 0;
        s.calls += 1; s.requestBytes += jsonBytes({ method: 'tools/list', anonymous: true });
        const anonymous = await mcpRaw(ctx, rpc('tools/list'));
        s.responseBytes += Number(anonymous.headers.get('content-length') ?? 0);
        if (anonymous.status !== 401) violations += 1;
        const reader = await obtainToken(ctx, { scope: 'dodo:read' });
        const write = await measured(s, 'dodo_write', 'write_file', { path: 'forbidden.txt', content: 'no' }, reader.accessToken);
        if ((write.envelope.error as { code?: string } | null)?.code !== 'FORBIDDEN') violations += 1;
        const secret = await measured(s, 'dodo_media', 'resource_inspect', { path: '.env' });
        if ((secret.envelope.error as { code?: string } | null)?.code !== 'SECRET_PATH_DENIED') violations += 1;
        s.calls += 1;
        const staleArgs = { workspaceId: ctx.server.workspaceId, workspaceEpoch: 'stale-benchmark-epoch', operation: 'read_files', args: { files: [{ path: 'src/alpha.ts' }] } };
        s.requestBytes += jsonBytes(staleArgs);
        const stale = await tool(ctx, token.accessToken, 'dodo_read', staleArgs);
        s.responseBytes += jsonBytes(stale.raw);
        if ((stale.envelope.error as { code?: string } | null)?.code !== 'STALE_WORKSPACE') violations += 1;

        const inspect = await launch({ toolSurface: 'compact', trust: 'inspect', fixtureFiles: { 'safe.txt': 'safe\n' } });
        roots.push(inspect.fixtureDir, inspect.configDir);
        try {
          const inspectToken = await obtainToken(inspect);
          s.calls += 1;
          const approvalArgs = { operation: 'write_file', args: { path: 'pending.txt', content: 'pending\n' } };
          s.requestBytes += jsonBytes(approvalArgs);
          const approval = await tool(inspect, inspectToken.accessToken, 'dodo_write', approvalArgs);
          s.responseBytes += jsonBytes(approval.raw);
          if ((approval.envelope.error as { code?: string } | null)?.code !== 'APPROVAL_REQUIRED') violations += 1;
        } finally { await inspect.cleanup(); }
        if (violations > 0) throw new SecurityViolationError(violations);
        return {};
      });

      if (!fs.existsSync(chromium.executablePath())) {
        cases.push(DodoBenchCase.parse({ id: 'browser-visual', domain: 'runtime_browser_visual', status: 'SKIPPED', eligible: false,
          latencyMs: 0, toolCalls: 0, serializedRequestBytes: 0, serializedResponseBytes: 0,
          humanInterventions: 0, securityViolations: 0, metrics: {}, notes: ['Playwright Chromium is not installed on this host.'] }));
      } else {
        await record('browser-visual', 'runtime_browser_visual', async (s) => {
          const opened = assertOk(await measured(s, 'dodo_browser', 'browser_session', { source: 'workspace', path: 'index.html', idempotencyKey: 'dodobench-browser-open-001' })) as { sessionId: string; observation: { text: string } };
          expect(opened.observation.text).toContain('Ready');
          const observed = await measured(s, 'dodo_browser', 'browser_observe', { sessionId: opened.sessionId });
          expect(blocks(observed).some((block) => block.type === 'image')).toBe(true);
          assertOk(await measured(s, 'dodo_browser', 'browser_session', { mode: 'close', sessionId: opened.sessionId, idempotencyKey: 'dodobench-browser-close-001' }));
          return {};
        });
      }

      const aggregate = evaluateDodoBench(cases, baseline);
      const datasetText = fs.readFileSync(path.join(ROOT, 'benchmarks/dodobench-core-v1.json'));
      const report = DodoBenchReport.parse({
        schemaVersion: 1, status: aggregate.regressions.length === 0 ? 'PASS' : 'FAIL', generatedAt: new Date().toISOString(),
        source: {
          revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
          dirty: execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim().length > 0,
        },
        dataset: { ...baseline.dataset, digest: sha256(datasetText) },
        environment: { platform: process.platform, arch: process.arch, release: os.release(), node: process.version,
          dependencyLockSha256: sha256(fs.readFileSync(path.join(ROOT, 'package-lock.json'))),
          configurationSha256: sha256(JSON.stringify({ surface: 'compact', network: false, externalServices: false })) },
        client: { name: 'dodo-bench-vitest', version: '1' },
        model: { name: null, version: null, note: 'No model was invoked; modelTokens is null rather than estimated.' },
        cases, aggregate,
        limitations: ['Fixture latency is local-host evidence, not a production SLA.', 'Optional browser evidence depends on the locally installed Playwright Chromium.', 'External AI clients and Windows hardware are separate manual/platform gates.'],
      });
      const output = process.env['DODO_BENCH_OUTPUT'];
      if (output) { fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true }); fs.writeFileSync(path.resolve(output), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 }); }
      expect(report.status, report.aggregate.regressions.join('\n')).toBe('PASS');
      expect(report.aggregate.modelTokens).toBeNull();
    } finally {
      await ctx.cleanup().catch(() => undefined);
      for (const root of [...new Set(roots)]) fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    }
  }, 300_000);
});
