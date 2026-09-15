import { DodoError } from '../../errors.js';

type SharpFactory = (typeof import('sharp'))['default'];

let backend: Promise<SharpFactory> | undefined;

/**
 * Load the optional raster backend only when an image operation needs it.
 *
 * Some supported core/runtime platforms do not have a native sharp build.
 * Keeping this import lazy lets text/code/transport commands continue to work
 * there while image operations fail with a bounded, non-secret error.
 */
export async function loadSharpBackend(): Promise<SharpFactory> {
  backend ??= import('sharp')
    .then((module) => module.default)
    .catch(() => {
      backend = undefined;
      throw new DodoError('NOT_SUPPORTED', 'image processing backend is unavailable on this platform', {
        recovery: 'Install @img/sharp-wasm32 beside dodo-mcp or provide a supported libvips build, then restart DODO.',
      });
    });
  return backend;
}
