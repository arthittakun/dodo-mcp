# Architecture Decision Records

- [022 — Owner kill preserves login](022-owner-kill-preserves-login.md)

- [021 — Persistent desktop consent](021-persistent-desktop-consent.md)

Short records of load-bearing decisions, each with the trade-off and the
evidence (source and test) that settled it. ADR-001..010 capture the foundational
decisions; ADR-011+ resolve implementation ambiguities without reducing security.

| ADR | Decision |
|---|---|
| [001](001-one-process-one-workspace.md) | One process = one CWD workspace = one endpoint profile |
| [002](002-external-tunnel.md) | External named tunnel mode (partly superseded by ADR-031) |
| [003](003-sdk-v2-legacy-stateless.md) | Official MCP SDK v2 + legacy stateless fallback |
| [004](004-embedded-oauth-provider.md) | Embedded `oidc-provider` authorization server |
| [005](005-static-client-baseline.md) | Static client registration baseline; DCR off, CIMD deferred |
| [006](006-guarded-fs-explicit-exec.md) | Guarded file tools + explicit native execution (no OS sandbox) |
| [007](007-preview-hash-journal.md) | Preview / hash / idempotency / journal for changes |
| [008](008-ts-js-semantics-first.md) | TypeScript/JavaScript semantics first, in a guarded worker |
| [009](009-jobs-polling.md) | Jobs + polling as the execution baseline |
| [010](010-sqlite-better-sqlite3.md) | `better-sqlite3` durable store, chosen in M0 |
| [011](011-env-example-secure-default.md) | `.env.example` denied by default (secure default) |
| [012](012-workspace-scope-grant.md) | OAuth grants at both OIDC and resource scope; first-party auto-consent |
| [013](013-loopback-proxy-trust.md) | `trust proxy = loopback`; issuer from explicit config only |
| [014](014-direct-coding-tier.md) | Direct coding-agent tool tier (write/edit/glob/run_command/git_commit), 33 tools |
| [015](015-coding-agent-parity.md) | Coding-agent parity: parallel/background commands, OS sandbox, apply_patch, LSP adapter, stdio transport (43 tools) |


- [016 — OpenID consent correction](016-oidc-openid-consent.md)
- [017 — Installation identity and local config](017-installation-identity-local-config.md)
- [018 — ACL scope encoding contract](018-access-scope-encoding.md)
- [019 — Runtime workspace switch from Local Config](019-runtime-workspace-switch.md)
- [020 — Local macOS desktop access](020-desktop-access.md)

- [023 — Large coding inputs and private shell scripts](023-large-coding-inputs.md)

- [024 — Usage rounds and separately approved schedules](024-usage-rounds-and-schedules.md)

- [025 — Owner-first chat whitelist and reset](025-owner-chat-whitelist.md)

- [026 — Remove conversation confirmation; retain existing access policy](026-remove-conversation-confirmation.md)

- [027 — Current-workspace client list and explicit add picker](027-workspace-client-list.md)

- [028 — Reviewed owner deletion of selected OAuth clients](028-owner-client-deletion.md)
- [029 — Compact MCP tool surface with capability gateways](029-compact-tool-surface.md)
- [030 — Windows native candidate and authenticated owner IPC](030-windows-native-candidate.md)
- [031 — Owner-selected Cloudflare Tunnel supervision](031-owner-selected-tunnel-supervision.md)
- [032 — Owner-only durable project registry](032-owner-project-registry.md)
- [033 — Read-only multi-project federation](033-read-only-project-federation.md)
- [034 — Universal resource identity and private SHA-256 CAS](034-universal-resource-cas.md)
- [035 — Incremental Project Brain with source-verified graph evidence](035-project-brain-incremental-index.md)
- [036 — Goal-driven Context Engine and source-verifying evidence](036-context-engine-evidence.md)
- [037 — Evidence-backed owner-reviewed memory](037-owner-reviewed-memory.md)
- [038 — Caller-scoped Runtime Intelligence](038-runtime-intelligence.md)
- [039 — Advanced Agent Runtime](039-advanced-agent-runtime.md)
- [040 — Revision-bound DodoBench and release evidence](040-dodobench-release-gate.md)
- [041 — Local macOS and Docker Linux release gates](041-local-macos-docker-linux-gates.md)
- [042 — Project directory generation identity](042-project-directory-generation-identity.md)
- [043 — Trusted self-hosted platform gates](043-trusted-self-hosted-platform-gates.md)
- [044 — Global launcher and interactive owner menu](044-global-launcher-and-cli-menu.md)
- [045 — Explicit project runtimes and provider-backed sub-agents](045-ai-providers-multiproject.md)
- [046 — Personal add-and-use mode](046-personal-access-mode.md)
- [047 — Temporary Remote Config on the tunneled listener](047-temporary-remote-config.md)
- [048 — Persistent exclusive Local/Tunnel connection mode](048-persistent-connection-mode.md)
- [049 — Owner-approved Android control through ADB](049-android-adb-control.md)
