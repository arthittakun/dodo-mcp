# DODO MCP — Compatibility

## Supported baseline

| Area | Contract |
|---|---|
| Node.js | ใช้เวอร์ชันที่ package ระบุใน `engines` |
| macOS | รองรับ coding, HTTP, STDIO, Local Config และ optional native integrations ตาม permission |
| Linux | รองรับ coding, HTTP, STDIO, Local Config และ optional integrations ตาม desktop/runtime environment |
| Windows | Deferred — มี candidate code/tests แต่ยังไม่ประกาศ native support จนกว่าจะผ่าน Windows 11 จริง |
| Android / ADB | ควบคุม physical device/emulator จาก macOS/Linux/Windows/Termux ได้เมื่อ Platform-Tools พร้อมและเจ้าของอนุญาต exact serial |
| Android / Termux host | Experimental — core CLI และ text/code MCP เริ่มได้โดยไม่บังคับ Sharp; optional integrations ต้องตรวจแยก |
| MCP HTTP | OAuth protected MCP endpoint ที่ `/mcp` |
| MCP STDIO | Full surface เป็นค่าเริ่มต้น |
| Local Config | loopback owner control ที่ 21731; เปิด bounded Remote Config `/config` ผ่าน 21730 ได้ครั้งละไม่เกิน 1 ชั่วโมง |
| Cloudflare | เลือก persistent `local` (loopback), `external` (Cloudflare Local ที่เจ้าของรันเอง) หรือ `tunnel` (DODO ดูแล process); credential ใช้เฉพาะ `tunnel` และอยู่ใน OS store/reference |
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

- HTTP default: Compact 20 tools
- STDIO default: Full 134 tools; เปิด Sub-agent MCP exposure แล้วเป็น 138
- explicit Hybrid: 49 tools

Complete capability schema มี 138 operations ค่าเริ่มต้น `exposeSubagentsToMcp=false`
ซ่อน `subagent_spawn/status/result/control` จาก MCP เท่านั้น หน้าเว็บ Chat & Tasks ยัง
ใช้ได้ Compact/Hybrid คงจำนวน 20/49 tool names แต่กรอง operation enum, instructions
และ discover index ให้ตรงกับ live runtime หลังเปลี่ยนค่าต้อง restart และให้ client
โหลด catalog ใหม่
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

Android ADB family มี 13 operations ใน Full และรวมอยู่ใน `dodo_mobile` ของ Compact
owner ต้องอนุญาต exact serial แบบ view/control ผ่าน Local Config หรือ `dodo android`
ก่อน Pair/connect/root และ ADB server management ไม่อยู่ใน MCP catalog ส่วน install/push
ใช้ expected SHA-256 และ private staging ตาม shared workspace guards

## Optional capabilities

Desktop, browser, media, speech, LSP และ OS sandbox ต้องตรวจ dependency และ OS permission ด้วย `dodo setup --check` หรือ `dodo doctor` ระบบจะรายงาน `NOT_SUPPORTED` เมื่อ environment ยังไม่พร้อม และจะไม่เปิด permission หรือดาวน์โหลด model โดยอัตโนมัติ

บน Android/Termux แพ็กเกจ Sharp ไม่มี native prebuild โดยตรง DODO จึงโหลด raster
backend เฉพาะเมื่อเรียก image operation และมี `@img/sharp-wasm32` เป็น optional
dependency หาก optional install ไม่สำเร็จ CLI/text/code ยังคงทำงาน ส่วน image
operation ตอบ `NOT_SUPPORTED` Android installer, secure credential store, sandbox,
desktop และ browser ยังไม่ถือว่ารองรับจนกว่าจะมี platform acceptance แยก

`dodo setup --plan` ใช้ตรวจขั้นตอนติดตั้งแบบ read-only ส่วน installer ต้องมี `--yes` การใช้ `--import-state` รองรับเฉพาะ config ตำแหน่งมาตรฐานและนำเข้า non-authority preferences เท่านั้น custom `DODO_CONFIG_DIR` ไม่ถูกค้นหรือ merge อัตโนมัติ

`dodo setup --components cloudflared` ตรวจ executable ได้ทุก OS การติดตั้งอัตโนมัติ
รองรับ Homebrew บน macOS ส่วน Linux/Windows ใช้ signed official package ที่เจ้าของติดตั้งเอง
โหมด Cloudflare Local ต้องมี public origin แต่ไม่รับ credential และไม่ supervise
`cloudflared` โหมด DODO Tunnel ต้องมี public origin และ credential reference ที่ผ่านการตรวจแล้ว ค่า
`--os-credential` ใช้ macOS Keychain, Windows Credential Manager หรือ Linux Secret
Service ส่วน env/file references มีไว้สำหรับ owner-controlled headless environment

Windows state ค่าเริ่มต้นอยู่ที่ `%LOCALAPPDATA%\dodo` และต้องผ่าน owner/DACL/reparse
checks บน local NTFS การปฏิเสธ ACL ไม่ใช่ dependency failure และห้ามแก้ด้วย permissive
ACL ดูขั้นตอน diagnosis และ fresh-state fallback ที่ [WINDOWS_SETUP.md](WINDOWS_SETUP.md)

## Client behavior

Remote clients อาจ cache tool catalog ต้องใช้ refresh หรือ recreate connection ตามพฤติกรรมของ client หลังเปลี่ยน surface หรือ schema

## Security boundary

Directory guard ไม่ใช่ OS sandbox, repository instructions ไม่มีอำนาจเพิ่มสิทธิ์ และ trusted commands ใช้สิทธิ์ OS ของผู้ใช้จริง

## Evaluation evidence

DodoBench local fixture ใช้ยืนยัน contract บน platform/revision ที่ report ระบุเท่านั้น
ผลของ macOS ไม่แทน Linux และ Linux ไม่แทน Windows native Release gate ต้องมี
หลักฐาน macOS local และ Linux native CI ที่ clean revision/source fingerprint/lock digest ตรงกัน
Dedicated self-hosted GitHub Actions รัน Linux และ Windows โดยตรงบน Node 22/24
ไม่ใช้ Docker; ตรวจ Chromium sandbox และ media dependencies บน Linux ก่อนรันทดสอบ
Workflow รับเฉพาะ trusted main/manual ดู [CI](CI.md) สำหรับ prerequisites และการสั่งรัน
Windows manual acceptance ยังคง `MANUAL_NOT_RUN` จนกว่าจะทดสอบบน Windows 11 จริง

## AI Providers / Multi-project

Full เพิ่ม `subagent_spawn/status/result/control` เป็น 125 tools Compact ยังคง 19 และ
Hybrid 49 โดยใช้ assist gateways เดิม Full/Compact รองรับ optional `targetProjectId`
STDIO default ยัง Full; HTTP default ยัง Compact Refresh/recreate MCP app ตาม client
เพื่อรับ schema ใหม่ รัน `project_overview` ใหม่ก่อนใช้ epoch หลัง restart

Protocol fixtures ครอบคลุม Responses, Gemini Interactions, Anthropic, Chat Completions
และ Ollama Native ทั้งเจ็ด presets ซึ่งไม่เท่ากับ live API/model compatibility ของแต่ละ
account Session credentials ใช้ได้โดยไม่ต้อง Keychain; persistent Keychain ตรวจบน macOS
Linux Docker และ live providers ต้องดูผลแยกใน TEST_REPORT ไม่ใช้ผล macOS แทน
