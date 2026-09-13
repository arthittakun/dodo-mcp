# ADR-015 — Coding-agent parity (v1.2): parallel commands, sandbox, patch, LSP, stdio

**Status:** accepted (implemented)

**Context.** After v1.1 the owner asked for DODO to match the tool set of
Claude Code / Codex CLI / Kiro / OpenCode "in one package", including running
several commands at once so the AI works faster. The MCP client confirms every
call, so DODO's own approvals stay for `inspect`/`edit` but must not add
friction in `trusted` mode.

**Decision.** Add, on the same policy + journal:

- **Parallel & background execution** — `run_commands` (up to 8 commands at
  once, one result each), `run_command background:true`, `job_wait`.
- **OS sandbox for commands** (Codex-style) — `run_command{sandbox:true}` /
  global `commandSandbox: off|prefer|require`: macOS `sandbox-exec` seatbelt
  profile or Linux `bwrap`, restricting **writes** to the workspace + declared
  caches and optionally denying network. Availability is detected; `require`
  fails closed. It confines what the command may *write*, not what it may read.
- **`apply_patch`** — unified-diff application with `fuzzFactor: 0` (no fuzzy
  matching); a non-applying hunk fails the whole call.
- **`replace_in_files`** — bulk literal replace, dry-run by default.
- **Grep parity** — `search_code` gains context lines, `fileGlob`, output modes
  `files`/`count`, and a time-capped worker-thread regex fallback when ripgrep
  is absent (the worker is terminated on timeout).
- **`read_image`**, `read_files{numbered}`, `glob_files{sortBy:'mtime'}`.
- **Agent memory** — `todo_write`/`todo_read` (per-workspace, outside the repo),
  `read_instructions` (AGENTS.md / CLAUDE.md / .cursor/rules / .kiro/steering…
  as untrusted conventions), `environment_info`.
- **`fetch_url`** — opt-in (`allowWebFetch`), https-only, SSRF-guarded
  (private/loopback/link-local refused, re-checked on every redirect hop),
  gated like a command.
- **LSP adapter** — owner-registered language servers (`dodo lsp add`) behind
  the same semantic tools; see docs/LSP.md.
- **stdio transport** — `dodo stdio` for local clients (Claude Code, Cursor,
  Codex CLI, Claude Desktop): no tunnel, no OAuth; the local client process is
  the principal. Trust modes, approvals and path policy are unchanged.
- **Ecosystem task discovery** — Makefile, pyproject/pytest, Cargo, Go,
  composer, Gradle, Maven recipes in `project_overview`.
- `dodo audit` to review what the AI did.

**Trade-offs.** More surface (43 tools). The sandbox is best-effort OS
isolation of writes/network for the command process tree — not a security
boundary against a hostile same-user process; `sandbox-exec` is deprecated by
Apple but functional. `fetch_url` is network egress from the owner's machine
and stays off by default.

**Evidence / validation.** `tests/integration/agentTools.test.ts` (parallel
results, background + job_wait, macOS sandbox write denial, search modes +
regex worker, multi-file apply_patch + CONFLICT on stale hunks, bulk replace
dry-run/apply, image block, numbered reads, instructions, todos, env info,
Makefile recipes, fetch_url disabled/SSRF refusals),
`tests/integration/stdio.test.ts` (real `@modelcontextprotocol/client` stdio
transport against `dodo stdio`), `tests/unit/sandbox.test.ts` (seatbelt profile
+ real enforcement on macOS), `tests/integration/lsp.test.ts` (pyright over
stdio JSON-RPC), `tests/integration/faultInjection.test.ts` (CHG-08/09).
