import { DodoError } from '../../errors.js';
import { digestOf, newId } from '../../util/hash.js';
import { MediaStorage, actorKey, type Actor } from './storage.js';
import { ScreenFrame, type CropRect, type AssetMetadata } from './contracts.js';
import { loadSharpBackend } from './sharpBackend.js';
import type { z } from 'zod';

const OPTIONS = { limitInputPixels: 40_000_000, failOn: 'warning' as const };
export async function imageView(bytes: Buffer, maxEdge: number, crop?: CropRect) {
  if (bytes.length > 16 * 1024 * 1024) throw new DodoError('FILE_TOO_LARGE', 'image input exceeds 16 MiB');
  const sharp = await loadSharpBackend();
  const image = sharp(bytes, OPTIONS); const metadata = await image.metadata();
  if (!['jpeg', 'png', 'webp', 'gif'].includes(metadata.format ?? '') || !metadata.width || !metadata.height) throw new DodoError('UNSUPPORTED_ENCODING', 'use PNG/JPEG/WebP/GIF; animated files use the first frame');
  const width = metadata.width, height = metadata.height;
  if (crop && (crop.left + crop.width > width || crop.top + crop.height > height)) throw new DodoError('INVALID_INPUT', 'crop is outside source image pixels');
  if (crop) image.extract(crop);
  // No super-resolution claims. Pixel geometry remains explicit for subsequent actions.
  const converted = await image.resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: !crop }).jpeg({ quality: 80 }).toBuffer({ resolveWithObject: true });
  return { bytes: converted.data, view: { width: converted.info.width, height: converted.info.height, sourceWidth: width, sourceHeight: height, crop: crop ?? null,
    scaleX: (crop?.width ?? width) / converted.info.width, scaleY: (crop?.height ?? height) / converted.info.height, sourceOffsetX: crop?.left ?? 0, sourceOffsetY: crop?.top ?? 0 } };
}
export async function imageDifference(before: Buffer, after: Buffer): Promise<number> {
  const sharp = await loadSharpBackend();
  const normalize = (b: Buffer) => sharp(b, OPTIONS).resize(64, 64, { fit: 'fill' }).removeAlpha().toColourspace('srgb').raw().toBuffer();
  const [a, b] = await Promise.all([normalize(before), normalize(after)]); let changed = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 3) if (Math.max(Math.abs(a[i]! - b[i]!), Math.abs(a[i + 1]! - b[i + 1]!), Math.abs(a[i + 2]! - b[i + 2]!)) > 24) changed++;
  return changed / 4096;
}
type Observation = z.infer<typeof ScreenFrame>;
interface RememberedFrame { owner: string; frame: Observation; comparisonKey: string; policyDigest: string }
export class ScreenService {
  readonly frames = new Map<string, RememberedFrame>();
  private busy = false;
  constructor(private readonly storage: MediaStorage) {}
  private sweep(): void { for (const [id, f] of this.frames) if (f.frame.expiresAt <= Date.now()) this.frames.delete(id); }
  frame(actor: Actor, id: string): Observation {
    this.storage.check(); this.sweep(); const value = this.frames.get(id);
    if (!value || value.owner !== actorKey(actor)) throw new DodoError('NOT_FOUND', 'screen observation expired or belongs to another client');
    this.storage.get(actor, value.frame.asset.assetId); return value.frame;
  }
  async observe(actor: Actor, opts: { windowId: number; maxEdge: number; crop?: CropRect | undefined; previousId?: string | undefined; count: number; intervalMs: number }, check: () => void): Promise<{ frames: Observation[]; note: string }> {
    this.storage.check(); if (this.busy) throw new DodoError('RESOURCE_LIMIT', 'screen observation already in progress');
    if ((opts.count - 1) * opts.intervalMs > 3000) throw new DodoError('RESOURCE_LIMIT', 'screen sample burst is limited to 3 seconds');
    this.busy = true;
    try {
      const out: Observation[] = []; let previous = opts.previousId;
      for (let i = 0; i < opts.count; i++) {
        if (i) await new Promise(resolve => setTimeout(resolve, opts.intervalMs));
        this.storage.check(); check();
        const desktop = this.storage.services.desktop, policy = desktop.policy(), policyDigest = digestOf(policy);
        const captured = await desktop.capture(opts.windowId, opts.maxEdge, false, actor); check();
        const raw = Buffer.from(captured.image, 'base64'), converted = await imageView(raw, opts.maxEdge, opts.crop);
        const expiresAt = Math.min(captured.data.expiresAt, Date.now() + 30000);
        const guard = () => { this.storage.check(); const now = desktop.policy(); if (now.mode === 'off' || digestOf(now) !== policyDigest || expiresAt <= Date.now()) throw new DodoError('FORBIDDEN', 'desktop permission/snapshot changed; capture again'); };
        const key = digestOf({ windowId: captured.data.windowId, pid: captured.data.pid, appId: captured.data.appId, bounds: captured.data.bounds, view: converted.view });
        let difference: Observation['difference'] = null;
        if (previous) {
          this.frame(actor, previous); const prior = this.frames.get(previous)!;
          const comparable = prior.comparisonKey === key;
          difference = { comparable, changedFraction: comparable ? await imageDifference(this.storage.get(actor, prior.frame.asset.assetId).bytes, converted.bytes) : null,
            note: comparable ? 'Fraction of changed cells on a 64x64 RGB grid; pixel difference is not semantic understanding or task success.' : 'Window identity/geometry/crop changed; images are not comparable.' };
        }
        guard(); const asset = this.storage.put(actor, 'image', 'image/jpeg', converted.bytes, { ttlMs: Math.max(1, expiresAt - Date.now()), guard });
        const frame: Observation = { observationId: newId('obs'), windowId: captured.data.windowId, appId: captured.data.appId, pid: captured.data.pid, snapshotId: captured.data.snapshotId, expiresAt, capturedAt: Date.now(), asset, view: converted.view, difference };
        this.sweep(); if (this.frames.size >= 32) this.frames.delete(this.frames.keys().next().value!);
        this.frames.set(frame.observationId, { frame, owner: actorKey(actor), comparisonKey: key, policyDigest }); out.push(frame); previous = frame.observationId;
      }
      return { frames: out, note: 'Images are returned to the client model. This is an explicit bounded burst, not continuous background surveillance. Crop coordinates map back using view.scale/offset; desktop_action uses original snapshot image coordinates.' };
    } finally { this.busy = false; }
  }
  async readFile(actor: Actor, file: string, maxEdge: number, crop?: CropRect): Promise<{ asset: AssetMetadata; view: Awaited<ReturnType<typeof imageView>>['view'] }> {
    const input = this.storage.services.wfs.readFileBytes(file, Math.min(this.storage.services.limits.readFileBytes, 16 * 1024 * 1024));
    const image = await imageView(input.bytes, maxEdge, crop);
    const guard = () => { const p = this.storage.services.wfs.resolve(input.rel); this.storage.services.wfs.assertRegularFileForDirectAccess(p); };
    return { asset: this.storage.put(actor, 'image', 'image/jpeg', image.bytes, { guard }), view: image.view };
  }
  close(): void { this.frames.clear(); }
}
