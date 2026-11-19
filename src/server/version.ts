import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DODO_VERSION = readOwnVersion();
const STARTED_AT = Date.now();
/** Owner-only runtime identity. Never include these machine paths in public health/MCP responses. */
export function runtimeIdentity() {
  return { serverVersion: DODO_VERSION, pid: process.pid, startedAt: STARTED_AT,
    nodeExecutable: process.execPath, entryPoint: path.resolve(process.argv[1] ?? fileURLToPath(import.meta.url)),
    packageRoot: fileURLToPath(new URL('../../', import.meta.url)) };
}

function readOwnVersion(): string {
  try {
    const pkgPath = fileURLToPath(new URL('../../package.json', import.meta.url));
    return (JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version: string }).version;
  } catch {
    return 'unknown';
  }
}
