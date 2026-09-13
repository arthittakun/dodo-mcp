# ADR-036 — Goal-driven Context Engine and source-verifying evidence

**Status:** Accepted for DODO 1.0.0 Phase 06

## Context

Low-level search, Project Brain and read-only federation expose useful evidence, but
an AI client still had to select and merge each source itself. A raw repository dump
would exceed context budgets, obscure omissions and make stale or inferred data look
equivalent to verified source.

## Decision

Add `context_query`, `context_evidence` and `context_status` to Full. Compact and
Hybrid route all three through the existing `dodo_assist_read` gateway, keeping their
catalog sizes at 19 and 49 while Full grows from 86 to 89.

`context_query` accepts a goal, optional terms, up to eight authorized project
selectors, an evidence byte budget and pagination. It combines bounded literal
search, active Project Brain entities/relations, active Git metadata and federated
read search. Ranking is deterministic and includes reasons. Output always separates
FACT, OBSERVATION, MEMORY, INFERENCE and HYPOTHESIS; unavailable Phase 07 memory and
Phase 08 runtime sources remain explicit empty/unavailable data.

Evidence records carry project/workspace identity, source type, opaque source URI,
relative path, SHA-256, location, optional commit, confidence, generation/verification
times, freshness and limitations. All retrieved content is marked untrusted.
`context_evidence` resolves only records owned by the same principal/request workspace
and rechecks live authorization and the current source dependency.

SQLite stores caller-scoped context cache levels L0–L6, evidence records and aggregate
metrics. Derived levels include dependency path/hash sets. Every L6 reuse first
rechecks active and target ACL plus all dependencies; mismatch marks prior evidence
stale and invalidates L1–L6. Cache/evidence have TTL and per-principal row caps. HMAC
cursors bind query, source index version, active workspace and principal.

## Security consequences

Retrieval uses `dodo:read` and cannot call write/exec handlers. Project selectors are
resolved only from the caller's authorized federation view; unauthorized targets fail
without returning path metadata. Active and target `WorkspaceFS` policy remains the
source/path/secret authority. Evidence IDs, hashes, source URIs, cache rows and cursor
tokens grant no access. Repository instructions and retrieved text never alter OAuth,
ACL, trust, approvals, command sandbox or tool policy.

## Consequences

- An AI can request bounded context by goal while seeing omissions and unavailable
  providers explicitly.
- Stale evidence is inspectable as stale and is never silently presented as current.
- Full clients receive three additional definitions; remote catalog budgets remain
  unchanged.
- Federated semantic graph, durable memory and runtime evidence remain later phases.
