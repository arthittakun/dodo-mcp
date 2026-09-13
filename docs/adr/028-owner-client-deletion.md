# ADR-028: explicit reviewed deletion of selected OAuth clients

Status: accepted, 2026-09-10. The owner requested a clear-client button.

Keep the current-folder access list. A separate collapsed manager loads safe
installation-wide ID/name/count summaries on demand and deletes only explicitly
selected registrations (up to 100). Confirm the global effect with exact IDs.
The UI uses textContent; no client secret or callback is returned by review.

Deletion is a single SQLite IMMEDIATE transaction after all review hashes match:
deny related approvals, revoke grant rows, remove provider models and workspace
ACLs, delete client registrations, audit. Roll back the entire batch on failure.
Keep histories and unrelated registrations/keys/files. No wildcard future-client
selection, reset of state or remote MCP tool is introduced. Existing work may
finish; subsequent calls/refresh and grant-backed scheduled launches are denied.

The existing oidc-provider 9.12.2 implementation (lib/models/client.js Client.find)
consults the adapter before dynamic-cache reuse; clients:[] avoids static cached
registrations. The verifier independently checks registration existence and
interaction completion checks again after asynchronous grant persistence.

Evidence: clientDeletion.test.ts real access/refresh, preserved second client,
stale/hostile requests, race-safe selection and injected SQLite rollback tests;
local browser cancel/select/delete/empty-state check. Exact outcomes in
TEST_REPORT. Real owner clients were not deleted. No new dependencies/migrations.
