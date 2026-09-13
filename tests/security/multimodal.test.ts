import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import sharp from 'sharp';
import { chromium } from 'playwright';
import { launch, obtainToken, mcpRaw, rpc, wsArgs, type TestContext, type TokenSet } from '../helpers/testServer.js';
import { tool, assertOk, blocks, ImageDesktop, BROWSER_FIXTURE } from '../helpers/multimodal.js';
import { DesktopService } from '../../src/services/desktop/desktopService.js';
import { ScreenFrame, AssetInfo, WorkflowRecord, BrowserObservation } from '../../src/services/multimodal/contracts.js';
import { multimediaEffect } from '../../src/services/multimodal/operations.js';
import type { ToolCtx } from '../../src/tools/context.js';

/** All consent changes below are in an isolated test database with a fake OS adapter, never real desktop permissions. */
describe('multimodal security and failure boundaries', () => {
  let ctx: TestContext, owner: TokenSet, other: TokenSet, reader: TokenSet, fake: ImageDesktop;
  let originalConfig: string;
  beforeAll(async () => {
    ctx = await launch({ toolSurface: 'full',  fixtureFiles: { 'index.html': BROWSER_FIXTURE, '.env': 'private secret', 'clip.srt': '1\n00:00:00,000 --> 00:00:01,000\nhello\n\n', 'input.mp4': 'invalid media for preflight tests' } });
    fs.writeFileSync(path.join(ctx.fixtureDir, 'image.png'), await sharp({ create: { width: 100, height: 80, channels: 3, background: '#223344' } }).png().toBuffer());
    fs.symlinkSync('image.png', path.join(ctx.fixtureDir, 'symlink.png'));
    fs.copyFileSync(path.join(ctx.fixtureDir, 'image.png'), path.join(ctx.fixtureDir, 'hard-source.png'));
    fs.linkSync(path.join(ctx.fixtureDir, 'hard-source.png'), path.join(ctx.fixtureDir, 'hard-link.png'));
    await ctx.server.services.desktop.close(); fake = new ImageDesktop(); await fake.prepare();
    ctx.server.services.desktop = new DesktopService(ctx.server.services.store, ctx.server.workspaceId, ctx.server.epoch, fake);
    owner = await obtainToken(ctx); other = await obtainToken(ctx); reader = await obtainToken(ctx, { scope: 'dodo:read' });
    originalConfig = fs.readFileSync(path.join(ctx.configDir, 'config.json'), 'utf8');
  });
  afterEach(() => { vi.restoreAllMocks(); ctx.server.services.store.setTrustMode(ctx.server.workspaceId, 'inspect'); ctx.server.services.desktop.setPolicy({ mode: 'off' }); });
  afterAll(async () => { expect(fs.readFileSync(path.join(ctx.configDir, 'config.json'), 'utf8')).toBe(originalConfig); await ctx.cleanup(); });
  const call = (name: string, args: Record<string, unknown>, token = owner.accessToken) => tool(ctx, token, name, args);
  const error = (result: Awaited<ReturnType<typeof call>>, code: string) => { expect(result.isError).toBe(true); expect(result.envelope.error).toMatchObject({ code }); };
  function allow(mode: 'view' | 'control' = 'control') { ctx.server.services.desktop.setPolicy({ mode, allowedApps: ['dev.dodo.fixture'], minutes: 60 }); }
  const screen = async (args: Record<string, unknown> = {}) => z.object({ frames: z.array(ScreenFrame) }).parse(assertOk(await call('screen_observe', { windowId: 42, ...args })));
  function localContext(): ToolCtx { return { services: ctx.server.services, principal: { grantId: owner.grantId, clientId: owner.clientId, sub: 'owner', scopes: ['dodo:read', 'dodo:write', 'dodo:exec'] }, trustMode: ctx.server.services.trustMode() }; }

  it('requires authentication before any new tool dispatch', async () => {
    expect((await mcpRaw(ctx, rpc('tools/call', { name: 'multimodal_status', arguments: wsArgs(ctx) }))).status).toBe(401);
  });
  it('read-only clients can see capability metadata but cannot capture/execute or save procedures', async () => {
    expect((await call('multimodal_status', {}, reader.accessToken)).isError).toBe(false);
    error(await call('screen_observe', { windowId: 42 }, reader.accessToken), 'FORBIDDEN');
    error(await call('image_view', { path: 'image.png' }, reader.accessToken), 'FORBIDDEN');
    error(await call('browser_session', { path: 'index.html', idempotencyKey: 'mm-sec-read-browser' }, reader.accessToken), 'FORBIDDEN');
    error(await call('workflow_save', { workflow: { name: 'x', goal: 'x', steps: [{ instruction: 'x', expectedBefore: 'x', action: { target: 'manual' } }] } }, reader.accessToken), 'FORBIDDEN');
  });
  it('inspect mode blocks decoder and browser execution before any job, temp source or browser is created', async () => {
    const mm = ctx.server.services.multimodal!, before = mm.storage.directories.size;
    error(await call('media_open', { path: 'input.mp4', idempotencyKey: 'mm-sec-inspect-open' }), 'APPROVAL_REQUIRED');
    error(await call('speech_synthesize', { text: 'hello', idempotencyKey: 'mm-sec-inspect-speech' }), 'APPROVAL_REQUIRED');
    error(await call('browser_session', { path: 'index.html', idempotencyKey: 'mm-sec-inspect-browser' }), 'APPROVAL_REQUIRED');
    expect(mm.media.jobs.size).toBe(0); expect(mm.storage.directories.size).toBe(before);
  });
  it('inherits off/view/control desktop grants and returns no screen without existing consent', async () => {
    error(await call('screen_observe', { windowId: 42 }), 'FORBIDDEN'); expect(fake.calls).toHaveLength(0);
    allow('view'); const captured = await screen(); expect(captured.frames).toHaveLength(1);
    const game = z.object({ gameId: z.string(), observation: ScreenFrame }).parse(assertOk(await call('game_session', { windowId: 42 })));
    error(await call('game_step', { gameId: game.gameId, observationId: game.observation.observationId, action: { kind: 'keys', keys: ['a'], holdMs: 0 }, idempotencyKey: 'mm-sec-view-game' }), 'FORBIDDEN');
    expect(fake.calls.filter(c => c.op === 'action')).toHaveLength(0);
  });
  it('returns bounded actual images, crop mapping and explicit visual-difference evidence', async () => {
    allow();
    const first = await screen({ crop: { left: 100, top: 50, width: 200, height: 100 }, maxEdge: 800 });
    const second = await screen({ previousId: first.frames[0]!.observationId, crop: { left: 100, top: 50, width: 200, height: 100 }, maxEdge: 800 });
    expect(second.frames[0]?.difference?.changedFraction).toBe(0);
    await fake.prepare('#dd9900');
    const different = await screen({ previousId: second.frames[0]!.observationId, crop: { left: 100, top: 50, width: 200, height: 100 }, maxEdge: 800 });
    expect(different.frames[0]?.difference?.changedFraction).toBeGreaterThan(0.9);
    expect(different.frames[0]?.view).toMatchObject({ sourceOffsetX: 100, scaleX: 0.25 });
    expect(fake.calls.filter(c => c.op === 'capture').every(c => c.ocr === false)).toBe(true);
    const receipt = await call('media_read', { assetId: different.frames[0]!.asset.assetId }); assertOk(receipt);
    expect(blocks(receipt).some(b => b.type === 'image')).toBe(true);
    expect(JSON.stringify(ctx.server.services.store.db.prepare('SELECT * FROM meta').all())).not.toContain(fake.image);
  });
  it('cached screen images/crops become inaccessible when permission is revoked', async () => {
    allow(); const frame = (await screen()).frames[0]!;
    const crop = z.object({ asset: AssetInfo }).parse(assertOk(await call('image_view', { assetId: frame.asset.assetId, crop: { left: 0, top: 0, width: 80, height: 80 } })));
    ctx.server.services.desktop.setPolicy({ mode: 'off' });
    error(await call('media_read', { assetId: frame.asset.assetId }), 'FORBIDDEN');
    error(await call('media_read', { assetId: crop.asset.assetId }), 'FORBIDDEN');
  });
  it('binds assets to a principal and rejects stale workspace context', async () => {
    const image = z.object({ asset: AssetInfo }).parse(assertOk(await call('image_view', { path: 'image.png' })));
    error(await call('media_read', { assetId: image.asset.assetId }, other.accessToken), 'NOT_FOUND');
    error(await call('image_view', { path: 'image.png', workspaceEpoch: 'stale' }), 'STALE_WORKSPACE');
  });
  it('preserves secret/traversal/symlink/hardlink guards on every direct source image read', async () => {
    for (const [file, code] of [['.env', 'SECRET_PATH_DENIED'], ['../image.png', 'PATH_DENIED'], ['symlink.png', 'PATH_DENIED'], ['hard-link.png', 'PATH_DENIED']] as const) error(await call('image_view', { path: file }), code);
    const mm = ctx.server.services.multimodal!;
    for (const file of ['.env', '../input.mp4', 'hard-link.png']) {
      const directory = mm.storage.directory();
      try { await expect(mm.storage.copySource(file, directory)).rejects.toThrow(); }
      finally { mm.storage.removeDirectory(directory); }
    }
  });
  it('remembers procedures as data only, checks revisions and separates client memories', async () => {
    const definition = { name: 'Remember demo', goal: 'No privilege granted', steps: [{ instruction: 'Press Save', expectedBefore: 'Ready', expectedAfter: 'Saved', action: { target: 'desktop', action: { kind: 'click', x: 10, y: 10 } } }] };
    const saved = WorkflowRecord.parse(assertOk(await call('workflow_save', { workflow: definition })));
    expect(ctx.server.services.trustMode()).toBe('inspect'); expect(ctx.server.services.desktop.policy().mode).toBe('off');
    error(await call('workflow_search', { workflowId: saved.workflowId }, other.accessToken), 'NOT_FOUND');
    error(await call('workflow_save', { workflow: definition, workflowId: saved.workflowId, expectedRevision: 'sha256:' + '0'.repeat(64) }), 'FILE_CHANGED');
    expect(fake.calls.filter(c => c.op === 'action')).toHaveLength(0);
  });
  it('requires live desktop approval for a remembered step and does not treat memory as consent', async () => {
    fake.text = 'Ready Save'; allow();
    const saved = WorkflowRecord.parse(assertOk(await call('workflow_save', { workflow: { name: 'Save step', goal: 'Save', steps: [{ instruction: 'click', expectedBefore: 'Ready', expectedAfter: 'Saved', action: { target: 'desktop', action: { kind: 'click', x: 10, y: 10 } } }] } })));
    const started = z.object({ runId: z.string(), observation: ScreenFrame.passthrough() }).parse(assertOk(await call('workflow_run', { mode: 'start', workflowId: saved.workflowId, revision: saved.revision, windowId: 42 })));
    const before = fake.calls.filter(c => c.op === 'action').length;
    error(await call('workflow_run', { mode: 'next', runId: started.runId, stepIndex: 0, observationId: started.observation.observationId, idempotencyKey: 'mm-sec-workflow-approval' }), 'APPROVAL_REQUIRED');
    expect(fake.calls.filter(c => c.op === 'action')).toHaveLength(before);
  });
  it('refuses public browsing without existing web permission and never changes the setting', async () => {
    ctx.server.services.store.setTrustMode(ctx.server.workspaceId, 'trusted');
    error(await call('browser_session', { source: 'public', url: 'https://example.com', idempotencyKey: 'mm-sec-public-off' }), 'FORBIDDEN');
    expect(ctx.server.services.config.allowWebFetch).toBe(false);
  });
  it.skipIf(!fs.existsSync(chromium.executablePath()))('keeps browser sessions/images private and closes all owned browser processes on workspace shutdown', async () => {
    ctx.server.services.store.setTrustMode(ctx.server.workspaceId, 'trusted');
    const opened = z.object({ sessionId: z.string(), observation: BrowserObservation }).parse(assertOk(await call('browser_session', { path: 'index.html', idempotencyKey: 'mm-sec-browser-owner' })));
    error(await call('browser_observe', { sessionId: opened.sessionId }, other.accessToken), 'NOT_FOUND');
    error(await call('media_read', { assetId: opened.observation.asset.assetId }, other.accessToken), 'NOT_FOUND');
    assertOk(await call('browser_session', { mode: 'close', sessionId: opened.sessionId, idempotencyKey: 'mm-sec-browser-close' }));
    error(await call('browser_observe', { sessionId: opened.sessionId }), 'NOT_FOUND');
  });
  it('preserves uncertain effect reservations after persistence failure, never repeating side effects', async () => {
    ctx.server.services.store.setTrustMode(ctx.server.workspaceId, 'trusted');
    let effects = 0;
    const persist = vi.spyOn(ctx.server.services.store, 'completeIdempotency').mockImplementation(() => { throw new Error('storage fixture failure'); });
    const perform = () => multimediaEffect(localContext(), 'test.multimedia', 'mm-sec-uncertain-key', { operation: 'test' }, async () => { effects++; return { happened: true }; });
    await expect(perform()).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' }); persist.mockRestore();
    await expect(perform()).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' }); expect(effects).toBe(1);
  });
  it('checks grant revocation again before returning captured media', async () => {
    allow(); const original = fake.run.bind(fake);
    vi.spyOn(fake, 'run').mockImplementation(async request => { const result = await original(request); if (request.op === 'capture') ctx.server.services.store.revokeGrant(owner.grantId); return result; });
    error(await call('screen_observe', { windowId: 42 }), 'FORBIDDEN');
    owner = await obtainToken(ctx);
  });
});
