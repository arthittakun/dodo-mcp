# ADR-035 — Incremental Project Brain with source-verified graph evidence

## Status

Accepted for DODO MCP 1.0.0.

## Context

Per-request AST/LSP calls answer a focused question but do not preserve a bounded project
map. A persistent graph can reduce repeated work, yet cached code metadata creates a
security and correctness risk if clients treat it as authority or current source.

## Decision

DODO keeps one regenerable Project Brain per workspace in installation SQLite. A bounded
worker parses TypeScript/JavaScript with DODO's pinned TypeScript package and parses
`package.json` as data. It never loads repository plugins or runs repository code.

The cache key includes source SHA-256, parser version, graph schema version and relevant
configuration. Incremental runs preserve unchanged parsed payloads, calculate affected
sources from import and symbol-reference evidence, and commit cache plus graph atomically.
An opaque file identity survives one unambiguous exact-content move, so semantic
`symbol://` identifiers can survive path changes.

Index records are evidence, not capabilities. Every public query rechecks the live grant,
workspace ACL, workspace context, guarded path and current source hash. Stale records are
omitted by default. HMAC cursors are bound to principal, workspace and query. Maintenance
operations require `dodo:exec` and target-specific trust approval.

## Consequences

- Full grows to 86 operations; Compact remains 19 and Hybrid remains 49 by routing the six
  brain operations through existing assistance gateways.
- TypeScript/JavaScript and package dependency graphs are available immediately; other
  language graph providers require an explicit later contract.
- File-system metadata avoids hashing unchanged files on each poll, while final query
  freshness still depends on SHA-256.
- Exact-content copies get new identity; ambiguous multiple removals do not reuse identity.
- Route/test/reference relations are labelled syntax evidence and do not claim runtime truth.
- Interrupted or corrupt state queues a full rebuild while retaining the last committed graph.

## Rejected alternatives

- Treat graph IDs as authorization: rejected because copied/stale metadata must not bypass
  direct source policy.
- Load repository TypeScript plugins or execute build scripts: rejected because repository
  configuration has no authority.
- Rebuild the entire repository for every file change: rejected because the feature requires
  measurable incremental work.
- Use embeddings as the sole source of truth: rejected because results need source location,
  hash, parser version and deterministic freshness evidence.
