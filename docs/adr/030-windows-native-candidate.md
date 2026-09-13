# ADR-030: Windows native candidate and authenticated owner IPC

Date: 2026-09-10
Status: Implemented candidate; native Windows validation and support claim pending
Target source version: Windows native work

## Context

The Windows proposal identifies independent blockers in Unix-only IPC, POSIX
shell/execute-bit assumptions, process-group cancellation, executable search,
NTFS aliases and private-state permissions. Extending platform support must
not turn a missing sandbox, private ACL or trusted executable into an implicit
permission grant. Existing dirty working-tree changes must be preserved.

## Decision

Introduce shared platform helpers under `src/platform` and route jobs, git,
search, LSP and media execution through the relevant helpers. Resolve implicit
executables using absolute canonical paths outside the workspace; sanitize
Windows PATH/PATHEXT and environment keys. Prefer Git for Windows Bash, with
an explicit cmd.exe fallback and restricted batch arguments. Use bounded
UTF-16 argv and cmd-line budgets. Windows cancellation targets live owned
children through the absolute system taskkill executable, with hard-kill-only
semantics; it is not Job Object containment.

Use an owner-private per-listener credential on every OS. Windows transport
uses a fresh named pipe; POSIX retains Unix sockets. Both peers authenticate
using fresh nonce challenges and domain-separated HMAC over exact payloads.
Credentials never travel on the IPC connection, and privileged requests are
not sent until server authentication succeeds. Invalid/replayed proofs fail
before owner command dispatch. Socket/descriptor cleanup is generation-bound.

Windows state uses LOCALAPPDATA/dodo and checked DACLs; POSIX retains owner/mode
checks. The Windows ACL code permits the current SID, SYSTEM and Administrators.
Same-user processes and administrators remain inside the trust boundary.
ACL failure is fatal rather than silently substituting ineffective chmod.

Reject ambiguous NTFS lexical paths and recheck canonical components against
containment and secret/protected guards. Do not claim elimination of same-user
check/use races. Retry transient Windows sharing locks only within a bounded
budget, never deleting a destination or clearing read-only attributes to force
a write. Preserve BOM and CRLF bytes in source edits.

OAuth, workspace/client ACLs, trust modes, per-action approvals, journals and
compact/hybrid/full exposure retain their existing authority. Windows has no
DODO command sandbox; requested sandboxing fails closed. Schedules require an
explicit unsandboxed specification and separate local owner approval. Desktop
and macOS speech remain unsupported on Windows; no silent privilege downgrade.

## Compatibility and rollout

The project keeps its current baseline while the Windows support status remains
EXPERIMENTAL until the proposal's native gates pass. Add an allow-failure
Windows Node 22/24 CI evidence job first; do not skip entire legacy suites to
produce green results. Only after native tests and Windows 11 manual acceptance
may that job become required and documentation say supported.

The IPC protocol intentionally has no unauthenticated fallback. Owners
must stop running servers from the existing installation or terminal before
replacing the installation. OAuth/state is not cleared. Building a checkout
never replaces a running server or a global installation by itself.

## Evidence and outstanding gates

Portable contracts exercise actual filesystem, processes and IPC on the local
host. Windows-only tests remain skipped on POSIX and are not native evidence.
Actual 8.3 aliases, DACL isolation from a second OS user, Defender/OneDrive,
Windows full-suite portability and a real external Windows MCP client remain
native/manual gates. See `docs/WINDOWS.md`, `docs/TEST_REPORT.md` and
`release-evidence/Windows native work/verification.json`. No npm publication, git tag or
production deployment is implied by this ADR.
