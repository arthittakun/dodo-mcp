import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AndroidService } from '../../src/services/android/androidService.js';
import { ipcCall } from '../../src/ipc/client.js';
import { ipcSocketPath } from '../../src/config/paths.js';
import { FakeAdb } from '../helpers/adbBackend.js';
import { callToolLegacy, launch, obtainToken, wsArgs, type TestContext } from '../helpers/testServer.js';
import { sha256Bytes } from '../../src/util/hash.js';

let current: TestContext | undefined;
afterEach(async () => { await current?.cleanup(); current = undefined; });

async function fixture(trust: 'inspect' | 'trusted' = 'trusted', surface: 'compact' | 'full' = 'full') {
  const ctx = current = await launch({ trust, toolSurface: surface, configPort: 0, fixtureFiles: { 'fixture.apk': 'APK', '.env.apk': 'SECRET' } });
  const adb = new FakeAdb();
  ctx.server.services.android = new AndroidService(ctx.server.services.store, ctx.server.services.wfs, ctx.server.workspaceId, ctx.server.epoch, adb, ctx.configDir);
  const token = await obtainToken(ctx);
  const ipc = ipcSocketPath(ctx.configDir, ctx.server.workspaceId);
  return { ctx, adb, token, ipc };
}

describe('Android ADB MCP security', () => {
  it('is off by default; owner IPC enables exact devices while read-only OAuth cannot inspect them', async () => {
    const { ctx, adb, token, ipc } = await fixture();
    const denied = await callToolLegacy(ctx, token.accessToken, 'android_devices', wsArgs(ctx));
    expect((denied.envelope.error as { code: string }).code).toBe('FORBIDDEN');
    expect(adb.calls).toHaveLength(0);
    await ipcCall(ipc, 'android.policy', { mode: 'view', allowedDevices: ['SERIAL-1'], minutes: 5 });
    const status = await callToolLegacy(ctx, token.accessToken, 'android_status', wsArgs(ctx));
    expect(status.envelope.data).toMatchObject({ policy: { mode: 'view', allowedDeviceCount: 1 } });
    expect(JSON.stringify(status.envelope.data)).not.toContain('SERIAL-1');
    expect((await callToolLegacy(ctx, token.accessToken, 'android_devices', wsArgs(ctx))).envelope.data).toMatchObject({ devices: [{ serial: 'SERIAL-1', state: 'device' }], hiddenCount: 1 });
    const readonly = await obtainToken(ctx, { scope: 'dodo:read' });
    const scopeDenied = await callToolLegacy(ctx, readonly.accessToken, 'android_devices', wsArgs(ctx));
    expect((scopeDenied.envelope.error as { code: string }).code).toBe('FORBIDDEN');
  });

  it('passes a real PNG content block through compact dodo_mobile and redacts secure UI text', async () => {
    const { ctx, token, ipc } = await fixture('trusted', 'compact');
    await ipcCall(ipc, 'android.policy', { mode: 'control', allowedDevices: ['SERIAL-1'], persistent: true });
    const capture = await callToolLegacy(ctx, token.accessToken, 'dodo_mobile', { ...wsArgs(ctx), operation: 'android_capture', args: { serial: 'SERIAL-1' } });
    expect(capture.envelope.ok).toBe(true);
    expect((capture.raw as { result: { content: Array<{ type: string }> } }).result.content.some((c) => c.type === 'image')).toBe(true);
    const snapshotId = (capture.envelope.data as { snapshotId: string }).snapshotId;
    const ui = await callToolLegacy(ctx, token.accessToken, 'dodo_mobile', { ...wsArgs(ctx), operation: 'android_ui', args: { snapshotId } });
    const serialized = JSON.stringify(ui.envelope.data);
    expect(serialized).toContain('Visible');
    expect(serialized).not.toContain('SECRET');
  });

  it('binds control to a fresh client snapshot and preserves exact idempotency receipts', async () => {
    const { ctx, adb, token, ipc } = await fixture();
    await ipcCall(ipc, 'android.policy', { mode: 'control', allowedDevices: ['SERIAL-1'], minutes: 5 });
    const capture = await callToolLegacy(ctx, token.accessToken, 'android_capture', { ...wsArgs(ctx), serial: 'SERIAL-1' });
    const snapshotId = (capture.envelope.data as { snapshotId: string }).snapshotId;
    const args = { ...wsArgs(ctx), serial: 'SERIAL-1', snapshotId, action: { kind: 'tap', x: 0, y: 0 }, idempotencyKey: 'android-tap-01' };
    expect((await callToolLegacy(ctx, token.accessToken, 'android_action', args)).envelope.data).toMatchObject({ posted: true, replayed: false });
    expect((await callToolLegacy(ctx, token.accessToken, 'android_action', args)).envelope.data).toMatchObject({ posted: true, replayed: true });
    expect(adb.calls.filter((call) => call.join(' ').includes('input tap'))).toHaveLength(1);
    const other = await obtainToken(ctx);
    const secondCapture = await callToolLegacy(ctx, token.accessToken, 'android_capture', { ...wsArgs(ctx), serial: 'SERIAL-1' });
    const foreign = await callToolLegacy(ctx, other.accessToken, 'android_action', { ...args, snapshotId: (secondCapture.envelope.data as { snapshotId: string }).snapshotId, idempotencyKey: 'android-tap-02' });
    expect((foreign.envelope.error as { code: string }).code).toBe('STALE_WORKSPACE');
  });

  it('inspect mode creates an approval for the target operation and never executes before approval', async () => {
    const { ctx, adb, token, ipc } = await fixture('inspect');
    await ipcCall(ipc, 'android.policy', { mode: 'control', allowedDevices: ['SERIAL-1'], minutes: 5 });
    const capture = await callToolLegacy(ctx, token.accessToken, 'android_capture', { ...wsArgs(ctx), serial: 'SERIAL-1' });
    const args = { ...wsArgs(ctx), serial: 'SERIAL-1', snapshotId: (capture.envelope.data as { snapshotId: string }).snapshotId, action: { kind: 'key', keyCode: 'KEYCODE_HOME' }, idempotencyKey: 'android-key-01' };
    const first = await callToolLegacy(ctx, token.accessToken, 'android_action', args);
    expect((first.envelope.error as { code: string }).code).toBe('APPROVAL_REQUIRED');
    expect(adb.calls.some((call) => call.join(' ').includes('input keyevent'))).toBe(false);
    const approval = ctx.server.services.store.listPendingApprovals('action').find((row) => row.tool === 'android_action')!;
    expect(ctx.server.services.store.setApprovalStatus(approval.id, 'approved')).toBe(true);
    expect((await callToolLegacy(ctx, token.accessToken, 'android_action', args)).envelope.ok).toBe(true);
  });

  it('blocks unapproved serials, secret host paths, traversal and non-device advanced commands', async () => {
    const { ctx, adb, token, ipc } = await fixture();
    await ipcCall(ipc, 'android.policy', { mode: 'control', allowedDevices: ['SERIAL-1'], minutes: 5 });
    const wrong = await callToolLegacy(ctx, token.accessToken, 'android_device_info', { ...wsArgs(ctx), serial: 'OTHER-2' });
    expect((wrong.envelope.error as { code: string }).code).toBe('FORBIDDEN');
    const secret = await callToolLegacy(ctx, token.accessToken, 'android_install', { ...wsArgs(ctx), serial: 'SERIAL-1', apkPath: '.env.apk', expectedHash: sha256Bytes('SECRET'), idempotencyKey: 'android-install-01' });
    expect((secret.envelope.error as { code: string }).code).toBe('SECRET_PATH_DENIED');
    const changed = await callToolLegacy(ctx, token.accessToken, 'android_install', { ...wsArgs(ctx), serial: 'SERIAL-1', apkPath: 'fixture.apk', expectedHash: sha256Bytes('old bytes'), idempotencyKey: 'android-install-02' });
    expect((changed.envelope.error as { code: string }).code).toBe('FILE_CHANGED');
    expect(adb.calls.some((call) => call.includes('install'))).toBe(false);
    const traversal = await callToolLegacy(ctx, token.accessToken, 'android_push', { ...wsArgs(ctx), serial: 'SERIAL-1', sourcePath: 'fixture.apk', expectedHash: sha256Bytes('APK'), destinationPath: '/sdcard/../data/x', idempotencyKey: 'android-push-01' });
    expect((traversal.envelope.error as { code: string }).code).toBe('PATH_DENIED');
    const outside = await callToolLegacy(ctx, token.accessToken, 'android_adb', { ...wsArgs(ctx), serial: 'SERIAL-1', command: 'pair', args: [], idempotencyKey: 'android-pair-01' });
    expect(outside.isError).toBe(true);
    expect(JSON.stringify(outside.raw)).toContain('Invalid option');
    expect(fs.existsSync(path.join(ctx.fixtureDir, '.env.apk'))).toBe(true);
  });

  it('Local Config Android mutation requires the private token and current workspace context', async () => {
    const { ctx } = await fixture();
    const url = new URL(ctx.configUrl!);
    const endpoint = `${url.origin}/api/android/policy`;
    expect((await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'off' }) })).status).toBe(401);
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${url.hash.slice(1)}`, 'x-dodo-workspace': ctx.server.workspaceId, 'x-dodo-epoch': 'stale' };
    expect((await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ mode: 'off' }) })).status).toBe(409);
    const current = { ...headers, 'x-dodo-epoch': ctx.server.epoch };
    const saved = await fetch(endpoint, { method: 'POST', headers: current, body: JSON.stringify({ mode: 'view', allowedDevices: ['SERIAL-1'], persistent: true }) });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ ok: true, policy: { mode: 'view', allowedDevices: ['SERIAL-1'], persistent: true } });
    const scanned = await fetch(`${url.origin}/api/android/devices`, { headers: { authorization: `Bearer ${url.hash.slice(1)}` } });
    expect(scanned.status).toBe(200);
    expect(await scanned.json()).toMatchObject({ devices: [{ serial: 'SERIAL-1', state: 'device' }, { serial: 'OTHER-2', state: 'unauthorized' }] });
  });
});
