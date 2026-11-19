# DODO MCP 1.7.0 — Persistent local Env API keys

Provider API keys can now survive DODO restarts on Windows, Linux and macOS using
**Env ถาวรในเครื่องที่รัน DODO**. This storage option is available in both the
general AI Providers form and the Creative Media provider form, and the same
credential service supplies model listing, inference/probes, agents, images and
compatible video requests.

## Upgrade and save a permanent key

```bash
npm install -g dodo-mcp@1.7.0
```

Restart DODO, then open **Providers & Profiles**. Create a connection or edit an
existing one, choose Env storage, enter its API key and save. The variable name is
optional when saving a key: DODO creates a connection-specific name when blank.
Changing an existing connection from Session/Keychain to Env requires entering
the key again. The browser never receives the old key to refill the field.

The new form defaults to Env when the running server supports it. Existing
connections retain their selected storage, and the Provider API continues to
default to Session when `credentialStorage` is omitted. A keyless Ollama preset
uses Session. Keychain availability follows the **server's** platform, even when
the browser is running on another operating system.

## What Env means

| Storage | Persistence | Location |
|---|---|---|
| Env | Survives restart when DODO owns the file, or when an external variable is provisioned for every launch | A private file beneath `DODO_CONFIG_DIR/credentials/ai`, or an explicit inherited server variable |
| Session | Until the DODO process closes | Process memory |
| macOS Keychain | Survives restart | The server Mac's OS credential store |

DODO-managed Env files contain plaintext credential values with private file
permissions: 0700/0600 on POSIX and private ACLs on Windows. This is local Env
storage rather than an encrypted OS vault. Files are separate per connection and
outside project source. Saving a key does not change Windows registry settings,
shell profiles, or the system-wide environment; it does not copy the key into
browser storage or export it to child jobs.

For Docker, mount `DODO_CONFIG_DIR` on a persistent volume. Keeping the same
configuration directory preserves both connection metadata and Env files when a
container is recreated; an ephemeral container filesystem is not permanent host
storage.

Writes use a private staged file, atomic replacement and read-back validation.
Reads reject invalid formats, unexpected bindings, unsafe paths and unsuitable
permissions. A damaged owned file stops credential use rather than silently
falling back to another source. State reports credential presence without
returning its value.

## Use an existing server variable

For a **new** Env connection, specify a variable name such as
`DODO_IMAGE_API_KEY` and leave the API key field blank. The variable must already
exist in the inherited environment of the process that runs DODO. A variable set
only on the browser's machine does not configure a remote server. Names use
uppercase letters, numbers and underscores, start with a letter, and contain
3–128 characters; OS/loader names such as `PATH` and `NODE_OPTIONS` are refused.

DODO reads inherited variables only when no owned file exists for the connection.
An owned file always takes precedence. Entering a new key in the UI creates or
updates that owned file; it does not modify the external variable. Removing a
connection deletes only DODO's owned file and leaves external variables intact.

The confirmed key is bound to its connection configuration. If an operator
rotates an inherited variable, reopen the connection, confirm its settings and
save before making another provider request. Endpoint, protocol, storage and
variable-name changes require fresh key entry. An interrupted credential update
remains quarantined across restart until explicitly repaired.

## Existing features and validation

Image model discovery/Auto, local crops, background edits, video compatibility,
immutable resources and temporary token downloads retain their existing scope
and permission guards. This release adds no MCP operation: Full remains 173
capabilities (169 with sub-agent operations hidden), Compact 20 and Hybrid 49.
Private test providers, endpoints and credentials are not included as defaults,
examples or shipped source.

See [AI Providers](AI_PROVIDERS.md#credential-และ-endpoint),
[Creative Media](CREATIVE_MEDIA.md), [Multimodal](MULTIMODAL.md), and the measured
[Test report](TEST_REPORT.md) for setup, storage behavior and validation limits.
