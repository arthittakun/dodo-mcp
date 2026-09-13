# DODO MCP — Compatibility

## Supported baseline

| Area | Contract |
|---|---|
| Node.js | ใช้เวอร์ชันที่ package ระบุใน `engines` |
| macOS | รองรับ coding, HTTP, STDIO, Local Config และ optional native integrations ตาม permission |
| Linux | รองรับ coding, HTTP, STDIO, Local Config และ optional integrations ตาม desktop/runtime environment |
| Windows | Deferred — มี candidate code/tests แต่ยังไม่ประกาศ native support จนกว่าจะผ่าน Windows 11 จริง |
| MCP HTTP | OAuth protected MCP endpoint ที่ `/mcp` |
| MCP STDIO | Full surface เป็นค่าเริ่มต้น |
| Local Config | loopback owner control เท่านั้น |
| Cloudflare Tunnel | external mode ทุก OS; managed process ใช้ OS credential provider และต้องมี `cloudflared` ที่ตรวจพบ |
| Package | `dodo-mcp` |
| CLI | `dodo` |

Project Registry ใช้ได้ผ่าน `dodo project add/list/info/remove` และ private Local
Config โดยไม่เปลี่ยนพฤติกรรม `dodo start --root PATH` หรือ single-workspace STDIO

Read-only multi-project federation ใช้ tools เดิมโดยเพิ่ม optional `projectId` ใน
overview/list/read/search และ `projectIds` สูงสุด 8 รายการใน search จึงไม่เปลี่ยน
จำนวนหรือชื่อ tool ของ Full/Compact/Hybrid HTTP remote client ต้องมี installation
identity และ `dodo:read` ACL ในทุก target; STDIO local owner ใช้ registry เดียวกัน
Effectful tools และ jobs ยังทำงานใน active workspace เดียว

## Tool surfaces

- HTTP default: Compact 19 tools
- STDIO default: Full 121 tools (Core 104 + Advanced Agent Runtime 17)
- explicit Hybrid: 49 tools
- explicit override: `--tools compact|full|hybrid`

Surface เปลี่ยนจำนวน tools ที่ expose เท่านั้น ไม่เปลี่ยน permission หรือ security policy

Project Brain รุ่นแรกใช้ bundled TypeScript 5.9 AST provider สำหรับ TypeScript,
TSX, JavaScript และ JSX พร้อมอ่าน dependency metadata จาก `package.json` ภาษาอื่น
ยังใช้ semantic/LSP tools เดิม และ Project Brain จะไม่อ้างว่ามี parser graph หากยัง
ไม่มี provider ที่ประกาศรองรับ

Context Engine ใช้ lexical/Project Brain/Git สำหรับ active workspace, guarded lexical
federation สำหรับ project อื่น, owner-reviewed current Memory และ caller-scoped current
Runtime Intelligence evidence ตาม live ACL Runtime process ใช้ executable/sandbox
support ของ JobManager ปัจจุบัน ส่วน browser evidence ต้องมี Playwright Chromium และ
owned browser session เดิม Compact/Hybrid ยังคง 19/49 tools

Advanced Agent Runtime ใช้ SQLite และ invocation pipeline เดิมทุก platform Managed
exec ต้องใช้ explicit argv และ executable ที่ JobManager รองรับ ส่วน browser/desktop/
media/workflow ขึ้นกับ optional capability ของ platform เช่นเดิม

## Optional capabilities

Desktop, browser, media, speech, LSP และ OS sandbox ต้องตรวจ dependency และ OS permission ด้วย `dodo setup --check` หรือ `dodo doctor` ระบบจะรายงาน `NOT_SUPPORTED` เมื่อ environment ยังไม่พร้อม และจะไม่เปิด permission หรือดาวน์โหลด model โดยอัตโนมัติ

`dodo setup --plan` ใช้ตรวจขั้นตอนติดตั้งแบบ read-only ส่วน installer ต้องมี `--yes` การใช้ `--import-state` รองรับเฉพาะ config ตำแหน่งมาตรฐานและนำเข้า non-authority preferences เท่านั้น custom `DODO_CONFIG_DIR` ไม่ถูกค้นหรือ merge อัตโนมัติ

`dodo setup --components cloudflared` ตรวจ executable ได้ทุก OS การติดตั้งอัตโนมัติในรุ่นนี้รองรับ Homebrew บน macOS ส่วน Linux/Windows ใช้ signed official package ที่เจ้าของติดตั้งเอง Managed mode ใช้ macOS Keychain, Windows Credential Manager หรือ Linux Secret Service; headless environment ใช้ owner-selected env/file reference

## Client behavior

Remote clients อาจ cache tool catalog ต้องใช้ refresh หรือ recreate connection ตามพฤติกรรมของ client หลังเปลี่ยน surface หรือ schema

## Security boundary

Directory guard ไม่ใช่ OS sandbox, repository instructions ไม่มีอำนาจเพิ่มสิทธิ์ และ trusted commands ใช้สิทธิ์ OS ของผู้ใช้จริง

## Evaluation evidence

DodoBench local fixture ใช้ยืนยัน contract บน platform/revision ที่ report ระบุเท่านั้น
ผลของ macOS ไม่แทน Linux และ Linux Docker ไม่แทน Windows native ช่วงนี้ release gate
ต้องมีหลักฐาน macOS local และ Linux Docker ที่ revision/lock digest ตรงกัน Docker image
ติดตั้ง Playwright Chromium เพื่อรัน browser case จริง โครงการไม่ใช้ GitHub Actions
เป็น test runner ส่วน Windows คง `MANUAL_NOT_RUN` จนถึง phase สุดท้าย
