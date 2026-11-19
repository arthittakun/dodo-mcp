import { DodoError } from '../../errors.js';

export interface CreativeDiagnostics {
  httpStatus?: number;
  providerCode?: string;
  message?: string;
  requestId?: string;
  retryAfterMs?: number;
  phase: 'before_send' | 'request_sent' | 'response_received' | 'output_save';
  retryable: boolean;
  outcome: 'rejected' | 'unknown' | 'not_sent';
}

/** Provider text is untrusted. Keep only bounded redacted explanation, never raw bodies. */
export function safeProviderText(value: unknown, secrets: readonly string[] = []): string | undefined {
  if (typeof value !== 'string') return undefined;
  let text = value.slice(0, 16384);
  for (const secret of secrets) if (secret) text = text.split(secret).join('[redacted]');
  text = text.replace(/https?:\/\/[^\s"'<>]+/gi, '[redacted-url]')
    .replace(/\b(?:Bearer\s+|sk[-_])[a-z0-9_.\/-]+/gi, '[redacted-key]')
    .replace(/\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g, '[redacted-token]')
    .replace(/\b(?:api[-_ ]?key|authorization|password|secret|token)\s*[:=]\s*[^\s,;]+/gi, '[redacted]')
    .replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, 400) : undefined;
}

export function providerFailure(status: number, bytes: Buffer, headers: Record<string, string | string[] | undefined>, secrets: readonly string[]): DodoError {
  let error: { code?: unknown; type?: unknown; message?: unknown } = {};
  try { const value = JSON.parse(bytes.toString('utf8')) as { error?: unknown }; if (value.error && typeof value.error === 'object') error = value.error as typeof error; } catch { /* non-JSON bodies are intentionally discarded */ }
  const rawCode = typeof error.code === 'string' ? error.code : typeof error.type === 'string' ? error.type : undefined;
  const looksSecret = (text: string) => /(?:\bsk[-_]|\bbearer\b|^eyJ[a-zA-Z0-9_-]+\.)/i.test(text);
  const providerCode = rawCode && /^[a-zA-Z0-9_.:-]{1,100}$/.test(rawCode) && !looksSecret(rawCode) && !secrets.some(secret => secret && rawCode.includes(secret)) ? rawCode : undefined;
  const header = (name: string) => { const v = headers[name]; return typeof v === 'string' ? v : undefined; };
  const rawId = header('x-request-id') ?? header('request-id') ?? header('x-goog-request-id');
  const requestId = rawId && /^[a-zA-Z0-9_.:-]{1,128}$/.test(rawId) && !looksSecret(rawId) && !secrets.some(secret => secret && rawId.includes(secret)) ? rawId : undefined;
  const retry = header('retry-after');
  const retryMs = retry ? (/^\d+(?:\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now()) : undefined;
  const retryAfterMs = retryMs !== undefined && Number.isFinite(retryMs) ? Math.max(0, Math.min(retryMs, 24 * 3600000)) : undefined;
  const quota = status === 429 && /quota|credit|billing|spend|usage_limit|balance/i.test(providerCode ?? '');
  const code = status === 429 ? quota ? 'QUOTA_EXCEEDED' : 'RATE_LIMITED' : status === 401 || status === 403 ? 'AUTH_REQUIRED' : status === 413 ? 'RESOURCE_LIMIT' : status >= 400 && status < 500 ? 'NOT_SUPPORTED' : 'PROVIDER_ERROR';
  const diagnostics: CreativeDiagnostics = { httpStatus: status, ...(providerCode ? { providerCode } : {}), ...(requestId ? { requestId } : {}), ...(retryAfterMs !== undefined ? { retryAfterMs } : {}), message: safeProviderText(error.message, secrets) ?? `Provider returned HTTP ${status}`, phase: 'response_received', retryable: !quota && (status === 429 || status >= 500), outcome: status >= 400 && status < 500 && status !== 408 ? 'rejected' : 'unknown' };
  return new DodoError(code, diagnostics.message!, { retryable: diagnostics.retryable, detail: { ...diagnostics } });
}

export function creativeDiagnostics(error: unknown, sent: boolean): CreativeDiagnostics {
  const detail = error instanceof DodoError ? error.detail : undefined;
  if (detail && ['rejected', 'unknown', 'not_sent'].includes(String(detail['outcome']))) return detail as unknown as CreativeDiagnostics;
  return { phase: sent ? 'request_sent' : 'before_send', outcome: sent ? 'unknown' : 'not_sent', retryable: false, message: error instanceof DodoError ? safeProviderText(error.message) ?? 'Media operation failed' : 'Media operation failed' };
}
