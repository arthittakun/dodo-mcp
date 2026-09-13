import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const DODO_VERSION = readOwnVersion();

function readOwnVersion(): string {
  try {
    const pkgPath = fileURLToPath(new URL('../../package.json', import.meta.url));
    return (JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version: string }).version;
  } catch {
    return '0.0.0';
  }
}
