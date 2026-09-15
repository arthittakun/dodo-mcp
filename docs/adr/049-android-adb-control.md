# ADR-049 — Owner-approved Android control through ADB

## Decision

DODO exposes a bounded Android capability family through an `AndroidService`. The
native backend invokes a reviewed `adb` executable with `shell:false` and an exact
owner-approved device serial. Full surface has individual `android_*` operations;
Compact uses one `dodo_mobile` gateway so the Compact catalog remains at 20 tools.

The local owner chooses `off`, `view`, or `control` and an exact serial allowlist.
A temporary grant is bound to one workspace identity and epoch. A persistent grant
belongs to the installation and survives project switches until the owner disables it.
Neither kind grants OAuth scopes, project access, trust, an action approval, or a
sandbox exception.

Pairing, connecting, root mode, ADB server management and port forwarding remain
owner actions outside the MCP catalog. The advanced operation accepts only
device-side shell/exec-out/logcat/state/features command families. Dedicated install
and push operations require a workspace source, shared path/secret/link checks and an
expected SHA-256. They pass an immutable private staging copy to ADB and remove it
after the command.

Every effectful operation uses the shared invocation and idempotency pipeline. Screen
input consumes a fresh principal-bound snapshot. Output, time and concurrency are
bounded; one serial is process-wide serialized across project runtimes so concurrent
agents cannot interleave device commands. Device output is untrusted content. Audit stores operation metadata and
digests, never screenshots, UI text, logs or file bytes.

## Why

ADB offers one portable control plane for physical devices and emulators on macOS,
Linux, Windows and Termux. Exact device consent prevents a connected phone from
becoming available merely because the executable exists. Reusing the normal DODO
scope, workspace and approval checks keeps mobile automation from becoming a second
authorization system.

## Consequences

- `dodo:exec` is required even for device observation because connected-device state
  is private host information.
- ADB runs with the Android shell user's effective permissions and is not a device
  sandbox. Owners must review `control` grants accordingly.
- Operations whose outcome becomes uncertain are not silently retried.
- Android/Termux as the DODO host remains experimental independently of the ADB tool
  family.

## Evidence

- `tests/unit/androidAdb.test.ts`
- `tests/security/androidAdb.test.ts`
- `tests/integration/androidAdb.test.ts`
- generated Full/Compact/Hybrid schema consistency and packaging gates
