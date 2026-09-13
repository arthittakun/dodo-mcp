# ADR-026: remove conversation confirmation; retain existing access policy

Status: accepted, 2026-09-10. Supersedes ADR-025 and the usage-round portion of
ADR-024; scheduled commands retain their separate local approval.

## Decision

The owner explicitly requested removal after the chat-ID workflow proved cumbersome.
Remove the gate entirely rather than infer a conversation from untrusted labels
or silently approve a default chat. The MCP transport exposes no verified chat
identity in our installed integration; an owner-pasted ID never proved one.

HTTP authentication, effective workspace ACL/scopes, workspace ID/epoch, trust,
action approval, Desktop policy, path/hash/journal checks remain. Both HTTP and
STDIO start with direct project_overview. Shared connections share permission;
DODO no longer claims conversation-level permission or revocation.

Remove all three usage tools, chat/usageId wire fields, owner chat/usage/reset
commands, private routes/UI and usage service/timer. Keep schedule_propose and
owner schedule approval. Catalog: 52 -> 49. Job principal is the authenticated
grant. This policy requires refreshing cached tool schemas and restarting DODO.

Retain migrations 5/6 and their old tables as inert upgrade history, without
runtime permission reads/writes. Do not reset OAuth, keys, ACLs, desktop consent,
schedules, files or audit history. This avoids destructive rollback of state.

## Evidence

Dependencies unchanged: MCP SDK 2.0.0, oidc-provider 9.12.2 and better-sqlite3
13.0.3. directAccess.test.ts covers immediate HTTP read/write/exec, removed
schemas/interfaces, legacy rows across restart and unchanged auth/path/trust
boundaries. STDIO, schedule, kill and package tests dispatch without any hidden
consent fixture. Removed feature tests are replaced by direct-access regressions;
existing auth, file safety, exec and Desktop security tests remain. Exact commands
and outcomes are recorded in TEST_REPORT.md; external AI-client runs remain manual.
