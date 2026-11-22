import { z } from 'zod';
import { ResourceInfo } from '../resources/contracts.js';

/**
 * Contracts for the local Gift animation engine (engines/animation). Inputs mirror Gift's own
 * pydantic models closely so the AI sees real limits up front; the Python engine still
 * validates every request and its messages are relayed as job errors.
 */
export const ANIMATION_FORMATS = ['gif', 'webp', 'apng', 'webm', 'mp4', 'spritesheet', 'line', 'telegram'] as const;
export const VIDEO_FORMATS: ReadonlySet<string> = new Set(['webm', 'mp4', 'telegram']);
export const IMAGE_EFFECTS = ['wiggle', 'zoom', 'pan', 'bounce', 'float', 'sway', 'heartbeat', 'shake', 'spin', 'jelly'] as const;
export const CHARACTER_ACTIONS = ['blink', 'wave'] as const;
export const RIG_PRESETS = ['orange_cat', 'orange_cat_ik', 'orange_cat_idle', 'orange_cat_jump', 'fox_girl_idle', 'fox_girl_bounce', 'fox_girl_jump'] as const;

export const AnimationFormat = z.enum(ANIMATION_FORMATS).describe('gif | webp | apng | webm (transparent VP9) | mp4 (on background) | spritesheet (PNG + Aseprite JSON) | line (LINE animated sticker APNG) | telegram (Telegram video sticker WebM)');
export const RigPreset = z.enum(RIG_PRESETS);
const Fraction = z.number().min(0).max(1);
const Point = z.tuple([Fraction, Fraction]);
const Outline = z.array(Point).min(3).max(40);
const Radius = z.number().gt(0).max(0.25);
const Degrees = z.number().min(-65).max(65);
export const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export const Eye = z.tuple([Fraction, Fraction, Radius, Radius]).describe('(x, y, horizontal_radius, vertical_radius) normalized to the full image');
export const Arm = z.tuple([Fraction, Fraction, Fraction, Fraction, Fraction, Fraction, Radius]).describe('(shoulder_x, shoulder_y, elbow_x, elbow_y, hand_x, hand_y, radius); radius is relative to the shorter side');

export const Caption = z.object({
  text: z.string().min(1).max(80),
  position: z.enum(['top', 'bottom']).default('bottom'),
  color: HexColor.default('#FFFFFF'),
  outline: HexColor.default('#3A2414'),
  size: z.number().min(0.05).max(0.3).default(0.13),
  motion: z.enum(['none', 'bounce', 'pulse', 'wiggle', 'pop']).default('bounce'),
  overlap: z.boolean().default(false),
}).strict().describe('Sticker text drawn with the bundled Sarabun font (Thai and Latin)');

const Physics = z.object({
  strength: z.number().min(4).max(400).optional(), damping: z.number().min(0.05).max(1.5).optional(),
  inertia: z.number().min(0).max(8).optional(), whip: Fraction.optional(), wind: z.number().min(0).max(30).optional(),
  limit_deg: z.number().min(5).max(80).optional(),
}).strict().describe('Spring follow-through: stiffness, damping ratio, how much body motion throws the part, outer-half lag, gusty sway (deg) and soft swing cap');
const FootIK = z.object({ knee: Point, stance_fraction: z.number().min(0.5).max(0.85).optional(), foot_fraction: z.number().min(0.6).max(0.95).optional() }).strict();
const RigPart = z.object({
  name: z.string().min(1).max(48),
  polygon: Outline.describe('Outline of the part, normalized (x, y) points'),
  root: Point.describe('Pivot where the part joins the body'), tip: Point,
  motion: z.enum(['step', 'wave', 'swing']),
  phase_offset: Fraction.optional(), movement_x: z.number().min(-0.25).max(0.25).optional(), movement_y: z.number().min(0).max(0.25).optional(),
  rotation_deg: Degrees.optional(), rotation_bias: Degrees.optional(), anchor_fraction: z.number().min(0.07).max(0.6).optional(),
  behind: z.boolean().optional().describe('Draw behind the body; hidden paint is filled in so a swinging part never shows a hole'),
  cut_polygon: Outline.optional(), foot_ik: FootIK.optional(), physics: Physics.optional(),
  seeds: z.array(Point).min(1).max(8).optional().describe("Points on the part's own paint: the part is cut along the drawing's line art from these, so nothing tears"),
}).strict();
const BodyMotion = z.object({
  style: z.enum(['bob', 'breathe', 'jump']).optional(), bob: z.number().min(0).max(0.04).optional(), squash: Fraction.optional(),
  beats: z.number().int().min(1).max(4).optional(), phase_offset: Fraction.optional(), jump_height: z.number().min(0).max(0.5).optional(),
  jump_squash: z.number().min(0).max(0.3).optional(), ground_y: Fraction.optional(), center_x: Fraction.optional(),
}).strict();
const Blink = z.object({ eyes: z.array(Eye).min(1).max(2).optional(), count: z.number().int().min(1).max(4).optional(), double: z.boolean().optional() }).strict();
export const AnimationRig = z.object({
  parts: z.array(RigPart).min(1).max(8), cycles: z.number().int().min(1).max(6).optional(),
  body: BodyMotion.optional(), blink: Blink.optional(),
}).strict().describe('Gift rig format (snake_case, same JSON the Gift rig editor saves): up to 8 layered parts plus optional body motion and blinks');

/** Fields shared by every render: how the loop is encoded. */
export const ExportFields = {
  format: AnimationFormat.default('gif'),
  caption: Caption.optional(),
  edgeMatte: HexColor.optional().describe('GIF only: blend soft edges onto the page color the GIF will sit on'),
  gifDither: z.boolean().default(false),
  background: HexColor.default('#FFFFFF').describe('Background for mp4, which has no transparency'),
  loops: z.number().int().min(1).max(4).optional().describe('Fixed play count for webp/apng/line; omitted loops forever (LINE defaults to its 4 s limit)'),
  maxSide: z.number().int().min(128).max(800).optional().describe('Scale the loop so its longer side is at most this many pixels, for lighter chat files (e.g. 480). Default keeps up to 800 px; a long 800 px GIF can exceed media_save\'s 8 MiB budget, so prefer webp, a smaller maxSide or download_link_create'),
};

export const AnimationCheck = z.object({ id: z.string().max(64), status: z.enum(['pass', 'fail', 'skipped']), detail: z.string().max(2000), metrics: z.record(z.string(), z.unknown()) });
export const AnimationDetails = z.object({ format: z.string().max(20), width: z.number().int().positive(), height: z.number().int().positive(), frames: z.number().int().positive(), durationMs: z.number().int().nonnegative(), bytes: z.number().int().positive(), loops: z.number().int().nonnegative() }).strict();
/** Motions a generated pose sheet can show. `custom` takes one description per cell after the first. */
export const FRAME_MOTIONS = ['wave', 'walk', 'idle', 'jump', 'custom'] as const;
const Box = z.tuple([z.number().int().min(0).max(4096), z.number().int().min(0).max(4096), z.number().int().min(0).max(4096), z.number().int().min(0).max(4096)]);
/** The layout animation_frames_plan returns; pass it back unchanged to animation_sprite. */
export const AnimationLayout = z.object({
  poses: z.union([z.literal(8), z.literal(16)]), columns: z.literal(4), rows: z.union([z.literal(2), z.literal(4)]),
  sheet: z.tuple([z.number().int().min(64).max(4096), z.number().int().min(64).max(4096)]),
  cells: z.array(Box).min(8).max(16), inner: z.array(Box).min(8).max(16), ground: z.array(z.number().int().min(0).max(4096)).min(8).max(16),
  figure_height: z.number().int().positive().max(4096), figure_width: z.number().int().positive().max(4096), motion: z.enum(FRAME_MOTIONS),
}).strict().refine(layout => layout.cells.length === layout.poses && layout.inner.length === layout.poses && layout.ground.length === layout.poses, 'layout cells must match its pose count')
  .describe('The layout object from animation_frames_plan, passed back unchanged');

export const AnimationJob = z.object({
  jobId: z.string(), kind: z.enum(['image', 'rig', 'sprite', 'plan', 'banner', 'scene']), status: z.enum(['running', 'completed', 'failed']),
  animation: ResourceInfo.nullable(), companions: z.array(ResourceInfo).max(2), preview: ResourceInfo.nullable(),
  details: AnimationDetails.nullable(), checks: z.array(AnimationCheck).max(12), passed: z.boolean().nullable(),
  notes: z.array(z.string()).max(12), error: z.string().nullable(), createdAt: z.number(), expiresAt: z.number(),
  plan: z.object({ prompt: z.string(), size: z.string(), layout: z.record(z.string(), z.unknown()), guide: ResourceInfo, mask: ResourceInfo }).nullable().optional(),
});
export type AnimationJobData = z.infer<typeof AnimationJob>;
export type AnimationKind = AnimationJobData['kind'];

/** What the Python bridge writes to result.json. File names are fixed by the bridge. */
const OutputName = z.string().regex(/^(?:animation\.(?:gif|webp|png|webm|mp4|json)|preview\.png)$/);
export const BridgeResult = z.object({
  version: z.literal(1), operation: z.enum(['image', 'rig', 'sprite', 'plan', 'banner', 'scene']), error: z.string().max(2000).nullable(),
  animation: z.object({ file: OutputName, mimeType: z.enum(['image/gif', 'image/webp', 'image/png', 'video/webm', 'video/mp4']), format: z.string().max(20), width: z.number().int().positive(), height: z.number().int().positive(), frames: z.number().int().positive(), durationMs: z.number().int().nonnegative(), bytes: z.number().int().positive(), loops: z.number().int().nonnegative() }).strict().nullable(),
  companions: z.array(z.object({ file: OutputName, mimeType: z.literal('application/json') }).strict()).max(2),
  preview: z.object({ file: z.literal('preview.png') }).strict().nullable(),
  checks: z.array(AnimationCheck).max(12), passed: z.boolean().nullable(), notes: z.array(z.string().max(2000)).max(12),
  plan: z.object({ prompt: z.string().min(1).max(8000), layout: AnimationLayout, size: z.enum(['1536x1024', '1024x1536']), guide: z.object({ file: z.literal('guide.png') }).strict(), mask: z.object({ file: z.literal('mask.png') }).strict() }).strict().nullable(),
}).strict();
export type BridgeResultData = z.infer<typeof BridgeResult>;

/** The private spec the worker hands to Python. Paths are backend-chosen, never client input. */
export const AnimationWorkerSpec = z.object({
  version: z.literal(1), operation: z.enum(['image', 'rig', 'sprite', 'plan', 'banner', 'scene']), directory: z.string().min(1),
  python: z.string().min(1), bridge: z.string().min(1), ffmpeg: z.string().min(1).nullable(),
  params: z.record(z.string(), z.unknown()),
}).strict();
export type AnimationWorkerSpecData = z.infer<typeof AnimationWorkerSpec>;
