# ADR-006 — Guarded file tools + explicit native execution (no OS sandbox)

**Status:** accepted (implemented)

**Decision.** File tools are confined by one shared `WorkspaceFS` path policy;
execution is explicit and gated by trust mode + per-action approval. We do
**not** claim an OS sandbox. Programs run with the user's real OS privileges;
`shell:false` reduces wrapper injection only, not confinement.

**Trade-off.** `trusted` mode is genuinely powerful and dangerous; the boundary
is "I trust this code with my account", not isolation. Documented prominently.

**Evidence / validation.** Path traversal/symlink/hardlink/secret denial via
tools in `security/pathTraversal.test.ts`; the non-sandbox limit is stated in
[SECURITY.md](../SECURITY.md). See [src/workspace/fs.ts](../../src/workspace/fs.ts),
[src/security/policy.ts](../../src/security/policy.ts).
