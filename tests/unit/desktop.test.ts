import { FakeDesktop } from '../helpers/desktopBackend.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../../src/store/db.js';
import { Store } from '../../src/store/store.js';
import { DesktopService } from '../../src/services/desktop/desktopService.js';
import { DesktopActionSchema } from '../../src/services/desktop/protocol.js';
import { saveDesktopPolicy } from '../../src/services/desktop/desktopPolicy.js';
const identity = { grantId: 'grant-one', clientId: 'client-one' };
const win = { windowId: 42, pid: 123, appId: 'dev.dodo.fixture', title: 'Fixture', bounds: { x: 100, y: 200, width: 800, height: 600 } };
const capture = { ...win, imageWidth: 800, imageHeight: 600, mimeType: 'image/jpeg', image: '/9j/2Q==' };
describe('desktop permission, snapshots and receipts', () => {
    let dir: string, store: Store, backend: FakeDesktop, service: DesktopService, now: number;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dodo-desktop-test-')); store = new Store(openDatabase(path.join(dir, 'state.db'))); backend = new FakeDesktop(); now = 1000000; service = new DesktopService(store, 'ws_test', 'epoch-a', backend, () => now); });
    afterEach(async () => { await service.close(); store.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    function allow(mode: 'view' | 'control' = 'control') { service.setPolicy({ mode, allowedApps: [win.appId], minutes: 1 }); }
    it('is off by default and never invokes capture or actions without permission', async () => { await expect(service.windows()).rejects.toMatchObject({ code: 'FORBIDDEN' }); await expect(service.capture(42, 800, false, identity)).rejects.toMatchObject({ code: 'FORBIDDEN' }); expect(backend.calls).toEqual([]); });
    it('allows bounded status without screen reads and reports missing helper', async () => { backend.installed = false; expect((await service.status()).permissions).toBeNull(); expect(backend.calls).toEqual([]); });
    it('requires exact apps and bounded local lifetime; never accepts wildcard or empty apps', () => { expect(() => service.setPolicy({ mode: 'control', allowedApps: ['*'] })).toThrow(); expect(() => service.setPolicy({ mode: 'control', allowedApps: [] })).toThrow(); expect(() => service.setPolicy({ mode: 'view', allowedApps: [win.appId], minutes: 481 })).toThrow(); });
    it('expires, revokes and does not carry authorization to another boot or workspace', async () => { allow(); expect((await service.windows()).windows).toEqual([win]); const reboot = new DesktopService(store, 'ws_test', 'epoch-b', backend, () => now); expect(reboot.policy().mode).toBe('off'); const other = new DesktopService(store, 'ws_other', 'epoch-a', backend, () => now); expect(other.policy().mode).toBe('off'); now += 60001; await expect(service.windows()).rejects.toMatchObject({ code: 'FORBIDDEN' }); });
    it('remembers explicit consent across boots and time, only for the same workspace', async () => {
        service.setPolicy({ mode: 'control', allowedApps: [win.appId], persistent: true });
        const oldCapture = await service.capture(42, 800, false, identity);
        now += 365 * 24 * 60 * 60000;
        const reboot = new DesktopService(store, 'ws_test', 'epoch-b', backend, () => now);
        expect(reboot.policy()).toMatchObject({ mode: 'control', persistent: true, expiresAt: null, epoch: 'epoch-b' });
        expect((await reboot.windows()).windows).toEqual([win]);
        await expect(reboot.accessibility(oldCapture.data.snapshotId, identity)).rejects.toMatchObject({ code: 'STALE_WORKSPACE' });
        const other = new DesktopService(store, 'ws_other', 'epoch-b', backend, () => now);
        await expect(other.windows()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });
    it('keeps snapshots at 30 seconds even when app consent never expires', async () => {
        service.setPolicy({ mode: 'view', allowedApps: [win.appId], persistent: true });
        const c = await service.capture(42, 800, false, identity);
        expect(c.data.expiresAt).toBe(now + 30000);
        now += 30001;
        await expect(service.accessibility(c.data.snapshotId, identity)).rejects.toMatchObject({ code: 'STALE_WORKSPACE' });
        expect((await service.windows()).windows).toEqual([win]);
        const fresh = await service.capture(42, 800, false, identity);
        await expect(service.action(fresh.data.snapshotId, { kind: 'focus' }, 'still-view-only', identity, () => undefined)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });
    it('picks up owner CLI revocation through another DB connection and does not restore it on boot', async () => {
        service.setPolicy({ mode: 'control', allowedApps: [win.appId], persistent: true });
        const c = await service.capture(42, 800, false, identity);
        const owner = new Store(openDatabase(path.join(dir, 'state.db')));
        try { saveDesktopPolicy(owner, 'ws_test', 'local-cli', { mode: 'off' }, now); }
        finally { owner.db.close(); }
        await expect(service.action(c.data.snapshotId, { kind: 'focus' }, 'revoked-cli', identity, () => undefined)).rejects.toMatchObject({ code: 'FORBIDDEN' });
        const reboot = new DesktopService(store, 'ws_test', 'epoch-b', backend, () => now);
        expect(reboot.policy()).toMatchObject({ mode: 'off', persistent: false });
    });
    it('invalidates captures on identical consent replacement from outside the service', async () => {
        const input = { mode: 'control', allowedApps: [win.appId], persistent: true };
        service.setPolicy(input);
        const c = await service.capture(42, 800, false, identity);
        const first = service.policy().revision;
        saveDesktopPolicy(store, 'ws_test', 'local-cli', input, now);
        expect(service.policy().revision).not.toBe(first);
        await expect(service.action(c.data.snapshotId, { kind: 'focus' }, 'old-revision', identity, () => undefined)).rejects.toMatchObject({ code: 'STALE_WORKSPACE' });
        expect(backend.calls.filter(c => c['op'] === 'action')).toHaveLength(0);
    });
    it('a temporary grant replaces remembered consent and does not revive it when expired', async () => {
        service.setPolicy({ mode: 'control', allowedApps: [win.appId], persistent: true });
        allow('view');
        expect(service.policy().persistent).toBe(false);
        now += 60001;
        expect(service.policy().mode).toBe('off');
        expect(new DesktopService(store, 'ws_test', 'epoch-b', backend, () => now).policy().mode).toBe('off');
    });
    it('rejects ambiguous duration and malformed saved consent; legacy grants remain temporary', () => {
        expect(() => service.setPolicy({ mode: 'control', allowedApps: [win.appId], persistent: true, minutes: 60 })).toThrow();
        const legacy = { mode: 'control', allowedApps: [win.appId], epoch: 'epoch-a', expiresAt: now + 60000 };
        store.setMeta('desktop-policy:ws_test', JSON.stringify(legacy));
        expect(service.policy()).toMatchObject({ mode: 'control', persistent: false });
        expect(new DesktopService(store, 'ws_test', 'epoch-b', backend, () => now).policy().mode).toBe('off');
        for (const invalid of ['invalid JSON', JSON.stringify({ ...legacy, persistent: true }), JSON.stringify({ ...legacy, expiresAt: null }), JSON.stringify({ ...legacy, persistent: true, expiresAt: null, allowedApps: ['*'] })]) {
            store.setMeta('desktop-policy:ws_test', invalid);
            expect(service.policy().mode).toBe('off');
        }
    });
    it('view permission cannot send input; missing helper fails explicitly', async () => { allow('view'); const c = await service.capture(42, 800, false, identity); await expect(service.action(c.data.snapshotId, { kind: 'focus' }, 'key-first', identity, () => undefined)).rejects.toMatchObject({ code: 'FORBIDDEN' }); backend.installed = false; await expect(service.windows()).rejects.toMatchObject({ code: 'NOT_SUPPORTED' }); });
    it('binds snapshots to principal and 30-second freshness; does not store image bytes', async () => { allow(); const c = await service.capture(42, 800, false, identity); expect(c.image).toBe(capture.image); expect(JSON.stringify(store.db.prepare('SELECT * FROM meta').all())).not.toContain(capture.image); await expect(service.accessibility(c.data.snapshotId, { ...identity, clientId: 'other' })).rejects.toMatchObject({ code: 'STALE_WORKSPACE' }); now += 30001; await expect(service.accessibility(c.data.snapshotId, identity)).rejects.toMatchObject({ code: 'STALE_WORKSPACE' }); });
    it('executes once, consumes snapshots and returns a durable retry receipt without reposting', async () => { allow(); const c = await service.capture(42, 800, false, identity); const act = { kind: 'click', x: 10, y: 20, button: 'left', count: 1 } as const; const first = await service.action(c.data.snapshotId, act, 'click-once', identity, () => undefined); expect(first.replayed).toBe(false); const second = await service.action(c.data.snapshotId, act, 'click-once', identity, () => undefined); expect(second.replayed).toBe(true); expect(backend.calls.filter(c => c['op'] === 'action')).toHaveLength(1); await expect(service.action(c.data.snapshotId, act, 'another-key', identity, () => undefined)).rejects.toMatchObject({ code: 'STALE_WORKSPACE' }); await expect(service.action(c.data.snapshotId, { kind: 'focus' }, 'click-once', identity, () => undefined)).rejects.toMatchObject({ code: 'CONFLICT' }); });
    it('does not retry uncertain native outcomes, including after service reconstruction', async () => { allow(); const c = await service.capture(42, 800, false, identity); backend.failure = true; await expect(service.action(c.data.snapshotId, { kind: 'type', text: 'private-input' }, 'uncertain-key', identity, () => undefined)).rejects.toThrow(); backend.failure = false; const again = new DesktopService(store, 'ws_test', 'epoch-a', backend, () => now); await expect(again.action(c.data.snapshotId, { kind: 'type', text: 'private-input' }, 'uncertain-key', identity, () => undefined)).rejects.toMatchObject({ code: 'CONFLICT' }); expect(JSON.stringify(store.db.prepare('SELECT * FROM meta').all())).not.toContain('private-input'); expect(backend.calls.filter(c => c['op'] === 'action')).toHaveLength(1); });
    it('validates image-coordinate bounds and schema before dispatch', async () => { allow(); const c = await service.capture(42, 800, false, identity); await expect(service.action(c.data.snapshotId, { kind: 'move', x: 800, y: 0 }, 'bounds-key', identity, () => undefined)).rejects.toMatchObject({ code: 'INVALID_INPUT' }); expect(DesktopActionSchema.safeParse({ kind: 'key', key: 'a; sh' }).success).toBe(false); expect(DesktopActionSchema.safeParse({ kind: 'type', text: 'x'.repeat(2001) }).success).toBe(false); expect(backend.calls.filter(c => c['op'] === 'action')).toHaveLength(0); });
    it('approval gate runs before side effects; denial does not consume a snapshot', async () => { allow(); const c = await service.capture(42, 800, false, identity); await expect(service.action(c.data.snapshotId, { kind: 'focus' }, 'approve-key', identity, () => { throw Error('local approval required'); })).rejects.toThrow('approval required'); expect(backend.calls.filter(c => c['op'] === 'action')).toHaveLength(0); await service.action(c.data.snapshotId, { kind: 'focus' }, 'approve-key', identity, () => undefined); expect(backend.calls.filter(c => c['op'] === 'action')).toHaveLength(1); });
    it('serializes operations and discards a capture if permission is revoked while waiting', async () => { allow(); let resolve!: () => void; backend.wait = new Promise<void>(r => { resolve = r; }); const running = service.capture(42, 800, false, identity); await expect(service.windows()).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' }); service.setPolicy({ mode: 'off' }); resolve(); await expect(running).rejects.toMatchObject({ code: 'FORBIDDEN' }); });
    it('drains native calls before close so late receipts never touch a closed store', async () => {
        allow();
        const c = await service.capture(42, 800, false, identity);
        let release!: () => void;
        backend.wait = new Promise<void>(resolve => { release = resolve; });
        const action = service.action(c.data.snapshotId, { kind: 'focus' }, 'drain-key', identity, () => undefined);
        let finished = false;
        const close = service.close().then(() => { finished = true; });
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(finished).toBe(false);
        release();
        expect((await action).posted).toBe(true);
        await close;
        expect(finished).toBe(true);
        await expect(service.windows()).rejects.toMatchObject({ code: 'STALE_WORKSPACE' });
    });
    it('invalidates old captures on permission changes and bounds the snapshot cache', async () => { allow(); const old = await service.capture(42, 800, false, identity); allow(); await expect(service.accessibility(old.data.snapshotId, identity)).rejects.toMatchObject({ code: 'STALE_WORKSPACE' }); const first = await service.capture(42, 800, false, identity); for (let i = 0; i < 32; i++)
        await service.capture(42, 800, false, identity); await expect(service.accessibility(first.data.snapshotId, identity)).rejects.toMatchObject({ code: 'STALE_WORKSPACE' }); });
});
