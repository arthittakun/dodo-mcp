/**
 * Typed application errors. Every tool failure surfaces as a `DodoError` with
 * a stable machine code from the spec's minimum catalog (§15). Anything else
 * escaping a handler is mapped to INTERNAL_ERROR with no stack/secret leak.
 */

export const ERROR_CODES = [
  'AUTH_REQUIRED',
  'WORKSPACE_ACCESS_REQUIRED',
  'FORBIDDEN',
  'WORKSPACE_MISMATCH',
  'STALE_WORKSPACE',
  'PATH_DENIED',
  'SECRET_PATH_DENIED',
  'NOT_FOUND',
  'UNSUPPORTED_ENCODING',
  'UNSUPPORTED_LANGUAGE',
  'FILE_TOO_LARGE',
  'FILE_CHANGED',
  'AMBIGUOUS_EDIT',
  'PLAN_EXPIRED',
  'PLAN_HASH_MISMATCH',
  'APPROVAL_REQUIRED',
  'APPROVAL_EXPIRED',
  'IDEMPOTENCY_CONFLICT',
  'RESOURCE_LIMIT',
  'JOB_NOT_FOUND',
  'JOB_NOT_RUNNING',
  'TIMEOUT',
  'RECOVERY_REQUIRED',
  'PARTIAL_RECOVERY_REQUIRED',
  'MIGRATION_REVIEW_REQUIRED',
  'INVALID_INPUT',
  'NOT_SUPPORTED',
  'CONFLICT',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface DodoErrorInfo {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  /** Actionable, non-secret recovery hint for the calling model/user. */
  recovery?: string;
  /** Extra machine-readable, non-secret detail (approval ids, counts, paths). */
  detail?: Record<string, unknown>;
}

export class DodoError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly recovery: string | undefined;
  readonly detail: Record<string, unknown> | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    opts: { retryable?: boolean; recovery?: string; detail?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = 'DodoError';
    this.code = code;
    this.retryable = opts.retryable ?? false;
    this.recovery = opts.recovery;
    this.detail = opts.detail;
  }

  toInfo(): DodoErrorInfo {
    const info: DodoErrorInfo = {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    };
    if (this.recovery !== undefined) info.recovery = this.recovery;
    if (this.detail !== undefined) info.detail = this.detail;
    return info;
  }
}

export function toDodoError(err: unknown): DodoError {
  if (err instanceof DodoError) return err;
  // Never leak stack traces or arbitrary error internals to remote callers.
  return new DodoError('INTERNAL_ERROR', 'internal error', { retryable: false });
}

/**
 * Rebuild a typed error from a serialized envelope error, preserving the
 * exact code/message/retryable/recovery/detail. Used by the compact gateway
 * so a target tool's failure surfaces unchanged through the outer tool.
 */
export function fromErrorInfo(info: DodoErrorInfo): DodoError {
  const code: ErrorCode = (ERROR_CODES as readonly string[]).includes(info.code) ? info.code : 'INTERNAL_ERROR';
  return new DodoError(code, info.message, {
    retryable: info.retryable,
    ...(info.recovery !== undefined ? { recovery: info.recovery } : {}),
    ...(info.detail !== undefined ? { detail: info.detail } : {}),
  });
}
