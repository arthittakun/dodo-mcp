# ADR-022 — CWD-independent owner shutdown preserves OAuth identity

Date: 2026-09-09. Status: accepted for owner shutdown, requested by the owner.

Implement `dodo kill` as a lifecycle command over private IPC, not process-name
matching or a signal to whatever owns 21730. Resolve the owner's installation
config independently of CWD and read the SQLite workspace registry without
writing/migrating auth data. Old versions are discoverable through their root
sockets. New versions also maintain a unique per-instance control socket and
ephemeral metadata so multiple stdio clients of the same root stay discoverable.

Validate private same-user sockets, live status/root/workspace and endpoint
identity. Stop requests include expected PID/epoch; new servers reject stale
values. Probe first and deduplicate processes before dispatching stops. Bound
concurrency to eight, response bytes and wait durations. Report failures rather
than silently force-killing a hung or unregistered process. Another
DODO_CONFIG_DIR is a separate installation; never scan other users/configs.

Cancel owned jobs before draining handlers that may wait for their completion.
Prevent new jobs once shutdown starts and share the close promise with repeated
callers. Library shutdown closes resources; the CLI exits after completion.
Keep OAuth keys, clients, tokens, grants, config and ACLs. Restore neither
expired/revoked credentials nor missing client access to another root.

Tests cover real child HTTP/stdio processes, duplicate stdio roots, unrelated
process/config preservation, owned job cancellation, and real OAuth access plus
refresh credentials after restart. Negative cases cover spoofed status,
symlink/non-private sockets, stale stop identity, oversized IPC and timeout.
Actual ChatGPT automatic reconnect is a manual gate; local token continuity
does not prove client retry behavior. See TEST_REPORT for commands/outcomes.
