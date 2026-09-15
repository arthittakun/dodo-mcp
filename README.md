# DODO MCP

**DODO MCP 1.0.6** คือ MCP server แบบ local-first สำหรับให้ AI ช่วยพัฒนา software โดยทำงานกับ workspace ที่เจ้าของเลือก ค่าเริ่มต้นเป็นโหมดส่วนตัวแบบเพิ่มโปรเจกต์แล้วใช้ได้ทันที และยังมีโหมด managed สำหรับแยก workspace ACL/trust แบบละเอียด

## จุดเด่น

- MCP ผ่าน HTTP ที่ `127.0.0.1:21730/mcp` พร้อม OAuth และ PKCE
- Local Config แบบ loopback ที่ `127.0.0.1:21731` และ Remote Config ชั่วคราวผ่าน tunnel เมื่อเจ้าของสั่ง `dodo --web`
- HTTP ใช้ Compact Tool Surface 19 tools เพื่อลดภาระการโหลด schema
- STDIO ใช้ Full Tool Surface; มี capability definitions ทั้งหมด 125 รายการ แต่ค่าเริ่มต้นซ่อน Sub-agent 4 operations จาก MCP จึงเห็น 121 tools
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
- มี AI Providers เจ็ด presets/Custom, profiles, model/tool loop และประวัติ private ผ่าน Local Config ([คู่มือ](docs/AI_PROVIDERS.md))
- เขียน/รันหลายโปรเจกต์พร้อมกันด้วย targetProjectId และคิว mutation แยกโปรเจกต์
- มี DodoBench และ revision-bound release gate สำหรับ retrieval, safe edit, runtime, resource, recovery, security และ fresh package artifact
- เปลี่ยน workspace จาก Local Config ได้จริง โดยรอ request/jobs และ rollback เมื่อเตรียม workspace ใหม่ไม่สำเร็จ
- มี owner-only Project Registry พร้อม stable project ID และ readiness โดยไม่คัดลอก trust/ACL
- อ่าน overview/list/files และค้นหาพร้อมกันได้สูงสุด 8 โปรเจกต์ที่เจ้าของลงทะเบียน โดย personal mode ไม่ต้องตั้ง ACL ซ้ำ
- เปิด Cloudflare Tunnel พร้อม `dodo start` ด้วย token ชั่วคราวจาก terminal หรือ Local Config โดยไม่บันทึก token ลงเครื่อง
- ไม่ส่ง token, secret หรือ state DB ไปที่ repository และไม่ให้ repository config เพิ่มสิทธิ์

## เริ่มใช้งาน

```bash
npm install -g dodo-mcp
dodo setup --check
dodo --cli
```

### Android / Termux (ทดลองใช้)

DODO 1.0.6 ไม่โหลด Sharp ตั้งแต่เริ่ม CLI อีกต่อไป จึงใช้คำสั่งพื้นฐานและ MCP
สำหรับ text/code ได้แม้เครื่องไม่มี native Sharp build แพ็กเกจมี WebAssembly image backend
เป็น optional dependency; หาก npm ข้าม optional dependency ให้ติดตั้งเพิ่มแล้วเปิด DODO ใหม่:

```bash
npm install -g dodo-mcp@latest @img/sharp-wasm32@0.35.4
dodo --version
```

หาก image backend ยังไม่พร้อม เฉพาะเครื่องมือภาพจะตอบ `NOT_SUPPORTED` โดย CLI และ
เครื่องมือ coding ส่วนอื่นยังเริ่มได้ Android/Termux ยังเป็นสถานะทดลองใช้: installer,
OS credential store, sandbox, desktop control และ browser automation ยังไม่ได้ผ่าน
Android acceptance ครบ ดูข้อจำกัดและวิธีตรวจรับที่ [Android / Termux](docs/ANDROID.md)

## เชื่อม ChatGPT ภายในไม่กี่นาที

ChatGPT ต้องเชื่อมผ่าน **Public MCP URL** ของ DODO ซึ่งลงท้ายด้วย `/mcp` ส่วน
`https://chatgpt.com/connector_platform_oauth_redirect` เป็น **OAuth callback**
สำหรับลงทะเบียน client เท่านั้น ไม่ใช่ MCP Server URL

ก่อนเริ่มให้อัปเดต CLI แล้วตั้ง Cloudflare Tunnel ของ DODO โดยแทน
`https://dodo.example.com` ด้วย public hostname ของคุณ Tunnel ต้อง route ทุก path
ไปที่ `http://127.0.0.1:21730`

```bash
npm install -g dodo-mcp@latest
dodo --version
dodo tunnel configure \
  --tunnel \
  --public-url https://dodo.example.com \
  --os-credential
```

ลงทะเบียน static OAuth client ด้วยคำสั่งด้านล่าง คัดลอกคำสั่งตรงจาก code block
โดยไม่เติม `\` หน้า `--` และไม่ครอบ URL ด้วยรูปแบบ Markdown `[ข้อความ](URL)`:

```bash
dodo auth add-client \
  --name "ChatGPT" \
  --redirect-uri "https://chatgpt.com/connector_platform_oauth_redirect"
```

คำสั่งจะแสดง `client_id` และ `client_secret` ครั้งเดียว ให้เก็บไว้ในหน้าตั้งค่า
ChatGPT เท่านั้น ห้ามส่งลงแชต, issue หรือ Git จากนั้นเปิด DODO ค้างไว้:

```bash
dodo start
```

ใน ChatGPT web ให้เปิด **Settings → Security and login → Developer mode** แล้วไปที่
[ChatGPT Plugins](https://chatgpt.com/plugins) กด `+` และกรอก:

- **MCP Server URL:** `https://dodo.example.com/mcp`
- **Authentication:** `OAuth`
- **OAuth Client ID / Secret:** ค่าที่ได้จาก `dodo auth add-client`

เมื่อกด Connect/Create/Scan Tools และหน้า authorization กำลังรอ ให้เปิด terminal
อีกหน้าต่างเพื่อตรวจ request แล้วอนุมัติ ID ที่ตรงกับหน้า browser:

```bash
dodo auth pending
dodo auth approve REQUEST_ID
```

กลับไปที่ ChatGPT รอให้ scan เสร็จ เริ่มแชตใหม่ เลือก DODO ใน Developer mode แล้ว
ทดสอบด้วย `ใช้ DODO เรียก project_overview` HTTP จะแสดง Compact surface ประมาณ 19
tools และเข้าถึง operations ที่เหลือผ่าน `dodo_discover` กับ gateway ตามสิทธิ์เดิม

ดูขั้นตอนเต็มและวิธีแก้ OAuth/Tunnel ที่ [เชื่อม Web clients](docs/WEB_CLIENTS.md)

`dodo --cli` เปิดเมนู local owner สำหรับเลือก/เพิ่มโปรเจกต์ เปิด MCP + Local Config +
Tunnel, เปิด Remote Config ชั่วคราว 1 ชั่วโมง และรัน setup รวม `cloudflared` โดยไม่ต้อง
`cd` เข้าโปรเจกต์
ก่อน หากเรียก `dodo` หรือ `dodo start` จากโฟลเดอร์ใดก็ตาม ระบบจะเปิดโปรเจกต์ที่
เจ้าของเลือกล่าสุด หากยังไม่มีโปรเจกต์ใน registry จะเปิด control plane, OAuth และ
authenticated tool catalog ได้โดยไม่ใช้ CWD เป็น workspace เมื่อเจ้าของเพิ่มโปรเจกต์
จาก Local Config แล้ว OAuth client ที่เจ้าของอนุมัติจะใช้โปรเจกต์นั้นได้ทันทีตาม scopes
ของ token และ Agent Profile ที่เลือก โดยไม่ต้องตั้ง permission ซ้ำต่อ path

เปิดโปรเจกต์โดยตรงและจำไว้สำหรับครั้งถัดไปได้ด้วย:

```bash
dodo start --root /path/to/your/project
```

โหมดส่วนตัวใช้ effective trust แบบ trusted กับโปรเจกต์ที่เจ้าของลงทะเบียน คำสั่งจึงรัน
ด้วยสิทธิ์ OS ของบัญชีเจ้าของและยังผ่าน command sandbox ที่ตั้งไว้, path/secret guards,
expected hash, workspace context และ OAuth scopes หากต้องแยก client/profile/trust ต่อ
โปรเจกต์ ให้เปลี่ยนเป็นโหมด managed ที่หน้า Settings

`dodo setup --check` และ `dodo setup --plan` เป็น read-only หากแผนมี dependency ที่ต้องติดตั้ง ให้ตรวจรายการก่อนแล้วจึงรัน `dodo setup --yes --components <list>` ระบบจะไม่เริ่ม installer หากไม่มี `--yes` และ `--yes` ไม่ข้าม sudo, OS permission หรือ owner consent

บน Windows ให้รัน DODO ด้วย account เดียวกับที่จะใช้งานประจำและเก็บ state บน local
NTFS หากพบ `private Windows state ACL could not be established or verified` ห้ามลด
ACL หรือลบ state เดิม ดูวิธีใช้ `DODO_CONFIG_DIR` เพื่อเริ่ม installation ใหม่อย่าง
ปลอดภัยและรายการ component ที่ต้องติดตั้งเองใน [Windows Setup](docs/WINDOWS_SETUP.md)
โดยเฉพาะ `cloudflared` ซึ่ง Windows ต้องติดตั้ง signed package จาก Cloudflare ก่อน

เมื่อ DODO ตรวจพบ config เดิมในตำแหน่งมาตรฐาน สามารถใช้ `dodo setup --import-state` เพื่อนำเข้าเฉพาะ preference ที่ปลอดภัย เช่น port, search backend, retention และ tool surface ระบบจะสร้าง installation identity ใหม่เสมอและไม่คัดลอก OAuth keys/tokens, client grants, workspace ACL, trust, approvals, schedules, public origin, web/desktop permission, executable registration หรือฐานข้อมูลเดิม ต้นฉบับจะไม่ถูกแก้ไข

เปิด Local Config จาก URL ที่ `dodo` แสดงใน terminal ใช้สำหรับเพิ่มโปรเจกต์, AI
connections/profiles, public origin และเปลี่ยน access mode เจ้าของเท่านั้น โหมดส่วนตัว
พร้อมใช้โดยไม่ต้องตั้ง trust/client/profile permission รายโปรเจกต์

หน้าเว็บจัดเป็น dashboard 8 หน้า (ภาพรวม · โปรเจกต์ · Providers & Profiles ·
Chat & Tasks · Runs & Jobs · Approvals · Knowledge · Settings) หน้าภาพรวมแสดงสถานะ,
ขั้นตอนถัดไป และสิ่งที่ต้องตรวจสอบเท่านั้น คำอธิบายยาวถูกย้ายไป tooltip (ปุ่ม `?`
เปิดด้วย hover/โฟกัสคีย์บอร์ด/แตะ ปิดด้วย Escape) และส่วน "รายละเอียดทางเทคนิค"
ที่พับได้ กล่องยืนยัน/แจ้งผลใช้ SweetAlert2 ที่ vendor มากับแพ็กเกจ (same-origin
ไม่มี CDN, CSP `'self'` เท่าเดิม) การลบ/ยกเลิก/เปลี่ยนโหมดต้องยืนยันก่อนเสมอ
และงานที่มีค่าใช้จ่ายหรือผลไม่แน่นอนจะบอกชัดว่า "ไม่ retry อัตโนมัติ"

หน้า **Settings → Sub-agent tools ใน MCP** มีสวิตช์เปิด/ปิดการ expose
`subagent_spawn`, `subagent_status`, `subagent_result` และ `subagent_control` ให้ AI
ภายนอก ค่าเริ่มต้นปิดเพื่อให้ catalog สำหรับงานทั่วไปกระชับขึ้น แต่หน้า Chat & Tasks
ยังสร้างและจัดการ agent ได้ตามเดิม เมื่อเปลี่ยนค่านี้ต้อง restart DODO แล้ว rescan หรือ
สร้าง MCP app ใหม่ตามพฤติกรรมของ client การตั้งค่านี้เปลี่ยนเฉพาะการมองเห็น tools
และไม่เพิ่ม OAuth scope, trust, approval หรือสิทธิ์ของ profile

ลงทะเบียนโปรเจกต์ที่ต้องการใช้งานบ่อยได้โดยไม่เริ่ม server:

```bash
dodo project add /absolute/path/to/project --name "Web application"
dodo project list
dodo project info prj_xxxxxxxxxxxx
dodo project remove prj_xxxxxxxxxxxx --yes
```

Project Registry ใช้ project ID คงที่แยกจาก workspace authority และแสดง readiness
ของ path ปัจจุบัน ดู contract ที่ [Project Registry](docs/PROJECTS.md)

### อ่านหลายโปรเจกต์พร้อมกัน

เจ้าของต้องลงทะเบียนแต่ละโปรเจกต์ โหมดส่วนตัวใช้ OAuth scopes เดิมกับทุก project
ที่ลงทะเบียน ส่วนโหมด managed ต้องให้ `dodo:read` แก่ client ในแต่ละ workspace:

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

Federation แบบ `projectId/projectIds` ยังคง read-only สำหรับการเขียน/รันหลายโปรเจกต์
ให้เรียก `project_overview(targetProjectId="prj_…")` แล้วใช้ `targetProjectId` และ
workspace ID/epoch ที่ได้รับกับทุก operation ต่อมา คนละโปรเจกต์ทำงานพร้อมกันได้
โดยไม่เปลี่ยน default; งาน mutation ในโปรเจกต์เดียวกันเข้าคิวร่วมกัน
ดู [การตั้ง AI Providers, Profiles และ Sub-agents ผ่านเว็บ](docs/AI_PROVIDERS.md)

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
target authority, workspace ID/epoch และ principal ownership ซ้ำ ไม่ ingest `.env`,
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
OAuth, live grant, target authority, workspace ID/epoch, path/secret policy และ SHA-256
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
OAuth scope, live target authority/epoch, trust approval, path/secret guards, expected hash,
command sandbox, idempotency และ audit เดิม `agent_exec` ใช้ explicit argv/owned handles
เท่านั้น และ cancel/pause coordinator ไม่ kill job ดู
[Advanced Agent Runtime](docs/AGENT_RUNTIME.md)

### เชื่อม Remote MCP ผ่าน Cloudflare Tunnel

DODO เลือกวิธีเชื่อมต่อระดับ installation ได้หนึ่งแบบ: `local` หรือ `tunnel` ค่าที่เลือก
มีผลกับทุก `dodo start` และไม่มี fallback อัตโนมัติ หากเลือก Tunnel แล้ว credential หรือ
readiness ไม่พร้อม DODO จะหยุด startup แทนการเปิด local โดยไม่แจ้ง

Local mode:

```bash
dodo tunnel configure --local
dodo start
```

DODO Tunnel mode:

```bash
dodo setup --check --components cloudflared
dodo tunnel configure \
  --tunnel \
  --public-url https://mcp.example.com \
  --os-credential
dodo start
```

เจ้าของสร้าง remotely-managed Tunnel, public hostname และ DNS ใน Cloudflare และ route
**ทุก path** มาที่ `http://127.0.0.1:21730` DODO ไม่จัดการ Cloudflare account/DNS
Token ถูกบันทึกใน macOS Keychain, Windows Credential Manager หรือ Linux Secret Service;
global config เก็บเพียง opaque reference ทุกครั้งที่เปิด DODO ระบบจะเริ่ม
`cloudflared` เป็น child และหยุด child พร้อม DODO Token ไม่อยู่ใน argv, config, log,
audit, browser storage, MCP response หรือ environment ของ MCP jobs

หากต้องตั้งค่าจากอุปกรณ์อื่น ให้เปิดหน้าเจ้าของแบบชั่วคราวผ่าน public listener เดียวกัน:

```bash
dodo --web          # เริ่ม DODO/Tunnel หรือเปิด lease ใหม่ให้ process ที่รันอยู่
dodo web --status   # ดูสถานะแบบไม่มี secret
dodo web --close    # ปิดหน้า Remote Config แต่ MCP/Tunnel ยังทำงาน
```

คำสั่งจะแสดง `https://mcp.example.com/config` กับ pairing code แบบใช้ครั้งเดียวใน
terminal หลังจับคู่ browser จะใช้ cookie ที่เป็น `Secure`, `HttpOnly`,
`SameSite=Strict` และจำกัด path ที่ `/config` หน้า Remote Config ปิดอัตโนมัติภายใน
1 ชั่วโมง การเปิดใหม่ออก code/session ใหม่และไม่ต้อง restart MCP ไม่มี token หรือ
credential อยู่ใน URL คำสั่งนี้ใช้ได้เฉพาะเมื่อ persistent mode เป็น `tunnel` และ
DODO-owned Tunnel กำลังทำงาน; มันไม่รับ token ใหม่ผ่าน IPC และไม่เปลี่ยนจาก Local เอง

หน้า Local Config ที่ `127.0.0.1:21731` เลือก Local/Tunnel, ตั้ง public origin และบันทึก
token แบบ write-only เข้า OS credential store ได้ ค่าใหม่มีผลหลัง restart หน้าเว็บแสดง
Active MCP URL จาก runtime จริงและไม่กล่าวว่า Tunnel หรือ AI client เชื่อมแล้วหากไม่มี
หลักฐาน ดูสถานะด้วย `dodo tunnel status`, ตรวจ connectivity ด้วย `dodo tunnel doctor`
และดู log ที่ redacted ด้วย `dodo tunnel logs`

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

ระบบไม่ kill jobs เงียบ ๆ Managed mode ไม่คัดลอก trust หรือ client ACL ไปยัง workspace ใหม่

## การเชื่อมต่อ

- **Local MCP:** `http://127.0.0.1:21730/mcp` สำหรับ process ในเครื่อง
- **Public MCP:** origin HTTPS ของ tunnel ที่เจ้าของสร้างและกำหนด route เอง; DODO อาจ supervise เฉพาะ `cloudflared` process ที่เจ้าของสั่ง
- **Local Config:** `127.0.0.1:21731` เท่านั้น ใช้ owner capability token และ Host/Origin checks
- **Remote Config:** ปิดเป็น 404 โดยค่าเริ่มต้น; เจ้าของเปิด `/config` บน public origin ได้ครั้งละไม่เกิน 1 ชั่วโมงด้วย `dodo --web`

DODO รายงาน `connected` เฉพาะเมื่อ managed `cloudflared` ตอบ readiness จริง และ `doctor` แยก local/public health ออกจากกัน สถานะนี้ไม่ใช่หลักฐานว่า ChatGPT หรือ AI client เชื่อมต่อแล้ว

## สิทธิ์

ค่าเริ่มต้น **personal** ใช้ OAuth scope + Agent Profile เป็นเพดานและไม่ถามซ้ำต่อ
โปรเจกต์ ส่วน **managed** ใช้ intersection ของ OAuth scope, workspace ACL และ local policy:

- `inspect` อ่านและวิเคราะห์ได้
- `edit` ทำ file changes ที่ผ่าน approval/policy ได้
- `trusted` อนุญาต effectful work ตาม policy ที่เจ้าของยืนยัน

โหมด trusted และคำสั่งที่เจ้าของอนุมัติใช้สิทธิ์ OS ของผู้ใช้จริง ควรเปิดเฉพาะ workspace ที่เชื่อถือได้

`dodo --bypass` ปรับ policy เฉพาะรอบนั้นตามที่เจ้าของสั่ง และไม่ปิด OAuth, target authority, workspace context, path guards หรือ secret guards

Desktop/Chrome consent แบบ `--persist` เป็นระดับ installation อนุญาตครั้งเดียวจาก path
ใดก็ได้แล้วใช้กับทุกโปรเจกต์ ส่วน macOS Screen Recording/Accessibility ยังต้องกดให้
สิทธิ์ใน System Settings จริง:

```bash
dodo desktop allow --app com.google.Chrome --mode control --persist --yes
```

## ความปลอดภัย

- public MCP ใช้ OAuth เสมอ ไม่มี NoAuth fallback
- Local Config bind loopback และมี capability token, expiration, Host/Origin checks และ rate limit; Remote Config ต้องจับคู่ด้วย code ใช้ครั้งเดียวและหมดอายุภายใน 1 ชั่วโมง
- client secret/access token ไม่แสดงใน UI หรือ audit
- path traversal, symlink/hardlink, secret paths และ stale hashes ถูกปฏิเสธ
- command environment ใช้ allowlist และไม่ส่ง local auth state ให้ child process
- repository instructions, `.dodo.json`, project hints และ AGENTS.md ไม่มีอำนาจเพิ่มสิทธิ์
- gateway ไม่ grant สิทธิ์และไม่ข้าม approval หรือ target operation policy
- CAS URI/hash ไม่ grant สิทธิ์; resource ทุก read/range/preview ตรวจ live target authority และ object hash ซ้ำ

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
- [Windows setup และ ACL troubleshooting](docs/WINDOWS_SETUP.md)
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
