# ADR-012 — Grants at both OIDC and resource scope; first-party auto-consent

**Status:** accepted (implemented)

**Context.** During M0 the authorization flow returned `access_denied`
("no scope granted"). Root cause: `dodo:*` are RFC 8707 resource-indicator
scopes, and the just-created grant was not being reused as the consent grant
because it was not yet linked to the browser session.

**Decision.** (1) Advertise `dodo:*` both as global OIDC scopes (so the
authorization request's `scope` param is accepted) and as resource-server scopes
(so the access token audience is the `/mcp` resource); grant at both levels.
(2) Implement `loadExistingGrant` to reuse the DODO grant the owner approved for
this client + this workspace — the standard first-party trusted-client pattern —
so the owner consents once over local IPC and the browser does not re-prompt. A
grant bound to a different workspace is filtered out (no cross-workspace reuse).

**Trade-off.** Slightly more grant plumbing; in return single-owner consent is
one approval, and audience binding is still enforced by the verifier.

**Evidence / validation.** `integration/m0` issues a working token; AUTH-07
cross-workspace isolation holds in `security/auth.test.ts`. See
[src/auth/provider.ts](../../src/auth/provider.ts),
[src/auth/interactions.ts](../../src/auth/interactions.ts).
