# ADR-031 — Owner-selected Cloudflare Tunnel supervision

**Status:** accepted (implemented)

**Decision.** DODO supports two tunnel modes. `external` observes owner/system-managed connectivity and never starts a process. `managed` starts only an owner-selected, trusted `cloudflared` executable in the foreground after `dodo tunnel start --yes`. The owner still creates the remotely-managed Tunnel, public hostname and DNS in Cloudflare.

Tunnel tokens live in the platform credential store or an explicit secure env/file reference. Global config stores only the reference. The managed child receives the token through its dedicated environment; it is absent from argv, logs, MCP, audit and job environments.

The supervisor uses a separate authenticated singleton owner IPC endpoint, loopback readiness, bounded restarts, private bounded/redacted logs and live child handles for termination. It never signals a saved PID or searches by process name. Local Config and the metrics listener remain loopback-only and are not part of the public route.

**Trade-off.** Foreground supervision is easier to inspect and stop safely, but the terminal must remain open. Native service installation is left to the owner. A readiness success proves a Cloudflare connection, not that an AI client is connected.

**Evidence.** `tests/security/tunnelCredentials.test.ts`, `tests/integration/tunnelSupervisor.test.ts`, authenticated IPC tests, setup tests and packaging tests exercise credential boundaries, argv non-disclosure, exact redaction, singleton ownership, readiness, bounded restart and owned stop without using a real Cloudflare credential or network tunnel. Real macOS/Windows/Linux Tunnel validation remains a manual gate in `docs/MANUAL_ACCEPTANCE.md`.
