import { z } from 'zod';

const CredentialKey = z.string().regex(/^[a-f0-9]{24}$/);

/** Opaque locator only. A Cloudflare Tunnel token is never valid config data. */
export const TunnelCredentialRefSchema = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('os'), key: CredentialKey }).strict(),
  z.object({ provider: z.literal('env'), name: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/) }).strict(),
  z.object({ provider: z.literal('file'), path: z.string().min(1).max(4096) }).strict(),
]);

export const TunnelConfigSchema = z
  .object({
    /** Exactly one advertised connection path is active for a DODO process. */
    connectionMode: z.enum(['local', 'tunnel']).default('local'),
    credentialRef: TunnelCredentialRefSchema.optional(),
    /** Canonical cloudflared path selected by the local owner, never by repo config. */
    executable: z.string().min(1).max(4096).optional(),
    /** Loopback-only cloudflared metrics/readiness listener. */
    metricsPort: z.number().int().min(1024).max(65535).default(21732),
    /** Process restarts after cloudflared exhausts its own bounded retries. */
    maxRestarts: z.number().int().min(0).max(5).default(2),
  })
  .strict();

export type TunnelCredentialRef = z.infer<typeof TunnelCredentialRefSchema>;
export type TunnelConfig = z.infer<typeof TunnelConfigSchema>;
