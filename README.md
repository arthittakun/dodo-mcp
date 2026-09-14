# DODO MCP

**DODO MCP 1.0.0** คือ MCP server แบบ local-first สำหรับให้ AI ช่วยพัฒนา software โดยทำงานกับ workspace ที่เจ้าของเลือก ใช้ OAuth, workspace ACL, trust policy และ file/secret guards เป็นชั้นความปลอดภัยหลัก

## จุดเด่น

- MCP ผ่าน HTTP ที่ `127.0.0.1:21730/mcp` พร้อม OAuth และ PKCE
- Local Config แบบ loopback ที่ `127.0.0.1:21731`
- HTTP ใช้ Compact Tool Surface 19 tools เพื่อลดภาระการโหลด schema
- STDIO ใช้ Full Tool Surface 121 tools เป็นค่าเริ่มต้น
- Hybrid Surface 49 tools สำหรับ client ที่รับ catalog ขนาดกลาง
- อ่าน ค้นหา สร้าง แก้ ย้าย ลบไฟล์ พร้อม expected hash, journal และ rollback
- รันคำสั่ง งานแบบขนาน jobs, Git, TypeScript/JavaScript intelligence, LSP และ task assistance
- รองรับภาพ เสียง วิดีโอ เบราว์เซอร์ เกม และ workflow ตาม dependency และ permission ที่เจ้าของเปิดใช้
- มี Universal Resource Layer + CAS สำหรับ text/binary/image/audio/video/PDF/ZIP/WASM พร้อม SHA-256, dedup, bounded range/resume และ MCP image/audio blocks
- มี Project Brain ที่ทำ incremental AST index สำหรับ symbols, references, imports, routes, tests และ dependencies พร้อม source-hash freshness
- มี Context Engine สำหรับ goal-driven retrieval แบบมี budget, provenance, confidence, freshness และ L0–L6 dependency cache
- มี owner-reviewed Memory สำหรับ fact/decision/fix/convention ที่ผูก source evidence, retention และ freshness พร้อม learning proposal ที่ไม่ติดตั้งหรือรันเอง
- มี Runtime Intelligence สำหรับ task ที่ reconnect ได้, process/test/browser evidence แบบ bounded, snapshot freshness และ diagnosis ที่แยก fact/observation/inference
- มี Advanced Agent Runtime สำหรับ immutable plan, parallel hypotheses, intent locks, guarded snapshots, evidence-backed completion, restart recovery และ owner-reviewed reusable guidance
- มี DodoBench และ revision-bound release gate สำหรับ retrieval, safe edit, runtime, resource, recovery, security และ fresh package artifact
- เปลี่ยน workspace จาก Local Config ได้จริง โดยรอ request/jobs และ rollback เมื่อเตรียม workspace ใหม่ไม่สำเร็จ
- มี owner-only Project Registry พร้อม stable project ID และ readiness โดยไม่คัดลอก trust/ACL
- อ่าน overview/list/files และค้นหาพร้อมกันได้สูงสุด 8 โปรเจกต์ที่เจ้าของลงทะเบียนและให้ ACL แล้ว โดยไม่สลับ active workspace
- เปิด Cloudflare Tunnel พร้อม `dodo start` ด้วย token ชั่วคราวจาก terminal หรือ Local Config โดยไม่บันทึก token ลงเครื่อง
- ไม่ส่ง token, secret หรือ state DB ไปที่ repository และไม่ให้ repository config เพิ่มสิทธิ์

## เริ่มใช้งาน

```bash
npm install -g dodo-mcp
dodo setup --check
dodo --cli
```

`dodo --cli` เปิดเมนู local owner สำหรับเลือก/เพิ่มโปรเจกต์ เปิด MCP + Local Config +
Tunnel และรัน setup รวม `cloudflared` โดยไม่ต้อง `cd` เข้าโปรเจกต์
ก่อน หากเรียก `dodo` หรือ `dodo start` จากโฟลเดอร์ใดก็ตาม ระบบจะเปิดโปรเจกต์ที่
เจ้าของเลือกล่าสุด หากยังไม่เลือกจะเปิดเฉพาะ control plane และปฏิเสธ MCP/OAuth ด้วย
`workspace_required` จนกว่าจะเลือก absolute path จาก Local Config หรือเมนู CLI

เปิดโปรเจกต์โดยตรงและจำไว้สำหรับครั้งถัดไปได้ด้วย:

```bash
dodo start --root /path/to/your/project
```

การเลือกโปรเจกต์ไม่คัดลอก trust หรือ client ACL จากโปรเจกต์อื่น ตั้งสิทธิ์ของโปรเจกต์
ที่เปิดแล้วผ่าน Local Config หรือคำสั่ง owner ที่ผูกกับ workspace นั้น

`dodo setup --check` และ `dodo setup --plan` เป็น read-only หากแผนมี dependency ที่ต้องติดตั้ง ให้ตรวจรายการก่อนแล้วจึงรัน `dodo setup --yes --components <list>` ระบบจะไม่เริ่ม installer หากไม่มี `--yes` และ `--yes` ไม่ข้าม sudo, OS permission หรือ owner consent

เมื่อ DODO ตรวจพบ config เดิมในตำแหน่งมาตรฐาน สามารถใช้ `dodo setup --import-state` เพื่อนำเข้าเฉพาะ preference ที่ปลอดภัย เช่น port, search backend, retention และ tool surface ระบบจะสร้าง installation identity ใหม่เสมอและไม่คัดลอก OAuth keys/tokens, client grants, workspace ACL, trust, approvals, schedules, public origin, web/desktop permission, executable registration หรือฐานข้อมูลเดิม ต้นฉบับจะไม่ถูกแก้ไข

เปิด Local Config จาก URL ที่ `dodo` แสดงใน terminal ใช้สำหรับตั้ง trust, public origin, client access และเปลี่ยน workspace เจ้าของเท่านั้น

ลงทะเบียนโปรเจกต์ที่ต้องการใช้งานบ่อยได้โดยไม่เริ่ม server และไม่เปลี่ยนสิทธิ์:

```bash
dodo project add /absolute/path/to/project --name "Web application"
dodo project list
dodo project info prj_xxxxxxxxxxxx
dodo project remove prj_xxxxxxxxxxxx --yes
```

Project Registry ใช้ project ID คงที่แยกจาก workspace authority และแสดง readiness
ของ path ปัจจุบัน ดู contract ที่ [Project Registry](docs/PROJECTS.md)

### อ่านหลายโปรเจกต์พร้อมกัน

เจ้าของต้องลงทะเบียนแต่ละโปรเจกต์ และให้ `dodo:read` แก่ client ในแต่ละ workspace
ก่อน การอยู่ใน registry เพียงอย่างเดียวไม่ให้สิทธิ์ AI:

```text
project_overview()
  → federation.projects แสดงเฉพาะโปรเจกต์ที่ client อ่านได้

dodo_read(operation="search_code", args={
  projectIds: ["prj_2bcdefghjkmn", "prj_3cdefghjkmnp"],
  query: "UserDto"
})
```

`project_overview`, `list_files` และ `read_files` รับ `projectId` ได้ ส่วน
`search_code` รับ `projectId` หรือ `projectIds` สูงสุด 8 รายการ ผลแต่ละโปรเจกต์มี
project/workspace identity, federation epoch และ source hash เพื่อแยก evidence
ออกจากกัน ค่า `workspaceId`/`workspaceEpoch` ระดับบนของ MCP call ยังคงเป็นของ
active workspace เสมอ

Federation รุ่นนี้เป็น read-only การเขียนไฟล์และรันคำสั่งยังทำได้เฉพาะ active
workspace เจ้าของต้องเปิดโปรเจกต์นั้นผ่าน Local Config แล้วให้ AI เรียก
`project_overview` และอ่านไฟล์ใหม่ก่อนแก้ จึงไม่สามารถนำ hash หรือ context จาก
โปรเจกต์อื่นไปใช้เขียนโดยตรงได้

### Universal Resource Layer

ไฟล์ขนาดใหญ่และสื่อใช้ resource contract เดียวกัน โดยเริ่มจาก path ภายใน active
workspace หรือ `assetId` ที่ principal เดียวกันเป็นเจ้าของ:

```text
resource_inspect(path="docs/spec.pdf")
  → resourceId + dodo-resource:// URI + MIME + bytes + SHA-256 + capabilities

resource_read_range(resourceId=..., offset=0, length=65536)
  → bounded Base64 chunk + chunk hash + principal-bound resumeToken

resource_preview(resourceId=...)
  → text / MCP image / MCP audio / metadata ตามชนิดและขนาด
```

HTTP Compact/Hybrid เรียก operation เดียวกันผ่าน `dodo_media` หลังค้นด้วย
`dodo_discover` CAS เก็บ object แบบ immutable ตาม hash และ deduplicate ข้าม reference
ได้ แต่ resource ID/URI ไม่ใช่ capability ทุก call ยังตรวจ OAuth, live grant,
workspace ACL, workspace ID/epoch และ principal ownership ซ้ำ ไม่ ingest `.env`,
private DODO state, traversal, symlink หรือ hardlink และไม่ inflate/execute archive
content ดูรายละเอียดที่ [Resources](docs/RESOURCES.md)

### Project Brain

Project Brain สร้าง graph แบบ bounded จาก TypeScript/JavaScript AST และ
`package.json` โดยไม่รัน source, repository plugin หรือ command ใด ๆ ระบบ refresh
อัตโนมัติและ parse ใหม่เฉพาะไฟล์ที่เปลี่ยน พร้อมขยายผลไปยัง relation ที่ได้รับ
ผลกระทบ:

```text
brain_status()
brain_query(query="UserService", nodeTypes=["symbol"])
brain_symbol(uri="symbol://...")
brain_rebuild(mode="incremental", waitMs=10000)
```

ใน Compact/Hybrid ให้เรียกผ่าน `dodo_assist_read` หรือ `dodo_assist_change`
ตาม schema จาก `dodo_discover` ค่า `symbol://` เป็น semantic identity ที่คงเดิม
เมื่อไฟล์ถูกย้ายแบบ exact-content แต่ URI/index row ไม่ใช่สิทธิ์ ทุก query จะตรวจ
OAuth, live grant, workspace ACL, workspace ID/epoch, path/secret policy และ SHA-256
ของ source ปัจจุบันใหม่ก่อนคืนผล ดู [Project Brain](docs/BRAIN.md)

### Context Engine และ Evidence

ให้ AI ขอ context ตาม goal ได้โดยไม่ต้องเลือก search/brain/git ทีละตัว:

```text
context_query(goal="Fix login callback", terms=["loginCallback", "OAuth"],
  projects=["Frontend", "Backend"], budget=24000)
```

Compact/Hybrid ใช้ `dodo_assist_read(operation="context_query", args={...})` ผลลัพธ์
แยก `FACT`, `OBSERVATION`, `MEMORY`, `INFERENCE`, `HYPOTHESIS` และทุก evidence มี
project identity, source hash, line/commit, confidence, generated/verified time และ
freshness Cache L0–L6 ตรวจ ACL และ dependency hash ก่อนใช้ซ้ำ Source เปลี่ยนแล้ว
evidence เดิมจะเป็น stale และ derived cache ถูกสร้างใหม่

ผลค้นหา, README และ repository instruction เป็น untrusted content และไม่สามารถเพิ่ม
scope, ACL, trust หรือ approval ได้ Memory ที่เจ้าของอนุมัติจะแสดงเป็น evidence class
`MEMORY`; runtime evidence ที่ caller เดียวกันเก็บไว้จะแสดงเป็น `OBSERVATION` พร้อม
source hash และ freshness ดู contract ที่
[Context Engine](docs/CONTEXT.md)

### Owner-reviewed Memory

AI สร้าง memory ถาวรเองไม่ได้ ขั้นแรกต้องใช้ current `context_evidence` เพื่อเสนอ:

```text
dodo_assist_read(operation="context_query", args={goal:"Find session policy", ...})
dodo_assist_change(operation="memory_propose", args={
  kind:"decision",
  claim:"Keep session state scoped to one workspace.",
  evidenceIds:["evidence_..."]
})
```

จากนั้นเจ้าของตรวจ proposal และ digest ผ่าน private local CLI เท่านั้น:

```bash
dodo memory pending
dodo memory show memprop_xxxxxxxxxxxx
dodo memory approve memprop_xxxxxxxxxxxx --digest sha256:...
```

Memory ทุกชิ้นเป็น `evidence_only` และ `untrusted_content` Source เปลี่ยนหรือ retention
หมดจะเป็น stale และไม่ถูกใช้เป็น current context การแชร์ข้าม project ต้องระบุ
`--share-with` ตอน owner approval และ client ยังต้องมี live ACL ใน project เป้าหมาย
รายละเอียดอยู่ที่ [Memory and Reviewed Learning](docs/MEMORY.md)

### Runtime Intelligence

งานทดสอบหรือ process ที่ต้องติดตามข้ามการ reconnect ใช้ runtime session โดยคำสั่ง
ยังผ่าน exec approval, trusted executable resolver และ command sandbox เดิม:

```text
dodo_assist_change(operation="runtime_session_open", args={label:"verify checkout"})
dodo_exec(operation="runtime_task_start", args={
  sessionId:"runtime_...", kind:"test", program:"npm", args:["test"],
  network:false, idempotencyKey:"client-generated-key"
})
dodo_assist_read(operation="runtime_task_observe", args={sessionId:"runtime_...", taskId:"rtask_..."})
dodo_assist_read(operation="runtime_diagnose", args={sessionId:"runtime_...", evidenceIds:["runtimeev_..."]})
```

Runtime store เก็บเฉพาะ status, byte counts, aggregate test counts และ SHA-256 ไม่เก็บ
stdout/stderr, DOM, console หรือ header ดิบ Browser collector ใช้ได้เฉพาะ
`browser_session` ที่ caller เปิดและมีสิทธิ์อยู่แล้ว โดยส่ง bounded observation/image
ใน response ปัจจุบัน แต่ persist เฉพาะ safe URL, hashes และ counts Snapshot ไม่ copy
ไฟล์และไม่ rollback เอง; ต้องเรียก `rollback_changes` แยกต่างหาก ดู
[Runtime Intelligence](docs/RUNTIME.md)

### Advanced Agent Runtime

งานแก้ปัญหาหลายขั้นสามารถเปิด durable agent run ที่จำกัด project, writable paths,
programs, optional capabilities, quotas และเวลาทำงานเพิ่มจากสิทธิ์เดิม:

```text
dodo_assist_change(operation="agent_run_open", args={goal, completionCriteria, capabilities})
dodo_assist_change(operation="agent_hypothesis_open", args={runId, ...})
dodo_assist_change(operation="agent_intent_acquire", args={runId, hypothesisId, kind:"path", resourceKey:"src"})
dodo_write(operation="agent_write", args={runId, hypothesisId, operation:"edit_file", args:{...}})
dodo_assist_read(operation="agent_snapshot_compare", args={...})
```

Run/plan/hypothesis/intent/snapshot/skill ไม่ให้ permission เพิ่ม ทุก target ยังผ่าน
OAuth scope, live workspace ACL/epoch, trust approval, path/secret guards, expected hash,
command sandbox, idempotency และ audit เดิม `agent_exec` ใช้ explicit argv/owned handles
เท่านั้น และ cancel/pause coordinator ไม่ kill job ดู
[Advanced Agent Runtime](docs/AGENT_RUNTIME.md)

### เชื่อม Remote MCP ผ่าน Cloudflare Tunnel

DODO ไม่สร้าง Tunnel, DNS หรือ Cloudflare account ให้ ผู้ใช้สร้าง remotely-managed Tunnel และตั้ง public hostname ให้ route **ทุก path** มาที่ `http://127.0.0.1:21730` ก่อน จากนั้นตั้ง public origin ครั้งเดียว:

```bash
dodo setup --check --components cloudflared
dodo init --public-url https://mcp.example.com
dodo start
# Cloudflare Tunnel token (temporary; Enter = local only):
```

เมื่อกรอก token DODO จะเริ่ม `cloudflared` เป็น child process ของรอบนั้นและหยุดพร้อม
DODO Token อยู่ในหน่วยความจำระหว่างรอบและ environment ของ child เท่านั้น ไม่อยู่ใน
argv, config, Keychain, Credential Manager, Secret Service, tunnel log, MCP response
หรือ environment ของ MCP jobs กด Enter หรือใช้ `dodo start --no-tunnel` เพื่อเปิด
เฉพาะ local MCP

หน้า Local Config ที่ `127.0.0.1:21731` มีช่อง **Temporary Tunnel token** สำหรับเริ่ม
และหยุด tunnel ของ DODO process ปัจจุบันได้จริง ช่องจะถูกล้างหลังส่งและ backend ไม่
persist ค่า ดูสถานะด้วย `dodo tunnel status`, ตรวจ connectivity ด้วย
`dodo tunnel doctor` และดู log ที่ redacted ด้วย `dodo tunnel logs` คำสั่ง
`dodo tunnel configure` เดิมยังมีสำหรับ advanced/headless compatibility และต้องเรียก
โดยเจ้าของอย่างชัดเจน; เส้นทาง `dodo start` และหน้าเว็บไม่ใช้ credential store

บน macOS `dodo setup --yes` เลือก component `cloudflared` อยู่ในชุด `all` แล้ว
Tunnel route ต้องชี้เฉพาะ MCP/OAuth listener `21730` ห้ามชี้ Local Config `21731`
หรือ metrics `21732` ออก public

สำหรับ local MCP client เช่น Codex, Cursor หรือ Claude Desktop:

```bash
dodo stdio --root /path/to/your/project
```

STDIO ใช้ full catalog เป็นค่าเริ่มต้น ถ้าต้องการลด catalog ชั่วคราว:

```bash
dodo stdio --root /path/to/your/project --tools compact
dodo stdio --root /path/to/your/project --tools hybrid
```

## Compact Tool Surface

HTTP ใช้ Compact เป็นค่าเริ่มต้น ลำดับการใช้งานคือ:

```text
project_overview
→ dodo_discover
→ gateway ที่ตรงกับ operation
```

ตัวอย่างให้ AI แก้ `src/example.ts`:

```text
dodo_discover(query="edit TypeScript file")
dodo_read(operation="read_files", args={...})
dodo_write(operation="edit_file", args={...})
dodo_read(operation="read_files", args={...})
```

`dodo_discover` คืน schema ของ operation ที่เลือกและ hash ที่ deterministic ส่วน gateway จะส่ง request ผ่าน policy pipeline เดียวกับ tool รายตัว จึงยังตรวจ scope, ACL, workspace ID/epoch, trust, approval, path guard, secret guard, hash และ audit ครบทุกชั้น

ชื่อ gateway `dodo_*` เป็นชื่อ MCP protocol ที่คงไว้เพื่อ compatibility กับ client ที่เชื่อมต่ออยู่ การเปลี่ยนชื่อ gateway ต้องทำเป็น protocol migration แยกต่างหาก

## การเปลี่ยน workspace

1. เปิด Local Config จาก workspace ปัจจุบัน
2. ใส่ absolute path ของ project ใหม่
3. กดเปลี่ยนโปรเจกต์
4. ระบบตรวจ realpath, root policy, jobs และ request ที่กำลังทำงาน
5. ระบบเตรียม workspace ใหม่ก่อนสลับ และคืน workspace เดิมหากเตรียมไม่สำเร็จ
6. client ต้องเรียก `project_overview` ใหม่เพื่อรับ workspace ID/epoch ใหม่

ระบบไม่ kill jobs เงียบ ๆ และไม่คัดลอก trust หรือ client ACL ไปยัง workspace ใหม่

## การเชื่อมต่อ

- **Local MCP:** `http://127.0.0.1:21730/mcp` สำหรับ process ในเครื่อง
- **Public MCP:** origin HTTPS ของ tunnel ที่เจ้าของสร้างและกำหนด route เอง; DODO อาจ supervise เฉพาะ `cloudflared` process ที่เจ้าของสั่ง
- **Local Config:** loopback เท่านั้น ใช้ owner capability token และ Host/Origin checks

DODO รายงาน `connected` เฉพาะเมื่อ managed `cloudflared` ตอบ readiness จริง และ `doctor` แยก local/public health ออกจากกัน สถานะนี้ไม่ใช่หลักฐานว่า ChatGPT หรือ AI client เชื่อมต่อแล้ว

## สิทธิ์

สิทธิ์ของ client เป็น intersection ของ OAuth scope, workspace ACL และ local policy:

- `inspect` อ่านและวิเคราะห์ได้
- `edit` ทำ file changes ที่ผ่าน approval/policy ได้
- `trusted` อนุญาต effectful work ตาม policy ที่เจ้าของยืนยัน

โหมด trusted และคำสั่งที่เจ้าของอนุมัติใช้สิทธิ์ OS ของผู้ใช้จริง ควรเปิดเฉพาะ workspace ที่เชื่อถือได้

`dodo --bypass` ปรับ policy เฉพาะรอบนั้นตามที่เจ้าของสั่ง และไม่ปิด OAuth, ACL, workspace context, path guards หรือ secret guards

## ความปลอดภัย

- public MCP ใช้ OAuth เสมอ ไม่มี NoAuth fallback
- Local Config bind loopback และมี capability token, expiration, Host/Origin checks และ rate limit
- client secret/access token ไม่แสดงใน UI หรือ audit
- path traversal, symlink/hardlink, secret paths และ stale hashes ถูกปฏิเสธ
- command environment ใช้ allowlist และไม่ส่ง local auth state ให้ child process
- repository instructions, `.dodo.json`, project hints และ AGENTS.md ไม่มีอำนาจเพิ่มสิทธิ์
- gateway ไม่ grant สิทธิ์และไม่ข้าม approval หรือ target operation policy
- CAS URI/hash ไม่ grant สิทธิ์; resource ทุก read/range/preview ตรวจ live ACL และ object hash ซ้ำ

ดูรายละเอียดที่ [SECURITY](docs/SECURITY.md), [AUTH](docs/AUTH.md) และ [ARCHITECTURE](docs/ARCHITECTURE.md)

## เอกสาร

- [Release 1.0.0](docs/RELEASE_1.0.0.md)
- [Runtime Intelligence](docs/RUNTIME.md)
- [Advanced Agent Runtime](docs/AGENT_RUNTIME.md)
- [Release notes](docs/RELEASE_NOTES.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Compatibility](docs/COMPATIBILITY.md)
- [Security](docs/SECURITY.md)
- [Authentication](docs/AUTH.md)
- [Tunnel](docs/TUNNEL.md)
- [Web clients](docs/WEB_CLIENTS.md)
- [Windows compatibility](docs/WINDOWS.md)
- [Task assistance](docs/ASSISTANCE.md)
- [Multimodal](docs/MULTIMODAL.md)
- [Project Registry](docs/PROJECTS.md)
- [Universal resources and CAS](docs/RESOURCES.md)
- [Project Brain and incremental index](docs/BRAIN.md)
- [DodoBench and release gate](docs/EVALUATION.md)
- [Manual acceptance](docs/MANUAL_ACCEPTANCE.md)
- [Test report](docs/TEST_REPORT.md)

## Development

Platform CI ใช้ dedicated self-hosted runners ที่เจ้าของควบคุม: Linux X64 รันผ่าน
Docker พร้อม Playwright Chromium และ Windows X64 รัน native candidate gate ส่วน
macOS ยังรัน release gate บนเครื่องพัฒนา Workflow รับเฉพาะ push ที่ `main` และ manual
dispatch ไม่รัน pull request จากภายนอกบน self-hosted runner

รัน regression benchmark, macOS candidate gate และ Linux Docker gate ได้ด้วย:

```bash
npm run bench
npm run release:gate
npm run test:linux:docker
```

GitHub workflow รัน Node 22 และ 24 ทั้ง Linux/Windows โดยไม่ publish npm Windows จะ
ยังไม่ถูกประกาศเป็น supported platform จนกว่า automated native gate และ manual
Windows 11 acceptance จะผ่านตามเอกสาร

Release gate สร้างหลักฐาน non-secret ใน ignored `release-evidence/` และตรวจ fresh
exact-tarball ผ่าน STDIO Full กับ HTTP/OAuth Compact โดยไม่ publish npm ดูรายละเอียดที่
[DodoBench และ Release Gate](docs/EVALUATION.md)

เมื่อทั้งสอง report มาจาก Git revision และ `package-lock.json` เดียวกัน ให้รวมหลักฐาน
บน macOS ด้วย `node scripts/release-gate.mjs --release --platform-evidence /absolute/path/to/linux/gate-report.json`
คำสั่งนี้ไม่ publish package

```bash
npm ci
npm run build
npm run typecheck
npm run lint
npm run test:all
npm pack
```

โปรเจกต์นี้ใช้ GitHub repository [arthittakun/dodo-mcp](https://github.com/arthittakun/dodo-mcp) และ package `dodo-mcp`
