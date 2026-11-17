import { z } from 'zod';
import type { Provider } from '../ai/contracts.js';

/** Public defaults only. Private test endpoints and credentials never belong in this configuration. */
export const CREATIVE_MEDIA_DEFAULTS = {
  provider: 'openai',
  name: 'OpenAI Media',
  protocol: 'responses',
  baseUrl: 'https://api.openai.com/v1',
  imageModel: 'gpt-image-2.5-flare',
  videoModel: '',
} as const;

const Model = z.string().trim().min(1).max(200).regex(/^[a-zA-Z0-9_./:-]+$/);
export const CreativeSettingsInput = z.object({
  enabled: z.boolean().default(false),
  connectionId: z.string().regex(/^ai_[a-z0-9_-]{8,64}$/).nullable().default(null),
  imageModel: Model.default(CREATIVE_MEDIA_DEFAULTS.imageModel),
  videoEnabled: z.boolean().default(false),
  videoModel: z.union([Model, z.literal('')]).default(CREATIVE_MEDIA_DEFAULTS.videoModel),
  allowImageUpload: z.boolean().default(false),
  projectIds: z.array(z.string().regex(/^prj_[a-z0-9_-]{8,64}$/)).max(1000).default([]),
}).strict().refine(value => !value.videoEnabled || value.videoModel.length > 0, { path: ['videoModel'], message: 'enter a supported video model before enabling compatibility video' });
export type CreativeSettings = z.infer<typeof CreativeSettingsInput>;

export function isCreativeConnection(connection: Provider): boolean {
  return connection.enabled && ['openai', 'custom'].includes(connection.provider)
    && ['responses', 'chat-completions'].includes(connection.protocol);
}

/** The official Videos API is retired; changing a display label cannot make it available. */
export function isOfficialOpenAIVideoConnection(connection: Provider): boolean {
  try { return new URL(connection.baseUrl).hostname.toLowerCase().replace(/\.$/, '') === 'api.openai.com'; }
  catch { return false; }
}

export function supportsCreativeVideoConnection(connection: Provider): boolean {
  return isCreativeConnection(connection) && !isOfficialOpenAIVideoConnection(connection);
}
