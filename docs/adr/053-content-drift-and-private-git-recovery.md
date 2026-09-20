# ADR 053: content drift and independent Git recovery copies

Status: implemented in the unreleased Recovery candidate (R03); platform evidence is recorded separately.

The expected source state is a durable, per-workspace manifest plus committed journal updates. It is **not** the most recently captured checkpoint. Restart, owner checkpoint creation, periodic observations and emergency snapshots never silently adopt external bytes. Only a successfully verified journal transaction or an authenticated owner acknowledgement advances this state. Baseline snapshots remain retention-protected.

Mutation targets are checked by content/type/mode/identity, irrespective of mtime or a freshly supplied expectedHash. Non-target changes do not block an unrelated simple edit. Before commands, Git commit hooks and verification recipes, a source scan blocks significant drift. Default significance is at least 20 changed source files **and more than 20%** of baseline file count, or at least 10 deleted source files. These are owner policy thresholds, not a malware classifier. Existing ACL, trust, approvals, sandbox and secret/path restrictions remain authoritative.

A 60-second timer skips busy workspaces. Scans have a 15-second default wall budget (owner range 100–60000 ms), entry/file budgets, guarded reads and two content inventories. Watchers are not an authority or prerequisite. Missed events and equal size/mtime edits remain detectable; edits changed back between scans cannot be proven. Interrupted or over-budget scans never acknowledge the state. Jobs retain the project mutation ticket through their bounded post-exit observation. Shell results are attributed as **unknown**, because external programs may write concurrently.

Emergency observations preserve the newly observed bytes separately from the original baseline. They are not known-good or verification results, and cannot recover pre-overwrite bytes that were never captured. Ordinary ignored files become tracked after a named journaled mutation; generated/data/secret exclusions still apply. Reviewed R02 restore plans have a private exemption from the drift-baseline comparison only; immutable plan/hash, caller, epoch, source scope, new before-image capture, expected hashes and journal verification still apply. This lets an owner restore externally changed files without first accepting them as normal work.

## Git storage decision

Git checkpoint refs live in **independent private bare repositories**, not in the working repository. Each source checkpoint at activation/session boundary, before exec, explicit owner checkpoint and successful fresh verification creates a parentless commit and create-only `refs/dodo/snapshots/<snapshot-id>`. Target-only file edits and emergency observations do not run Git. Verification-triggered copies are deduplicated by the owned verification receipt and must still match the verifier at publication; this is not a deployment approval or known-good promotion.

The builder uses captured, hash-verified CAS bytes, an empty private index and plumbing commands. It never copies the working object database/history, user index, remotes, alternates, hooks, filters or configuration. Sanitized HEAD/branch/index fingerprint is evidence only. No checkout, reset, add, remote operation or credential helper runs. Missing Git/non-Git projects retain mandatory content backup; optional Git reports its limitation. Git-required projects fail closed when a required full copy cannot be created.

Unborn and detached HEAD, parent repositories and worktree gitfiles use source-root scope. Submodule files already materialized in that scope are ordinary captured source; submodule Git history is not copied. LFS pointer bytes remain pointers; no LFS network fetch occurs. Git alone preserves executable bits, not all POSIX modes or empty directories; the separately stored source manifest remains the complete recovery contract.

An owner can choose an existing, canonical, private, dedicated empty directory outside registered projects, DODO state and recognized credential namespaces. Subsequent contents must be registered recovery copies. Its filesystem identity is pinned. Missing/replaced volumes fail closed with **no fallback**, even if optional Git was otherwise selected. This is a bare storage backend, not a mirror of all repository history. Default copies use private installation recovery storage.

Copy reservations and physical bytes count against the existing project/installation quotas. Contents/refs are checked before READY, then files and directories are synced; source-retention pruning also removes matching owned Git copies. Crash-interrupted copies remain non-READY and counted until safe retention cleanup. They are never automatically executed or treated as valid.

## Owner review and limits

Web/CLI scan results are bounded and paginated. Acknowledgement requires the exact observation digest, workspace/epoch, confirmation and live owner authority; it rechecks the content again under the mutation queue. MCP can inspect via `restore_status(scan:true)` but cannot acknowledge/configure. Full/Compact/Hybrid tool counts do not increase in R03.

Deleting source files and `.git` inside the original registered root does not remove independent copies. The source restore restores approved files only and does not recreate Git metadata. Replacing/deleting the root directory itself still fails the root-identity contract: recover to a new directory manually from the independent copy, review it, then register that directory. Storage on the same device/account is not protection from device failure or a compromised owner account. Database/volume/destructive command side effects remain outside source recovery.
