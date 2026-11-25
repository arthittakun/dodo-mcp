# DODO MCP 1.11.2 — Windows startup during state upgrades

DODO 1.11.1 could stop at startup with `cannot establish whether an installation
runtime is still using state`. The startup order created the new workspace lease
before opening the database. If that lease could not be read, an upgrade could
fail before DODO reached the check for its own PID.

DODO now opens the database and takes any required checkpoint before creating the
lease. These steps run under the same installation lock, so an offline restore
cannot start between them. A verified live lease from another process still
blocks an upgrade. Lease errors identify the affected file and a safe code, such
as `EACCES`, `FILE_CHANGED`, or `INVALID_JSON`. If a listed lease vanishes during
shutdown, the scan checks that the path is absent before continuing.

The local Windows reproduction required simulating an unreadable lease. Normal
file identity checks succeeded on the test machine, so the underlying filesystem
error on the reported machine is still unconfirmed. See the [test report](TEST_REPORT.md).

Use the same OS account and configuration directory. Stop DODO, install the
patch, then start the updated executable.

```powershell
dodo kill
npm install -g dodo-mcp@1.11.2
dodo --version
dodo
```
