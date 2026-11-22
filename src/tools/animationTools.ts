import { z } from 'zod';
import { DodoError } from '../errors.js';
import { defineTool, type AnyToolDef, type ToolCtx } from './context.js';
import { Id, Key, Path } from '../services/multimodal/contracts.js';
import { liveAccess } from '../services/multimodal/storage.js';
import { multimediaEffect } from '../services/multimodal/operations.js';
import {
  ANIMATION_FORMATS, CHARACTER_ACTIONS, FRAME_MOTIONS, IMAGE_EFFECTS,
  AnimationJob, AnimationLayout, AnimationRig, Arm, Eye, ExportFields, HexColor, RigPreset, type AnimationJobData,
} from '../services/multimodal/animationContracts.js';

/**
 * Local looping animations with the vendored Gift engine: whole-image effects, rigged characters
 * with spring physics and blinks, and sprite-sheet assembly. Everything renders on this machine as
 * an owned, network-less job; no model or API is called and nothing costs money.
 */
const render = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const source = {
  path: Path.optional().describe('Workspace image path (needs that project context)'),
  assetId: Id.optional().describe('Owned image asset'),
  resourceId: Id.optional().describe('Owned image resource, e.g. from image_generate, image_crop or image_remove_background'),
};
const Fraction = z.number().min(0).max(1);
const WaitMs = z.number().int().min(0).max(170000).default(120000).describe('Wait this long for the render (typical: 5-40 s); if still running, collect it with animation_job');
const Output = AnimationJob.extend({ replayed: z.boolean().optional() });

function use(ctx: ToolCtx, scope: 'dodo:read' | 'dodo:exec' = 'dodo:exec') {
  liveAccess(ctx, scope); const mm = ctx.services.multimodal;
  if (!mm) throw new DodoError('NOT_SUPPORTED', 'animation needs the multimodal media service'); mm.storage.check(); return mm;
}

/** Export options in the engine's snake_case, without unset keys. */
function exportParams(args: { format: string; caption?: unknown; edgeMatte?: string | undefined; gifDither: boolean; background: string; loops?: number | undefined; maxSide?: number | undefined }) {
  return {
    format: args.format, gif_dither: args.gifDither, background: args.background,
    ...(args.caption !== undefined ? { caption: args.caption } : {}),
    ...(args.edgeMatte !== undefined ? { edge_matte: args.edgeMatte } : {}),
    ...(args.loops !== undefined ? { loops: args.loops } : {}),
    ...(args.maxSide !== undefined ? { max_side: args.maxSide } : {}),
  };
}

function pickSource(args: { path?: string | undefined; assetId?: string | undefined; resourceId?: string | undefined }) {
  const chosen = { ...(args.path !== undefined ? { path: args.path } : {}), ...(args.assetId !== undefined ? { assetId: args.assetId } : {}), ...(args.resourceId !== undefined ? { resourceId: args.resourceId } : {}) };
  if (Object.keys(chosen).length > 1) throw new DodoError('INVALID_INPUT', 'provide one source: path, assetId or resourceId');
  return Object.keys(chosen).length ? chosen : undefined;
}

/** Attach the six-frame contact sheet so the client can see the motion without downloading the file. */
async function withPreview(ctx: ToolCtx, data: AnimationJobData & { replayed?: boolean }) {
  if (!data.preview) return { data };
  try {
    const preview = await ctx.services.resources!.preview(ctx, data.preview.resourceId, 1024);
    return { data, ...(preview.block ? { contentBlocks: [preview.block] } : {}) };
  } catch { return { data }; }
}

const catalog = defineTool({
  name: 'animation_catalog', title: 'List local animation presets, effects and formats',
  description: 'Read what the local Gift animation engine can make and whether it is ready: bundled character presets (orange cat and anime fox girl: walk, IK walk, idle, bounce, jump), whole-image effects, blink/wave, export formats (GIF, WebP, APNG, WebM, MP4, sprite sheet, LINE and Telegram stickers) and setup status. No rendering, network or cost.',
  input: {},
  output: z.object({
    ready: z.boolean(), python: z.object({ available: z.boolean(), source: z.enum(['env', 'venv']).nullable() }), ffmpeg: z.boolean(),
    engine: z.object({ verified: z.boolean(), problem: z.string().optional() }), setup: z.string(),
    presets: z.array(z.object({ name: RigPreset, character: z.enum(['orange_cat', 'fox_girl']), title: z.string(), motion: z.string() })),
    characters: z.array(z.string()), imageEffects: z.array(z.enum(IMAGE_EFFECTS)), characterActions: z.array(z.enum(CHARACTER_ACTIONS)),
    formats: z.array(z.object({ format: z.enum(ANIMATION_FORMATS), mimeType: z.string(), transparent: z.boolean(), note: z.string() })),
    spriteSheet: z.string(), limits: z.record(z.string(), z.unknown()), note: z.string(),
  }),
  requiredScope: 'dodo:read', action: 'read', optionalWorkspaceContext: true, annotations: read,
  handler: async (_args, ctx) => ({ data: use(ctx, 'dodo:read').animation.catalog() }),
});

const image = defineTool({
  name: 'animation_image', title: 'Animate a still image into a smooth loop',
  description: 'Turn ONE still cartoon or photo (resourceId, assetId or workspace path) into a seamless loop, rendered locally with premultiplied-alpha supersampling. actions: ONE whole-image effect (wiggle, zoom, pan, bounce, float, sway, heartbeat, shake, spin, jelly) or blink and/or wave on a clean front-facing drawing (optional eyes/arm landmarks, normalized to the image). Transparent subjects get room to move instead of being cropped. Add caption for Thai or Latin sticker text. Returns animation, optional companion and a contact-sheet preview as owned resources; use media_save or download_link_create to deliver.',
  input: {
    ...source,
    actions: z.array(z.enum([...IMAGE_EFFECTS, ...CHARACTER_ACTIONS])).min(1).max(2),
    duration: z.number().min(1).max(5).default(2.5), fps: z.number().int().min(8).max(50).default(20),
    eyes: z.array(Eye).min(1).max(2).optional(), arm: Arm.optional(),
    strength: z.number().min(0.1).max(1.5).default(1).describe('blink/wave only'),
    quality: z.number().int().min(0).max(100).default(86).describe('WebP quality'), lossless: z.boolean().default(false),
    motionBlur: z.boolean().optional().describe('Sub-frame blur for fast effects; on by default for line'),
    ...ExportFields, waitMs: WaitMs, idempotencyKey: Key,
  },
  output: Output, requiredScope: 'dodo:exec', action: 'exec', optionalWorkspaceContext: true, annotations: render,
  handler: async (args, ctx) => {
    const mm = use(ctx), { idempotencyKey, waitMs, path, assetId, resourceId, ...rest } = args;
    const chosen = pickSource({ path, assetId, resourceId });
    if (!chosen) throw new DodoError('INVALID_INPUT', 'animation_image needs one source image: resourceId, assetId or path');
    const params = {
      ...exportParams(rest), actions: rest.actions, duration: rest.duration, fps: rest.fps, strength: rest.strength, quality: rest.quality, lossless: rest.lossless,
      ...(rest.eyes ? { eyes: rest.eyes } : {}), ...(rest.arm ? { arm: rest.arm } : {}), ...(rest.motionBlur !== undefined ? { motion_blur: rest.motionBlur } : {}),
    };
    const data = await multimediaEffect(ctx, 'animation_image', idempotencyKey, { source: chosen, params }, () => mm.animation.start(ctx, 'image', chosen, params, waitMs));
    return withPreview(ctx, data);
  },
});

const rig = defineTool({
  name: 'animation_rig', title: 'Animate a rigged 2D character',
  description: 'Render a rigged character loop locally with spring physics (ears, tail, hands follow through), natural blinks and body motion (bob, breathe, jump with anticipation and squash). Use a bundled preset (orange_cat, orange_cat_ik, orange_cat_idle, orange_cat_jump, fox_girl_idle, fox_girl_bounce, fox_girl_jump; see animation_catalog) with its own art, or a custom rig in Gift format on ONE source image: give parts seeds on their own paint so they are cut along the line art and never tear. Returns the animation plus Gift loop-review checks (loop seam, body drift, limbs attached, part seams, foot lock); report any failed check and notes to the user.',
  input: {
    preset: RigPreset.optional(), rig: AnimationRig.optional(), ...source,
    duration: z.number().min(1).max(8).default(3), fps: z.number().int().min(8).max(50).default(25),
    antialias: z.boolean().default(true).describe('Render at 2x and downsample for smooth edges'),
    motionBlur: z.boolean().optional().describe('Soften fast limbs; on by default for line except jumps'),
    bodyCore: z.tuple([Fraction, Fraction, Fraction, Fraction]).optional().describe('Stable face/torso box (left, top, right, bottom) for the body-drift check of a custom rig'),
    ...ExportFields, waitMs: WaitMs, idempotencyKey: Key,
  },
  output: Output, requiredScope: 'dodo:exec', action: 'exec', optionalWorkspaceContext: true, annotations: render,
  handler: async (args, ctx) => {
    const mm = use(ctx), { idempotencyKey, waitMs, path, assetId, resourceId, ...rest } = args;
    if ((rest.preset === undefined) === (rest.rig === undefined)) throw new DodoError('INVALID_INPUT', 'choose one preset or provide one custom rig');
    const chosen = pickSource({ path, assetId, resourceId });
    if (rest.rig && !chosen) throw new DodoError('INVALID_INPUT', 'a custom rig needs the source image it was drawn on');
    const params = {
      ...exportParams(rest), duration: rest.duration, fps: rest.fps, antialias: rest.antialias,
      ...(rest.preset ? { preset: rest.preset } : {}), ...(rest.rig ? { rig: rest.rig } : {}),
      ...(rest.motionBlur !== undefined ? { motion_blur: rest.motionBlur } : {}), ...(rest.bodyCore ? { body_core: rest.bodyCore } : {}),
    };
    const data = await multimediaEffect(ctx, 'animation_rig', idempotencyKey, { source: chosen ?? null, params }, () => mm.animation.start(ctx, 'rig', chosen, params, waitMs));
    return withPreview(ctx, data);
  },
});

const sprite = defineTool({
  name: 'animation_sprite', title: 'Assemble a pose sheet into a loop',
  description: 'Assemble ONE transparent PNG pose sheet (4 columns by 2 rows = 8 poses, or 4 rows = 16 poses, row-major) into an aligned, seamless loop. Poses are kept intact and aligned on their heads and baseline; walk contact poses hold slightly longer. For a sheet drawn with image_edit from an animation_frames_plan, pass layout (the plan\'s layout, unchanged) and reference (the character): the sheet is first checked against the plan (one whole figure per cell, transparent background, consistent size, shared ground line, same colours as the reference, distinct poses) and small size drift is scaled back. Report failed checks to the user before redrawing; another image_edit is a new paid request. Returns owned resources and a preview.',
  input: {
    ...source, motion: z.enum(FRAME_MOTIONS).describe('wave, walk, idle, jump or custom; use the plan\'s motion for a planned sheet'),
    poses: z.union([z.literal(8), z.literal(16)]).default(8),
    duration: z.number().min(0.8).max(5).optional().describe('Loop length; default 1.0 s for walk, 1.6 s otherwise'),
    layout: AnimationLayout.optional(), reference: z.object(source).strict().optional().describe('The character the sheet was drawn from, for the colour check'),
    ...ExportFields, waitMs: WaitMs, idempotencyKey: Key,
  },
  output: Output, requiredScope: 'dodo:exec', action: 'exec', optionalWorkspaceContext: true, annotations: render,
  handler: async (args, ctx) => {
    const mm = use(ctx), { idempotencyKey, waitMs, path, assetId, resourceId, layout, reference, ...rest } = args;
    const chosen = pickSource({ path, assetId, resourceId });
    if (!chosen) throw new DodoError('INVALID_INPUT', 'animation_sprite needs the pose sheet as resourceId, assetId or path');
    if (layout && (layout.poses !== rest.poses || layout.motion !== rest.motion)) throw new DodoError('INVALID_INPUT', 'motion and poses must match the plan\'s layout');
    const picked = reference ? pickSource(reference) : undefined;
    const params = { ...exportParams(rest), motion: rest.motion, poses: rest.poses, ...(rest.duration !== undefined ? { duration: rest.duration } : {}), ...(layout ? { layout } : {}) };
    const data = await multimediaEffect(ctx, 'animation_sprite', idempotencyKey, { source: chosen, params, reference: picked ?? null }, () => mm.animation.start(ctx, 'sprite', chosen, params, waitMs, { reference: picked }));
    return withPreview(ctx, data);
  },
});

const framesPlan = defineTool({
  name: 'animation_frames_plan', title: 'Plan frames for an image model to draw',
  description: 'Prepare a frame-by-frame animation that an image model draws, with conditions that keep it accurate. From ONE transparent character image it builds, locally and for free: guide (the sheet with the character in cell 1 at the size and ground line every frame must use), mask (only the other cells may be repainted, so cell 1 and the gutters stay fixed), a prompt listing one pose per cell, the sheet size and the layout. motion: wave, walk, idle (breathing and a blink), jump (with room to leave the ground) or custom with customPoses (one description per cell after the first). Next: image_edit with images [plan.guide, the character], mask plan.mask, prompt plan.prompt, size plan.size, background transparent; collect it with creative_job; then animation_sprite with that sheet, the same motion and poses, layout plan.layout and reference the character, which checks the sheet before assembling it.',
  input: {
    ...source, motion: z.enum(FRAME_MOTIONS), poses: z.union([z.literal(8), z.literal(16)]).default(8).describe('16 adds in-betweens (wave, walk and custom)'),
    customPoses: z.array(z.string().trim().min(1).max(200)).min(7).max(15).optional().describe('For motion custom: 7 (or 15) pose descriptions for cells 2..N in loop order'),
    waitMs: WaitMs, idempotencyKey: Key,
  },
  output: Output, requiredScope: 'dodo:exec', action: 'exec', optionalWorkspaceContext: true, annotations: render,
  handler: async (args, ctx) => {
    const mm = use(ctx), { idempotencyKey, waitMs, path, assetId, resourceId, motion, poses, customPoses } = args;
    const chosen = pickSource({ path, assetId, resourceId });
    if (!chosen) throw new DodoError('INVALID_INPUT', 'animation_frames_plan needs the character image as resourceId, assetId or path');
    if ((motion === 'custom') !== (customPoses !== undefined)) throw new DodoError('INVALID_INPUT', 'customPoses goes with motion custom, and motion custom needs customPoses');
    if (customPoses && customPoses.length !== poses - 1) throw new DodoError('INVALID_INPUT', `customPoses needs ${poses - 1} descriptions for ${poses} poses`);
    if (poses === 16 && (motion === 'idle' || motion === 'jump')) throw new DodoError('INVALID_INPUT', `${motion} sheets have 8 poses`);
    const params = { motion, poses, ...(customPoses ? { custom: customPoses } : {}) };
    const data = await multimediaEffect(ctx, 'animation_frames_plan', idempotencyKey, { source: chosen, params }, () => mm.animation.start(ctx, 'plan', chosen, params, waitMs));
    return withPreview(ctx, data);
  },
});

const job = defineTool({
  name: 'animation_job', title: 'Collect a local animation render',
  description: 'Read one of your animation_image/animation_rig/animation_sprite jobs, optionally waiting for it to finish. Never starts another render. Completed jobs return the animation, companions and contact-sheet preview as owned resources, plus review checks for rigs.',
  input: { jobId: Id, waitMs: z.number().int().min(0).max(120000).default(30000) },
  output: AnimationJob, requiredScope: 'dodo:exec', action: 'read', optionalWorkspaceContext: true, annotations: read,
  handler: async (args, ctx) => withPreview(ctx, await use(ctx).animation.report(ctx, args.jobId, args.waitMs)),
});

/** Appended to the full catalog so every earlier capability keeps its position. */
const { caption: _caption, background: _matte, ...BannerExport } = ExportFields;
const banner = defineTool({
  name: 'animation_banner', title: 'Make an animated text banner',
  description: 'Render a seamless looping neon text banner locally (no image model, no browser, no cost): a headline with Thai or Latin text, an optional status badge label, a comet running around the frame and a headline motion (bounce, pulse, slide, shake or still). Choose the size, colours or a transparent background, and any export format. Returns owned resources and a preview.',
  input: {
    text: z.string().max(500).default('').describe('One-line headline; empty hides it'),
    label: z.string().max(64).default('').describe('Small badge above the headline, e.g. ONLINE or SALE; empty hides it'),
    motion: z.enum(['bounce', 'pulse', 'slide', 'shake', 'still']).default('bounce'),
    width: z.number().int().min(120).max(1600).default(800), height: z.number().int().min(60).max(800).default(200),
    background: z.union([z.literal('transparent'), HexColor]).default('#0F172A'),
    accent: HexColor.default('#38BDF8'), textColor: HexColor.default('#F1F7FF'),
    strength: z.number().min(0).max(2).default(1).describe('Headline motion intensity'),
    duration: z.number().min(1).max(5).default(2.5), fps: z.number().int().min(8).max(50).default(20),
    ...BannerExport, waitMs: WaitMs, idempotencyKey: Key,
  },
  output: Output, requiredScope: 'dodo:exec', action: 'exec', optionalWorkspaceContext: true, annotations: render,
  handler: async (args, ctx) => {
    const mm = use(ctx), { idempotencyKey, waitMs, ...rest } = args;
    if (!rest.text.trim() && !rest.label.trim()) throw new DodoError('INVALID_INPUT', 'give the banner a headline text or a label');
    const params = {
      ...exportParams({ ...rest, background: rest.background === 'transparent' ? '#FFFFFF' : rest.background }), size: [rest.width, rest.height], text: rest.text, label: rest.label, motion: rest.motion,
      banner_background: rest.background, accent: rest.accent, text_color: rest.textColor, strength: rest.strength, duration: rest.duration, fps: rest.fps,
    };
    const data = await multimediaEffect(ctx, 'animation_banner', idempotencyKey, { params }, () => mm.animation.start(ctx, 'banner', undefined, params, waitMs));
    return withPreview(ctx, data);
  },
});

const Position = z.number().min(-1).max(2);
const Turns = z.number().int().min(-12).max(12);
const Degrees360 = z.number().min(-360).max(360);
const SceneLayer = z.object({
  image: z.object(source).strict().describe('Still or animated GIF/APNG/WebP, e.g. an animation_rig result'),
  x: Position.default(0.5), y: Position.default(0.5),
  endX: Position.optional(), endY: Position.optional(),
  width: z.number().gt(0).max(1.5).default(0.2).describe('Layer width as a share of the canvas width'),
  opacity: Fraction.default(1), rotationDeg: Degrees360.default(0), spinTurns: Turns.default(0),
  orbit: z.object({ radiusX: Fraction, radiusY: Fraction, turns: Turns.default(1), phaseDeg: Degrees360.default(0), tiltDeg: Degrees360.default(0), depthScale: z.number().min(0).max(0.35).default(0), guide: z.boolean().default(false) }).strict().optional(),
  pulse: z.number().min(0).max(0.35).default(0), mirror: z.boolean().default(false),
  animationLoops: z.number().int().min(1).max(12).default(1).describe('How many times an animated layer plays per clip'),
}).strict();

const scene = defineTool({
  name: 'animation_scene', title: 'Compose a multi-layer animated scene',
  description: 'Render a looping multi-layer scene locally as GIF or MP4: preset solar_system (the Sun and eight orbiting planets), or a background image plus 1-20 layers in back-to-front order. Layers can be stills or animated GIF/APNG/WebP (for example an animation_rig loop of a character), placed by center x/y (0-1, beyond for off-canvas) and width, and move: endX/endY walk in a straight line across the clip (start and end off-canvas for a seamless walk-through), orbit on an ellipse, spin, pulse, mirror. Combine with image_generate for the background and characters. Positions glide at sub-pixel precision; motionBlur softens fast movement.',
  input: {
    preset: z.literal('solar_system').optional(), guides: z.boolean().default(true).describe('solar_system: draw orbit guides'),
    width: z.number().int().min(32).max(1280).optional(), height: z.number().int().min(32).max(1280).optional(),
    background: z.object(source).strict().optional().describe('Still background image, stretched to the canvas'),
    backgroundColor: HexColor.default('#000000'), layers: z.array(SceneLayer).min(1).max(20).optional(),
    depthOrder: z.boolean().default(false).describe('Sort orbiting layers by depth each frame'),
    duration: z.number().min(1).max(10).default(6), fps: z.number().int().min(8).max(50).default(25),
    format: z.enum(['gif', 'mp4']).default('gif'), motionBlur: z.boolean().default(false), waitMs: WaitMs, idempotencyKey: Key,
  },
  output: Output, requiredScope: 'dodo:exec', action: 'exec', optionalWorkspaceContext: true, annotations: render,
  handler: async (args, ctx) => {
    const mm = use(ctx), { idempotencyKey, waitMs, ...rest } = args;
    if ((rest.preset === undefined) === (rest.layers === undefined)) throw new DodoError('INVALID_INPUT', 'choose the solar_system preset or give layers');
    const width = rest.width ?? 960, height = rest.height ?? 540;
    const files: Array<{ name: string; source: { path?: string; assetId?: string; resourceId?: string } }> = [];
    let params: Record<string, unknown> = { format: rest.format, duration: rest.duration, fps: rest.fps, motion_blur: rest.motionBlur };
    if (rest.preset) params = { ...params, preset: rest.preset, size: [width, height], guides: rest.guides };
    else {
      if (rest.background) files.push({ name: 'background.bin', source: pickSource(rest.background) ?? {} });
      const layers = rest.layers!.map((layer, index) => {
        files.push({ name: `layer-${index}.bin`, source: pickSource(layer.image) ?? {} });
        return {
          file: `layer-${index}.bin`, x: layer.x, y: layer.y, width: layer.width, opacity: layer.opacity, rotation_deg: layer.rotationDeg,
          spin_turns: layer.spinTurns, pulse: layer.pulse, mirror: layer.mirror, animation_loops: layer.animationLoops,
          ...(layer.endX !== undefined ? { end_x: layer.endX } : {}), ...(layer.endY !== undefined ? { end_y: layer.endY } : {}),
          ...(layer.orbit ? { orbit: { radius_x: layer.orbit.radiusX, radius_y: layer.orbit.radiusY, turns: layer.orbit.turns, phase_deg: layer.orbit.phaseDeg, tilt_deg: layer.orbit.tiltDeg, depth_scale: layer.orbit.depthScale, guide: layer.orbit.guide } } : {}),
        };
      });
      params = { ...params, scene: { width, height, background_color: rest.backgroundColor, depth_order: rest.depthOrder, layers, ...(rest.background ? { background_file: 'background.bin' } : {}) } };
    }
    const data = await multimediaEffect(ctx, 'animation_scene', idempotencyKey, { params, files }, () => mm.animation.start(ctx, 'scene', undefined, params, waitMs, { files }));
    return withPreview(ctx, data);
  },
});

export const ANIMATION_TOOLS: AnyToolDef[] = [catalog, image, rig, sprite, job, framesPlan, banner, scene];
