# ADR-024: owner-confirmed usage rounds and separately approved schedules

> Conversation/usage-round portions superseded by [ADR-026](026-remove-conversation-confirmation.md). Scheduled-command approval remains accepted. The original decision below is retained as design context.

Date: 2026-09-10. Status: retained design decision. Supersedes any earlier assumption
that OAuth/trust alone enables project tools, or that a missing workspace ACL
is an invalid OAuth identity token.

## Decision and limits

Installed official MCP SDK server/client 2.0.0 provides the existing stateless
HTTP and STDIO handlers; neither the request label nor a model-chosen ID is a
trusted conversation identity. Do not invent a protocol session and claim chat
isolation. Ship fail-closed owner-approved usage rounds with client/grant/root/
epoch/expiry binding, and require cooperative clients to create a new round per
conversation and end it on revocation/end. No verified chat adapter is claimed.
An approved ID replayed by the same authenticated principal in another chat is
indistinguishable in this fallback. Process restart/root switch requires a fresh
round; a dropped network connection does not.

All actual tools, including overview/read/job/desktop, share the gate before
handler dispatch. Only usage_request/status/end are exempt control operations;
these reveal no workspace context. No MCP approve operation exists. Owner CLI
uses private IPC; UI approval keeps existing capability/origin/workspace epoch
checks and requires typing the displayed phrase. Default TTL 60 min, max 8h;
pending requests expire in 10 min. Internal bootstrap/recovery by the owner CLI
and OAuth/protocol metadata are control-plane operations, not granted tool use.

A valid identity token without active workspace permissions authenticates with
zero effective scopes. Tools return WORKSPACE_ACCESS_REQUIRED with null workspace
context, without WWW-Authenticate. Invalid/expired/wrong-audience/revoked tokens
still fail at the resource server. No root access is added by this distinction.

Schedules have immutable specs/digests and local owner approval distinct from
usage consent. They run current project code, not a pinned revision. Baseline
saved trust must be trusted and the captured root/policy must match. Defaults:
require OS sandbox, network off, timeout 5 min, expiry explicitly supplied up to
30 days, five-field cron. Local owner-created schedules do not depend on OAuth;
remote proposals additionally depend on their client's live exec ACL/grant.

SQLite migration 5 adds usage_consents, schedules and schedule_runs. Claim due
slots and advance next_at in BEGIN IMMEDIATE before spawn. A crash may lose an
execution, but never automatically replays an uncertain occurrence. Skip missed
and overlapping ticks. Scheduler is internal to the active HTTP workspace only;
no OS cron/launchd installation, no inactive-root traversal, no auto-start service.

## Evidence

- Registry verified cron-parser 5.10.0 (Node >=18), pinned exact with lockfile.
  API read from installed declarations: CronExpressionParser.parse(...,
  {tz,currentDate}).next().getTime(); use maintained parser for calendar/timezone
  computation. Upstream: https://github.com/harrisiirak/cron-parser
- Installed SDK declarations support McpServer options.instructions; both transports
  advertise confirmation/revocation instructions without changing the MCP protocol.
- tests/security/usageConsent.test.ts: actual HTTP/OAuth dispatch denied before
  confirmation, local IPC/UI approval, replay/client/root/epoch/expiry/revoke cases.
- tests/integration/schedules.test.ts: pending/approve/hash, real execution,
  overlap, revoke, restart/missed/uncertain, policy/grant changes, shared claims.
- Existing identity tests now assert zero effective scopes AND tool denial, rather
  than only an OAuth exception. Old-schema migration fixtures remove later tables
  when reconstructing the actual historical schema.
- Exact totals and manual gates: TEST_REPORT and MANUAL_ACCEPTANCE.

## Threat model

Private same-UID IPC is the existing owner authority boundary, not a defense
against hostile code already running as that OS user. Unsandboxed trusted exec
or desktop control can act with user privileges, including interacting with
owner controls. Prompt instructions forbid self-approval, but are not an OS
security boundary. These limitations remain explicit; usage consent does not
turn arbitrary code execution into isolation. No server-side guarantee of
recognizing chat text or closing a chat is claimed.
