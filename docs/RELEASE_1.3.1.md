# DODO MCP 1.3.1

## Remote Config opens independently of the local link

Previously, a DODO process running for over eight hours could accept a new
`dodo --web` pairing but return the Local Config expiry error when loading data.
The domain dashboard now uses its own revocable owner session, valid for one hour
from the CLI opening. Reopen it at any process age without restarting MCP.

- Local Config's eight-hour link stays separate and is not renewed by remote use.
- New pairing revokes the previous remote session. Close/expiry also revokes its
  internal loopback capability, including owner requests still waiting for execution.
- AI/Projects owner principals and event streams use the request's actual session.
- One-time pairing, Secure/HttpOnly/SameSite cookies, Host/Origin checks, rate limits,
  workspace/epoch validation, MCP OAuth and all tool permissions remain enforced.
- The CLI and pairing page explain how to reopen without a server restart.

## Connection guides

[MCP connections](MCP_CONNECTIONS.md) covers ChatGPT, Claude Custom Connectors,
Claude Code, Codex CLI, Gemini CLI, Cursor and VS Code. It distinguishes `/mcp`,
`/config`, OAuth callbacks, static credentials, local STDIO and AI provider keys.
Claude's form has explicit Sign in now / Use your own OAuth client instructions.
The guide ships in the npm package and is linked near the top of the README.

## Upgrade

```text
npm install -g dodo-mcp@1.3.1
dodo --version
```

Stop/start the existing foreground DODO process once to load the updated code.
After that, opening Remote Config needs only `dodo --web`, even after eight hours.
Enter the new terminal pairing code at the printed domain `/config` URL.
This patch does not require deleting OAuth clients or copying private state.

## Verification scope

Regression tests cover a nine-hour-old process, local expiry, remote renewal,
settings writes, AI project access, cookie/code replay rejection, in-flight owner
revocation and real Chromium desktop/mobile dashboards. Full automated gates and
fresh-package results are recorded in the release evidence; native platforms must
pass on this source revision before publication.

External AI account logins, real Cloudflare routes and a physical eight-hour wait
are `MANUAL_NOT_RUN` for this patch. The automated clock/HTTP/browser fixtures do
not claim to prove those live integrations. This patch does not change Windows
dependency installers or repair private state created by another OS account.
