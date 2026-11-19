# DODO MCP 1.8.0 — Global image and video tools

Create images directly from a connected chat without creating, registering or
selecting a project. Configure an image provider URL and API key once in Local
Config; the existing creative, resource and download-link tools can then run in
an installation scope that is independent of the selected default project.

## Upgrade and configure

```bash
npm install -g dodo-mcp@1.8.0
```

Restart DODO, then reconnect or rescan DODO in the MCP client so it receives the
updated tool schemas and instructions. DODO can start with no registered project.
In **Local Config → Providers & Profiles → Creative Media → เพิ่ม / แก้ไข Provider
สำหรับสร้างภาพ**, select OpenAI, Google Gemini or Custom and enter the API base
URL, supported protocol and key. Choose permanent Env storage if the key should
survive restart. Leave the image model on **Auto** or select a supported image
model, then save the enabled provider. Saving selects that connection for media
and makes it ready for chat tools immediately. A disabled provider can be saved
as a draft without changing the existing media selection.

No Agent Profile, project allowlist, media-enable switch or image-upload switch
is required. If an existing connection is already selected, its configured key
and model continue to be used. Model listing and Auto retain their existing
behavior; provider/model capabilities and account access still determine which
requests succeed. Video continues to require an explicitly configured compatible
connection and video model.

## Call directly from chat

Ask the AI, for example, “สร้างภาพแมวใส่ชุดนักบินอวกาศ อัตราส่วน 1:1”. The AI can
submit the tool immediately without first calling `project_overview` or obtaining
workspace context.

Full surface:

```text
image_generate(
  prompt="A cat astronaut, illustration",
  size="1024x1024",
  idempotencyKey="chat-image-0001"
)
  → jobId

creative_job(jobId="creative_…")
  → status, resource
```

Compact and Hybrid surfaces use the same operations through `dodo_media`:

```text
dodo_media(
  operation="image_generate",
  args={
    prompt:"A cat astronaut, illustration",
    size:"1024x1024",
    idempotencyKey:"chat-image-0001"
  }
)
dodo_media(operation="creative_job",args={jobId:"creative_…"})
dodo_media(operation="resource_preview",args={resourceId:"res_…"})
```

Use the actual job/resource IDs returned by the preceding calls. Global image
generation, crop, background removal, compatible video operations, job collection,
resource operations, temporary download links, `multimodal_status` and
`dodo_discover` accept calls without `workspaceId`, `workspaceEpoch` or a project
target. Results remain private to the authenticated caller until a download link
is explicitly created. A link can last 1, 2, 7, 14 or 30 days and still requires a
running HTTP server with a usable origin.

## Existing project calls

Supplying workspace context or a project target explicitly routes the call to
that project and keeps its access and trust policy. Use project context when
reading a project file path. Existing clients that send context continue to use
their project-scoped jobs and resources; omit context for new global work.

`media_save` writes to a project and still requires its destination context. It
can copy the caller's own globally generated PNG/MP4 into that project using the
resource's exact `expectedSha256` and the usual file/hash checks. Project file
and command tools continue to require a selected project context.

## Configuration and access changes

Legacy Creative Media fields `enabled`, `allowImageUpload` and `projectIds` remain
accepted for compatibility, but no longer limit creative calls. Read/save results
normalize `enabled` to whether a connection is selected, `allowImageUpload` to
`true`, and `projectIds` to `[]`. Select an enabled image connection and configure
its credentials to use cloud image tools.

Global media is available to authenticated installation clients with the
operation's required OAuth scopes, including in managed mode. Legacy root-bound
logins must reconnect; delegated agents restricted to a project cannot use global
tools. Global media does not check
per-project AI client allowlists or request project trust approval. This applies
to existing selected provider settings after upgrade. Token/grant validation,
scope checks, credential binding, endpoint checks and caller isolation remain in
place; an AI caller cannot retrieve another caller's private jobs/resources.

## Jobs, restart and tool counts

A creative submission returns a job ID. Collect that same job with `creative_job`;
polling does not submit another paid render. If a pending global image job was
submitted by another server instance, its status reports `uncertain` with
`SERVER_INSTANCE_CHANGED` rather than resubmitting or rewriting that instance's
receipt. Completed jobs remain readable by their owner, and stored remote video
handles can be checked when the connection and authorization are still valid.
Uncertain work may already have consumed provider credits. Inspect the existing
job before deciding whether to create a new one.

This release adds no MCP operation. Counts remain Full **173** capabilities
(default **169** when sub-agent tools are hidden), Compact **20** and Hybrid **49**.
See [Creative Media](CREATIVE_MEDIA.md), [Resources and downloads](RESOURCES.md)
and the measured [Test report](TEST_REPORT.md).
