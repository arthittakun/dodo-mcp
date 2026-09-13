# ADR-013 — `trust proxy = loopback`; issuer from explicit config only

**Status:** accepted (implemented)

**Decision.** Express `trust proxy` is set to `'loopback'` (not `true`). The only
hop in front of DODO is the owner's tunnel daemon on loopback, so its
`X-Forwarded-Proto` is trusted for HTTPS/secure-cookie handling — but the OAuth
issuer and resource URLs are **always** the explicit configured `publicUrl`,
never derived from `Host` or `X-Forwarded-Host`. Host and Origin are allowlisted
before the provider sees a request; `Origin: null` is denied.

**Trade-off.** The owner must configure `publicUrl` correctly; DODO will not
guess it from headers (which would be spoofable).

**Evidence / validation.** `security/auth.test.ts` (AUTH-14: evil Host 403,
`Origin: null` 403, spoofed forwarded headers do not change issuer; AUTH-13:
loopback traffic still needs a token). See
[src/server/appServer.ts](../../src/server/appServer.ts).
