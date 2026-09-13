import type { BootstrappedWorkspace } from './bootstrap.js';

/**
 * Attaches optional capabilities that depend on owner configuration and
 * owner-installed software (currently: LSP servers). Kept separate so the
 * core bootstrap has no dependency on the adapter modules; the LSP adapter is
 * wired here once available.
 */
export function attachOptionalServices(ws: BootstrappedWorkspace, log: (line: string) => void): void {
  const registry = ws.config.lsp;
  const languages = Object.keys(registry);
  if (languages.length === 0) return;
  try {
    // Loaded lazily so a missing/broken adapter never blocks the server.
    const mod = lspModule();
    if (!mod) {
      log('[dodo] lsp: configured languages ignored — adapter not available in this build');
      return;
    }
    ws.services.lsp = new mod.LspService({ wfs: ws.services.wfs, limits: ws.config.limits, registry, log });
    log(`[dodo] lsp: configured languages: ${languages.join(', ')} (servers start on first use; they run as your user)`);
  } catch (err) {
    log(`[dodo] lsp: disabled — ${(err as Error).message}`);
  }
}

import * as lsp from '../services/lsp/lspService.js';
function lspModule(): typeof lsp | undefined {
  return typeof lsp.LspService === 'function' ? lsp : undefined;
}
