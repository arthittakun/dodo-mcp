import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { DodoError } from '../../errors.js';
import { addressClass } from '../../security/outboundAddress.js';
import type { Provider } from '../ai/contracts.js';
import { validateEndpoint } from '../ai/network.js';

const MiB = 1024 * 1024;
const IMAGE_CAP = 16 * MiB;
const JSON_CAP = 24 * MiB;
const VIDEO_CAP = 64 * MiB;
const DEADLINE_MS = 180000;
const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const VIDEO_ID = /^[a-zA-Z0-9_-]{1,200}$/;

export interface CreativeImageInput {
  model: string;
  prompt: string;
  size: string;
  quality: 'auto' | 'low' | 'medium' | 'high';
  background: 'auto' | 'opaque' | 'transparent';
}
export interface CreativeVideoInput { model: string; prompt: string; size: string; seconds: number; reference?: Buffer | undefined }
export interface CreativeVideoJob { id: string; status: 'queued' | 'in_progress' | 'completed' | 'failed'; progress: number }
export interface CreativeImageResult { bytes: Buffer; mimeType: 'image/png' }
interface RequestBody { bytes: Buffer; contentType: string }

function multipart(fields: Record<string, string>, image?: Buffer, imageField: 'image[]' | 'input_reference' = 'image[]'): RequestBody {
  const boundary = `dodo-${randomBytes(24).toString('hex')}`;
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  if (image) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${imageField}"; filename="input.png"\r\nContent-Type: image/png\r\n\r\n`), image, Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { bytes: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

/** OpenAI image/video endpoints only. Credentials and provider-controlled URLs never reach tool results. */
export class CreativeProvider {
  constructor(private readonly connection: Provider, private readonly key: string, private readonly ports: number[]) {
    if (!connection.enabled || !['responses', 'chat-completions'].includes(connection.protocol)) throw new DodoError('NOT_SUPPORTED', 'creative media requires an enabled OpenAI-compatible connection');
    validateEndpoint(connection, ports);
    if (!key) throw new DodoError('AUTH_REQUIRED', 'configure an API key for creative media first');
    if (key.length > 4096 || /[\x00-\x20\x7f]/.test(key)) throw new DodoError('INVALID_INPUT', 'invalid creative media credential');
  }

  private async request(suffix: string, body: RequestBody | undefined, cap: number, signal?: AbortSignal, beforeSend?: () => void): Promise<Buffer> {
    const base = validateEndpoint(this.connection, this.ports);
    const host = base.hostname.replace(/^\[|\]$/g, '');
    const deadline = AbortSignal.timeout(DEADLINE_MS);
    const active = signal ? AbortSignal.any([signal, deadline]) : deadline;
    if (active.aborted) throw new DodoError('CONFLICT', 'creative media request canceled before sending');
    const addresses: Array<{ address: string; family: number }> = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await new Promise((resolve, reject) => {
      const abort = () => reject(new DodoError('CONFLICT', 'creative media request canceled before sending'));
      active.addEventListener('abort', abort, { once: true });
      void dns.lookup(host, { all: true }).then(resolve, () => reject(new DodoError('NOT_SUPPORTED', 'creative media hostname could not be resolved'))).finally(() => active.removeEventListener('abort', abort));
    });
    if (!addresses.length) throw new DodoError('NOT_SUPPORTED', 'creative media hostname has no address');
    for (const { address } of addresses) {
      const kind = addressClass(address);
      if (kind === 'denied' || (kind === 'private' && !this.connection.allowPrivateNetwork) || (kind === 'public' && base.protocol === 'http:')) throw new DodoError('FORBIDDEN', 'creative media address is not allowed by endpoint policy');
    }
    const chosen = addresses.find(entry => entry.family === 4) ?? addresses[0]!;
    const url = new URL(`${base.toString().replace(/\/$/, '')}/${suffix}`);
    if ((body?.bytes.length ?? 0) > IMAGE_CAP + MiB) throw new DodoError('RESOURCE_LIMIT', 'creative media request exceeds its upload budget');
    if (active.aborted) throw new DodoError('CONFLICT', 'creative media request canceled before sending');
    beforeSend?.();
    return new Promise((resolve, reject) => {
      let request: http.ClientRequest;
      const failed = () => reject(new DodoError('CONFLICT', 'creative media connection failed or was canceled; outcome may be uncertain and was not retried'));
      try {
        request = (url.protocol === 'https:' ? https : http).request(url, {
          method: body ? 'POST' : 'GET', agent: false, signal: active,
          headers: { authorization: `Bearer ${this.key}`, accept: suffix.endsWith('/content') ? 'video/mp4' : 'application/json', 'accept-encoding': 'identity', ...(body ? { 'content-type': body.contentType, 'content-length': String(body.bytes.length) } : {}) },
          lookup: (_hostname, options, callback) => {
            if (typeof options === 'object' && options.all) callback(null, [chosen]);
            else callback(null, chosen.address, chosen.family);
          },
        }, response => {
          const status = response.statusCode ?? 0;
          if (status >= 300 && status < 400) {
            response.destroy(); reject(new DodoError('FORBIDDEN', 'creative media redirects are refused; credentials were not forwarded')); return;
          }
          if (status < 200 || status >= 300) {
            response.destroy();
            const code = status === 401 || status === 403 ? 'AUTH_REQUIRED' : [400, 404, 405, 422].includes(status) ? 'NOT_SUPPORTED' : status === 413 ? 'RESOURCE_LIMIT' : 'CONFLICT';
            reject(new DodoError(code, `creative media provider returned HTTP ${status}; request was not retried`, { detail: { httpStatus: status } })); return;
          }
          if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
            request.destroy(); reject(new DodoError('NOT_SUPPORTED', 'compressed creative media responses are not supported')); return;
          }
          const declared = Number(response.headers['content-length']);
          if (Number.isFinite(declared) && declared > cap) {
            request.destroy(); reject(new DodoError('RESOURCE_LIMIT', 'creative media response exceeds its size budget')); return;
          }
          const chunks: Buffer[] = []; let bytes = 0;
          response.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > cap) { request.destroy(); reject(new DodoError('RESOURCE_LIMIT', 'creative media response exceeds its size budget')); }
            else chunks.push(chunk);
          });
          response.on('error', failed); response.on('aborted', failed);
          response.on('end', () => resolve(Buffer.concat(chunks)));
        });
      } catch { failed(); return; }
      request.on('error', failed);
      request.end(body?.bytes);
    });
  }

  private json(bytes: Buffer): Record<string, unknown> {
    const text = bytes.toString('utf8');
    if (text.includes(this.key)) throw new DodoError('FORBIDDEN', 'creative media response echoed a credential and was discarded');
    let value: unknown;
    try { value = JSON.parse(text) as unknown; } catch { throw new DodoError('NOT_SUPPORTED', 'creative media returned an unsupported JSON response'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DodoError('NOT_SUPPORTED', 'creative media returned an unsupported JSON response');
    if (JSON.stringify(value).includes(this.key)) throw new DodoError('FORBIDDEN', 'creative media response echoed a credential and was discarded');
    return value as Record<string, unknown>;
  }

  private image(bytes: Buffer): CreativeImageResult {
    const response = this.json(bytes);
    const item = Array.isArray(response.data) && response.data.length === 1 ? response.data[0] as { b64_json?: unknown } : undefined;
    if (!item || typeof item.b64_json !== 'string') throw new DodoError('NOT_SUPPORTED', 'creative media must return one base64 PNG image; remote image URLs are not downloaded');
    const encoded = item.b64_json;
    if (encoded.length > Math.ceil(IMAGE_CAP / 3) * 4) throw new DodoError('RESOURCE_LIMIT', 'generated image exceeds 16 MiB');
    const decoded = Buffer.from(encoded, 'base64');
    if (decoded.length > IMAGE_CAP) throw new DodoError('RESOURCE_LIMIT', 'generated image exceeds 16 MiB');
    if (decoded.toString('base64') !== encoded || !decoded.subarray(0, PNG_HEADER.length).equals(PNG_HEADER)) throw new DodoError('NOT_SUPPORTED', 'creative media did not return a supported PNG image');
    return { bytes: decoded, mimeType: 'image/png' };
  }

  private validateModel(model: string): void {
    if (!model || model.length > 200 || /[\x00-\x1f\x7f]/.test(model)) throw new DodoError('INVALID_INPUT', 'invalid creative media model ID');
  }
  private validatePrompt(prompt: string): void {
    if (!prompt.trim() || prompt.length > 16000) throw new DodoError('INVALID_INPUT', 'creative media prompt must contain 1-16000 characters');
  }

  /** Official OpenAI video endpoints retired on 2026-09-24. The wire format
   * remains available only for owner-configured compatibility providers.
   */
  private requireVideoCompatibility(): void {
    const hostname = new URL(this.connection.baseUrl).hostname.toLowerCase().replace(/\.+$/, '');
    if (hostname === 'api.openai.com') throw new DodoError('NOT_SUPPORTED', 'OpenAI Videos API retired on 2026-09-24; configure a compatible video provider before using video operations');
  }

  async generateImage(input: CreativeImageInput, signal?: AbortSignal, beforeSend?: () => void): Promise<CreativeImageResult> {
    this.validateModel(input.model); this.validatePrompt(input.prompt);
    if (!['auto', '1024x1024', '1536x1024', '1024x1536'].includes(input.size) || !['auto', 'low', 'medium', 'high'].includes(input.quality) || !['auto', 'opaque', 'transparent'].includes(input.background)) throw new DodoError('INVALID_INPUT', 'invalid creative image options');
    const body = Buffer.from(JSON.stringify({ ...input, n: 1, output_format: 'png' }));
    return this.image(await this.request('images/generations', { bytes: body, contentType: 'application/json' }, JSON_CAP, signal, beforeSend));
  }

  async removeBackground(input: { model: string; image: Buffer }, signal?: AbortSignal, beforeSend?: () => void): Promise<CreativeImageResult> {
    this.validateModel(input.model);
    if (input.image.length > IMAGE_CAP) throw new DodoError('RESOURCE_LIMIT', 'background removal image exceeds 16 MiB');
    if (!input.image.subarray(0, PNG_HEADER.length).equals(PNG_HEADER)) throw new DodoError('INVALID_INPUT', 'background removal input must be a PNG image');
    const body = multipart({ model: input.model, prompt: 'Remove only the background from this image. Preserve the main foreground subject, its colors, fine details, shape and proportions. Do not add objects, shadows or text. Return the isolated foreground on a fully transparent background.', n: '1', background: 'transparent', output_format: 'png', size: 'auto' }, input.image);
    return this.image(await this.request('images/edits', body, JSON_CAP, signal, beforeSend));
  }

  private job(bytes: Buffer): CreativeVideoJob {
    const data = this.json(bytes);
    if (typeof data.id !== 'string' || !VIDEO_ID.test(data.id) || !['queued', 'in_progress', 'completed', 'failed'].includes(String(data.status))) throw new DodoError('NOT_SUPPORTED', 'creative media returned an unsupported video job');
    const progress = typeof data.progress === 'number' && Number.isFinite(data.progress) ? Math.min(100, Math.max(0, data.progress)) : data.status === 'completed' ? 100 : 0;
    return { id: data.id, status: data.status as CreativeVideoJob['status'], progress };
  }

  async createVideo(input: CreativeVideoInput, signal?: AbortSignal, beforeSend?: () => void): Promise<CreativeVideoJob> {
    this.requireVideoCompatibility();
    this.validateModel(input.model); this.validatePrompt(input.prompt);
    if (!['720x1280', '1280x720', '1024x1792', '1792x1024', '1920x1080', '1080x1920'].includes(input.size) || ![4, 8, 12, 16, 20].includes(input.seconds)) throw new DodoError('INVALID_INPUT', 'invalid creative video size or duration');
    if (input.reference !== undefined) {
      if (input.reference.length > IMAGE_CAP) throw new DodoError('RESOURCE_LIMIT', 'video reference image exceeds 16 MiB');
      if (!input.reference.subarray(0, PNG_HEADER.length).equals(PNG_HEADER)) throw new DodoError('INVALID_INPUT', 'video reference must be a normalized PNG image');
    }
    const body = multipart({ model: input.model, prompt: input.prompt, size: input.size, seconds: String(input.seconds) }, input.reference, 'input_reference');
    return this.job(await this.request('videos', body, MiB, signal, beforeSend));
  }

  async editVideo(input: { id: string; prompt: string }, signal?: AbortSignal, beforeSend?: () => void): Promise<CreativeVideoJob> {
    this.requireVideoCompatibility();
    if (!VIDEO_ID.test(input.id)) throw new DodoError('INVALID_INPUT', 'invalid creative video job ID');
    this.validatePrompt(input.prompt);
    const bytes = Buffer.from(JSON.stringify({ video: { id: input.id }, prompt: input.prompt }));
    return this.job(await this.request('videos/edits', { bytes, contentType: 'application/json' }, MiB, signal, beforeSend));
  }

  async extendVideo(input: { id: string; prompt: string; seconds: number }, signal?: AbortSignal, beforeSend?: () => void): Promise<CreativeVideoJob> {
    this.requireVideoCompatibility();
    if (!VIDEO_ID.test(input.id)) throw new DodoError('INVALID_INPUT', 'invalid creative video job ID');
    this.validatePrompt(input.prompt);
    if (![4, 8, 12, 16, 20].includes(input.seconds)) throw new DodoError('INVALID_INPUT', 'invalid creative video extension duration');
    const bytes = Buffer.from(JSON.stringify({ video: { id: input.id }, prompt: input.prompt, seconds: String(input.seconds) }));
    return this.job(await this.request('videos/extensions', { bytes, contentType: 'application/json' }, MiB, signal, beforeSend));
  }

  async videoStatus(id: string, signal?: AbortSignal, beforeSend?: () => void): Promise<CreativeVideoJob> {
    this.requireVideoCompatibility();
    if (!VIDEO_ID.test(id)) throw new DodoError('INVALID_INPUT', 'invalid creative video job ID');
    const result = this.job(await this.request(`videos/${id}`, undefined, MiB, signal, beforeSend));
    if (result.id !== id) throw new DodoError('NOT_SUPPORTED', 'creative media returned a different video job');
    return result;
  }

  async videoContent(id: string, signal?: AbortSignal, beforeSend?: () => void): Promise<Buffer> {
    this.requireVideoCompatibility();
    if (!VIDEO_ID.test(id)) throw new DodoError('INVALID_INPUT', 'invalid creative video job ID');
    const bytes = await this.request(`videos/${id}/content`, undefined, VIDEO_CAP, signal, beforeSend);
    if (bytes.length < 12 || bytes.subarray(4, 8).toString('ascii') !== 'ftyp') throw new DodoError('NOT_SUPPORTED', 'creative media did not return an MP4 video');
    return bytes;
  }
}
