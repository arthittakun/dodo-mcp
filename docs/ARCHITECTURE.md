# DODO MCP — Architecture

## Overview

DODO แบ่งเป็น data plane สำหรับ MCP tools และ owner control plane สำหรับ Local Config/CLI ทั้งสอง plane ใช้ state และ workspace lifecycle เดียวกัน แต่ public MCP ไม่มี admin endpoint

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
                                      ├─ Project Brain ──► incremental AST graph
                                      └─ resource references ──► private SHA-256 CAS

Owner browser/CLI
   │ loopback + capability token / IPC
   ▼
Local Config 127.0.0.1:21731 ──► WorkspaceHost ──► active workspace lifecycle

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
`brain_symbol` ตรวจ principal/live grant/workspace ACL, workspace context,
`WorkspaceFS` policy และ SHA-256 ปัจจุบันซ้ำ stale row ถูกตัดออกโดย default และ
cursor ใช้ HMAC ผูก query, workspace และ principal การเปลี่ยน workspace ปิด parser,
scheduler และ run เดิมก่อนปิด database

## Bootstrap and workspace lifecycle

`bootstrapWorkspace` เปิด database, store, root policy, ignore engine, planner/applier, jobs, Git, search, intelligence และ optional services สำหรับ root เดียว

`WorkspaceHost` ถือ active workspace เดียวต่อ process การเปลี่ยน workspace ทำแบบ prepare → readiness → drain/teardown → commit และ rollback เมื่อขั้นตอน prepare ล้มเหลว ทุก request resolve active workspace ตอนเริ่ม request และตรวจ identity/epoch ซ้ำใน invocation pipeline

running jobs, in-flight requests, stale Local Config headers และ duplicate server ownership ถูกตรวจเป็น precondition การสลับจะไม่ kill jobs เงียบ ๆ

## Project registry

Project Registry อยู่ใน installation SQLite และใช้ opaque random project ID แยกจาก
path-derived workspace ID รายการเก็บ canonical root, directory identity, display
metadata และ readiness เท่านั้น ไม่ใช่ authority store และไม่มี MCP/public route

การ relocate ที่พิสูจน์ directory identity เดิมได้รักษา project ID แต่คำนวณ
workspace ID จาก path ใหม่ ทำให้ trust และ client ACL ไม่ถูกคัดลอก Registry mutation
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
workspace ACL ซ้ำ Project Registry ถูก resolve และตรวจ canonical directory identity
ทุกครั้งก่อนใช้ cache cache key ผูก workspace ID, registry update และ dev/inode

cross-project search รับสูงสุด 8 project IDs แบ่ง result quota รวมและทำ target ที่
พร้อมแบบ concurrent ผลแต่ละ target มี project/workspace identity, epoch และ hashes
ของ source files Target ที่ authorized แต่ unavailable แสดงเป็น partial failure;
หาก target ใดไม่มี ACL request ทั้งก้อนถูกปฏิเสธก่อนคืนผล

Federation audit เขียนอีกแถวด้วย target workspace ID นอกเหนือจาก outer tool audit
ของ active workspace ทำให้ history กรองตาม project ได้ รุ่นนี้เปิดเฉพาะ read tools
การ write/exec/jobs/plans ยังคงผูก active `BootstrappedWorkspace` เพียงตัวเดียว

## Tool invocation

ทุก direct tool และ gateway ใช้ pipeline กลาง:

1. resolve principal
2. ตรวจ active workspace และ ACL
3. ตรวจ workspace ID/epoch
4. ตรวจ required OAuth scope
5. parse input schema แบบ strict
6. ตรวจ trust/action/approval และ idempotency
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

## Tool surfaces

- Full catalog 94 individual definitions
- Compact catalog 19 definitions: overview, discover และ gateways
- Hybrid catalog 49 definitions: compact core ตามด้วย direct tools

`schemas/tools.json` เป็น full schema ส่วน compact และ hybrid เป็น schema แยก การเลือก surface เปลี่ยนการ expose เท่านั้น ไม่เปลี่ยน permission

## State and security

SQLite ใช้ durable migrations, WAL ตาม platform และ transaction ที่เหมาะสม Changesets มี immutable plan, journal, backups และ recovery marker

Global config อยู่นอก workspace ใน platform config directory และรองรับ `DODO_CONFIG_DIR` เป็น explicit override

`dodo setup --import-state` ใช้ state-import pipeline แยกจาก runtime bootstrap โดยอ่านได้เฉพาะ `config.json` ที่เป็น private regular file, validate ด้วย config schema, เลือกเฉพาะ non-authority allowlist, ตรวจ SHA-256 ซ้ำก่อนเขียน และ commit target ด้วย atomic rename การนำเข้าจะไม่เปิด SQLite เดิมหรืออ่าน/copy keys, tokens, ACL, trust, approvals, schedules, executable registrations หรือ runtime state

Repo config เป็น hints-only และไม่สามารถ widen permissions, change OAuth, disable guards หรือ grant client access

## Tunnel lifecycle

Tunnel config อยู่ใน global owner config และมีเฉพาะ mode, opaque credential reference, canonical executable selection, loopback metrics port และ bounded restart count Credential provider แยกตาม OS ส่วน token ถูก resolve เฉพาะตอน start และส่งผ่าน child environment โดยไม่เข้า argv

managed supervisor เป็น foreground process มี state machine `starting → connecting → connected/backoff → stopped/failed`, private bounded/redacted log และ authenticated singleton IPC `status/logs/stop` การ stop อ้างอิง live `ChildProcess` ที่ supervisor ถืออยู่เท่านั้น External mode ไม่ spawn process และ `doctor` ตรวจ local/public health โดยไม่จัดการ Cloudflare account หรือ DNS

## Optional services

Optional services ถูกสร้างจาก config และ probe readiness ก่อน expose capability ได้แก่ LSP, desktop, media, browser, game, speech และ workflow ทุก operation ใช้ policy gate เดิม

## Observability

startup log แสดง transport, selected surface, tool count และ schema bytes แบบ bounded ไม่ log request args, token หรือ file content
