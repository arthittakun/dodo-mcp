# ADR-011 — `.env.example` denied by default (secure default)

**Status:** accepted (implemented)

**Context.** Spec §10.2 flags `.env.example` ambiguously: the `.env*` hard deny
covers it, yet the text says it should not be excluded "by guessing".

**Decision.** Apply the pack's conflict rule — "when specs conflict, choose the
path that does not reduce security" — and keep `.env.example` under the `.env*`
secret deny **by default**. An owner who wants it readable can allow it via
explicit local policy in future (not exposed as a repo-config toggle, since repo
config cannot widen access).

**Trade-off.** A genuinely-template `.env.example` is unreadable by default,
which is mildly inconvenient but never leaks a misused one.

**Evidence / validation.** `unit/ignores.test.ts` asserts the secure default and
documents the rationale. See
[src/workspace/ignores.ts](../../src/workspace/ignores.ts).
