# ADR-046: Personal add-and-use mode

Status: accepted for the single-owner default.

DODO is commonly run by one owner on one machine. Requiring the same owner to approve an
OAuth client, then repeat client ACL, trust, Agent Profile, source-egress and native-app
consent for every registered path creates ceremony without adding a second trust principal.

Global `accessMode` therefore defaults to `personal`. An owner-approved installation OAuth
grant can use every owner-registered, ready project according to its live grant/token scopes.
Enabled Agent Profiles are available to those projects; selecting a remote profile is owner
consent for its bounded source/context egress. Effective trust is `trusted`. Provider and
profile setup remains explicit because the owner must choose the endpoint, model, credential
storage and scope ceiling.

`managed` remains available from authenticated Local Config. It restores per-project client
ACL, saved trust, profile/client allowlist and source-egress decisions. Switching modes changes
new authorization decisions immediately and never copies managed rows between projects.

Persistent Desktop/Chrome named-app consent is installation-scoped and can be set once from
any directory. Temporary consent stays workspace/epoch-bound. OS Screen Recording,
Accessibility or platform prompts still require the real user, and every operation still
checks `dodo:exec`, target context, exact app allowlist, fresh principal-bound snapshot,
idempotency and action policy.

Neither mode disables OAuth, registered-target readiness, live revocation, workspace ID/epoch,
path/secret/symlink/hardlink guards, expected hashes, journals, idempotency or the configured
command sandbox. Repository configuration, model output, workflows and memory cannot change
the mode or grant authority.

Evidence: `tests/security/personalMode.test.ts`, `tests/unit/desktop.test.ts`,
`tests/security/desktop.test.ts`, managed-mode security suites and packaging smoke.
