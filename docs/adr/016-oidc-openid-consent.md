# 016 — Preserve requested OpenID consent

The ChatGPT authorization request observed on 2026-09-09 includes `openid`
alongside DODO resource scopes. The interaction adapter filtered this out of
its grant, so oidc-provider 9.12.2 resumed into another consent interaction
instead of returning an authorization code.

Grant `openid` at the OIDC level only when the authorization request includes
it. Keep resource scopes and workspace grants restricted to DODO permissions.
Local approval, PKCE, session binding and static registration remain required.

Evidence: AUTH-22 reproduced the redirect to a second interaction before the
fix; after the fix, one approval reaches the callback, exchanges the code and
successfully calls authenticated MCP tools/list. All 20 auth tests passed.
Live ChatGPT/tunnel reconnection remains a manual verification.
