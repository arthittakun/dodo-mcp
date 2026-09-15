# ADR-048 — Persistent exclusive Local/Tunnel connection mode

## Status

Accepted in source; unreleased.

## Context

The prior launch flow asked for a run-scoped Cloudflare Tunnel token each time and could
start locally when the owner omitted it. That made the advertised endpoint depend on an
interactive answer and allowed a configuration mistake to change the connection path.
Owners need one installation-wide choice: always use the DODO Tunnel or always use the
local endpoint until they explicitly change it.

## Decision

Global owner config stores one authoritative `connectionMode`: `local` or `tunnel`.
Legacy `mode` and `startWithDodo` fields are accepted only during load-time migration
and are removed from newly saved config.

In Local mode DODO advertises `http://127.0.0.1:<port>/mcp`, uses the loopback origin as
its OAuth issuer/resource and never starts `cloudflared`. In Tunnel mode DODO advertises
the configured public HTTPS origin, starts one process-owned supervisor on every
`dodo start`, waits for readiness and stops that child with DODO. Missing credentials,
executable failure or readiness failure aborts startup; there is no Local fallback.

The standard credential path is a reviewed OS store: macOS Keychain, Windows Credential
Manager or Linux Secret Service. Global config stores only an opaque reference. Explicit
environment/private-file references remain for owner-controlled headless deployments.
The token reaches `cloudflared` through its dedicated child environment and never enters
argv, config, logs, audit, browser storage, MCP output or MCP-job environments.

Local Config may select the mode and accept a write-only token after its existing owner,
Host, Origin, proxy-header, rate and workspace-context checks. The backend writes it to
the OS store and returns only presence/provider. A saved change requires restart and the
UI distinguishes saved mode from the active runtime endpoint.

Remote Config remains a bounded one-hour `/config` lease. It is available only while
Tunnel mode and the DODO-owned supervisor are active. Installation IPC cannot transmit a
Tunnel token or change mode, and public MCP routes expose no owner control operation.

## Consequences

- Startup and endpoint selection are deterministic and auditable.
- Tunnel mode fails closed instead of silently changing how clients reach DODO.
- Credential unlock may still require an owner/OS interaction at startup.
- The loopback MCP listener remains present as the private Tunnel upstream, but the
  public URL is the only advertised active MCP endpoint in Tunnel mode.
- Switching modes or public origin requires a DODO restart and client reconnect/rescan.

## Evidence

- `tests/integration/connectionMode.test.ts`
- `tests/security/tunnelCredentials.test.ts`
- `tests/security/localConfig.test.ts`
- `tests/integration/tunnelSupervisor.test.ts`
- `tests/security/remoteConfig.test.ts`
- `tests/integration/remoteConfigUi.test.ts`
