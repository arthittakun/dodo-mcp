import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Store } from '../../store/store.js';
import { digestOf } from '../../util/hash.js';
import { DesktopPolicySchema, DesktopModeSchema, type DesktopPolicy } from './protocol.js';

const INSTALLATION_POLICY_KEY = 'desktop-policy:installation';
const workspacePolicyKey = (workspaceId: string) => `desktop-policy:${workspaceId}`;

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
    // A temporary grant remains workspace/epoch bound. A persistent grant is
    // installation-scoped because native Chrome/desktop access is an OS-user
    // capability, not a filesystem capability. Every actual call still checks
    // OAuth exec scope, target workspace context, trust and a fresh snapshot.
    const temporary = store.getMeta(workspacePolicyKey(workspaceId));
    if (temporary) {
        try {
            const p = DesktopPolicySchema.parse(JSON.parse(temporary));
            if (!p.persistent && p.epoch === epoch && p.expiresAt !== null && p.expiresAt > now) return p;
        } catch { /* ignore invalid private state and fail closed */ }
    }
    const installed = store.getMeta(INSTALLATION_POLICY_KEY);
    if (installed) {
        try {
            const p = DesktopPolicySchema.parse(JSON.parse(installed));
            if (p.persistent && p.mode !== 'off') return { ...p, epoch };
        } catch { /* ignore invalid private state and fail closed */ }
    }
    // Preserve legacy workspace-scoped persistent grants until the owner next
    // changes them; do not silently expand one old project grant installation-wide.
    if (temporary) {
        try {
            const legacy = DesktopPolicySchema.parse(JSON.parse(temporary));
            if (legacy.persistent && legacy.mode !== 'off') return { ...legacy, epoch };
        } catch { /* fail closed */ }
    }
    return off;
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
        if (args.mode === 'off') {
            store.db.prepare("DELETE FROM meta WHERE key LIKE 'desktop-policy:%'").run();
            store.setMeta(INSTALLATION_POLICY_KEY, JSON.stringify(policy));
        } else if (persistent) {
            store.db.prepare("DELETE FROM meta WHERE key LIKE 'desktop-policy:%'").run();
            store.setMeta(INSTALLATION_POLICY_KEY, JSON.stringify(policy));
        } else {
            store.setMeta(workspacePolicyKey(workspaceId), JSON.stringify(policy));
        }
        store.audit({ workspaceId, principal: 'local-owner', tool: 'desktop.policy', inputDigest: digestOf(policy).slice(0, 24), durationMs: 0, result: args.mode });
    })();
    return policy;
}
