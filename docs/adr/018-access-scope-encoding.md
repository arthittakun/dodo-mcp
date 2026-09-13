# 018 — ACL scope encoding contract

OAuth grants store a space-separated scope list while `workspace_clients`
stores JSON arrays. Schema migration must normalize the two representations
without widening permissions.

A transactional schema step normalizes recognized space-delimited scope lists
and existing JSON ACLs. Invalid or unknown entries become empty ACLs, never new
permissions. Empty ACLs remain empty, existing grants are not recopied on
reopen, and runtime JSON decoding fails closed. Tests cover each supported
schema transition and already-normalized state.
