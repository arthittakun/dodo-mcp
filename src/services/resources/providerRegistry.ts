import type { ResourceCapabilitiesData } from './contracts.js';
import { isTextMime, resourceFamily } from './mime.js';

export interface ResourceProviderDescriptor {
  name: string;
  matches(mimeType: string): boolean;
  capabilities(mimeType: string): ResourceCapabilitiesData;
}
const base = (extra: Partial<ResourceCapabilitiesData> = {}): ResourceCapabilitiesData => ({
  read: true, stream: true, seek: true, preview: true, transform: false, extractText: false, ...extra,
});

/**
 * Fixed, local decoder registry. Providers describe only bounded operations;
 * registering one never grants scope, ACL, executable or network authority.
 */
export class ResourceProviderRegistry {
  private readonly providers: readonly ResourceProviderDescriptor[] = [
    { name: 'builtin-utf8', matches: isTextMime, capabilities: () => base({ extractText: true }) },
    { name: 'sharp-raster', matches: (mime) => ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mime), capabilities: () => base({ transform: true }) },
    { name: 'bounded-audio-block', matches: (mime) => resourceFamily(mime) === 'audio', capabilities: () => base() },
    { name: 'zip-central-directory', matches: (mime) => mime === 'application/zip', capabilities: () => base() },
    { name: 'metadata-only', matches: () => true, capabilities: () => base() },
  ];

  providerFor(mimeType: string): ResourceProviderDescriptor {
    return this.providers.find((provider) => provider.matches(mimeType))!;
  }

  list(): Array<{ name: string }> { return this.providers.map((provider) => ({ name: provider.name })); }
}
