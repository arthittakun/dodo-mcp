# DODO MCP 1.4.0

## Non-Blocking Recovery, Git Recovery & Configurable File Access Policy

### 1. Non-blocking Recovery by default
- Recovery no longer blocks file edits (`write_file`, `edit_file`, `move_path`) or command execution (`run_command`) when encountering credential-like template files (such as `env.example` or `scripts/setup-env.sh`), external file changes, or non-critical backup warnings unless `strictEnforcement` is explicitly enabled.
- Added automatic omission of generated directories (`.next`, `.nuxt`, `.svelte-kit`, `.turbo`, `.output`, `.vercel`, `.parcel-cache`, `tmp`, `temp`) during recovery scans.
- Added `skipSecretContentFiles` (enabled by default) so files containing token-like placeholders are skipped during backup with a clear diagnostic path list instead of locking the workspace in `BLOCKED (SECRET_PATH_DENIED)`.
- Added 1-click `recovery.reset` to clear blocked states and rescan immediately from the web UI.

### 2. Native Git Recovery Mode (`auto` | `git` | `snapshot` | `off`)
- Projects with a `.git` repository can now use Git directly for recovery checkpoints (`refs/dodo/checkpoints/gitcp_*`) without touching the user's working `.git/index` or active branch.
- The Recovery UI includes a Git Recovery panel showing current branch, working tree status, DODO Git checkpoints, recent commits, diff preview, and 1-click restore.

### 3. Configurable File Access & Secret Policy (`secretPolicyMode`)
- Added live-configurable file access policy in both Project and Global Settings (`standard`, `off` / Allow All with owner confirmation, and `strict`), along with quick-add chips for `secretAllow` and `secretDeny` that take effect immediately without restarting DODO.
- Added optional `relaxEpochCheck` (accept valid `boot_*` epochs across server restarts) and `relaxExpectedHash` (tolerate `expectedHash` changes in `edit_file` when target snippets still match uniquely).
- Added project sub-tabs and a 1-click unlocker for stuck `recovery_required` changesets.

## Upgrade

```sh
npm install -g dodo-mcp@1.4.0
dodo --version
```
