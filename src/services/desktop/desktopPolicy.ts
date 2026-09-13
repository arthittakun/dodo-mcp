import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Store } from '../../store/store.js';
import { digestOf } from '../../util/hash.js';
import { DesktopPolicySchema, DesktopModeSchema, type DesktopPolicy } from './protocol.js';

export const DesktopPolicyInputSchema = z.object({
    mode: DesktopModeSchema,
    allowedApps: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.-]{1,199}$/)).max(20).default([]),
    minutes: z.number().int().min(1).max(480).optional(),
    persistent: z.boolean().default(false),
}).strict()
    .refine(p => p.mode === 'off' || p.allowedApps.length > 0, 'choose at least one application bundle ID')
    .refine(p => !p.persistent || p.minutes === undefined, 'use --persist or --minutes, not both');

export function readDesktopPolicy(store: Store, workspaceId: string, epoch: string, now: number): DesktopPolicy {
    const off: DesktopPolicy = { mode: 'off', allowedApps: [], epoch, expiresAt: 0, persistent: false };
    const raw = store.getMeta(`desktop-policy:${workspaceId}`);
    if (!raw) return off;
    try {
        const p = DesktopPolicySchema.parse(JSON.parse(raw));
        // Persistent consent is for this exact workspace. Snapshots and action
        // approvals still bind to the new service epoch on every boot/switch.
        if (p.persistent) return { ...p, epoch };
        return p.epoch === epoch && p.expiresAt !== null && p.expiresAt > now ? p : off;
    } catch {
        return off;
    }
}

/** Local owner only: called by private IPC/config or the installed CLI. */
export function saveDesktopPolicy(store: Store, workspaceId: string, epoch: string, input: unknown, now: number): DesktopPolicy {
    const args = DesktopPolicyInputSchema.parse(input);
    const persistent = args.mode !== 'off' && args.persistent;
    const policy: DesktopPolicy = {
        mode: args.mode, allowedApps: args.mode === 'off' ? [] : [...new Set(args.allowedApps)],
        epoch, persistent, revision: randomUUID(),
        expiresAt: args.mode === 'off' ? 0 : persistent ? null : now + (args.minutes ?? 60) * 60000,
    };
    store.db.transaction(() => {
        store.setMeta(`desktop-policy:${workspaceId}`, JSON.stringify(policy));
        store.audit({ workspaceId, principal: 'local-owner', tool: 'desktop.policy', inputDigest: digestOf(policy).slice(0, 24), durationMs: 0, result: args.mode });
    })();
    return policy;
}
