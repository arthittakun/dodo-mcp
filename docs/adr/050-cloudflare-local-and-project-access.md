# ADR-050 — Cloudflare Local mode and visible per-project access

## Status

Accepted for DODO 1.2.0. This extends ADR-048; its credential isolation and
DODO-owned supervisor rules remain in force.

## Context

The owner UI used the label “Local” for loopback-only MCP. Owners also use the word
local for a `cloudflared` binary installed and managed on the same machine, so the
two-process ownership models were easy to confuse. The personal access UI also hid
the detailed Trust and Client ACL cards without replacing them with a visible,
simple project-level control. Authority still existed, but owners could not see or
change the intended project ceiling from the Projects page.

## Decision

DODO exposes three mutually exclusive installation connection modes:

- `local`: loopback-only MCP; no Cloudflare process or public origin is used.
- `external`: **Cloudflare Local**; the owner installs, starts and stops
  `cloudflared`. DODO advertises the reviewed public HTTPS origin but never accepts
  a Tunnel token and never supervises that process.
- `tunnel`: **DODO Tunnel**; DODO reads a credential through the reviewed credential
  provider, starts one owned child, waits for readiness and stops that child.

The UI never uses “Local” by itself. It labels the choices “เฉพาะเครื่อง (Loopback)”,
“Cloudflare Local (ติดตั้งในเครื่อง)” and “DODO Tunnel”. `--local` remains a
deprecated loopback alias because changing an old flag to a public mode would be an
unsafe compatibility break; new commands are `--loopback` and
`--cloudflare-local`.

Every registered project has one visible access ceiling: `read`, `edit` or `full`.
The Projects page displays and saves it in both personal and managed installations.
In personal mode this replaces repeated Trust/Client ACL configuration; in managed
mode the existing per-client ACL remains required. Effective authority is always:

```text
token scopes ∩ live grant scopes ∩ managed ACL (when enabled) ∩ project access ceiling
```

The ceiling cannot grant a missing OAuth scope and does not bypass workspace
identity/epoch, approval, sandbox, path/secret guards, expected hashes, idempotency
or audit.

## Consequences

- Saving Cloudflare Local never reads, writes or validates a DODO Tunnel token.
- Remote Config can use either public Cloudflare mode; external mode depends on the
  owner-managed route, while tunnel mode additionally requires the owned supervisor.
- Existing `local` config remains loopback-only. Legacy external config migrates to
  the explicit `external` mode.
- Existing project rows migrate to `full` so the upgrade does not silently revoke
  authority. Invalid stored levels fail closed to `read`.
- Connection-mode and project-access changes require no repository configuration and
  expose no owner operation through MCP.

## Evidence

- `tests/integration/connectionMode.test.ts`
- `tests/integration/configUiComponents.test.ts`
- `tests/security/tunnelCredentials.test.ts`
- `tests/security/remoteConfig.test.ts`
- `tests/integration/projectAccessUi.test.ts`
- `tests/integration/projectByName.test.ts`
- `tests/security/projectAccessLevel.test.ts`
