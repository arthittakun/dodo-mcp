# ADR-031 — Owner-selected Cloudflare Tunnel supervision

**Status:** superseded in credential/lifecycle selection by ADR-048. Process ownership,
readiness, redaction and bounded-stop decisions remain accepted.

**Decision.** DODO starts only an owner-selected, trusted `cloudflared` executable owned by the current HTTP process. `dodo start` can attach it immediately; the authenticated Local Config can start or stop the same process-owned runtime. The owner still creates the remotely-managed Tunnel, public hostname and DNS in Cloudflare.

The original flow used a run-scoped token entered through a hidden terminal prompt or
the authenticated loopback Local Config. ADR-048 replaces that credential flow with one
persistent Local/Tunnel selection and a reviewed credential reference. The invariant
retained from this ADR is that a process-owned `TunnelRuntime` forwards the resolved
credential through the child environment, stops that child with DODO and keeps the
credential out of argv, logs, MCP, audit and job environments.

The supervisor uses a separate authenticated singleton owner IPC endpoint, loopback readiness, bounded restarts, private bounded/redacted logs and live child handles for termination. It never signals a saved PID or searches by process name. Local Config and the metrics listener remain loopback-only and are not part of the public route.

**Trade-off.** Foreground supervision is easier to inspect and stop safely, but the terminal must remain open. Native service installation is left to the owner. A readiness success proves a Cloudflare connection, not that an AI client is connected.

**Evidence.** `tests/security/tunnelCredentials.test.ts`, `tests/integration/tunnelSupervisor.test.ts`, authenticated IPC tests, setup tests and packaging tests exercise credential boundaries, argv non-disclosure, exact redaction, singleton ownership, readiness, bounded restart and owned stop without using a real Cloudflare credential or network tunnel. Real macOS/Windows/Linux Tunnel validation remains a manual gate in `docs/MANUAL_ACCEPTANCE.md`.
