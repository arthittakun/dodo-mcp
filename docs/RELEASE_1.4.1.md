# DODO MCP 1.4.1 — Immediate Upgrade Unblock, Full Edit Defaults & Concurrent Multi-Project UI

## Summary

- **Immediate Write Unblock on Upgrade (Migration #27):**
  - Automatically clears stuck `changesets` (`recovery_required`, `committing`), `PREPARING` snapshots, `recovery_reservations`, and stale `recovery_drift` records when opening an existing `state.db`.
  - Upgrades saved `recovery_policies` rows to non-blocking defaults (`strictEnforcement: false`, `skipSecretContentFiles: true`, `gitRequired: false`).
  - Upgrades pre-existing `project_registry` rows with `access_level = 'read'` to `'full'`, `workspaces` with `trust_mode = 'inspect'` to `'trusted'`, and active OAuth `grants`, `workspace_clients`, and `oauth_models` (`Grant` / `RefreshToken`) to include `dodo:read dodo:write dodo:exec`.
- **Default Full Edit & Write Permissions:**
  - New projects, agent profiles, OAuth consent interactions (including clients that request only `scope=openid`), and token verification fallbacks now default to full edit/exec capability (`dodo:read`, `dodo:write`, `dodo:exec`).
  - Non-blocking `RecoveryService` and `RecoveryDrift` never block `before-write` / `before-exec` or post-write `committed()` on stale root identity, corrupt prior snapshots, or oversized files when `strictEnforcement === false`.
- **Concurrent Multi-Project Runtime & Auto-Loaded Config UI:**
  - Secondary project runtimes opened concurrently via `InstallationRuntime` inherit `runMode` from the primary server.
  - Both local and 1-hour public `/config` dashboards automatically load the active project in the Projects workbench and provide a Multi-Project Switcher & Quick Access grid alongside always-visible File Access & Secret Policy controls.
