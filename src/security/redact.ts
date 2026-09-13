/**
 * Best-effort credential redaction for logs and error text (spec §8.5).
 * Never a substitute for not logging tokens in the first place — DODO never
 * logs Authorization headers or token values by design; this catches
 * accidental inclusion in free-form messages.
 */
const PATTERNS: RegExp[] = [
  /(authorization\s*:\s*)bearer\s+[a-z0-9._~+/=-]{8,}/gi,
  /\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9._-]{10,}/g, // JWT-ish
  /\b(gh[pousr]|xox[baprs]|sk|pk|rk)[-_][a-zA-Z0-9_-]{16,}\b/g, // common API key shapes
  /(client_secret|refresh_token|access_token|password|api[_-]?key)(["']?\s*[:=]\s*["']?)[^\s"'&]{6,}/gi,
];

export function redact(text: string): string {
  let out = text;
  out = out.replace(PATTERNS[0] as RegExp, '$1Bearer [REDACTED]');
  out = out.replace(PATTERNS[1] as RegExp, '[REDACTED_JWT]');
  out = out.replace(PATTERNS[2] as RegExp, '[REDACTED_KEY]');
  out = out.replace(PATTERNS[3] as RegExp, '$1$2[REDACTED]');
  return out;
}

/** One-line, redacted, length-capped log formatting helper. */
export function logLine(...parts: unknown[]): string {
  const joined = parts
    .map((p) => (typeof p === 'string' ? p : JSON.stringify(p)))
    .join(' ')
    .replace(/[\r\n]+/g, ' ');
  const red = redact(joined);
  return red.length > 2000 ? `${red.slice(0, 2000)}…` : red;
}
