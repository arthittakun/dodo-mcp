# 017 — Installation identity, workspace ACL and private config (baseline)

Owner-requested change supersedes the original per-workspace OAuth grant-only
contract. One running process still serves one canonical CWD/root and epoch.

New consent records are marked `identity-grant:<id> = 2` in durable metadata.
Tokens carry `dodo_auth: 2`. Verification requires both markers, issuer,
audience, expiry, live grant and matching client. Resource scopes never exceed
the token/grant intersection. Personal mode applies that ceiling to registered
projects; managed mode also intersects the current workspace/client ACL.
No remote tool can register a path or grant itself access. Refresh preserves
grant version.

OAuth consent is installation-scoped and does not follow the active workspace
or the CLI process CWD. Completing login never creates a workspace ACL. An
authenticated client may scan the bounded tool catalog before a project is
selected. Operations require a real owner-registered project; only managed
mode requires an additional explicit client ACL there. Pending/approve/deny and
grant revocation locate the authenticated live HTTP installation process from
private per-instance IPC metadata, so owner commands work from any directory.

Migration 3 creates workspace_clients and copies active legacy grant scopes to
their original paths only. Legacy tokens remain bound to their original root.
Users log in once to receive the new identity grant. Revocation still checks
the live grant on every request. Root inode/device replacement resets saved
trust and client ACLs. Changing mode does not cancel already launched jobs.

Bare dodo now starts HTTP regardless of stdin. MCP subprocess clients must
explicitly use stdio. CLI HTTP starts local config at 127.0.0.1:21731, separate
from MCP 21730. Library callers opt in with configPort (0 supported for tests).
Admin API requires an 8-hour, random 256-bit per-process bearer capability,
passed in the terminal URL fragment, never query strings. The page moves it to
sessionStorage and strips the fragment. It rejects nonlocal hosts, foreign
origins, cross-site fetches and proxy/Cloudflare headers. No CORS or public
admin route. Same-UID adversaries and intentionally rewritten owner proxies
are not an isolation boundary. No remote config opt-in in this release.

--allow --all: run-only trusted actions and fetch_url; configured job sandbox.
--bypass: same plus default commandSandbox off. Neither changes durable trust,
OAuth, target authority, file guard, hashes or epoch checks. Flags do not alter
client application's own confirmations. They are local owner capabilities.

Recovery journal reconciliation, recovery status and interrupted-job updates
are scoped to the selected workspace, to avoid modifying another root's state.
