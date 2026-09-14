# Linux release-gate container

`linux-test.Dockerfile` runs the supported Linux gate as the unprivileged
`node` user. The image includes ffmpeg/ffprobe and espeak-ng, and sets
`DODO_TEST_REQUIRE_LINUX_MEDIA=1`: missing media prerequisites fail the Linux
speech suite instead of silently skipping it. Full and Compact HTTP/OAuth
speech tests verify real WAVE audio, idempotency and read-only denial. Existing
media tests cover decoding failures, frame/audio extraction and stale handles.
Whisper/model and interactive X11 remain separate optional acceptance gates.

`chromium-seccomp.json` is Playwright's Docker seccomp profile
for sandboxed Chromium, with `openat2` enabled so current runc releases can
safely reopen `/proc` after applying the container seccomp policy and
`clone3` enabled for current glibc/Node worker threads. It is
vendored from the matching Playwright v1.63.0
release and keeps Docker's default syscall policy while allowing the user
namespace operations Chromium's sandbox needs.

Run from the repository root:

```bash
npm run test:linux:docker
```

Source is copied into the image, not mounted from the host. Evidence is written
inside the container and retrieved with `docker cp` after the gate exits. This
avoids host/container UID and SELinux bind-mount mismatches without making the
evidence directory world-writable. The same command runs locally and on the
dedicated `linux-ci` self-hosted GitHub Actions runner; reports record the
runner origin explicitly. That runner uses Docker host networking because its
bridge resolver cannot reach public package registries; filesystem and process
isolation remain containerized, and the workflow accepts trusted `main` pushes
and manual owner dispatches only. Pushes and default manual dispatches run only
Windows; select `platform=linux` or `all` for an explicit remote Linux run.
Locally verified Linux Docker evidence does not require a duplicate X64 CI run.

Host networking and `--ipc=host` do not isolate the host network/IPC namespaces.
They are not evidence of command-sandbox confinement. The absent-bubblewrap
test selects a real empty trusted PATH without changing the host installation;
positive bubblewrap confinement needs a separate environment and evidence.

Build/run diagnostics are captured in private `linux-driver.log` and `gate.log`.
The workflow uploads only `public-summary.json` (seven-day retention), containing
validated revision/lock/code fingerprint, OS/architecture/Node, exit codes, test
counts/skips, audit counts and artifact hashes. Raw logs/state are not uploaded.
Use a fresh output directory for each run; existing reports are not overwritten.

Source: https://github.com/microsoft/playwright/blob/v1.63.0/utils/docker/seccomp_profile.json
