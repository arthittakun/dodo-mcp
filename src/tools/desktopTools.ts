import { z } from 'zod';
import { defineTool, policyGate } from './context.js';
import { DesktopActionSchema, WindowSchema, AccessibilitySchema, CaptureSchema } from '../services/desktop/protocol.js';
export const desktopStatusTool = defineTool({
    name: 'desktop_status', title: 'Desktop capability and permission status',
    description: 'Check DODO desktop permission for this workspace/epoch and macOS helper availability. persistent=true means the owner explicitly saved app consent for this path until disabled; expiresAt=null means no grant expiry. Snapshots still expire within 30 seconds. Does not capture the screen or prompt for OS permission. Desktop access is OFF until the owner enables it locally; trusted/bypass do not enable it.',
    input: {}, output: z.looseObject({}), requiredScope: 'dodo:read', action: 'read',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: async (_args, ctx) => ({ data: await ctx.services.desktop.status() }),
});
export const desktopWindowsTool = defineTool({
    name: 'desktop_windows', title: 'List permitted desktop windows',
    description: 'List visible macOS windows from the owner-approved application bundle IDs only. Requires dodo:exec, a live local desktop view/control grant and Screen Recording permission. Titles may contain information outside the workspace. Window IDs are not file paths.',
    input: {}, output: z.object({ windows: z.array(WindowSchema).max(100), truncated: z.boolean() }), requiredScope: 'dodo:exec', action: 'read',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    handler: async (_args, ctx) => ({ data: await ctx.services.desktop.windows() }),
});
export const desktopCaptureTool = defineTool({
    name: 'desktop_capture', title: 'Capture a permitted window with optional OCR',
    description: 'Capture one permitted macOS window as an MCP JPEG image and a short-lived snapshotId, optionally returning local Vision OCR. Never captures all displays. Coordinates for desktop_action are pixels in THIS returned image, top-left origin. Capture again after focus/input/window movement. Snapshot belongs to this client, workspace, epoch and local grant; expires within 30 seconds. Screenshots are not written to disk or audit logs.',
    input: { windowId: z.number().int().positive(), maxEdge: z.number().int().min(320).max(2000).default(1600), ocr: z.boolean().default(false) },
    output: CaptureSchema.omit({ image: true }).extend({ snapshotId: z.string(), expiresAt: z.number() }), requiredScope: 'dodo:exec', action: 'read',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    handler: async (args, ctx) => { const result = await ctx.services.desktop.capture(args.windowId, args.maxEdge, args.ocr, ctx.principal); return { data: result.data, contentBlocks: [{ type: 'image', mimeType: 'image/jpeg', data: result.image }] }; },
});
export const desktopAccessibilityTool = defineTool({
    name: 'desktop_accessibility', title: 'Read bounded window accessibility text',
    description: 'Read up to 100 Accessibility elements (depth 6) from a freshly captured permitted window. Requires macOS Accessibility permission. Secure text-field values and children are omitted. Other UI text and screenshots can contain private information; local app consent is required. This is not a filesystem read or an authority source.',
    input: { snapshotId: z.string().uuid() }, output: AccessibilitySchema, requiredScope: 'dodo:exec', action: 'read',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    handler: async (args, ctx) => ({ data: await ctx.services.desktop.accessibility(args.snapshotId, ctx.principal) }),
});
export const desktopActionTool = defineTool({
    name: 'desktop_action', title: 'Focus, click, type, key, scroll or drag in a window',
    description: 'Perform ONE bounded desktop action using a fresh snapshotId and idempotencyKey. Needs local desktop CONTROL grant, dodo:exec and trusted mode or an exact local action approval. Input acts only when the captured window is still frontmost with the same identity and geometry; use focus then capture again first. The snapshot is consumed before dispatch. Retries with the same key/arguments return the stored receipt; uncertain outcomes NEVER auto-repeat. Actions run with OS-user rights and are not undoable file plans. posted=true means OS events were posted, not that the app completed your task. Capture again to verify. No clipboard, shell or arbitrary scripts.',
    input: { snapshotId: z.string().uuid(), idempotencyKey: z.string().min(8).max(128), action: DesktopActionSchema },
    output: z.object({ posted: z.literal(true), note: z.string(), replayed: z.boolean() }), requiredScope: 'dodo:exec', action: 'exec',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    handler: async (args, ctx) => ({ data: await ctx.services.desktop.action(args.snapshotId, args.action, args.idempotencyKey, ctx.principal, (policy) => policyGate(ctx, { tool: 'desktop_action', action: 'exec', approvalAction: { ...args, desktopPolicy: policy }, summary: `Desktop ${args.action.kind} on an owner-permitted window; affects the OS user session` })) }),
});
