# ADR-045: Explicit project runtimes and provider-backed sub-agents

Status: Implemented in source; live-provider/platform acceptance is tracked separately.

DODO needs simultaneous projects and bounded model execution while preserving the
existing MCP authority pipeline. Default workspace switching alone serializes unrelated
projects; a generic model executor with direct handler access would bypass policy.

We introduce an installation runtime manager backed by the existing project registry.
Only the owner adds roots. Optional top-level targetProjectId selects a leased, ready
runtime before principal/target-authority/context validation. Default selection and read-only
projectId/projectIds federation retain distinct contracts. Nested routing overrides and
ambiguous combinations fail closed. Each runtime retains its own epoch/services/jobs;
close refuses active users. Root recovery occurs once under the project lease.

A reentrant FIFO mutation queue is shared by direct MCP, agents and schedules. Jobs retain
queue ownership until actual process exit. Reads remain concurrent. Hashes are validated
when work reaches the queue; external programs are outside this synchronization boundary.

Five adapters implement seven provider presets plus custom connections. Protocol-native
continuation is private, including signatures and encrypted reasoning. Streaming parsing
is bounded and handles split frames/JSON. No provider fallback or uncertain automatic retry.
Credentials are session-only or macOS Keychain; metadata contains references, never keys.
Requests validate DNS addresses and pin sockets, reject redirects and metadata/admin
endpoints, and re-check delegation before sending. Local Ollama model metadata, not URL
alone, is required for projects that forbid egress; this is not an OS sandbox guarantee.

Sub-agents reuse invokeToolDefinition and a limited coding/context/reviewed-skill catalog.
Profile scopes intersect the original caller; a project restriction prevents child reads
in other projects. Every turn/action revalidates live authority and immutable profile digest.
No recursive spawn, owner tool, blanket approval, or implicit permission activation.
Four public operations use existing assist gateways, preserving Compact 19 / Hybrid 49;
Full becomes 125. Same spawn idempotency key returns the same owned run.

Private SQLite stores bounded run continuation, events, delegation references and usage.
No raw OAuth tokens are retained. Restart marks interrupted runs; explicit Resume binds
fresh epoch/authentication to the original caller. Uncertain inference/actions require
review instead of replay. Pending jobs are observed and their real results feed the model.

The web uses existing loopback owner auth/CSP and authenticated fetch event cursors.
Project screen selection is independent from default switching. Advanced owner forms reuse
IPC/config/setup validation. Provider tests with synthetic prompts are explicit paid actions.

Consequences: profiles/models need owner configuration; 16 secondary runtimes have a
bounded resource ceiling. Budgets use conservative UTF-8 input accounting, not exact
provider tokenization. Queue and project isolation are not filesystem/OS sandboxes.
Live provider calls, OS permission dialogs and Linux Docker are separate acceptance gates;
protocol fixture success is not a claim that every hosted model was exercised.

Personal mode is the single-owner default. Registering a project and selecting an enabled
profile is explicit owner consent to use that profile there, including bounded remote source
egress. The approved OAuth grant and profile scopes remain ceilings. Managed mode retains
per-project client/profile/egress allowlists. Both modes re-check live grants, epochs,
filesystem guards, hashes, idempotency and sandbox policy before each model action.

See [AI guide](../AI_PROVIDERS.md), [security](../SECURITY.md), and [test report](../TEST_REPORT.md).
