# ADR-025: Owner-first chat references and reset

> Superseded by [ADR-026](026-remove-conversation-confirmation.md). This record describes historical behavior, no longer active.

Accepted: 2026-09-10. Retained as design context.

Owners want to paste a ChatGPT /c/ URL without first asking an AI to create a
pending usage request. The installed MCP SDK 2.0.0 contract supplies no trusted
ChatGPT conversation identity. A caller-supplied UUID is not authentication.

Decision: accept strictly parsed URLs/UUIDs only on the existing owner CLI/IPC
and private Local Config plane. Migration 6 stores permission generations bound
to workspace ID, directory device/inode and selected client. Owner permissions
persist until reset or optional expiry; duplicate allow is idempotent and does
not extend expiry. No new remote approval tool, public endpoint, OAuth scope or
DCR behavior is introduced. Ambiguous client selection fails closed.

Every operation accepts `chat` alternatively to an approved `usageId`. A valid
reference derives an epoch/grant-bound round from the standing permission. The
reference never falls back to a different or sole allowed chat. Round revocation
also revokes its parent permission; automatic round expiry does not, so an
unexpired standing permission can derive a fresh round. Reset invalidates all
linked rounds, including old epochs; allowing again uses a new generation.
Current live jobs belonging to those rounds are canceled. Schedules and OAuth
remain independent. Root replacement invalidates old permissions.

The private UI retains capability, Origin/forwarding rejection and workspace
header checks for every mutation. Chat links are parsed as text, never fetched.
`dodo reset` means current-workspace usage/chat reset, not factory reset. CLI
controls require a running process for that CWD; no offline/global reset implied.

Limitation: a cooperating client must supply the correct current-chat reference.
Another conversation using the same authenticated client can replay a permitted
reference. Whitelisting is owner consent with caller-supplied correlation, not
attestation or a verified lifecycle. This limitation is explicit in UI, server
instructions, tool descriptions, CLI output and docs. A trusted client adapter
would be needed to guarantee actual conversation isolation.

Evidence: chatConsent security fixtures cover raw MCP dispatch, no-root denial,
private UI, CLI reset, client/workspace isolation, root replacement, expiry,
revocation/cancellation and separate Cron execution; STDIO and packed-package
fixtures exercise the installed commands. See TEST_REPORT for actual commands
and results. No live ChatGPT conversation test is claimed.

### client context policy compatibility amendment

A user supplied a real-world `/c/WEB:UUID` URL rejected by the initial parser.
Accept that explicit namespace (or bare WEB:UUID) across the shared parser.
Preserve the prefix rather than stripping it: the server has no attestation that
a namespaced identifier equals the same bare UUID. Case normalizes within each
format; approval/reset do not cross namespaces. No arbitrary prefix, URL decode,
network request or weaker host/path check is added. Regression cases exercise
CLI, private UI API, MCP, namespace isolation/reset, STDIO and installed tarball.
