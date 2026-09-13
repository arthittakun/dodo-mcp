# ADR-021 — Remember desktop consent for an exact workspace path

Date: 2026-09-09. Status: accepted for persistent desktop consent at the owner's explicit request.

`dodo desktop allow --app <exact-bundle-ids> --mode view|control --persist --yes`
saves standing consent until disabled. It works before a server is started.
Without `--persist`, consent retains the 60-minute default (1–480 configurable)
and expires on boot/root switch. Mixing `--persist` and `--minutes` is rejected.
Every allow replaces the entire previous app/mode grant for that root.

Use the existing private SQLite meta store keyed by realpath-derived workspace
ID. No project file, public endpoint or MCP tool can set this policy. Saved
consent resumes only when the same workspace becomes active; it does not grant
other roots/client scopes or change exec trust. The local CLI and owner IPC/UI
share one validated writer. CLI save/disable use local SQLite directly, like
the existing trust command, so neither needs a running server. There is no
automatic listener, native helper setup or OS permission prompt.

The stored policy adds `persistent` (legacy default false), `revision` (UUID),
and nullable `expiresAt` (null only for explicitly persistent grants). On read,
persistent consent binds the current service epoch. Every replacement receives
a new revision; running services re-read it before work, so old snapshots and
action approvals cannot survive a CLI change even with identical apps/mode.
Snapshots remain principal-bound and at most 30 seconds. Uncertain action
receipts remain durable and never auto-replay after restart.

`dodo desktop disable` and the private config stop button revoke AND forget.
They prevent future dispatch; neither can retract an already posted OS event.
No global app whitelist or automatic permission for a newly selected project.
Same-UID processes remain outside the security boundary.

Evidence: existing Zod 4 and better-sqlite3 13.0.3 APIs, no new dependencies or
native code. Unit cases cover old records, malformed records, expiry versus
persistence, roots/epochs, revision invalidation and cross-connection revocation.
Real CLI tests save offline, start/restart a nested Thai/space path, check its
parent remains off, then revoke while stopped. HTTP/OAuth tests retain scope and
action approval boundaries with a fake OS adapter. Final outcomes are recorded
in TEST_REPORT; this change does not claim new native click/type acceptance.
