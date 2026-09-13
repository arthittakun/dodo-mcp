import { z } from 'zod';
import { truncateUtf8 } from '../util/bytes.js';
import type { DodoErrorInfo } from '../errors.js';

/**
 * Application output envelope (spec §15): every tool returns the same shape,
 * as structuredContent plus a concise JSON text fallback for legacy hosts.
 */
export const ErrorInfoSchema = z
  .object({
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
    recovery: z.string().optional(),
    detail: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export function envelopeSchema<T extends z.ZodType>(data: T) {
  return z
    .object({
      ok: z.boolean(),
      workspaceId: z.string().nullable(),
      workspaceEpoch: z.string().nullable(),
      data: data.nullable(),
      error: ErrorInfoSchema.nullable(),
      warnings: z.array(z.string()),
      truncated: z.boolean(),
      nextCursor: z.string().nullable(),
    })
    .strict();
}

export interface Envelope {
  ok: boolean;
  workspaceId: string | null;
  workspaceEpoch: string | null;
  data: unknown;
  error: DodoErrorInfo | null;
  warnings: string[];
  truncated: boolean;
  nextCursor: string | null;
}

export function okEnvelope(
  ws: { workspaceId: string; epoch: string },
  data: unknown,
  extras: { warnings?: string[]; truncated?: boolean; nextCursor?: string | null } = {},
): Envelope {
  return {
    ok: true,
    workspaceId: ws.workspaceId,
    workspaceEpoch: ws.epoch,
    data,
    error: null,
    warnings: extras.warnings ?? [],
    truncated: extras.truncated ?? false,
    nextCursor: extras.nextCursor ?? null,
  };
}

export function errorEnvelope(ws: { workspaceId: string; epoch: string } | null, error: DodoErrorInfo): Envelope {
  return {
    ok: false,
    workspaceId: ws?.workspaceId ?? null,
    workspaceEpoch: ws?.epoch ?? null,
    data: null,
    error,
    warnings: [],
    truncated: false,
    nextCursor: null,
  };
}

/** Text fallback: compact JSON, bounded. */
export function envelopeText(envelope: Envelope, maxBytes: number): string {
  const full = JSON.stringify(envelope);
  const { text, truncated } = truncateUtf8(full, maxBytes);
  if (!truncated) return text;
  // Provide a valid JSON summary instead of a cut-off blob.
  const summary = {
    ok: envelope.ok,
    workspaceId: envelope.workspaceId,
    workspaceEpoch: envelope.workspaceEpoch,
    error: envelope.error,
    truncated: true,
    note: 'text fallback truncated; use structuredContent',
  };
  return JSON.stringify(summary);
}
