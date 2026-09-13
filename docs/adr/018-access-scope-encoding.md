# 018 — Repair legacy ACL scope encoding

baseline migration 3 copied grants.scopes verbatim. Grants store a space-separated
OAuth scope list; workspace_clients stores JSON arrays. Fresh-store tests did
not cover upgrade data and missed this mismatch. The owner's config page
subsequently threw while reading migrated scopes.

baseline migration adds a transactional migration 4 that normalizes recognized legacy scope
lists and existing JSON ACLs. Invalid/unknown entries become empty ACLs, never
new permissions. Empty ACLs remain empty, existing grants are not recopied on
reopen, and runtime JSON decoding fails closed. Tests cover direct legacy
upgrades (schema 2) and already-migrated baseline state (schema 3).
