# DODO MCP

**DODO MCP 1.0.0** คือ MCP server แบบ local-first สำหรับให้ AI ช่วยพัฒนา software โดยทำงานกับ workspace ที่เจ้าของเลือก ใช้ OAuth, workspace ACL, trust policy และ file/secret guards เป็นชั้นความปลอดภัยหลัก

## จุดเด่น

- MCP ผ่าน HTTP ที่ `127.0.0.1:21730/mcp` พร้อม OAuth และ PKCE
- Local Config แบบ loopback ที่ `127.0.0.1:21731`
- HTTP ใช้ Compact Tool Surface 19 tools เพื่อลดภาระการโหลด schema
- STDIO ใช้ Full Tool Surface 74 tools เป็นค่าเริ่มต้น
- Hybrid Surface 49 tools สำหรับ client ที่รับ catalog ขนาดกลาง
- อ่าน ค้นหา สร้าง แก้ ย้าย ลบไฟล์ พร้อม expected hash, journal และ rollback
- รันคำสั่ง งานแบบขนาน jobs, Git, TypeScript/JavaScript intelligence, LSP และ task assistance
- รองรับภาพ เสียง วิดีโอ เบราว์เซอร์ เกม และ workflow ตาม dependency และ permission ที่เจ้าของเปิดใช้
- เปลี่ยน workspace จาก Local Config ได้จริง โดยรอ request/jobs และ rollback เมื่อเตรียม workspace ใหม่ไม่สำเร็จ
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
- **Public MCP:** origin HTTPS ของ tunnel ที่เจ้าของจัดการเองและ route ทุก path มายัง MCP listener
- **Local Config:** loopback เท่านั้น ใช้ owner capability token และ Host/Origin checks

DODO ไม่รายงาน tunnel หรือสถานะ client ว่าออนไลน์ หากไม่มีหลักฐานจาก request จริง

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
