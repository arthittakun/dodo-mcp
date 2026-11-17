import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { cropCreativeImage, gridCreativeRegions, normalizeCreativeImage } from '../../src/services/multimodal/creativeImages.js';

const rgba = Buffer.from([
  255, 0, 0, 255, 0, 255, 0, 0, 0, 0, 255, 128,
  255, 255, 0, 255, 0, 255, 255, 64, 255, 0, 255, 255,
]);
const fixture = () => sharp(rgba, { raw: { width: 3, height: 2, channels: 4 } }).png().toBuffer();

describe('creative image normalization and lossless crops', () => {
  it('returns actual PNG pixels and preserves transparent and partial-alpha pixels', async () => {
    const image = await normalizeCreativeImage(await fixture(), true);
    expect(image).toMatchObject({ mimeType: 'image/png', width: 3, height: 2 });
    expect((await sharp(image.bytes).metadata()).format).toBe('png');
    expect(await sharp(image.bytes).raw().toBuffer()).toEqual(rgba);
  });

  it('extracts exact regions in requested order without resizing or losing alpha', async () => {
    const results = await cropCreativeImage(await fixture(), [
      { left: 1, top: 0, width: 2, height: 2 },
      { left: 0, top: 1, width: 1, height: 1 },
    ]);
    expect(results.map(({ width, height, mimeType }) => ({ width, height, mimeType }))).toEqual([
      { width: 2, height: 2, mimeType: 'image/png' }, { width: 1, height: 1, mimeType: 'image/png' },
    ]);
    expect(await sharp(results[0]!.bytes).raw().toBuffer()).toEqual(Buffer.concat([rgba.subarray(4, 12), rgba.subarray(16, 24)]));
    expect(await sharp(results[1]!.bytes).raw().toBuffer()).toEqual(rgba.subarray(12, 16));
  });

  it('requires actual transparency rather than merely an alpha channel', async () => {
    const noAlpha = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#f0f0f0' } }).png().toBuffer();
    const opaqueAlpha = await sharp(noAlpha).ensureAlpha().png().toBuffer();
    await expect(normalizeCreativeImage(noAlpha, true)).rejects.toMatchObject({ code: 'UNSUPPORTED_ENCODING' });
    await expect(normalizeCreativeImage(opaqueAlpha, true)).rejects.toThrow(/opaque image/);
    expect((await normalizeCreativeImage(noAlpha)).width).toBe(2);
  });

  it('strips embedded metadata without rotating the encoded source coordinates', async () => {
    const jpeg = await sharp(await fixture()).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    expect((await sharp(jpeg).metadata()).orientation).toBe(6);
    const image = await normalizeCreativeImage(jpeg);
    expect(image).toMatchObject({ width: 3, height: 2 });
    const metadata = await sharp(image.bytes).metadata();
    expect(metadata.orientation).toBeUndefined(); expect(metadata.exif).toBeUndefined(); expect(metadata.icc).toBeUndefined();
    const [crop] = await cropCreativeImage(jpeg, [{ left: 2, top: 0, width: 1, height: 2 }]);
    expect(crop).toMatchObject({ width: 1, height: 2 });
    expect((await sharp(crop!.bytes).metadata()).exif).toBeUndefined();
  });

  it('rejects unsupported or malformed content even when filenames would suggest an image', async () => {
    const badInputs = [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="5" height="5"/></svg>'), Buffer.from('<html>not an image</html>'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('GIF89a')];
    for (const input of badInputs) {
      await expect(normalizeCreativeImage(input)).rejects.toMatchObject({ code: 'UNSUPPORTED_ENCODING' });
      await expect(cropCreativeImage(input, [{ left: 0, top: 0, width: 1, height: 1 }])).rejects.toMatchObject({ code: 'UNSUPPORTED_ENCODING' });
    }
  });

  it('rejects inputs larger than 16 MiB before decoding', async () => {
    const oversized = Buffer.alloc(16 * 1024 * 1024 + 1);
    await expect(normalizeCreativeImage(oversized)).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
    await expect(cropCreativeImage(oversized, [{ left: 0, top: 0, width: 1, height: 1 }])).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
  });

  it('rejects invalid, fractional, infinite or out-of-bounds crop rectangles', async () => {
    const bytes = await fixture();
    const regions = [
      { left: -1, top: 0, width: 1, height: 1 }, { left: 0, top: -1, width: 1, height: 1 },
      { left: 0, top: 0, width: 0, height: 1 }, { left: 0, top: 0, width: 1, height: -1 },
      { left: 0.5, top: 0, width: 1, height: 1 }, { left: 0, top: 0, width: Infinity, height: 1 },
      { left: NaN, top: 0, width: 1, height: 1 }, { left: 3, top: 0, width: 1, height: 1 },
      { left: 0, top: 2, width: 1, height: 1 }, { left: 2, top: 1, width: 2, height: 1 },
      { left: Number.MAX_SAFE_INTEGER, top: 0, width: Number.MAX_SAFE_INTEGER, height: 1 },
    ];
    for (const region of regions) await expect(cropCreativeImage(bytes, [region])).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(cropCreativeImage(bytes, [])).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(cropCreativeImage(bytes, Array.from({ length: 17 }, () => ({ left: 0, top: 0, width: 1, height: 1 })))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('validates the entire output pixel budget before rendering any crop', async () => {
    const image = await sharp({ create: { width: 2000, height: 2000, channels: 3, background: '#123456' } }).png().toBuffer();
    await expect(cropCreativeImage(image, Array.from({ length: 11 }, () => ({ left: 0, top: 0, width: 2000, height: 2000 })))).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' });
  });

  it('refuses pixel-bomb dimensions before attempting raster decompression', async () => {
    const image = Buffer.from(await fixture());
    image.writeUInt32BE(40_000_001, 16); image.writeUInt32BE(1, 20);
    // Keep the PNG IHDR checksum valid; only dimensions are altered.
    let crc = 0xffffffff;
    for (const byte of image.subarray(12, 29)) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    image.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 29);
    await expect(normalizeCreativeImage(image)).rejects.toThrow();
    await expect(cropCreativeImage(image, [{ left: 0, top: 0, width: 1, height: 1 }])).rejects.toThrow();
  });
});

describe('deterministic grid regions', () => {
  it('assigns remainder pixels to the first row/column and covers the entire source once', () => {
    const regions = gridCreativeRegions(7, 5, { rows: 2, columns: 3 });
    expect(regions).toEqual([
      { left: 0, top: 0, width: 3, height: 3 }, { left: 3, top: 0, width: 2, height: 3 }, { left: 5, top: 0, width: 2, height: 3 },
      { left: 0, top: 3, width: 3, height: 2 }, { left: 3, top: 3, width: 2, height: 2 }, { left: 5, top: 3, width: 2, height: 2 },
    ]);
    const covered = new Set<string>();
    for (const region of regions) for (let y = region.top; y < region.top + region.height; y++) for (let x = region.left; x < region.left + region.width; x++) {
      const pixel = `${x}:${y}`; expect(covered.has(pixel)).toBe(false); covered.add(pixel);
    }
    expect(covered.size).toBe(35);
  });

  it('reserves exact margins and gaps without dropping usable pixels', () => {
    const regions = gridCreativeRegions(13, 9, { rows: 2, columns: 3, gap: 1, margin: 2 });
    expect(regions).toEqual([
      { left: 2, top: 2, width: 3, height: 2 }, { left: 6, top: 2, width: 2, height: 2 }, { left: 9, top: 2, width: 2, height: 2 },
      { left: 2, top: 5, width: 3, height: 2 }, { left: 6, top: 5, width: 2, height: 2 }, { left: 9, top: 5, width: 2, height: 2 },
    ]);
    expect(regions.reduce((pixels, region) => pixels + region.width * region.height, 0)).toBe(28);
  });

  it('extracts grid cells as actual lossless PNG pixels with alpha', async () => {
    const regions = gridCreativeRegions(3, 2, { rows: 2, columns: 2 });
    const crops = await cropCreativeImage(await fixture(), regions);
    expect(crops.map(image => [image.width, image.height])).toEqual([[2, 1], [1, 1], [2, 1], [1, 1]]);
    expect(await sharp(crops[0]!.bytes).raw().toBuffer()).toEqual(rgba.subarray(0, 8));
    expect(await sharp(crops[1]!.bytes).raw().toBuffer()).toEqual(rgba.subarray(8, 12));
    expect(await sharp(crops[2]!.bytes).raw().toBuffer()).toEqual(rgba.subarray(12, 20));
    expect(await sharp(crops[3]!.bytes).raw().toBuffer()).toEqual(rgba.subarray(20, 24));
  });

  it('rejects invalid grids, impossible cell sizes and invalid dimensions', () => {
    for (const grid of [
      { rows: 0, columns: 1 }, { rows: 1.5, columns: 1 }, { rows: 1, columns: Infinity }, { rows: 1, columns: 17 }, { rows: 5, columns: 4 },
      { rows: 2, columns: 2, gap: -1 }, { rows: 1, columns: 1, margin: 0.5 }, { rows: 1, columns: 1, gap: 20001 },
      { rows: 2, columns: 2, gap: 10 }, { rows: 1, columns: 1, margin: 5 }, { rows: 1, columns: 4 },
    ]) expect(() => gridCreativeRegions(3, 2, grid)).toThrow();
    for (const [width, height] of [[0, 1], [-1, 1], [1.5, 1], [1, NaN], [Number.MAX_SAFE_INTEGER, 2]]) expect(() => gridCreativeRegions(width!, height!, { rows: 1, columns: 1 })).toThrow();
  });

  it('accepts the maximum 16 cells and a single whole-image cell', () => {
    expect(gridCreativeRegions(4, 4, { rows: 4, columns: 4 })).toHaveLength(16);
    expect(gridCreativeRegions(3, 2, { rows: 1, columns: 1 })).toEqual([{ left: 0, top: 0, width: 3, height: 2 }]);
    expect(() => gridCreativeRegions(40_000_001, 1, { rows: 1, columns: 1 })).toThrow();
  });
});
