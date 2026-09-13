# ADR-008 — TypeScript/JavaScript semantics first, in a guarded worker

**Status:** accepted (implemented)

**Decision.** `symbols` / `references` / `preview_rename` use the bundled
TypeScript Language Service running in a worker thread with a custom
`LanguageServiceHost` that routes every file access through the same
`WorkspaceFS` policy (plus a read-only allowlist for TypeScript's own lib dir).
Other languages return `UNSUPPORTED_LANGUAGE` — grep is never labeled semantic.
tsconfig is parsed as data; repo TS plugins are never loaded.

**Trade-off.** Only TS/JS get true semantics in v1. Honest capability reporting
over pretend coverage.

**Evidence / validation.** `integration/semantics.test.ts` (shadowing/import/
re-export references, homonym-safe rename, Python → UNSUPPORTED_LANGUAGE). See
[src/services/intelligence/tsWorker.ts](../../src/services/intelligence/tsWorker.ts).
