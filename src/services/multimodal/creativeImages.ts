import { DodoError } from '../../errors.js';
import { hasSupportedRasterHeader } from './images.js';
import { loadSharpBackend } from './sharpBackend.js';

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_PIXELS = 40_000_000;
const INPUT_OPTIONS = { limitInputPixels: MAX_PIXELS, failOn: 'warning' as const };

export interface CreativeImage {
  bytes: Buffer;
  mimeType: 'image/png';
  width: number;
  height: number;
}
export interface CreativeCrop { left: number; top: number; width: number; height: number }
export interface CreativeGrid { rows: number; columns: number; gap?: number; margin?: number }

/** Split encoded image pixels in row-major order. Earlier cells receive remainder
 * pixels, so every usable pixel belongs to exactly one cell without resizing.
 */
export function gridCreativeRegions(width: number, height: number, grid: CreativeGrid): CreativeCrop[] {
  if (![width, height].every(Number.isSafeInteger) || width < 1 || height < 1) throw new DodoError('INVALID_INPUT', 'grid requires positive integer source dimensions');
  if (!Number.isSafeInteger(width * height) || width * height > MAX_PIXELS) throw new DodoError('RESOURCE_LIMIT', 'image exceeds 40 million pixels');
  if (!grid || ![grid.rows, grid.columns].every(Number.isSafeInteger) || grid.rows < 1 || grid.columns < 1 || grid.rows > 16 || grid.columns > 16 || grid.rows * grid.columns > 16) throw new DodoError('INVALID_INPUT', 'grid requires 1-16 rows/columns and at most 16 cells');
  const { rows, columns, gap = 0, margin = 0 } = grid;
  if (![gap, margin].every(value => Number.isSafeInteger(value) && value >= 0 && value <= 20000)) throw new DodoError('INVALID_INPUT', 'grid gap and margin must be integer pixels between 0 and 20000');
  const availableWidth = width - 2 * margin - (columns - 1) * gap;
  const availableHeight = height - 2 * margin - (rows - 1) * gap;
  if (availableWidth < columns || availableHeight < rows) throw new DodoError('INVALID_INPUT', 'grid leaves no positive pixels for every cell');
  const baseWidth = Math.floor(availableWidth / columns), extraWidth = availableWidth % columns;
  const baseHeight = Math.floor(availableHeight / rows), extraHeight = availableHeight % rows;
  const regions: CreativeCrop[] = [];
  let top = margin;
  for (let row = 0; row < rows; row++) {
    const cellHeight = baseHeight + (row < extraHeight ? 1 : 0);
    let left = margin;
    for (let column = 0; column < columns; column++) {
      const cellWidth = baseWidth + (column < extraWidth ? 1 : 0);
      regions.push({ left, top, width: cellWidth, height: cellHeight });
      left += cellWidth + gap;
    }
    top += cellHeight + gap;
  }
  return regions;
}

async function raster(bytes: Buffer) {
  if (bytes.length > MAX_BYTES) throw new DodoError('FILE_TOO_LARGE', 'image input exceeds 16 MiB');
  if (!hasSupportedRasterHeader(bytes)) throw new DodoError('UNSUPPORTED_ENCODING', 'use PNG/JPEG/WebP/GIF; animated files use the first frame');
  const sharp = await loadSharpBackend();
  try {
    const image = sharp(bytes, INPUT_OPTIONS), metadata = await image.metadata();
    const width = metadata.width, height = metadata.height;
    if (!['jpeg', 'png', 'webp', 'gif'].includes(metadata.format ?? '') || !width || !height) throw new DodoError('UNSUPPORTED_ENCODING', 'image raster is invalid or unsupported');
    if (!Number.isSafeInteger(width * height) || width * height > MAX_PIXELS) throw new DodoError('RESOURCE_LIMIT', 'image exceeds 40 million pixels');
    return { sharp, image, width, height, hasAlpha: metadata.hasAlpha };
  } catch (error) {
    if (error instanceof DodoError) throw error;
    // Decoder messages can contain embedded metadata; expose a stable error only.
    throw new DodoError('UNSUPPORTED_ENCODING', 'image raster cannot be decoded within the supported limits');
  }
}

/** Decode and re-encode a first-frame raster, stripping metadata and preserving alpha.
 * Coordinates and dimensions refer to the encoded pixels, before any EXIF rotation,
 * matching image_view. No generated detail, scaling or automatic rotation is added.
 */
export async function normalizeCreativeImage(bytes: Buffer, requireAlpha = false): Promise<CreativeImage> {
  const source = await raster(bytes);
  if (requireAlpha && !source.hasAlpha) throw new DodoError('UNSUPPORTED_ENCODING', 'background removal returned an image without transparency');
  try {
    const output = await source.image.toColourspace('srgb').png({ palette: false }).toBuffer({ resolveWithObject: true });
    if (output.data.length > MAX_BYTES) throw new DodoError('FILE_TOO_LARGE', 'normalized image exceeds 16 MiB');
    if (requireAlpha && (await source.sharp(output.data, INPUT_OPTIONS).stats()).isOpaque) throw new DodoError('UNSUPPORTED_ENCODING', 'background removal returned an opaque image; no transparent pixels were produced');
    return { bytes: output.data, mimeType: 'image/png', width: output.info.width, height: output.info.height };
  } catch (error) {
    if (error instanceof DodoError) throw error;
    throw new DodoError('UNSUPPORTED_ENCODING', 'image raster cannot be decoded within the supported limits');
  }
}

/** Validate the editable region before accepting a paid edit, rather than relying
 * on the provider to reject an opaque or flattened mask after submission. */
export async function normalizeCreativeMask(bytes: Buffer): Promise<CreativeImage> {
  const invalid = () => new DodoError('INVALID_INPUT', 'the edit mask must be a valid PNG with an alpha channel and a fully transparent editable region');
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw invalid();
  try {
    const source = await raster(bytes);
    if (!source.hasAlpha || (await source.image.stats()).channels.at(-1)?.min !== 0) throw invalid();
    return await normalizeCreativeImage(bytes);
  } catch (error) {
    if (error instanceof DodoError && error.code !== 'UNSUPPORTED_ENCODING') throw error;
    throw invalid();
  }
}

/** Precisely extract bounded PNG crops without resizing or losing transparency. */
export async function cropCreativeImage(bytes: Buffer, regions: CreativeCrop[]): Promise<CreativeImage[]> {
  if (!Array.isArray(regions) || regions.length < 1 || regions.length > 16) throw new DodoError('INVALID_INPUT', 'provide between 1 and 16 crop regions');
  const source = await raster(bytes);
  let pixels = 0;
  for (const region of regions) {
    if (!region || ![region.left, region.top, region.width, region.height].every(Number.isSafeInteger)
      || region.left < 0 || region.top < 0 || region.width < 1 || region.height < 1) throw new DodoError('INVALID_INPUT', 'crop rectangles require integer pixel coordinates and positive dimensions');
    if (region.width > source.width - region.left || region.height > source.height - region.top) throw new DodoError('INVALID_INPUT', 'crop is outside source image pixels');
    pixels += region.width * region.height;
    if (!Number.isSafeInteger(pixels) || pixels > MAX_PIXELS) throw new DodoError('RESOURCE_LIMIT', 'combined crop output exceeds 40 million pixels');
  }
  const outputs: CreativeImage[] = [];
  try {
    // Sequential processing keeps transient decoder memory bounded even for 16 crops.
    for (const region of regions) {
      const output = await source.image.clone().extract(region).toColourspace('srgb').png({ palette: false }).toBuffer({ resolveWithObject: true });
      if (output.data.length > MAX_BYTES) throw new DodoError('FILE_TOO_LARGE', 'cropped image exceeds 16 MiB');
      outputs.push({ bytes: output.data, mimeType: 'image/png', width: output.info.width, height: output.info.height });
    }
    return outputs;
  } catch (error) {
    if (error instanceof DodoError) throw error;
    throw new DodoError('UNSUPPORTED_ENCODING', 'image raster cannot be decoded within the supported limits');
  }
}
