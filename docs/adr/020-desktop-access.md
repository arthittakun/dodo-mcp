# ADR-020 — Local, app-scoped macOS desktop access

Date: 2026-09-09. Status: accepted for desktop integration. The owner's explicit desktop
feature request supersedes v1's prohibition on desktop automation; it does not
remove OAuth, workspace identity, local authorization or the file guards.

The owner later requested one-time saved desktop configuration. The optional
persistent-grant behavior in [ADR-021](021-persistent-desktop-consent.md)
supersedes only the mandatory expiration/boot reset described below for
explicitly remembered grants; temporary grants retain this original behavior.

Use a bundled Swift helper, explicitly compiled by `dodo desktop setup` with
Apple Command Line Tools. No install lifecycle hooks, external relay, downloaded
executables, arbitrary AppleScript, clipboard or autonomous LLM loop. This
keeps one npm package and uses Apple's native permission checks:

- [ScreenCaptureKit / SCScreenshotManager](https://developer.apple.com/documentation/screencapturekit/scscreenshotmanager): bounded single-window capture on macOS 14+.
- [CGEvent](https://developer.apple.com/documentation/coregraphics/cgevent): explicit mouse/keyboard input; CGPreflightScreenCaptureAccess and AXIsProcessTrusted gate native operations.
- [Vision text recognition](https://developer.apple.com/documentation/vision/vnrecognizetextrequest): optional local OCR. UI text is data, never authorization.

APIs were verified by compiling against the installed Apple SDK and testing a
native fixture on macOS 26.3.1 arm64. The SDK's CGEvent.h notes that application
frameworks may ignore an event's Unicode string; callers must verify the result.
The [Desktop Commander project](https://github.com/wonderwhy-er/DesktopCommanderMCP)
and available connector catalog informed the comparison only; no assertion
about its hosted internals or complete parity is made.

Desktop authorization is off by default and a separate, expiring, exact-app
allowlist stored per workspace/boot epoch. Only private owner IPC enables it;
private Local Config can revoke. All image/UI tools beyond non-content status
require dodo:exec and the current client/path ACL, including over OAuth. View
permission enables reading; control additionally uses the existing exec trust
and exact local action approval gate. Run overrides do not enable desktop.

Snapshot IDs bind principal, workspace service/epoch, grant, window PID/id/app,
geometry and image-coordinate mapping for at most 30 seconds. Actions use a
single service mutex; all snapshots are invalidated before dispatch. A durable
started receipt precedes input, and uncertain outcomes are never automatically
repeated. Native checks require a frontmost matching window for input and check
point occlusion; they do not freeze the UI or form a same-UID security boundary.

Image bytes and typed text are not persisted in the state/audit; file-image
reads still use WorkspaceFS. Native helper input/output, OCR, AX traversal,
action size, process time and receipt count are bounded. Stop prevents future
dispatch, not rollback of OS events already posted.

Native compile/capture/OCR and refusal without Accessibility passed. Positive
Accessibility/input acceptance remains MANUAL_NOT_RUN because the machine did
not grant that OS permission. Default tests use a fake OS adapter so they never
click a user's screen; HTTP/OAuth/IPC/SQLite policy tests remain real.
