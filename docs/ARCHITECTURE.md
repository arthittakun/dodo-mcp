# DODO MCP — Architecture

## Platform evidence

`release-gate.mjs` collects separate core/packaging JSON reports from `test:all`,
validates their assertion counts, and binds the run to HEAD, dependency lock and
a fingerprint of code/tests/gate inputs (including untracked candidate files).
The fingerprint excludes generated dist/schemas and documentation; it is checked
again at completion. Docker also checks the actual copied inputs against the host
fingerprint. A dirty candidate remains ineligible for a clean release claim.

Private command capture is shared by the release gate and Linux Docker driver.
`gate-summary.mjs` writes a separate allowlisted public summary; it never rewrites
the authoritative private report or promotes manual acceptance. Evidence output
directories cannot reuse old gate/test reports. Linux images require real ffmpeg
and eSpeak coverage; absence of those prerequisites is a gate failure, while
Whisper/interactive desktop remain explicitly separate gates.

## Overview

DODO แบ่งเป็น data plane สำหรับ MCP tools และ owner control plane สำหรับ Local
Config/CLI ทั้งสอง plane ใช้ state และ workspace lifecycle เดียวกัน Public listener
ไม่มี owner route ที่ active ตามค่าเริ่มต้น; ADR-047 เพิ่ม bounded `/config` bridge ที่
เจ้าของเปิดชั่วคราวและปิดเป็น 404 เมื่อ lease หมด

```text
AI client
   │ OAuth + MCP
   ▼
HTTP MCP 127.0.0.1:21730 ──► surface registry ──► policy/invocation pipeline
                                      │
                                      ├─ workspace services
                                      ├─ changes and jobs
                                      ├─ Git/intelligence/LSP
                                      ├─ assistance/multimodal/workflow
                                      ├─ Context Engine ──► evidence + L0–L6 cache
                                      ├─ Memory ──► reviewed evidence + stale lifecycle
                                      ├─ Runtime Intelligence ──► durable tasks + bounded evidence
                                      ├─ Advanced Agent Runtime ──► plans + hypotheses + intents + reviewed skills
                                      ├─ Project Brain ──► incremental AST graph
                                      └─ resource references ──► private SHA-256 CAS

Owner browser/CLI
   │ loopback + capability token / IPC
   ▼
Local Config 127.0.0.1:21731 ──► WorkspaceHost ──► active workspace lifecycle

Tunnel ──► 127.0.0.1:21730/config ──► one-time pairing/session gate
                                      └──────────► Local Config 127.0.0.1:21731
                                                    (lease ไม่เกิน 1 ชั่วโมง)

Local owner CLI ──► authenticated tunnel IPC ──► bounded cloudflared supervisor

Local owner CLI/Config ──► project registry ──► projectId + workspace reference

Authorized MCP read ──► federation resolver ──► isolated read context A/B/…
```

## Project Brain และ incremental graph

`ProjectBrainService` เป็น service ต่อ active workspace และใช้ SQLite tables แยก
สำหรับ index state, parsed-file cache, nodes, edges และ bounded run history
background scheduler ตรวจ metadata เป็นช่วง แล้ว snapshot เฉพาะไฟล์ที่เปลี่ยนผ่าน
`WorkspaceFS` ก่อนส่ง UTF-8 text ไปยัง worker ที่โหลด bundled TypeScript เท่านั้น
ไม่มีการโหลด compiler plugin, language plugin หรือ code จาก repository

cache key ผูก content SHA-256, parser version, schema version และ config hash
exact-content move รักษา opaque file identity ทำให้ `symbol://<project>/<entity>`
คงเดิม จากนั้น affected calculator สร้าง graph ใหม่เฉพาะ source ที่เปลี่ยน ผู้ import
source นั้น และ source ที่อ้างชื่อ symbol ที่เปลี่ยน transaction เดียว commit cache,
nodes, edges, metrics และ run state จึงไม่เกิด graph ครึ่งรุ่น

index เป็น evidence ที่สร้างใหม่ได้ ไม่ใช่ authority ทุก `brain_query` และ
`brain_symbol` ตรวจ principal/live grant/target authority, workspace context,
`WorkspaceFS` policy และ SHA-256 ปัจจุบันซ้ำ stale row ถูกตัดออกโดย default และ
cursor ใช้ HMAC ผูก query, workspace และ principal การเปลี่ยน workspace ปิด parser,
scheduler และ run เดิมก่อนปิด database

## Bootstrap and workspace lifecycle

`bootstrapWorkspace` เปิด database, store, root policy, ignore engine, planner/applier, jobs, Git, search, intelligence และ optional services สำหรับ root เดียว

HTTP launcher เริ่มได้โดยไม่มี active project เพื่อให้ `dodo` รันจาก directory ใดก็ได้
ระหว่างนี้ process bootstrap private inert root ใต้ config directory สำหรับ control-plane
resources เท่านั้น `workspaceSelected=false` ยังเปิด OAuth installation login และ
authenticated MCP catalog เพื่อให้ remote client เชื่อมต่อได้ก่อน แต่ invocation pipeline
ไม่ให้สิทธิ์กับ inert root และคืน `WORKSPACE_ACCESS_REQUIRED` จนมี registered target จริง
`/healthz` และ Local Config ยังพร้อมให้เจ้าของเพิ่มหรือเลือกโปรเจกต์
เมื่อ target ผ่าน shared root policy, readiness และ WorkspaceHost switch lifecycle แล้ว
จึง flip active state, เริ่ม schedules และให้ request ใหม่สร้าง MCP context ของ root จริง

`WorkspaceHost` ถือ active workspace เดียวต่อ process การเปลี่ยน workspace ทำแบบ prepare → readiness → drain/teardown → commit และ rollback เมื่อขั้นตอน prepare ล้มเหลว ทุก request resolve active workspace ตอนเริ่ม request และตรวจ identity/epoch ซ้ำใน invocation pipeline

running jobs, in-flight requests, stale Local Config headers และ duplicate server ownership ถูกตรวจเป็น precondition การสลับจะไม่ kill jobs เงียบ ๆ

`startupProjectId` ชี้ owner registry entry เพื่อเลือก startup root แต่ไม่ใช่ authority
ระบบ resolve canonical identity/readiness ใหม่ทุก startup และ fallback เป็น launcher mode
เมื่อพิสูจน์ target ไม่ได้ ไม่มี service ใดเปลี่ยน root จาก `process.cwd()`

## Project registry

Project Registry อยู่ใน installation SQLite และใช้ opaque random project ID แยกจาก
path-derived workspace ID รายการเก็บ canonical root, directory identity แบบ
device/inode/birthtimeNs, display metadata และ readiness เท่านั้น ไม่ใช่ authority
store และไม่มี MCP/public route การใช้ birth time แยก directory generation ใหม่ออก
จาก inode เดิมที่ Linux อาจนำกลับมาใช้ซ้ำ

การ relocate ที่พิสูจน์ directory identity เดิมได้รักษา project ID แต่คำนวณ
workspace ID จาก path ใหม่ ทำให้ managed trust และ client ACL ไม่ถูกคัดลอก Registry mutation
และ audit commit ใน transaction เดียวกัน การ remove เป็น soft removal และไม่ลบไฟล์
workspace history หรือ security state

## Read-only federation

Phase 03 เพิ่ม `FederationService` เป็น isolation layer สำหรับ owner-registered
projects โดยไม่ bootstrap target เป็น active runtime และไม่เปลี่ยน `process.cwd()`
แต่ละ target สร้าง `IgnoreEngine`, `WorkspaceFS`, read/list/search/overview และ Git
read service ของตัวเอง พร้อม process-local federation epoch และ cache แบบ LRU
ที่มีเพดาน 16 target contexts

request ยังยึด active workspace ID/epoch ใน invocation pipeline แล้ว federation
ตรวจ installation identity, grant revocation, token/grant read scope และ target
authority ตาม access mode ซ้ำ Project Registry ถูก resolve และตรวจ canonical directory identity
ทุกครั้งก่อนใช้ cache cache key ผูก workspace ID, registry update และ
dev/inode/birthtimeNs

cross-project search รับสูงสุด 8 project IDs แบ่ง result quota รวมและทำ target ที่
พร้อมแบบ concurrent ผลแต่ละ target มี project/workspace identity, epoch และ hashes
ของ source files Target ที่ authorized แต่ unavailable แสดงเป็น partial failure;
หาก target ใดไม่มี authority request ทั้งก้อนถูกปฏิเสธก่อนคืนผล

Federation audit เขียนอีกแถวด้วย target workspace ID นอกเหนือจาก outer tool audit
ของ active workspace ทำให้ history กรองตาม project ได้ `projectId/projectIds` เปิดเฉพาะ
read tools; write/exec/jobs/plans ใช้ explicit `targetProjectId` เพื่อเลือก runtime แยก

## Tool invocation

ทุก direct tool และ gateway ใช้ pipeline กลาง:

1. resolve principal
2. เลือก target runtime (หรือ default เมื่อไม่ระบุ) แล้วตรวจ workspace และ target authority
3. ตรวจ workspace ID/epoch
4. ตรวจ required OAuth scope
5. parse input schema แบบ strict
6. ตรวจ effective trust/action/approval และ idempotency
7. เรียก handler
8. validate output และส่ง content blocks
9. บันทึก audit แบบ scrubbed

Gateway ไม่เรียก handler ตรง ๆ และไม่สามารถเรียก gateway อื่น, project overview หรือ owner controls

## Context Engine และ evidence

`ContextEngineService` ทำ goal-driven retrieval ต่อ active workspace โดยรวม guarded
lexical search, Project Brain, Git และ read-only federation ผลลัพธ์แยก evidence class,
project/source provenance, confidence, freshness และข้อจำกัด Ranking deterministic
ภายใต้ query/ACL/index version เดียวกันและจำกัดด้วย byte budget/cursor

SQLite เก็บ caller-scoped cache L0–L6, evidence และ aggregate metrics Derived cache
ผูก dependency path/hash ก่อน reuse ระบบตรวจ live active/target ACL และ guarded source
ซ้ำ หาก hash เปลี่ยนจะ mark evidence เดิม stale และ invalidate L1–L6 Cursor ใช้ HMAC
ผูก principal/workspace/query/index version ค่า ID/hash/cache ไม่ใช่ authority และ
retrieved content ทุกชนิดเป็น untrusted data

## Memory และ reviewed learning

`MemoryService` แยก durable experience จาก Context cache และ Project Brain MCP
caller สร้างได้เพียง proposal จาก current `context_evidence` ของ principal เดียวกัน
เจ้าของอนุมัติ proposal ID + digest ผ่าน authenticated private IPC เท่านั้น ก่อน commit
ระบบตรวจ source hash, conflict set, active workspace และ explicit cross-project
visibility ซ้ำใน transaction

Memory record มี source provenance, confidence, retention, CURRENT/STALE, content hash
และ `authority: evidence_only` การค้นตรวจ live target ACL/readiness แล้วจำกัด scan,
byte budget และ signed cursor Context Engine รับ memory ที่ current เป็น `MEMORY`
evidence และใส่ memory content hash/manifest ใน dependency cache เมื่อ source เปลี่ยน
memory stale และ derived cache ใช้ซ้ำไม่ได้

Learning proposal ต้องอ้าง current owner-reviewed successful memory อย่างน้อยสองชิ้น
Owner review บันทึก audit เท่านั้น ไม่มี handler สำหรับติดตั้ง/execute หรือเปลี่ยน policy

## Runtime Intelligence

`RuntimeService` อยู่ต่อ active workspace และเก็บ session, task reference และ immutable
evidence ใน SQLite Session ผูก digest ของ `grantId + clientId`, workspace ID และ
expiration งาน process/test/container ใช้ `JobManager` เดิมด้วย explicit program+argv,
environment allowlist, timeout, execution approval, idempotency และ owner-selected
command sandbox จึงไม่มี runtime shell หรือ process launcher อีกชุดหนึ่ง

process evidence เก็บ status/exit/signal/timestamps, stream byte counts และ SHA-256 ของ
bounded sample เท่านั้น Optional JSON test report อ่านผ่าน `WorkspaceFS` และลดเหลือ
aggregate counts กับ source hash ส่วน Browser collector เรียก `BrowserService.observe`
บน owned session เดิม แล้ว persist safe URL ที่ไม่มี query, content/screenshot hashes,
event counts และ bounded navigation timing โดย WebSocket policy ยังคง blocked ตาม
browser isolation ส่วน bounded DOM/image ส่งผ่าน MCP response แต่ไม่ถูกเก็บใน runtime tables

Snapshot hash มาจาก guarded file metadata manifest และแสดง caller-owned committed
changeset IDs เป็น rollback candidates เท่านั้น การ rollback จริงยังผ่าน
`rollback_changes` และ conflict journal เดิม Evidence revalidation ไม่แก้ record เดิม:
source เปลี่ยนหรือหายจะ mark record `STALE` Context Engine ใช้ current runtime row เป็น
`OBSERVATION` และผูก content hash + caller-specific runtime manifest เป็น cache
dependency ทุก access ตรวจ live OAuth grant/workspace ACL ใหม่

## Advanced Agent Runtime

`AgentRuntimeService` ผูกกับ active `BootstrappedWorkspace` และเก็บ durable run ของ
principal เดียวกัน: immutable plan revisions, bounded hypotheses, intent locks,
metadata snapshots, target-action receipts, evidence judgements และ reviewed skill
versions ทุก run มี `authority=coordination_only` และ capability envelope ที่ลด
project/path/program/network/browser/desktop/media/workflow/quota จาก authority เดิม

`agent_read`, `agent_write` และ `agent_exec` เลือกได้เฉพาะ allowlist ที่สร้างจาก
`CORE_TOOL_CATALOG` แล้วเรียก target ผ่าน `invokeToolDefinition` จึงไม่มี security
pipeline ชุดที่สอง Path write ต้องผ่าน run writable-path check + covering intent ก่อน
ผ่าน target WorkspaceFS/secret/hash checks ส่วน exec ใช้ explicit argv หรือ owned
runtime handles และตรวจ program/feature/job quota ก่อน target approval/sandbox

Snapshot เก็บ metadata manifest และ changeset baseline; compare คืน caller-owned
post-snapshot candidates; rollback ใช้ original `rollback_changes` pipeline Restart
เปลี่ยน unfinished action เป็น `INTERRUPTED/SERVER_RESTARTED` และ run epoch เก่าเป็น
`RECOVERY_REQUIRED` โดยไม่ replay หรือ signal stored PID Skill proposal อยู่ใน private
review queue จน owner อนุมัติ exact digest; approved steps ยังเป็น non-executable
`untrusted_guidance`

## Universal Resource Layer and CAS

`ResourceService` ผูกกับ active `BootstrappedWorkspace` และสร้าง opaque resource
reference ที่ bind กับ workspace ID และ digest ของ `grantId` + `clientId` ส่วน
`CasStore` เป็น installation-private immutable object store ที่
`<configDir>/store/sha256/<prefix>/<hash>` metadata/reference อยู่ใน SQLite แยกจาก
object bytes จึง deduplicate object เดียวกันได้โดยไม่ทำให้ hash หรือ URI เป็นสิทธิ์

การ ingest จาก workspace ผ่าน `WorkspaceFS`, regular-file/link checks, file identity
ก่อนและหลัง streaming และ expected SHA-256/MIME เมื่อ caller ระบุ จาก media asset
ต้องผ่าน owner lookup ของ `MediaStorage` อีกชั้น ทุก access ตรวจ live OAuth grant,
client registration, workspace ACL, principal owner, object size และ full SHA-256
ก่อนอ่าน range

`resource_read`/`resource_read_range` จำกัดหนึ่ง chunk ไม่เกิน 256 KiB และคืน
resume token ที่ signed/bound กับ workspace, principal, resource/hash และ expiry
แต่ token ไม่ข้าม authorization `resource_preview` ส่ง image/audio content block
เฉพาะ output ที่ bounded ส่วน ZIP provider อ่านเฉพาะ central directory โดยไม่
inflate และ SVG อยู่ใน text path ไม่ถูก render เป็น active content GC ลบ object
เฉพาะเมื่อไม่มี live reference ภายใต้ SQLite write transaction โดยเว้น grace
หนึ่งชั่วโมงสำหรับ object ที่เพิ่งสร้าง/verify เพื่อไม่ให้ชนกับขั้นสร้าง reference
การ publish ใช้ fsynced staging inode + create-if-absent hard link และ SQLite trigger
บังคับโควตารวม 2 GiB ซ้ำเพื่อรองรับหลาย process

## Evaluation and release evidence

`src/evaluation/` แยก report contract ออกจาก deterministic scoring ส่วน
`tests/evaluation/dodoBench.test.ts` เรียก real HTTP/OAuth fixtures ผ่าน Compact
gateways Report ผูก revision, dataset, dependency lock, config และ host environment
โดยไม่สร้าง model-token estimate

`scripts/release-gate.mjs` สร้าง immutable tarball แล้วส่ง exact file ให้
`scripts/release-smoke.mjs` ติดตั้งใน fresh prefix Smoke เปิด runtime จาก package ที่
ติดตั้งใหม่และตรวจ STDIO Full กับ Streamable HTTP/OAuth Compact สคริปต์ไม่ publish
และไม่ใช้ owner state จริง

## Tool surfaces

- Complete capability catalog 125 individual definitions (Core 104 + Advanced Agent Runtime 17 + Sub-agents 4)
- Full live catalog ค่าเริ่มต้น 121 definitions; owner เปิด Sub-agent MCP exposure แล้วเป็น 125
- Compact catalog 19 definitions: overview, discover และ gateways
- Hybrid catalog 49 definitions: compact core ตามด้วย direct tools

`schemas/tools.json` เป็น complete full schema ส่วน compact และ hybrid เป็น schema แยก
พร้อม metadata ของ optional feature ค่า `exposeSubagentsToMcp=false` จะกรองสี่
Sub-agent definitions ออกจาก Full และกรองสี่ operation names ออกจาก gateway schemas,
instructions และ `dodo_discover` ของ Compact/Hybrid โดยจำนวน gateway names ยังคง
19/49 การเลือก surface หรือ feature exposure ไม่เปลี่ยน permission

## Personal และ managed access mode

Global config ค่าเริ่มต้นเป็น `personal` สำหรับ installation ที่มีเจ้าของคนเดียว การ
อนุมัติ OAuth หนึ่งครั้งให้ installation identity และ scope ceiling จากนั้นทุก path ที่
owner เพิ่มลง Project Registry พร้อมใช้ตาม scopes โดยไม่สร้าง client ACL ซ้ำ Effective
trust เป็น `trusted` และ enabled AI profile ใช้ได้กับ registered projects ทั้งหมด การ
เลือก remote profile เป็น owner consent ให้ส่ง bounded context ของโปรเจกต์นั้น

`managed` คงโมเดลละเอียดเดิม: target authority เป็น intersection ของ token/grant scope,
workspace client ACL, saved trust, profile/client allowlist และ source-egress choice
การเปลี่ยน mode ทำได้เฉพาะ authenticated Local Config และมีผลกับ request ใหม่ทันที

ทั้งสอง mode ใช้ invocation pipeline เดียวกันและยังตรวจ live grant/revocation,
workspace ID/epoch, registered target/readiness, path/secret/symlink/hardlink guards,
expected hash, idempotency และ owner-configured command sandbox Profile ลด scopes ได้
แต่เพิ่มไม่ได้ Repo config, model output และ remembered data ไม่เปลี่ยน access mode

## State and security

SQLite ใช้ durable migrations, WAL ตาม platform และ transaction ที่เหมาะสม Changesets มี immutable plan, journal, backups และ recovery marker

Global config อยู่นอก workspace ใน platform config directory และรองรับ `DODO_CONFIG_DIR` เป็น explicit override

`dodo setup --import-state` ใช้ state-import pipeline แยกจาก runtime bootstrap โดยอ่านได้เฉพาะ `config.json` ที่เป็น private regular file, validate ด้วย config schema, เลือกเฉพาะ non-authority allowlist, ตรวจ SHA-256 ซ้ำก่อนเขียน และ commit target ด้วย atomic rename การนำเข้าจะไม่เปิด SQLite เดิมหรืออ่าน/copy keys, tokens, ACL, trust, approvals, schedules, executable registrations หรือ runtime state

Repo config เป็น hints-only และไม่สามารถ widen permissions, change OAuth, disable guards หรือ grant client access

## Tunnel lifecycle

Tunnel config อยู่ใน global owner config และมี `connectionMode` เป็นแหล่งความจริงเดียว:
`local` หรือ `tunnel` พร้อม opaque credential reference, canonical executable selection,
loopback metrics port และ bounded restart count Token ถูก resolve จาก reviewed OS
store หรือ owner-controlled env/private-file reference เมื่อเริ่ม process และส่งผ่าน
child environment โดยไม่เข้า argv

managed supervisor เป็น foreground process มี state machine `starting → connecting → connected/backoff → stopped/failed`, private bounded/redacted log และ authenticated singleton IPC `status/logs/stop` การ stop อ้างอิง live `ChildProcess` ที่ supervisor ถืออยู่เท่านั้น Local mode ไม่ spawn process และ `doctor` ตรวจ local/public health โดยไม่จัดการ Cloudflare account หรือ DNS

`TunnelRuntime` ผูก supervisor หนึ่งตัวกับ DODO HTTP process และยอมเริ่มเฉพาะเมื่อ
saved mode เป็น Tunnel พร้อม credential reference Runtime ส่งค่าผ่าน `TUNNEL_TOKEN`
ให้ child โดยตรง เก็บเพียงสถานะที่ไม่มี secret และปิด child ก่อน DODO process จบ
การเปลี่ยน workspace ไม่ย้ายหรือเพิ่มสิทธิ์ใด ๆ และ Local Config port 21731 ยังคง
ไม่รับ traffic จาก Tunnel

Remote Config ไม่เปลี่ยน bind ของ Local Config และไม่ copy admin handlers มาที่ public
app `RemoteConfigGateway` ถือ pairing/session digest กับ expiry ใน memory, proxy เฉพาะ
`/config`, `/config/assets/*`, `/config/api/*` และส่ง request ไป loopback owner server
ด้วย internal capability เดิม CLI เปิด/ต่ออายุผ่าน authenticated installation IPC
เฉพาะเมื่อ persistent Tunnel mode ทำงานอยู่ IPC ไม่รับ credential หรือสลับ connection
mode การหมดอายุล้าง code/session และทำให้ namespace กลับเป็น 404 โดยไม่หยุด
MCP/OAuth/Tunnel

## Optional services

Optional services ถูกสร้างจาก config และ probe readiness ก่อน expose capability ได้แก่ LSP, desktop, media, browser, game, speech และ workflow ทุก operation ใช้ policy gate เดิม

## Observability

startup log แสดง transport, selected surface, tool count และ schema bytes แบบ bounded ไม่ log request args, token หรือ file content

## Installation runtimes และ AI execution

`InstallationRuntime` ถือ installation Store แยกจากอายุ default workspace และ lazy-open
registered target runtimes ภายใต้ lease ก่อน recovery แต่ละ runtime มี refs/jobs/queue
ของตนเอง การเปิด B ไม่ปิด A; explicit routes ใช้ manager refcount และ default switch
ยังใช้ WorkspaceHost drain guard การ release ref เป็น idempotent

`projectAuthority` แยก identity (expiry/audience/live grant) จาก target scope intersection
และ legacy binding `invokeToolDefinition` เป็นจุดร่วมของ direct/gateway/model actions
รวม strict input/output validation, fresh principal หลังรอ queue, context, policy/audit
MutationQueue ใช้ AsyncLocalStorage เพื่อ nested invocation และ job-held references;
queued cancellation ถอน waiter ได้ ไม่มี handler/private-owner dispatcher ที่โมเดลเรียกเอง

AISettings เก็บ metadata ใน `ai_settings`; key อยู่ session Buffer หรือ macOS Keychain
Adapter ห้าชนิดมี native request/stream decoder และ continuation แยกตาม protocol
Network resolve-all/validate/pin, refuse redirects, timeout/response cap และตรวจ live
run authority ก่อนส่ง request Subagents จำกัด tools จาก catalog เดิมและลด caller scope
ผ่าน profile พร้อม project restriction Personal mode ใช้ owner-selected profile เป็น
egress consent ส่วน managed mode เพิ่ม project/provider/client egress checks

`ai_runs` เก็บ bounded private continuation/delegation (ไม่มี raw OAuth token), usage,
idempotency digest และ execution ownership `ai_events` เก็บ visible progress/receipts
แบบ cursor Jobs ที่ agent เริ่มถูกติดตามจนเสร็จและส่ง observed output กลับโมเดล
Unknown outcome เป็น review barrier; process restart ไม่ replay และต้อง explicit Resume
จากผู้เรียกเดิม Config/profile digest เปลี่ยนระหว่าง run จะหยุดและให้สร้าง task ใหม่

Owner UI อยู่ `configUi/workbench.js/.css` ใช้ authenticated same-origin fetch และ
`aiAdmin.ts` บน private listener เท่านั้น CLI/advanced web controls ใช้ IPC dispatcher,
setup/config validation ชุดเดิม ไม่มี secret fallback หรือการเปิด permission อัตโนมัติ
รายละเอียด [ADR-045](adr/045-ai-providers-multiproject.md)
