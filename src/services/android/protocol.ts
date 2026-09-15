import { z } from 'zod';

export const AndroidModeSchema = z.enum(['off', 'view', 'control']);
export type AndroidMode = z.infer<typeof AndroidModeSchema>;

export const AndroidSerialSchema = z.string()
  .min(1)
  .max(200)
  .regex(/^(?!-)[!-~]+$/, 'ADB serial must be printable ASCII without whitespace and cannot start with dash');

export const AndroidPolicySchema = z.object({
  mode: AndroidModeSchema,
  allowedDevices: z.array(AndroidSerialSchema).max(20),
  epoch: z.string(),
  expiresAt: z.number().int().nonnegative().nullable(),
  persistent: z.boolean().default(false),
  revision: z.string().uuid().optional(),
}).strict()
  .refine((p) => p.persistent === (p.expiresAt === null), 'only persistent grants have no expiry')
  .refine((p) => p.mode === 'off' ? !p.persistent : p.allowedDevices.length > 0, 'enabled grants require exact devices');
export type AndroidPolicy = z.infer<typeof AndroidPolicySchema>;

export const AndroidDeviceSchema = z.object({
  serial: AndroidSerialSchema,
  state: z.enum(['device', 'offline', 'unauthorized', 'recovery', 'sideload', 'bootloader', 'unknown']),
  product: z.string().max(200).optional(),
  model: z.string().max(200).optional(),
  device: z.string().max(200).optional(),
  transportId: z.string().max(40).optional(),
}).strict();
export type AndroidDevice = z.infer<typeof AndroidDeviceSchema>;

const Coord = z.number().int().min(0).max(20_000);
export const AndroidActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('tap'), x: Coord, y: Coord }).strict(),
  z.object({ kind: z.literal('long_press'), x: Coord, y: Coord, durationMs: z.number().int().min(300).max(5000).default(800) }).strict(),
  z.object({ kind: z.literal('swipe'), fromX: Coord, fromY: Coord, toX: Coord, toY: Coord, durationMs: z.number().int().min(100).max(5000).default(300) }).strict(),
  z.object({ kind: z.literal('text'), text: z.string().min(1).max(1000) }).strict(),
  z.object({ kind: z.literal('key'), keyCode: z.string().regex(/^(?:KEYCODE_[A-Z0-9_]{1,60}|[0-9]{1,3})$/) }).strict(),
]);
export type AndroidAction = z.infer<typeof AndroidActionSchema>;

export const AndroidAppActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('launch'), packageName: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/).max(220) }).strict(),
  z.object({ kind: z.literal('start_activity'), component: z.string().regex(/^[A-Za-z][A-Za-z0-9_.]*\/[A-Za-z0-9_.$]+$/).max(440) }).strict(),
  z.object({ kind: z.literal('force_stop'), packageName: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/).max(220) }).strict(),
  z.object({ kind: z.literal('clear_data'), packageName: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/).max(220) }).strict(),
]);
export type AndroidAppAction = z.infer<typeof AndroidAppActionSchema>;

export interface AdbResult {
  code: number;
  stdout: Buffer;
  stderr: Buffer;
}

export interface AdbBackend {
  available(): boolean;
  version(): Promise<string>;
  run(args: readonly string[], opts?: { timeoutMs?: number; maxStdoutBytes?: number; maxStderrBytes?: number }): Promise<AdbResult>;
}
