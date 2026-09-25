# DODO MCP 1.3.2

## Recovery storage management

The project Recovery dashboard can now preview and confirm deletion of old
checkpoints, retry pending file cleanup, change project quotas/retention, and exclude
relative paths such as `models/` from future backups. It distinguishes logical
checkpoint totals from unique source objects and separate Git copies. Verified
unchanged objects are reused without another staging copy.

Protected/current baselines, pinned/named points and referenced recovery history
remain protected. Cleanup never edits project source. Unlink failures remain pending,
and live capture reservations prevent deletion of objects another project is using.
Changing exclusions does not delete older backups or acknowledge source drift.

Four operations are available through existing Compact read/write gateways:
`recovery_storage_status`, `recovery_cleanup_preview`, `recovery_settings_preview`
and `recovery_maintenance_apply`. AI apply requires exact owner approval even in
trusted mode. OAuth, ACL, caller ownership, workspace/epoch, path guards and
idempotency remain authoritative. Full has 162 definitions (158 by default);
Compact stays at 20.

## Upgrade

```sh
npm install -g dodo-mcp@1.3.2
dodo --version
```

Restart your foreground DODO process once to load the update, reopen Config, and
select the project → Recovery → จัดการพื้นที่ Recovery. Refresh/rescan the MCP
connection so its gateway operation schemas include the new capabilities.

Private state gains maintenance review and cleanup-task tables on first open;
existing backup data and access scopes are preserved. Keep CLI/server versions
aligned: older DODO versions refuse a state database with newer migrations.
See the [Recovery guide](RECOVERY.md) for the review/confirmation flow and
limits on excluded files, retention and shared storage.

## Verification

AUTOMATED_PASS on macOS: build, typecheck, lint, core 926 passed / 40 skipped /
0 failed; packaging 17 passed, including an installed CLI approval and Compact
maintenance flow. Real Chromium exercised desktop and 390px screens. Production
dependency audit reported zero vulnerabilities.

Native Linux/Windows CI, live AI clients and production checkpoint cleanup are
MANUAL_NOT_RUN for this patch. The owner explicitly chose publication with the
completed macOS checks and deferred the remaining platform tests to the next release.
No production process, tunnel or backup history was changed by release validation.
