# ADR-027: show current-root client access; keep OAuth registration shared

Status: accepted, 2026-09-10.

The owner wants Client access to show only the running folder's clients. The
old UI listed all registrations, making unrelated ChatGPT entries look active.
Filter the main state/list by nonempty current-workspace ACL. Preserve shared
OAuth registration and other-root ACLs, rather than duplicate or delete clients.

An owner can explicitly add an existing registration through an on-demand picker
under the same private capability/Host/Origin boundary. Bind its read and write
to the reviewed workspace/epoch; invalidate stale UI responses on switch. Add-only
writes reject an existing ACL to avoid overwriting another tab's recent grant.
Revocation removes only the local ACL/card; it leaves login and registration.

No dependency/schema migration/MCP wire change. Evidence: localConfig security
fixtures for filtering, secret exclusion, read-only enumeration, local-only
addition/revocation and stale/foreign requests; workspaceSwitch verifies filtering
and unchanged cross-root OAuth denial. Browser fixture checks the actual owner
picker. Exact results are in TEST_REPORT; real ChatGPT remains MANUAL_NOT_RUN.
