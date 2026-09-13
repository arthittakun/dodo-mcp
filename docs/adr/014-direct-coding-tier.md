# ADR-014 — Direct coding-agent tool tier (v1.1)

**Status:** accepted (implemented)

**Context.** v1 shipped the 24-tool review workflow (preview → approve → apply;
argv-only exec + job polling). The owner's actual use is an MCP client that
confirms **every** tool call itself (ChatGPT developer mode), and wants the AI
to work like a local coding agent — run tests, install packages, edit and search
in one step — "as capable as AI coding tools".

**Decision.** Add a direct tier of 9 tools on top of the SAME policy and
journal, taking the catalog to 33:

- `write_file`, `edit_file`, `delete_path`, `move_path`, `make_directory` — one
  call each, implemented by building a single-op plan through the existing
  `Planner` and applying it through the journaled `Applier`, so every direct
  write stays hash-verified, backed up, visible in `change_history` and
  reversible with `rollback_changes`.
- `glob_files` — pattern search over the policy-filtered walk (`picomatch`).
- `run_command` — a shell command **string** executed as `bash -c` (fixed
  system binary), which waits up to `waitMs` and returns exit code + bounded
  stdout/stderr inline; a still-running command hands back its `jobId`. This is
  the same capability a trusted caller already had via
  `exec_command(program:'sh', args:['-c', …])`, exposed ergonomically and gated
  by the identical exec policy — it adds convenience, not authority. DODO itself
  still spawns with `shell:false` (argv), so the only shell parsing is the one
  the caller explicitly asked for.
- `git_log` (read tier) and `git_commit` (exec tier: hooks run and the user's
  git identity is needed). `all: true` stages only paths from the scoped,
  secret-filtered status — never `git add -A .`.

Trust-mode semantics are unchanged; `trusted` is now documented as the
recommended mode when the client confirms each call.

**Trade-off.** Fewer DODO-side checkpoints in `trusted` mode — by the owner's
explicit choice, since the client dialog is the gate. The safety floor that does
not depend on mode (path policy, secret deny, hash verification, journal,
reversibility, no token/secret in child env) is untouched.

**Evidence / validation.** `tests/integration/directTools.test.ts` (13 cases:
the fix-the-bug loop with `run_command npm test` → `edit_file` → green,
AMBIGUOUS_EDIT/FILE_CHANGED refusals, create/move/delete round-trip with
rollback, policy + secret denial through direct tools, running-job handoff and
cancel, a real local `npm install`, inspect-mode approval gating, `git_commit`
that never stages `.env`). Catalog/schema counts updated to 33 in m0/compat/pack
suites. See [src/tools/directTools.ts](../../src/tools/directTools.ts),
[src/tools/jobTools.ts](../../src/tools/jobTools.ts),
[src/services/git/gitService.ts](../../src/services/git/gitService.ts).
