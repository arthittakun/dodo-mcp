# Linux release-gate container

`linux-test.Dockerfile` runs the supported Linux gate as the unprivileged
`node` user. `chromium-seccomp.json` is Playwright's Docker seccomp profile
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
and manual owner dispatches only.

Source: https://github.com/microsoft/playwright/blob/v1.63.0/utils/docker/seccomp_profile.json
