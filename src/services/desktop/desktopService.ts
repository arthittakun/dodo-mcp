import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Store } from '../../store/store.js';
import { DodoError } from '../../errors.js';
import { digestOf } from '../../util/hash.js';
import { CaptureSchema, WindowSchema, NativeStatusSchema, AccessibilitySchema, DesktopActionSchema, type DesktopBackend, type DesktopPolicy, type DesktopAction, type DesktopCapture } from './protocol.js';
import { readDesktopPolicy, saveDesktopPolicy } from './desktopPolicy.js';
type Identity = {
    grantId: string;
    clientId: string;
};
type Snapshot = {
    principal: string;
    metadata: Omit<DesktopCapture, 'image' | 'ocr' | 'ocrTruncated'>;
    expiresAt: number;
    policyDigest: string;
};
export class DesktopService {
    private readonly snapshots = new Map<string, Snapshot>();
    private busy = false;
    private closed = false;
    constructor(private readonly store: Store, private readonly workspaceId: string, private readonly epoch: string, private readonly backend: DesktopBackend, private readonly clock: () => number = Date.now) { }
    policy(): DesktopPolicy {
        return readDesktopPolicy(this.store, this.workspaceId, this.epoch, this.clock());
    }
    /** Owner-only IPC/config-plane entry. Never expose this as an MCP tool. */
    setPolicy(input: unknown): DesktopPolicy {
        const policy = saveDesktopPolicy(this.store, this.workspaceId, this.epoch, input, this.clock());
        this.snapshots.clear();
        return policy;
    }
    async status() {
        return this.exclusive(async () => {
            if (this.closed) throw new DodoError('STALE_WORKSPACE', 'desktop service closed');
            return { policy: this.policy(), supported: ['darwin', 'win32', 'linux'].includes(process.platform), helperInstalled: this.backend.available(), permissions: this.backend.available() ? NativeStatusSchema.parse(await this.backend.run({ op: 'status' })) : null, setup: 'dodo setup --components desktop; dodo desktop allow --app <app-id> --mode view|control --persist --yes', scope: 'dodo:exec', coordinateSpace: 'captured-image pixels; window-only', snapshotTtlMs: 30_000 };
        });
    }
    private authorize(control = false): DesktopPolicy {
        if (this.closed)
            throw new DodoError('STALE_WORKSPACE', 'desktop service closed');
        const p = this.policy();
        if (p.mode === 'off' || (control && p.mode !== 'control'))
            throw new DodoError('FORBIDDEN', 'desktop access is disabled, expired, or view-only; the owner must authorize it locally');
        if (!this.backend.available())
            throw new DodoError('NOT_SUPPORTED', 'run dodo setup --components desktop in a supported interactive desktop session');
        return p;
    }
    private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
        if (this.busy)
            throw new DodoError('RESOURCE_LIMIT', 'another desktop operation is in progress; desktop actions are serialized');
        this.busy = true;
        try {
            return await fn();
        }
        finally {
            this.busy = false;
        }
    }
    private checkPolicy(p: DesktopPolicy) { if (digestOf(this.authorize()) !== digestOf(p))
        throw new DodoError('FORBIDDEN', 'desktop permission changed during operation'); }
    async windows() { return this.exclusive(async () => { const p = this.authorize(); const result = z.object({ windows: z.array(WindowSchema).max(100), truncated: z.boolean() }).strict().parse(await this.backend.run({ op: 'windows', allowedApps: p.allowedApps })); this.checkPolicy(p); return { ...result, windows: result.windows.filter(w => p.allowedApps.includes(w.appId)) }; }); }
    async capture(windowId: number, maxEdge: number, ocr: boolean, identity: Identity) {
        return this.exclusive(async () => {
            const p = this.authorize();
            const result = CaptureSchema.parse(await this.backend.run({ op: 'capture', windowId, maxEdge, ocr, allowedApps: p.allowedApps }));
            this.checkPolicy(p);
            if (!p.allowedApps.includes(result.appId))
                throw new DodoError('FORBIDDEN', 'captured window is outside local permission');
            const { image, ocr: recognized, ocrTruncated, ...metadata } = result;
            for (const [id, s] of this.snapshots)
                if (s.expiresAt <= this.clock())
                    this.snapshots.delete(id);
            if (this.snapshots.size >= 32)
                this.snapshots.delete(this.snapshots.keys().next().value!);
            const snapshotId = randomUUID(), expiresAt = Math.min(this.clock() + 30000, p.expiresAt ?? Infinity);
            this.snapshots.set(snapshotId, { principal: digestOf(identity), metadata, expiresAt, policyDigest: digestOf(p) });
            return { data: { ...metadata, snapshotId, expiresAt, ...(recognized ? { ocr: recognized, ocrTruncated: ocrTruncated ?? false } : {}) }, image };
        });
    }
    private snapshot(id: string, identity: Identity, control = false) {
        const policy = this.authorize(control), s = this.snapshots.get(id);
        if (!s || s.principal !== digestOf(identity) || s.expiresAt <= this.clock() || s.policyDigest !== digestOf(policy))
            throw new DodoError('STALE_WORKSPACE', 'capture a fresh window image for this client; snapshot is stale or consumed');
        return { snapshot: s, policy };
    }
    async accessibility(snapshotId: string, identity: Identity) { return this.exclusive(async () => { const { snapshot: s, policy: p } = this.snapshot(snapshotId, identity); const result = AccessibilitySchema.parse(await this.backend.run({ op: 'accessibility', target: s.metadata, deadline: s.expiresAt, allowedApps: p.allowedApps })); this.checkPolicy(p); return result; }); }
    async action(snapshotId: string, action: DesktopAction, idempotencyKey: string, identity: Identity, gate: (policy: DesktopPolicy) => void) {
        return this.exclusive(async () => {
            this.authorize(true);
            const checked = DesktopActionSchema.parse(action), key = `desktop-action:${this.workspaceId}:${digestOf({ identity, idempotencyKey })}`, digest = digestOf({ epoch: this.epoch, snapshotId, action: checked });
            const previous = this.store.getMeta(key);
            if (previous) {
                const receipt = JSON.parse(previous) as {
                    digest: string;
                    state: string;
                    result?: {
                        posted: boolean;
                        note: string;
                    };
                };
                if (receipt.digest !== digest)
                    throw new DodoError('CONFLICT', 'idempotency key belongs to another desktop action');
                if (receipt.state === 'done' && receipt.result)
                    return { ...receipt.result, replayed: true };
                throw new DodoError('CONFLICT', 'previous action outcome is uncertain; never auto-repeat it, capture and inspect the application');
            }
            const { snapshot: s, policy: p } = this.snapshot(snapshotId, identity, true);
            for (const [x, y] of [['x', 'y'], ['toX', 'toY']] as const) {
                const a = checked as unknown as Record<string, unknown>;
                if (a[x] !== undefined && (Number(a[x]) >= s.metadata.imageWidth || Number(a[y]) >= s.metadata.imageHeight))
                    throw new DodoError('INVALID_INPUT', 'coordinates are outside the captured image');
            }
            gate(p);
            const count = (this.store.db.prepare("SELECT count(*) AS n FROM meta WHERE key LIKE 'desktop-action:%'").get() as {
                n: number;
            }).n;
            if (count >= 10000)
                throw new DodoError('RESOURCE_LIMIT', 'desktop receipt limit reached; owner maintenance required');
            this.store.setMeta(key, JSON.stringify({ digest, state: 'started' }));
            // Invalidate ALL snapshots before dispatch: even an uncertain action may have changed the UI.
            this.snapshots.clear();
            const result = z.object({ posted: z.literal(true), note: z.string().max(300) }).strict().parse(await this.backend.run({ op: 'action', target: s.metadata, action: checked, deadline: s.expiresAt, allowedApps: p.allowedApps }));
            this.store.setMeta(key, JSON.stringify({ digest, state: 'done', result }));
            return { ...result, replayed: false };
        });
    }
    async close() {
        this.closed = true;
        this.snapshots.clear();
        // Keep the receipt store alive until any owned native call has settled.
        // The native backend enforces its own per-call timeout.
        while (this.busy) await new Promise<void>(resolve => setTimeout(resolve, 10));
    }
}
