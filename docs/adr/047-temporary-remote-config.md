# ADR-047 — Temporary Remote Config on the tunneled listener

## Status

Accepted in DODO MCP 1.0.2.

## Context

The MCP/OAuth listener is already tunneled from `127.0.0.1:21730`, while Local Config
is intentionally bound to `127.0.0.1:21731`. Owners sometimes need to configure DODO
from another device. Permanently routing 21731 or placing its bearer capability in a
public URL would break the owner control boundary.

## Decision

`dodo --web` opens a process-memory lease at `<public-origin>/config` for at most one
hour. The route is 404 before and after the lease. A random one-time pairing code is
shown only in the owner terminal; the server stores only its digest. Successful pairing
issues a random session cookie scoped to `/config` with Secure, HttpOnly and SameSite
Strict attributes. The server stores only the session digest.

The public handler is a bounded reverse proxy to the existing loopback Local Config.
It strips client credentials and proxy headers, injects the private loopback capability,
and leaves Local Config's workspace/epoch checks, validation, policy and audit as the
authority. Pairing never grants MCP scopes, project access, trust or approvals. No MCP
tool can open the lease.

ADR-048 supersedes the temporary-token handoff: current source opens Remote Config only
when the saved connection mode is Tunnel and the DODO-owned Tunnel is already running.
Owner IPC cannot carry a Tunnel credential or switch the connection mode. Closing or
expiry still affects only Remote Config; MCP, OAuth and Tunnel continue running.

## Consequences

- The owner can choose local-only MCP, tunneled MCP, or tunneled MCP plus temporary
  Remote Config without rebinding either listener.
- Reopening issues a new code/session and invalidates the previous pair.
- A live Cloudflare route and public HTTPS origin remain owner prerequisites.
- Anyone with both the public URL and current one-time code can pair during its short
  validity, so owners must treat the code as a temporary secret and close the lease
  when finished.

## Evidence

- `tests/security/remoteConfig.test.ts`
- `tests/integration/remoteConfigUi.test.ts`
- `tests/integration/cli.test.ts`
