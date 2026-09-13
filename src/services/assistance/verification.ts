import { z } from 'zod';
import { DodoError } from '../../errors.js';
import type { AppServices, ToolCtx } from '../../tools/context.js';
import { policyGate } from '../../tools/context.js';
import { withIdempotency } from '../../tools/changeTools.js';
import { validateExecArgs } from '../jobs/commandInput.js';
import { digestOf, newId, sha256Bytes } from '../../util/hash.js';
import { HashSchema, RecipeSchema } from './contracts.js';

const Count = z.number().int().nonnegative();
const SnapshotSchema = z.object({
  digest: HashSchema, entries: z.array(z.tuple([z.string(), HashSchema.nullable()])),
  complete: z.boolean(), skipped: Count, capturedAt: z.number(),
});
type Snapshot = z.infer<typeof SnapshotSchema>;
const StoredCheck = z.object({ taskId: z.string(), recipeDigest: z.string(), title: z.string(), jobId: z.string().nullable(), errorCode: z.string().nullable() });
const RecordSchema = z.object({
  id: z.string(), workspaceId: z.string(), epoch: z.string(), principal: z.string(),
  files: z.array(z.string()), baseline: SnapshotSchema, checks: z.array(StoredCheck),
  observedDrift: z.boolean(), nodeVersion: z.string(), platform: z.string(), createdAt: z.number(),
});
type VerificationRecord = z.infer<typeof RecordSchema>;
export const TestSummarySchema = z.object({
  source: z.enum(['json', 'text-summary', 'not_available']),
  total: Count.nullable(), passed: Count.nullable(), failed: Count.nullable(), skipped: Count.nullable(),
  failures: z.array(z.string()),
});
type TestSummary = z.infer<typeof TestSummarySchema>;
export const VerificationSchema = z.object({
  mode: z.enum(['plan', 'run', 'report']), verificationId: z.string().nullable(),
  status: z.enum(['not_run', 'running', 'passed', 'failed', 'stale', 'incomplete']),
  files: z.array(z.string()), recommendedTasks: z.array(RecipeSchema),
  checks: z.array(z.object({
    taskId: z.string(), jobId: z.string().nullable(), status: z.string(),
    exitCode: z.number().nullable(), commandPassed: z.boolean(), tests: TestSummarySchema,
    environmentHint: z.string().nullable(), outputTruncated: z.boolean(), errorCode: z.string().nullable(),
  })),
  freshness: z.object({
    baselineDigest: HashSchema, currentDigest: HashSchema, matchesBaseline: z.boolean(),
    complete: z.boolean(), monitoredFiles: Count, skippedFiles: Count, changedPaths: z.array(z.string()),
    changedPathsTruncated: z.boolean(), checkedAt: z.number(), scope: z.literal('guarded_nonignored_workspace_before_and_report'),
  }),
  notRun: z.array(z.string()), notes: z.array(z.string()), replayed: z.boolean(),
});
export type VerificationResult = z.infer<typeof VerificationSchema>;
export interface VerifyInput {
  mode: 'plan' | 'run' | 'report'; files: string[];
  tasks: Array<{ taskId: string; recipeDigest: string }>;
  sourceDigest?: string | undefined; verificationId?: string | undefined; idempotencyKey?: string | undefined;
  timeoutMs: number; waitMs: number;
}

/** Hash source/configuration without executing it. Ignored files and secrets are NOT read. */
export function captureSnapshot(s: AppServices, targets: string[]): Snapshot {
  const entries = new Map<string, string | null>();
  let bytes = 0, skipped = 0, complete = true;
  const maxFiles = Math.min(2000, s.limits.semanticFilesMax);
  const perFile = Math.min(s.limits.readFileBytes, 2 * 1024 * 1024);
  function add(file: string, explicit: boolean): void {
    const normal = s.wfs.normalizeRel(file);
    if (entries.has(normal)) return;
    try {
      const p = s.wfs.resolve(normal, { allowMissing: true });
      if (!p.stat) { if (explicit) entries.set(normal, null); return; }
      s.wfs.assertRegularFileForDirectAccess(p);
      if (entries.size >= maxFiles || p.stat.size > perFile || bytes + p.stat.size > 32 * 1024 * 1024) {
        complete = false; skipped++; return;
      }
      const result = s.wfs.readFileBytes(normal, perFile);
      bytes += result.bytes.length;
      entries.set(normal, sha256Bytes(result.bytes));
    } catch (err) {
      if (explicit) throw err;
      complete = false; skipped++;
    }
  }
  for (const file of targets) add(file, true);
  let count = 0;
  for (const item of s.wfs.walk({ maxEntries: maxFiles + 1, maxDepth: 64 })) {
    if (++count > maxFiles) { complete = false; skipped++; break; }
    if (item.depth >= 64) complete = false;
    add(item.rel, false);
  }
  const sorted = [...entries].sort((a, b) => a[0].localeCompare(b[0]));
  return { digest: digestOf(sorted), entries: sorted, complete, skipped, capturedAt: Date.now() };
}
export function summarizeTests(text: string): TestSummary {
  const empty: TestSummary = { source: 'not_available', total: null, passed: null, failed: null, skipped: null, failures: [] };
  // ANSI only affects display. No executable/log contents are interpreted as instructions.
  const plain = text.replace(/\u001b\[[0-9;]*m/g, '');
  const start = plain.indexOf('{'), end = plain.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const parsed = z.object({
        numTotalTests: Count, numPassedTests: Count, numFailedTests: Count,
        numPendingTests: Count.optional(), numTodoTests: Count.optional(),
        testResults: z.array(z.object({ assertionResults: z.array(z.object({
          fullName: z.string().optional(), status: z.string(), failureMessages: z.array(z.string()).optional(),
        })).optional() })).optional(),
      }).parse(JSON.parse(plain.slice(start, end + 1)));
      const skipped = (parsed.numPendingTests ?? 0) + (parsed.numTodoTests ?? 0);
      if (parsed.numPassedTests + parsed.numFailedTests + skipped > parsed.numTotalTests) return empty;
      return { source: 'json', total: parsed.numTotalTests, passed: parsed.numPassedTests, failed: parsed.numFailedTests, skipped,
        failures: (parsed.testResults ?? []).flatMap(r => r.assertionResults ?? []).filter(r => r.status === 'failed').slice(0, 5).map(r => `${r.fullName ?? 'test'}: ${(r.failureMessages ?? []).join(' ')}`.slice(0, 500)),
      };
    } catch { /* unrecognized/truncated JSON is not test evidence */ }
  }
  if (/no test (?:files? )?found|no tests collected/i.test(plain)) return { ...empty, source: 'text-summary', total: 0, passed: 0, failed: 0, skipped: 0 };
  const lines = plain.split('\n').filter(line => /^\s*Tests\s+/.test(line));
  const line = lines.at(-1);
  if (line) {
    const count = (label: string): number => Number(new RegExp(`(\\d+) ${label}`).exec(line)?.[1] ?? 0);
    const passed = count('passed'), failed = count('failed'), skipped = count('skipped') + count('todo');
    if (passed + failed + skipped > 0) return { ...empty, source: 'text-summary', total: passed + failed + skipped, passed, failed, skipped };
  }
  return empty;
}
function recordKey(id: string): string { return `assistance:verification:${id}`; }
function save(s: AppServices, record: VerificationRecord): void { s.store.setMeta(recordKey(record.id), JSON.stringify(record)); }
function load(ctx: ToolCtx, id: string): VerificationRecord {
  const raw = ctx.services.store.getMeta(recordKey(id));
  const parsed = raw ? RecordSchema.safeParse(JSON.parse(raw)) : null;
  if (!parsed?.success || parsed.data.workspaceId !== ctx.services.workspaceId || parsed.data.principal !== ctx.principal.grantId) {
    throw new DodoError('NOT_FOUND', 'unknown verificationId for this workspace and principal');
  }
  return parsed.data;
}
function recommendations(s: AppServices) {
  return s.overview.discoverTasks(s.projectConfig)
    .filter(r => /(?:^|:)(?:typecheck|lint|test(?::[\w.-]+)?|build|check|clippy|vet|pytest|ruff|mypy)$/.test(r.id))
    .slice(0, 20).map(r => ({ taskId: r.id, recipeDigest: r.recipeDigest, title: r.title }));
}
const NOTES = [
  'Commands inherit the existing exec approval and sandbox configuration. This tool never relaxes it.',
  'Freshness compares guarded source/config bytes before launch and when reporting, not an immutable or continuously watched snapshot.',
  'Ignored files, dependencies, OS/environment changes, and edits reverted between checks are not proven unchanged.',
  'Test counts are runner-reported evidence, not a guarantee of correctness. Full logs remain available through job_output.',
  'Text counts describe the last recognized runner summary, not the sum of nested scripts; JSON is preferred.',
];
function render(ctx: ToolCtx, record: VerificationRecord, mode: VerifyInput['mode'], replayed: boolean): VerificationResult {
  const s = ctx.services, current = captureSnapshot(s, record.files);
  const before = new Map(record.baseline.entries), after = new Map(current.entries);
  const changedPaths = [...new Set([...before.keys(), ...after.keys()])].filter(p => before.get(p) !== after.get(p)).sort();
  const sameRuntime = record.epoch === s.epoch && record.nodeVersion === process.version;
  const matches = current.digest === record.baseline.digest && !record.observedDrift && sameRuntime;
  if (changedPaths.length && !record.observedDrift) { record.observedDrift = true; save(s, record); }
  const checks: VerificationResult['checks'] = record.checks.map(check => {
    if (!check.jobId) return { taskId: check.taskId, jobId: null, status: 'not_started', exitCode: null, commandPassed: false,
      tests: summarizeTests(''), environmentHint: null, outputTruncated: false, errorCode: check.errorCode };
    const job = s.jobs.getJobChecked(check.jobId, s.workspaceId);
    const out = s.jobs.inlineOutput(check.jobId, s.workspaceId, 'stdout', 24000);
    const err = s.jobs.inlineOutput(check.jobId, s.workspaceId, 'stderr', 8000);
    const text = `${out.content}\n${out.tail ?? ''}\n${err.content}\n${err.tail ?? ''}`;
    const environmentHint = /\b(?:EPERM|EACCES|EADDRINUSE|ENOENT)\b/.exec(text)?.[0] ?? null;
    return { taskId: check.taskId, jobId: check.jobId, status: job.status, exitCode: job.exitCode,
      commandPassed: job.status === 'exited' && job.exitCode === 0,
      tests: summarizeTests(text), environmentHint,
      outputTruncated: out.truncated || err.truncated, errorCode: check.errorCode };
  });
  let status: VerificationResult['status'] = 'passed';
  if (!checks.length) status = 'not_run';
  else if (checks.some(c => c.status === 'running')) status = 'running';
  else if (checks.some(c => !c.commandPassed || (c.tests.failed ?? 0) > 0)) status = 'failed';
  else if (!matches) status = 'stale';
  else if (!record.baseline.complete || !current.complete || checks.some(c => /test|pytest/.test(c.taskId) && (c.tests.total === null || c.tests.total === 0 || (c.tests.passed ?? 0) + (c.tests.failed ?? 0) === 0))) status = 'incomplete';
  const recommended = recommendations(s);
  return {
    mode, verificationId: mode === 'plan' ? null : record.id, status, files: record.files, checks,
    recommendedTasks: recommended,
    freshness: { baselineDigest: record.baseline.digest, currentDigest: current.digest, matchesBaseline: matches,
      complete: current.complete && record.baseline.complete, monitoredFiles: record.baseline.entries.length,
      skippedFiles: Math.max(current.skipped, record.baseline.skipped), changedPaths: changedPaths.slice(0, 50),
      changedPathsTruncated: changedPaths.length > 50, checkedAt: current.capturedAt, scope: 'guarded_nonignored_workspace_before_and_report' },
    notRun: recommended.filter(r => !checks.some(c => c.taskId === r.taskId && c.status !== 'not_started')).map(r => r.taskId),
    notes: [...NOTES, ...(!sameRuntime ? ['Runtime restarted/switched since launch; evidence freshness is not established.'] : [])], replayed,
  };
}
export async function verifyChanges(ctx: ToolCtx, args: VerifyInput): Promise<VerificationResult> {
  const s = ctx.services;
  if (args.mode === 'report') {
    if (!args.verificationId) throw new DodoError('INVALID_INPUT', 'report needs verificationId');
    return render(ctx, load(ctx, args.verificationId), 'report', false);
  }
  if (args.verificationId) throw new DodoError('INVALID_INPUT', 'verificationId is only used for report');
  const files = [...new Set(args.files.map(file => s.wfs.normalizeRel(file)))];
  if (args.mode === 'plan') {
    if (args.tasks.length) throw new DodoError('INVALID_INPUT', 'plan only discovers recipes; choose tasks in run');
    const baseline = captureSnapshot(s, files);
    return render(ctx, { id: '', workspaceId: s.workspaceId, epoch: s.epoch, principal: ctx.principal.grantId,
      files, baseline, checks: [], observedDrift: false, nodeVersion: process.version, platform: process.platform, createdAt: Date.now() }, 'plan', false);
  }
  if (!args.tasks.length || !args.idempotencyKey || !args.sourceDigest) throw new DodoError('INVALID_INPUT', 'run needs tasks, idempotencyKey and sourceDigest from plan.freshness.baselineDigest');
  if (new Set(args.tasks.map(t => t.taskId)).size !== args.tasks.length) throw new DodoError('INVALID_INPUT', 'duplicate verification task');
  const recipes = s.overview.discoverTasks(s.projectConfig);
  const selected = args.tasks.map(task => {
    const recipe = recipes.find(r => r.id === task.taskId);
    if (!recipe) throw new DodoError('NOT_FOUND', 'unknown verification task; request plan again');
    if (recipe.recipeDigest !== task.recipeDigest) throw new DodoError('CONFLICT', 'recipe changed; request plan again');
    validateExecArgs(recipe.program, recipe.args);
    const cwd = s.wfs.resolve(recipe.cwd);
    if (!cwd.stat?.isDirectory()) throw new DodoError('PATH_DENIED', 'task cwd must be a workspace directory');
    s.jobs.resolveProgram(recipe.program, cwd.abs);
    return recipe;
  });
  const payload = { files, tasks: args.tasks, sourceDigest: args.sourceDigest, timeoutMs: args.timeoutMs };
  // Same existing policy gate as run_task, with the exact selected batch bound into approval.
  policyGate(ctx, { tool: 'verify_changes', action: 'exec', approvalAction: payload, summary: `verify: ${selected.map(t => t.id).join(', ')}` });
  const { result, replayed } = await withIdempotency(ctx, 'verify_changes', args.idempotencyKey, payload, async () => {
    if (s.jobs.runningCount() + selected.length > s.limits.jobsConcurrentMax) throw new DodoError('RESOURCE_LIMIT', 'not enough free job slots; select fewer tasks or wait for current jobs');
    const baseline = captureSnapshot(s, files);
    if (baseline.digest !== args.sourceDigest) throw new DodoError('FILE_CHANGED', 'source changed since verification plan; request plan again');
    const record: VerificationRecord = { id: newId('verify'), workspaceId: s.workspaceId, epoch: s.epoch, principal: ctx.principal.grantId,
      files, baseline, checks: selected.map(t => ({ taskId: t.id, recipeDigest: t.recipeDigest, title: t.title, jobId: null, errorCode: null })),
      observedDrift: false, nodeVersion: process.version, platform: process.platform, createdAt: Date.now() };
    save(s, record); // Never launch an unrecorded verification.
    for (let i = 0; i < selected.length; i++) {
      const task = selected[i]!, check = record.checks[i]!;
      try {
        const job = s.jobs.start({ workspaceId: s.workspaceId, epoch: s.epoch, principal: ctx.principal.grantId,
          kind: 'task', recipeId: task.id, program: task.program, args: task.args, cwdRel: task.cwd, timeoutMs: args.timeoutMs });
        check.jobId = job.jobId;
      } catch (err) {
        check.errorCode = err instanceof DodoError ? err.code : 'INTERNAL_ERROR';
        for (const remaining of record.checks.slice(i + 1)) remaining.errorCode = 'NOT_STARTED';
        try { save(s, record); } catch {
          throw new DodoError('RECOVERY_REQUIRED', 'verification may have started jobs; inspect jobs before retrying', { detail: { verificationId: record.id } });
        }
        break;
      }
      try { save(s, record); } catch {
        throw new DodoError('RECOVERY_REQUIRED', 'job started but verification receipt persistence failed; never repeat with a new key without reviewing jobs', { detail: { verificationId: record.id, jobId: check.jobId } });
      }
    }
    return { verificationId: record.id };
  });
  const record = load(ctx, result.verificationId);
  await Promise.all(record.checks.filter(c => c.jobId).map(c => s.jobs.waitForExit(c.jobId!, args.waitMs)));
  return render(ctx, record, 'run', replayed);
}
