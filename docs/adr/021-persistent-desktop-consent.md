# ADR-021 — Remember desktop consent for an installation

Date: 2026-09-09. Status: accepted for persistent desktop consent at the owner's explicit request.

`dodo desktop allow --app <exact-bundle-ids> --mode view|control --persist --yes`
saves standing consent until disabled. It works before a server is started.
Without `--persist`, consent retains the 60-minute default (1–480 configurable)
and expires on boot/root switch. Mixing `--persist` and `--minutes` is rejected.
Every persistent allow replaces the installation app/mode grant.

Use the existing private SQLite meta store keyed by installation. No project
file, public endpoint or MCP tool can set this policy. Saved consent applies to
all registered project runtimes but does not grant OAuth scopes, register roots,
change exec trust or relax snapshot checks. Temporary grants remain keyed by
workspace and epoch. The local CLI and owner IPC/UI
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

`dodo desktop disable` and the private config stop button revoke AND forget the
installation grant. They prevent future dispatch; neither can retract an already
posted OS event. Exact named-app allowlisting remains mandatory. Same-UID
processes remain outside the security boundary.

Evidence: existing Zod 4 and better-sqlite3 13.0.3 APIs, no new dependencies or
native code. Unit cases cover old records, malformed records, expiry versus
persistence, roots/epochs, revision invalidation and cross-connection revocation.
Real CLI tests save offline, start/restart a nested Thai/space path, reuse the
grant from its parent, then revoke while stopped. HTTP/OAuth tests retain scope,
workspace snapshot and action boundaries with a fake OS adapter. Final outcomes are recorded
in TEST_REPORT; this change does not claim new native click/type acceptance.
