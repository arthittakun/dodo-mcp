# ADR-031 — Owner-selected Cloudflare Tunnel supervision

**Status:** accepted (implemented)

**Decision.** DODO starts only an owner-selected, trusted `cloudflared` executable owned by the current HTTP process. `dodo start` can attach it immediately; the authenticated Local Config can start or stop the same process-owned runtime. The owner still creates the remotely-managed Tunnel, public hostname and DNS in Cloudflare.

The default flow uses a run-scoped token entered through a hidden terminal prompt or the authenticated loopback Local Config. The token is never persisted in global config or an OS credential store. A process-owned `TunnelRuntime` forwards it through the managed child's dedicated environment and stops that child with DODO; it is absent from argv, logs, MCP, audit and job environments. Explicit secure credential references remain supported only by advanced standalone tunnel commands for compatibility.

The supervisor uses a separate authenticated singleton owner IPC endpoint, loopback readiness, bounded restarts, private bounded/redacted logs and live child handles for termination. It never signals a saved PID or searches by process name. Local Config and the metrics listener remain loopback-only and are not part of the public route.

**Trade-off.** Foreground supervision is easier to inspect and stop safely, but the terminal must remain open. Native service installation is left to the owner. A readiness success proves a Cloudflare connection, not that an AI client is connected.

**Evidence.** `tests/security/tunnelCredentials.test.ts`, `tests/integration/tunnelSupervisor.test.ts`, authenticated IPC tests, setup tests and packaging tests exercise credential boundaries, argv non-disclosure, exact redaction, singleton ownership, readiness, bounded restart and owned stop without using a real Cloudflare credential or network tunnel. Real macOS/Windows/Linux Tunnel validation remains a manual gate in `docs/MANUAL_ACCEPTANCE.md`.
