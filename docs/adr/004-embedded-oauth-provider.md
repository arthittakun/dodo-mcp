# ADR-004 — Embedded `oidc-provider` authorization server

**Status:** accepted (implemented)

**Decision.** Co-host a maintained OAuth 2.1 / OIDC authorization server
(`oidc-provider` `9.12.2`) with the MCP resource server on one public origin. We
do not implement OAuth crypto, PKCE, token formats, or refresh rotation
ourselves. Issuer = configured public origin; resource = issuer + `/mcp`. Tokens
are ES256 JWTs bound to the workspace.

**Trade-off.** Local owner-consent UX must be built, and the provider is a large
dependency. In return there is no central SaaS and the protocol details are
handled by an audited library.

**Evidence / validation.** Full authorization-code + PKCE(S256) flow issues a
usable, workspace-bound token in `integration/m0` and `security/auth.test.ts`
(revocation, audience, PKCE failure, refresh). See
[src/auth/provider.ts](../../src/auth/provider.ts),
[src/auth/verifier.ts](../../src/auth/verifier.ts), [docs/AUTH.md](../AUTH.md).
