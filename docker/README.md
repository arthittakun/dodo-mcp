# Linux release-gate container

`linux-test.Dockerfile` runs the supported Linux gate as the unprivileged
`node` user. `chromium-seccomp.json` is Playwright's Docker seccomp profile
for sandboxed Chromium. It is vendored from the matching Playwright v1.63.0
release and keeps Docker's default syscall policy while allowing the user
namespace operations Chromium's sandbox needs.

Run from the repository root:

```bash
npm run test:linux:docker
```

The container receives only a writeable evidence directory. Source is copied
into the image, not mounted from the host. GitHub Actions is not part of this
gate.

Source: https://github.com/microsoft/playwright/blob/v1.63.0/utils/docker/seccomp_profile.json
