# ADR-005 — Static client registration baseline; DCR off, CIMD deferred

**Status:** accepted (implemented)

**Decision.** The v1 baseline is static OAuth client preregistration by the local
owner (`dodo auth add-client --redirect-uri <exact>`), copying the exact
callback the client UI shows. Wildcard redirect URIs are rejected. Dynamic
Client Registration (DCR) is **off** by default (deprecated in favor of CIMD in
the current spec). CIMD is **deferred** because the feature was experimental in
the `oidc-provider` version examined; enabling it requires allowlisted metadata
origins, SSRF/redirect/private-IP protection, and pinned deps first.

**Trade-off.** The owner registers a client once. In return there is no
anonymous public registration surface.

**Evidence / validation.** Redirect-URI exact-match, wildcard rejection, and
secret-shown-once are covered by `integration/cli.test.ts` and
`security/auth.test.ts` (AUTH-10, AUTH-12). Real ChatGPT registration mode is a
manual gate (MAN-03). See [src/auth/clients.ts](../../src/auth/clients.ts).
