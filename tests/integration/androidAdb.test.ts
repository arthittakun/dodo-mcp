import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AndroidService } from '../../src/services/android/androidService.js';
import { ipcCall } from '../../src/ipc/client.js';
import { ipcSocketPath } from '../../src/config/paths.js';
import { FakeAdb } from '../helpers/adbBackend.js';
import { callToolLegacy, launch, obtainToken, wsArgs, type TestContext, type TokenSet } from '../helpers/testServer.js';
import { sha256Bytes } from '../../src/util/hash.js';

describe('Android ADB complete tool family over real HTTP + OAuth', () => {
  let ctx: TestContext;
  let token: TokenSet;
  let adb: FakeAdb;

  beforeAll(async () => {
    ctx = await launch({ toolSurface: 'full', trust: 'trusted', configPort: 0, fixtureFiles: { 'build/app.apk': 'fixture apk', 'send.txt': 'hello device' } });
    adb = new FakeAdb();
    ctx.server.services.android = new AndroidService(ctx.server.services.store, ctx.server.services.wfs, ctx.server.workspaceId, ctx.server.epoch, adb, ctx.configDir);
    token = await obtainToken(ctx);
    await ipcCall(ipcSocketPath(ctx.configDir, ctx.server.workspaceId), 'android.policy', { mode: 'control', allowedDevices: ['SERIAL-1'], persistent: true });
  }, 120_000);
  afterAll(async () => ctx?.cleanup());

  const call = (name: string, args: Record<string, unknown> = {}) => callToolLegacy(ctx, token.accessToken, name, { ...wsArgs(ctx), ...args });

  it('reports status, devices and device information from the selected serial', async () => {
    expect((await call('android_status')).envelope.data).toMatchObject({ adbAvailable: true, policy: { mode: 'control' } });
    expect((await call('android_devices')).envelope.data).toMatchObject({ devices: [{ serial: 'SERIAL-1', model: 'Pixel_9' }] });
    expect((await call('android_device_info', { serial: 'SERIAL-1' })).envelope.data).toMatchObject({ model: 'Pixel 9', androidVersion: '16', battery: { level: 88, powered: true } });
  });

  it('serializes one physical device across concurrent project-runtime services', async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    class BlockingAdb extends FakeAdb {
      override async run(args: readonly string[]) {
        if (args.join(' ') === '-s SERIAL-1 shell getprop') { entered(); await gate; }
        return super.run(args);
      }
    }
    const backend = new BlockingAdb();
    const first = new AndroidService(ctx.server.services.store, ctx.server.services.wfs, ctx.server.workspaceId, ctx.server.epoch, backend, ctx.configDir);
    const second = new AndroidService(ctx.server.services.store, ctx.server.services.wfs, ctx.server.workspaceId, ctx.server.epoch, backend, ctx.configDir);
    const running = first.info('SERIAL-1');
    await started;
    try { await expect(second.info('SERIAL-1')).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' }); }
    finally { release(); }
    await expect(running).resolves.toMatchObject({ serial: 'SERIAL-1', model: 'Pixel 9' });
    await Promise.all([first.close(), second.close()]);
  });

  it('captures image evidence, reads UI/logcat/packages and bounded device files', async () => {
    const capture = await call('android_capture', { serial: 'SERIAL-1' });
    expect(capture.envelope.data).toMatchObject({ serial: 'SERIAL-1', width: 1, height: 1, mimeType: 'image/png' });
    expect((capture.raw as { result: { content: Array<{ type: string; mimeType?: string }> } }).result.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'image', mimeType: 'image/png' })]));
    const snapshotId = (capture.envelope.data as { snapshotId: string }).snapshotId;
    expect((await call('android_ui', { snapshotId })).envelope.data).toMatchObject({ nodes: [expect.objectContaining({ text: 'Visible' }), expect.objectContaining({ redacted: true })] });
    expect((await call('android_logcat', { serial: 'SERIAL-1', maxLines: 20 })).envelope.data).toMatchObject({ lines: expect.arrayContaining([expect.stringContaining('hello')]) });
    expect((await call('android_packages', { serial: 'SERIAL-1' })).envelope.data).toMatchObject({ packages: ['app.test', 'dev.dodo.fixture'] });
    expect((await call('android_file_read', { serial: 'SERIAL-1', path: '/sdcard/test.txt' })).envelope.data).toMatchObject({ encoding: 'utf8', data: 'device file\n' });
  });

  it('controls input/apps, installs APKs, pushes workspace files and runs bounded advanced ADB', async () => {
    const capture = await call('android_capture', { serial: 'SERIAL-1' });
    const snapshotId = (capture.envelope.data as { snapshotId: string }).snapshotId;
    expect((await call('android_action', { serial: 'SERIAL-1', snapshotId, action: { kind: 'tap', x: 0, y: 0 }, idempotencyKey: 'integration-action-01' })).envelope.data).toMatchObject({ posted: true, replayed: false });
    expect((await call('android_app', { serial: 'SERIAL-1', action: { kind: 'launch', packageName: 'app.test' }, idempotencyKey: 'integration-app-01' })).envelope.data).toMatchObject({ posted: true, action: 'launch' });
    expect((await call('android_install', { serial: 'SERIAL-1', apkPath: 'build/app.apk', expectedHash: sha256Bytes('fixture apk'), idempotencyKey: 'integration-install-01' })).envelope.data).toMatchObject({ posted: true, path: 'build/app.apk', sha256: sha256Bytes('fixture apk') });
    expect((await call('android_push', { serial: 'SERIAL-1', sourcePath: 'send.txt', expectedHash: sha256Bytes('hello device'), destinationPath: '/sdcard/send.txt', idempotencyKey: 'integration-push-01' })).envelope.data).toMatchObject({ posted: true, source: 'send.txt', destination: '/sdcard/send.txt', sha256: sha256Bytes('hello device') });
    const stagedPaths = adb.calls.filter((args) => args.includes('install') || args.includes('push')).map((args) => args.find((arg) => arg.includes('android-staging'))).filter((value): value is string => Boolean(value));
    expect(stagedPaths).toHaveLength(2);
    expect(stagedPaths.every((file) => !fs.existsSync(file))).toBe(true);
    expect((await call('android_adb', { serial: 'SERIAL-1', command: 'shell', args: ['echo', 'ok'], idempotencyKey: 'integration-adb-01' })).envelope.data).toMatchObject({ posted: true, command: 'shell', output: 'advanced output\n' });
  });
});
