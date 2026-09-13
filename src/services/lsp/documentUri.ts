import { fileURLToPath, pathToFileURL } from 'node:url';

/** Normalize URI escaping and Windows drive-letter spelling, not path case.
 * URI identity is only a lookup key; WorkspaceFS remains the access authority. */
export function documentUri(uri: string, platform: NodeJS.Platform = process.platform): string | undefined {
  try {
    const options = { windows: platform === 'win32' };
    const normalized = pathToFileURL(fileURLToPath(uri, options), options).href;
    return platform === 'win32'
      ? normalized.replace(/^file:\/\/\/([A-Z]):/, (_match, drive: string) => `file:///${drive.toLowerCase()}:`)
      : normalized;
  } catch { return undefined; }
}
