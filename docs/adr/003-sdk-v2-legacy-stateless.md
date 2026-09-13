# ADR-003 — Official MCP SDK v2 + legacy stateless fallback

**Status:** accepted (implemented)

**Decision.** Use the official MCP TypeScript SDK **v2** split packages
(`@modelcontextprotocol/{server,express,node}` `2.0.0`, verified on the npm
registry) and serve with `createMcpHandler(factory, { legacy: 'stateless' })`,
which handles the modern 2026-07-28 per-request path and a stateless fallback
for 2025-era clients on one endpoint. We do not hand-roll JSON-RPC, session
handling, or era classification, and do not mix v1 imports.

**Trade-off.** No support for the old sessionful GET-stream transport. The exact
protocol revision a given ChatGPT build negotiates was not captured; both
generations are tested locally instead.

**Evidence / validation.** `integration/m0-transport-oauth.test.ts` connects a
real SDK v2 `Client` (modern) AND drives a raw 2025 `initialize`+`tools/call`
(legacy stateless), both listing 33 tools; `GET`/`DELETE` return `405`. Versions
recorded in [COMPATIBILITY.md](../COMPATIBILITY.md). See
[src/server/appServer.ts](../../src/server/appServer.ts).
