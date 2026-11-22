import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnimationService } from '../../src/services/multimodal/animationService.js';
import { MediaStorage } from '../../src/services/multimodal/storage.js';
import { DodoError } from '../../src/errors.js';
import type { AppServices, ToolCtx } from '../../src/tools/context.js';
import type { ResourceInfoData, ResourceMetadataData } from '../../src/services/resources/contracts.js';
import type { CreativeService } from '../../src/services/multimodal/creativeService.js';
import type { StartJobRequest } from '../../src/services/jobs/jobManager.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dodo-animation-reliability-'))); roots.push(root);
  const rows = new Map<string, { status: string; exitCode: number | null; directory: string }>();
  const refs = new Map<string, ResourceInfoData>();
  let serial = 0, revoked = false;
  const ingestGenerated = vi.fn(async (_ctx: ToolCtx, bytes: Buffer, mimeType: string, label: string, metadata: ResourceMetadataData): Promise<ResourceInfoData> => {
    const resourceId = `res_${String(refs.size + 1).padStart(12, '0')}`;
    const value: ResourceInfoData = { resourceId, uri: `dodo-resource://ws_test/${resourceId}`, mimeType, bytes: bytes.length,
      sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, source: { kind: 'generated', label }, metadata,
      capabilities: { read: true, stream: true, seek: true, preview: true, transform: false, extractText: false }, createdAt: Date.now(), expiresAt: Date.now() + 86400000 };
    refs.set(label, value); return value;
  });
  const generatedForJob = vi.fn(async (_ctx: ToolCtx, label: string) => refs.get(label));
  const dispatch = async (req: StartJobRequest, revalidate?: () => void | Promise<void>) => {
    await revalidate?.();
    const spec = JSON.parse(fs.readFileSync(req.args[1]!, 'utf8')) as { directory: string; operation: string };
    const jobId = `job_${String(++serial).padStart(12, '0')}`;
    fs.writeFileSync(path.join(spec.directory, 'animation.gif'), 'GIF89a-private-render');
    fs.writeFileSync(path.join(spec.directory, 'preview.png'), 'private-preview');
    fs.writeFileSync(path.join(spec.directory, 'result.json'), JSON.stringify({ version: 1, operation: spec.operation, error: null,
      animation: { file: 'animation.gif', mimeType: 'image/gif', format: 'gif', width: 16, height: 16, frames: 8, durationMs: 1000, bytes: 20, loops: 0 },
      companions: [], preview: { file: 'preview.png' }, checks: [], passed: null, notes: [], plan: null }));
    rows.set(jobId, { status: 'exited', exitCode: 0, directory: spec.directory });
    return { jobId, pid: process.pid, sandboxed: null };
  };
  const jobs = { startProtected: vi.fn(dispatch), getJobChecked: vi.fn((id: string) => rows.get(id)!), waitForExit: vi.fn(async () => undefined), cancel: vi.fn() };
  const services = { workspaceId: 'ws_test', epoch: 'boot_test', wfs: { root }, jobs, resources: { ingestGenerated, generatedForJob } } as unknown as AppServices;
  const storage = new MediaStorage(services, root);
  const creative = { imageSource: vi.fn(async () => ({ bytes: Buffer.from('source'), guard: vi.fn() })) } as unknown as CreativeService;
  const animation = new AnimationService(storage, creative);
  vi.spyOn(animation, 'python').mockReturnValue({ program: process.execPath, source: 'env' });
  vi.spyOn(animation, 'ffmpeg').mockReturnValue(null);
  const ctx: ToolCtx = { services, principal: { grantId: 'local-stdio', clientId: 'stdio', sub: 'owner', scopes: ['dodo:read', 'dodo:write', 'dodo:exec'] }, trustMode: 'trusted',
    revalidate: () => { if (revoked) throw new DodoError('FORBIDDEN', 'test authority revoked'); } };
  const start = () => animation.start(ctx, 'rig', undefined, { format: 'gif' }, 0);
  return { animation, storage, ctx, jobs, rows, refs, ingestGenerated, dispatch, start, setRevoked: (value: boolean) => { revoked = value; } };
}

describe('animation dispatch and output collection reliability', () => {
  it('does not turn completed history into a render quota and clears expired records', async () => {
    const f = fixture();
    let first = '';
    for (let index = 0; index < 36; index++) { const result = await f.start(); first ||= result.jobId; expect(result.status).toBe('completed'); }
    expect(f.jobs.startProtected).toHaveBeenCalledTimes(36);
    const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 31 * 60000);
    expect((await f.start()).status).toBe('completed');
    await expect(f.animation.report(f.ctx, first)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('reserves concurrent dispatch capacity before asynchronous preparation', async () => {
    const f = fixture(); let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.jobs.startProtected.mockImplementation(async (request, revalidate) => { await gate; return f.dispatch(request, revalidate); });
    const first = f.start(), second = f.start();
    await expect(f.start()).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' });
    release(); expect((await Promise.all([first, second])).map(job => job.status)).toEqual(['completed', 'completed']);
    expect(f.jobs.startProtected).toHaveBeenCalledTimes(2);
  });

  it('collects each completed job once when several callers poll together', async () => {
    const f = fixture();
    f.jobs.startProtected.mockImplementation(async (request, revalidate) => { const result = await f.dispatch(request, revalidate); f.rows.get(result.jobId)!.status = 'running'; return result; });
    const started = await f.start(); f.rows.get(started.jobId)!.status = 'exited';
    const results = await Promise.all(Array.from({ length: 8 }, () => f.animation.report(f.ctx, started.jobId)));
    expect(new Set(results.map(result => result.animation!.resourceId)).size).toBe(1);
    expect(new Set(results.map(result => result.preview!.resourceId)).size).toBe(1);
    expect(f.ingestGenerated).toHaveBeenCalledTimes(2); expect(f.refs.size).toBe(2);
    expect(f.storage.directories.size).toBe(0);
  });

  it('keeps accepted render files and reuses existing refs after partial collection failure', async () => {
    const f = fixture(), ingest = f.ingestGenerated.getMockImplementation()!;
    let failPreview = true;
    f.ingestGenerated.mockImplementation(async (...args) => { if (args[4].format === 'contact-sheet' && failPreview) { failPreview = false; throw new DodoError('STORAGE_UNAVAILABLE', 'test preview persistence failure'); } return ingest(...args); });
    const accepted = await f.start();
    expect(accepted.status).toBe('failed'); expect(accepted.error).toContain('animation_job');
    const jobId = accepted.jobId, directory = f.rows.get(jobId)!.directory;
    expect(fs.existsSync(path.join(directory, 'animation.gif'))).toBe(true);
    f.ingestGenerated.mockImplementation(ingest);
    const recovered = await f.animation.report(f.ctx, jobId);
    expect(recovered.status).toBe('completed'); expect(f.refs.size).toBe(2);
    expect(f.ingestGenerated).toHaveBeenCalledTimes(3); expect(f.jobs.startProtected).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(directory)).toBe(false);
  });

  it('revalidates authority at queued dispatch and before returning cached results', async () => {
    const f = fixture();
    f.jobs.startProtected.mockImplementationOnce(async (request, revalidate) => { f.setRevoked(true); return f.dispatch(request, revalidate); });
    await expect(f.start()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.rows.size).toBe(0); expect(f.storage.directories.size).toBe(0);
    f.setRevoked(false); const result = await f.start();
    f.setRevoked(true); await expect(f.animation.report(f.ctx, result.jobId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('reports the JobManager timeout clearly without starting another render', async () => {
    const f = fixture();
    f.jobs.startProtected.mockImplementation(async (request, revalidate) => { const result = await f.dispatch(request, revalidate); f.rows.get(result.jobId)!.status = 'running'; return result; });
    const started = await f.start(); f.rows.get(started.jobId)!.status = 'timed_out';
    const result = await f.animation.report(f.ctx, started.jobId);
    expect(result.status).toBe('failed'); expect(result.error).toContain('timed out');
    expect(f.jobs.startProtected).toHaveBeenCalledTimes(1); expect(f.refs.size).toBe(0);
    expect(f.storage.directories.size).toBe(0);
  });
});
