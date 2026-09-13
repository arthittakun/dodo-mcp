# DODO MCP

**DODO MCP 1.0.0** คือ MCP server แบบ local-first สำหรับให้ AI ช่วยพัฒนา software โดยทำงานกับ workspace ที่เจ้าของเลือก ใช้ OAuth, workspace ACL, trust policy และ file/secret guards เป็นชั้นความปลอดภัยหลัก

## จุดเด่น

- MCP ผ่าน HTTP ที่ `127.0.0.1:21730/mcp` พร้อม OAuth และ PKCE
- Local Config แบบ loopback ที่ `127.0.0.1:21731`
- HTTP ใช้ Compact Tool Surface 19 tools เพื่อลดภาระการโหลด schema
- STDIO ใช้ Full Tool Surface 86 tools เป็นค่าเริ่มต้น
- Hybrid Surface 49 tools สำหรับ client ที่รับ catalog ขนาดกลาง
- อ่าน ค้นหา สร้าง แก้ ย้าย ลบไฟล์ พร้อม expected hash, journal และ rollback
- รันคำสั่ง งานแบบขนาน jobs, Git, TypeScript/JavaScript intelligence, LSP และ task assistance
- รองรับภาพ เสียง วิดีโอ เบราว์เซอร์ เกม และ workflow ตาม dependency และ permission ที่เจ้าของเปิดใช้
- มี Universal Resource Layer + CAS สำหรับ text/binary/image/audio/video/PDF/ZIP/WASM พร้อม SHA-256, dedup, bounded range/resume และ MCP image/audio blocks
- มี Project Brain ที่ทำ incremental AST index สำหรับ symbols, references, imports, routes, tests และ dependencies พร้อม source-hash freshness
- เปลี่ยน workspace จาก Local Config ได้จริง โดยรอ request/jobs และ rollback เมื่อเตรียม workspace ใหม่ไม่สำเร็จ
- มี owner-only Project Registry พร้อม stable project ID และ readiness โดยไม่คัดลอก trust/ACL
- อ่าน overview/list/files และค้นหาพร้อมกันได้สูงสุด 8 โปรเจกต์ที่เจ้าของลงทะเบียนและให้ ACL แล้ว โดยไม่สลับ active workspace
- ตรวจและเลือกใช้ Cloudflare Tunnel แบบ external หรือ DODO-managed โดย token อยู่ใน OS credential store/secure reference และการ start ต้องยืนยันทุกครั้ง
- ไม่ส่ง token, secret หรือ state DB ไปที่ repository และไม่ให้ repository config เพิ่มสิทธิ์

## เริ่มใช้งาน

```bash
npm install -g dodo-mcp
dodo setup --check
cd /path/to/your/project
dodo trust --mode edit
dodo start
```

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

### เชื่อม Remote MCP ผ่าน Cloudflare Tunnel

DODO ไม่สร้าง Tunnel, DNS หรือ Cloudflare account ให้ ผู้ใช้สร้าง remotely-managed Tunnel และตั้ง public hostname ให้ route **ทุก path** มาที่ `http://127.0.0.1:21730` ก่อน จากนั้นเลือกได้สองโหมด:

```bash
# ให้ system service/เจ้าของรัน cloudflared เอง
dodo tunnel configure --external

# หรือให้ DODO ดูแลเฉพาะ process cloudflared ใน foreground
dodo setup --check --components cloudflared
dodo tunnel configure --managed --os-credential
dodo tunnel start --yes
```

`--os-credential` ใช้ macOS Keychain, Windows Credential Manager หรือ Linux Secret Service และ config เก็บเพียง opaque reference สำหรับ headless environment ใช้ `--token-env NAME` หรือ `--token-file /absolute/private/path` ค่า token ไม่อยู่ใน argv, config, tunnel log หรือ MCP response ดูสถานะด้วย `dodo tunnel status`, ตรวจ connectivity ด้วย `dodo tunnel doctor` และดู log ที่ redacted ด้วย `dodo tunnel logs`

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
- [Manual acceptance](docs/MANUAL_ACCEPTANCE.md)
- [Test report](docs/TEST_REPORT.md)

## Development

```bash
npm ci
npm run build
npm run typecheck
npm run lint
npm run test:all
npm pack
```

โปรเจกต์นี้ใช้ GitHub repository [arthittakun/dodo-mcp](https://github.com/arthittakun/dodo-mcp) และ package `dodo-mcp`
