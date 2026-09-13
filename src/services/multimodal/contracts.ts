import { z } from 'zod';
import { DesktopActionSchema } from '../desktop/protocol.js';

export const Id = z.string().regex(/^[a-z]+_[a-z0-9]{8,64}$/).max(100);
export const Path = z.string().min(1).max(1024);
export const Hash = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const Key = z.string().min(8).max(128);
export const Crop = z.object({ left: z.number().int().min(0).max(20000), top: z.number().int().min(0).max(20000), width: z.number().int().min(1).max(20000), height: z.number().int().min(1).max(20000) }).strict();
export type CropRect = z.infer<typeof Crop>;
export const AssetInfo = z.object({ assetId: Id, kind: z.enum(['image', 'audio', 'transcript']), mimeType: z.string(), bytes: z.number().int().nonnegative(), sha256: Hash, createdAt: z.number(), expiresAt: z.number(), timeSec: z.number().nonnegative().optional(), endSec: z.number().nonnegative().optional() });
export type AssetMetadata = z.infer<typeof AssetInfo>;
export const Segment = z.object({ startSec: z.number().nonnegative(), endSec: z.number().nonnegative(), text: z.string().max(4000) }).strict().refine(s => s.endSec >= s.startSec, 'end must follow start');
export type TranscriptSegment = z.infer<typeof Segment>;
export const Transcript = z.object({ source: z.enum(['whisper.cpp', 'sidecar_subtitles']), language: z.string(), mediaId: Id, startSec: z.number(), endSec: z.number(), segments: z.array(Segment).max(10000), truncated: z.boolean() });
export type TranscriptData = z.infer<typeof Transcript>;
export const BrowserAction = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('click'), selector: z.string().min(1).max(500) }).strict(),
  z.object({ kind: z.literal('fill'), selector: z.string().min(1).max(500), text: z.string().max(4000) }).strict(),
  z.object({ kind: z.literal('press'), selector: z.string().min(1).max(500), key: z.enum(['Enter', 'Tab', 'Escape', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Backspace']) }).strict(),
  z.object({ kind: z.literal('select'), selector: z.string().min(1).max(500), value: z.string().max(500) }).strict(),
  z.object({ kind: z.literal('scroll'), deltaY: z.number().int().min(-2000).max(2000) }).strict(),
  z.object({ kind: z.literal('media'), selector: z.string().min(1).max(500), control: z.enum(['play', 'pause', 'seek', 'mute']), timeSec: z.number().min(0).max(86400).optional() }).strict(),
  z.object({ kind: z.literal('navigate'), url: z.string().min(1).max(2048) }).strict(),
]);
export type BrowserActionInput = z.infer<typeof BrowserAction>;
export const GameAction = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('wait'), durationMs: z.number().int().min(0).max(2000).default(200) }).strict(),
  z.object({ kind: z.literal('keys'), keys: z.array(z.string().regex(/^(?:[a-z0-9]|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Space|Enter|Escape)$/)).min(1).max(4), holdMs: z.number().int().min(0).max(500).default(0) }).strict(),
  z.object({ kind: z.literal('click'), x: z.number().min(0).max(2000), y: z.number().min(0).max(2000) }).strict(),
]);
export type GameActionInput = z.infer<typeof GameAction>;
export const WorkflowStep = z.object({
  instruction: z.string().min(1).max(1000),
  expectedBefore: z.string().min(1).max(300), expectedAfter: z.string().max(300).default(''),
  action: z.discriminatedUnion('target', [
    z.object({ target: z.literal('browser'), action: BrowserAction }).strict(),
    z.object({ target: z.literal('desktop'), action: DesktopActionSchema }).strict(),
    z.object({ target: z.literal('manual') }).strict(),
  ]),
  evidence: z.array(z.object({ source: z.enum(['observation', 'media', 'user_note']), reference: z.string().max(150), timeSec: z.number().nonnegative().optional() }).strict()).max(5).default([]),
}).strict();
export const Workflow = z.object({ name: z.string().min(1).max(100), goal: z.string().min(1).max(1500), tags: z.array(z.string().min(1).max(40)).max(10).default([]), steps: z.array(WorkflowStep).min(1).max(30) }).strict();
export type WorkflowInput = z.infer<typeof Workflow>;
export const WorkflowRecord = Workflow.extend({ workflowId: Id, revision: Hash, createdAt: z.number(), updatedAt: z.number(), provenance: z.literal('client_authored_untrusted_steps_not_permissions') });
export type WorkflowData = z.infer<typeof WorkflowRecord>;
export const WorkerSpec = z.object({
  operation: z.enum(['probe', 'frames', 'audio', 'transcribe', 'speak']),
  input: z.string(), directory: z.string(), ffmpeg: z.string(), ffprobe: z.string(),
  whisper: z.string().optional(), model: z.string().optional(), say: z.string().optional(),
  speechProgram: z.string().optional(), speechKind: z.enum(['macos-say', 'windows-sapi', 'espeak-ng']).optional(),
  startSec: z.number().min(0).max(86400), durationSec: z.number().positive().max(600),
  times: z.array(z.number().min(0).max(86400)).max(8), maxEdge: z.number().int().min(320).max(1600),
  language: z.string().regex(/^(auto|[a-z]{2,3})$/), voice: z.string().max(80).optional(),
}).strict();
export type WorkerSpecData = z.infer<typeof WorkerSpec>;
export const WorkerResult = z.object({
  operation: WorkerSpec.shape.operation,
  metadata: z.object({ durationSec: z.number().nonnegative().nullable(), streams: z.array(z.object({ type: z.string(), codec: z.string(), width: z.number().optional(), height: z.number().optional() })).max(20) }).optional(),
  files: z.array(z.object({ name: z.string().regex(/^out-[0-9]+\.(?:jpg|wav|json)$/), kind: AssetInfo.shape.kind, mimeType: z.string(), timeSec: z.number().optional(), endSec: z.number().optional() })).max(10),
  notes: z.array(z.string().max(500)).max(10),
}).strict();
export type WorkerResultData = z.infer<typeof WorkerResult>;
export const MediaJobResult = z.object({ jobId: z.string(), mediaId: Id.nullable(), operation: WorkerSpec.shape.operation, status: z.string(), exitCode: z.number().nullable(), sandboxed: z.string().nullable(), assets: z.array(AssetInfo), metadata: WorkerResult.shape.metadata, notes: z.array(z.string()), error: z.string().nullable() });
export const ImageView = z.object({ width: z.number(), height: z.number(), sourceWidth: z.number(), sourceHeight: z.number(), crop: Crop.nullable(), scaleX: z.number(), scaleY: z.number(), sourceOffsetX: z.number(), sourceOffsetY: z.number() });
export const ScreenFrame = z.object({ observationId: Id, windowId: z.number(), appId: z.string(), pid: z.number(), snapshotId: z.string(), expiresAt: z.number(), capturedAt: z.number(), asset: AssetInfo, view: ImageView,
  difference: z.object({ comparable: z.boolean(), changedFraction: z.number().nullable(), note: z.string() }).nullable(),
});
export const PlaybackState = z.object({ selector: z.string(), currentTime: z.number().nonnegative(), duration: z.number().nonnegative().nullable(), paused: z.boolean(), readyState: z.number().int().min(0).max(4), errorCode: z.number().int().nullable() });
export const BrowserObservation = z.object({ sessionId: Id, observationId: Id, url: z.string(), title: z.string(), text: z.string(), elements: z.array(z.object({ selector: z.string(), tag: z.string(), role: z.string(), name: z.string(), disabled: z.boolean(), type: z.string() })).max(100), truncated: z.boolean(), media: z.array(PlaybackState).max(8).default([]), expiresAt: z.number(), asset: AssetInfo, console: z.array(z.string()).max(30), network: z.array(z.string()).max(30), note: z.string() });
export type BrowserObservationData = z.infer<typeof BrowserObservation>;
