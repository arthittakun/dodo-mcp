import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Store } from '../../store/store.js';
import { digestOf } from '../../util/hash.js';
import { AndroidModeSchema, AndroidPolicySchema, AndroidSerialSchema, type AndroidPolicy } from './protocol.js';

const INSTALLATION_POLICY_KEY = 'android-policy:installation';
const workspacePolicyKey = (workspaceId: string) => `android-policy:${workspaceId}`;

export const AndroidPolicyInputSchema = z.object({
  mode: AndroidModeSchema,
  allowedDevices: z.array(AndroidSerialSchema).max(20).default([]),
  minutes: z.number().int().min(1).max(480).optional(),
  persistent: z.boolean().default(false),
}).strict()
  .refine((p) => p.mode === 'off' || p.allowedDevices.length > 0, 'choose at least one exact ADB serial')
  .refine((p) => !p.persistent || p.minutes === undefined, 'use persistent or minutes, not both');

export function readAndroidPolicy(store: Store, workspaceId: string, epoch: string, now = Date.now()): AndroidPolicy {
  const off: AndroidPolicy = { mode: 'off', allowedDevices: [], epoch, expiresAt: 0, persistent: false };
  const temporary = store.getMeta(workspacePolicyKey(workspaceId));
  if (temporary) {
    try {
      const parsed = AndroidPolicySchema.parse(JSON.parse(temporary));
      if (!parsed.persistent && parsed.epoch === epoch && parsed.expiresAt !== null && parsed.expiresAt > now) return parsed;
    } catch { /* corrupt private state fails closed */ }
  }
  const installed = store.getMeta(INSTALLATION_POLICY_KEY);
  if (installed) {
    try {
      const parsed = AndroidPolicySchema.parse(JSON.parse(installed));
      if (parsed.persistent && parsed.mode !== 'off') return { ...parsed, epoch };
    } catch { /* corrupt private state fails closed */ }
  }
  return off;
}

/** Local owner control only. This is deliberately absent from the MCP catalog. */
export function saveAndroidPolicy(store: Store, workspaceId: string, epoch: string, input: unknown, now = Date.now()): AndroidPolicy {
  const args = AndroidPolicyInputSchema.parse(input);
  const persistent = args.mode !== 'off' && args.persistent;
  const policy: AndroidPolicy = {
    mode: args.mode,
    allowedDevices: args.mode === 'off' ? [] : [...new Set(args.allowedDevices)],
    epoch,
    persistent,
    revision: randomUUID(),
    expiresAt: args.mode === 'off' ? 0 : persistent ? null : now + (args.minutes ?? 60) * 60_000,
  };
  store.db.transaction(() => {
    if (args.mode === 'off' || persistent) {
      store.db.prepare("DELETE FROM meta WHERE key LIKE 'android-policy:%'").run();
      store.setMeta(INSTALLATION_POLICY_KEY, JSON.stringify(policy));
    } else {
      store.setMeta(workspacePolicyKey(workspaceId), JSON.stringify(policy));
    }
    store.audit({ workspaceId, principal: 'local-owner', tool: 'android.policy', inputDigest: digestOf(policy).slice(0, 24), durationMs: 0, result: args.mode });
  })();
  return policy;
}
