import { describe, expect, it, vi } from 'vitest';

vi.mock('sharp', () => {
  throw new Error('simulated unsupported sharp runtime');
});

describe('optional sharp backend', () => {
  it('does not load sharp while importing image and resource modules', async () => {
    await expect(import('../../src/services/multimodal/images.js')).resolves.toBeDefined();
    await expect(import('../../src/services/resources/providers.js')).resolves.toBeDefined();
  });

  it('fails only the requested image operation with a typed error', async () => {
    const { imageView } = await import('../../src/services/multimodal/images.js');
    await expect(imageView(Buffer.from('not-an-image'), 320)).rejects.toMatchObject({
      code: 'NOT_SUPPORTED',
      message: 'image processing backend is unavailable on this platform',
    });
  });

  it('preserves the typed backend error for raster resources', async () => {
    const { inspectResourceFile } = await import('../../src/services/resources/providers.js');
    await expect(inspectResourceFile('/unused/image.png', 'image/png')).rejects.toMatchObject({
      code: 'NOT_SUPPORTED',
      message: 'image processing backend is unavailable on this platform',
    });
  });
});
