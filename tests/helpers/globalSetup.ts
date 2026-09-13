import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Vitest global setup: ensure dist/ exists (the TS language-service worker
 * and packaging tests need compiled output). Rebuilds only when a source file
 * is newer than the marker.
 */
export default function globalSetup(): void {
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const marker = path.join(rootDir, 'dist', '.build-marker');
  const newestSrc = newestMtime(path.join(rootDir, 'src'));
  let markerTime = 0;
  try {
    markerTime = fs.statSync(marker).mtimeMs;
  } catch {
    /* no marker yet */
  }
  if (newestSrc > markerTime) {
    execFileSync(process.execPath, [path.join(rootDir, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.build.json'], { cwd: rootDir, stdio: 'inherit', windowsHide: true });
    execFileSync(process.execPath, ['scripts/copy-ui.mjs'], { cwd: rootDir, stdio: 'inherit', windowsHide: true });
    fs.writeFileSync(marker, String(Date.now()));
  }
}

function newestMtime(dir: string): number {
  let newest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestMtime(p));
    else newest = Math.max(newest, fs.statSync(p).mtimeMs);
  }
  return newest;
}
