import { z } from 'zod';
export const DesktopModeSchema = z.enum(['off', 'view', 'control']);
export const DesktopPolicySchema = z.object({
    mode: DesktopModeSchema,
    allowedApps: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.-]{1,199}$/)).max(20),
    epoch: z.string(),
    expiresAt: z.number().int().nonnegative().nullable(),
    persistent: z.boolean().default(false),
    revision: z.string().uuid().optional(),
}).strict().refine(p => p.persistent === (p.expiresAt === null), 'only persistent grants have no expiry')
    .refine(p => p.mode === 'off' ? !p.persistent : p.allowedApps.length > 0, 'enabled grants require exact apps');
export type DesktopPolicy = z.infer<typeof DesktopPolicySchema>;
export const BoundsSchema = z.object({ x: z.number().finite(), y: z.number().finite(), width: z.number().positive(), height: z.number().positive() }).strict();
export const WindowSchema = z.object({ windowId: z.number().int().positive(), pid: z.number().int().positive(), appId: z.string().max(200), title: z.string().max(300), processIdentity: z.string().max(128).optional(), bounds: BoundsSchema }).strict();
export type DesktopWindow = z.infer<typeof WindowSchema>;
export const CaptureSchema = WindowSchema.extend({
    imageWidth: z.number().int().min(1).max(2000), imageHeight: z.number().int().min(1).max(2000),
    mimeType: z.literal('image/jpeg'), image: z.string().max(4 * 1024 * 1024),
    ocr: z.array(z.object({ text: z.string().max(500), confidence: z.number(), x: z.number(), y: z.number(), width: z.number(), height: z.number() }).strict()).max(150).optional(),
    ocrTruncated: z.boolean().optional(),
}).strict();
export type DesktopCapture = z.infer<typeof CaptureSchema>;
const point = { x: z.number().finite().min(0).max(2000), y: z.number().finite().min(0).max(2000) };
export const DesktopActionSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('focus') }).strict(),
    z.object({ kind: z.literal('move'), ...point }).strict(),
    z.object({ kind: z.literal('click'), ...point, button: z.enum(['left', 'right']).default('left'), count: z.number().int().min(1).max(2).default(1) }).strict(),
    z.object({ kind: z.literal('drag'), ...point, toX: point.x, toY: point.y }).strict(),
    z.object({ kind: z.literal('scroll'), ...point, deltaX: z.number().int().min(-1000).max(1000).default(0), deltaY: z.number().int().min(-1000).max(1000) }).strict(),
    z.object({ kind: z.literal('type'), text: z.string().min(1).max(2000) }).strict(),
    z.object({ kind: z.literal('key'), key: z.string().regex(/^(?:[a-z0-9]|f[1-9]|f1[0-2]|enter|tab|space|backspace|escape|delete|left|right|down|up|home|end|pageup|pagedown)$/), modifiers: z.array(z.enum(['command', 'control', 'option', 'shift'])).max(4).default([]) }).strict(),
]);
export type DesktopAction = z.infer<typeof DesktopActionSchema>;
export interface DesktopBackend {
    available(): boolean;
    run(request: Record<string, unknown>): Promise<unknown>;
}
export const NativeStatusSchema = z.object({ screenRecording: z.boolean(), accessibility: z.boolean(), platform: z.enum(['darwin', 'win32', 'linux']), backend: z.string() }).strict();
export const AccessibilitySchema = z.object({ elements: z.array(z.object({ role: z.string().max(100), depth: z.number().int().min(0).max(6), redacted: z.boolean().optional(), title: z.string().max(300).optional(), description: z.string().max(300).optional(), value: z.string().max(300).optional() }).strict()).max(100), truncated: z.boolean() }).strict();
