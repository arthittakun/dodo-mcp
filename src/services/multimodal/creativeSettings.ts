import { z } from 'zod';
import type { Provider } from '../ai/contracts.js';
import { DodoError } from '../../errors.js';

/** Public defaults only. Private test endpoints and credentials never belong in this configuration. */
export const CREATIVE_MEDIA_DEFAULTS = {
  provider: 'openai',
  name: 'OpenAI Media',
  protocol: 'responses',
  baseUrl: 'https://api.openai.com/v1',
  imageModel: 'auto',
  videoModel: '',
} as const;

/** Image protocol presets are editable starting points, not routing restrictions. */
export const CREATIVE_IMAGE_PRESETS = [
  { id: 'openai', name: 'OpenAI', provider: 'openai', protocol: 'responses', baseUrl: 'https://api.openai.com/v1', imageModel: 'auto' },
  { id: 'gemini', name: 'Google Gemini', provider: 'gemini', protocol: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', imageModel: 'auto' },
  { id: 'custom', name: 'OpenAI-compatible / Custom', provider: 'custom', protocol: 'responses', baseUrl: '', imageModel: 'auto' },
] as const;

const GEMINI_IMAGE_MODELS = ['gemini-nano-banana-2.1', 'gemini-3.1-flash-image', 'gemini-3.1-flash-lite-image', 'gemini-3-pro-image', 'gemini-2.5-flash-image'] as const;
const COMPATIBLE_IMAGE_MODELS = [
  'gpt-image-2.5-flare', 'gpt-image-2.6-flare', 'gpt-image-2.5-sunburst', 'gpt-image-2.6-sunburst',
  'gpt-image-2', 'gpt-image-1.5', '2k-gpt-image-2', 'gpt-image-2.6-flare-4k', 'gpt-image-2.6-4k', '4k-gpt-image-2',
  ...GEMINI_IMAGE_MODELS, 'gemini-3.0-pro-image',
] as const;

/** Select one known image model advertised by this connection. Never guess a
 * text model or retry an image POST with a different model after spending.
 */
export function resolveAutoImageModel(protocol: Provider['protocol'], ids: readonly string[]): string {
  if (!['responses', 'chat-completions', 'gemini'].includes(protocol)) throw new DodoError('NOT_SUPPORTED', 'Auto image selection requires a supported image protocol; select an image connection first');
  const preferences: readonly string[] = protocol === 'gemini' ? GEMINI_IMAGE_MODELS : COMPATIBLE_IMAGE_MODELS;
  const candidates = [...new Set(ids.map(id => protocol === 'gemini' ? id.replace(/^models\//, '') : id))]
    .filter(id => /^[a-zA-Z0-9_./:-]{1,200}$/.test(id)).sort();
  let selected: string | undefined, selectedRank = Number.POSITIVE_INFINITY;
  for (const id of candidates) {
    const canonical = protocol === 'gemini' ? id.toLowerCase() : id.toLowerCase().replace(/^(?:openai|google)\//, '');
    const rank = preferences.indexOf(canonical);
    if (rank >= 0 && rank < selectedRank) { selected = id; selectedRank = rank; }
  }
  if (selected === undefined) throw new DodoError('NOT_SUPPORTED', 'Auto could not find a recognized image model in this connection; choose a supported Model ID manually');
  return selected;
}

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
  return connection.enabled && ['responses', 'chat-completions', 'gemini'].includes(connection.protocol);
}

/** The official Videos API is retired; changing a display label cannot make it available. */
export function isOfficialOpenAIVideoConnection(connection: Provider): boolean {
  try { return new URL(connection.baseUrl).hostname.toLowerCase().replace(/\.$/, '') === 'api.openai.com'; }
  catch { return false; }
}

export function supportsCreativeVideoConnection(connection: Provider): boolean {
  return connection.enabled && ['responses', 'chat-completions'].includes(connection.protocol)
    && !isOfficialOpenAIVideoConnection(connection);
}
