# DODO MCP — Compatibility

## Supported baseline

| Area | Contract |
|---|---|
| Node.js | ใช้เวอร์ชันที่ package ระบุใน `engines` |
| macOS | รองรับ coding, HTTP, STDIO, Local Config และ optional native integrations ตาม permission |
| Linux | รองรับ coding, HTTP, STDIO, Local Config และ optional integrations ตาม desktop/runtime environment |
| Windows | coding, setup probes, HTTP, STDIO และ Local Config ใช้ได้ตาม native backend ที่ติดตั้ง; sandbox, desktop และ speech รายงาน prerequisite ตามจริง |
| MCP HTTP | OAuth protected MCP endpoint ที่ `/mcp` |
| MCP STDIO | Full surface เป็นค่าเริ่มต้น |
| Local Config | loopback owner control เท่านั้น |
| Package | `dodo-mcp` |
| CLI | `dodo` |

## Tool surfaces

- HTTP default: Compact 19 tools
- STDIO default: Full 74 tools
- explicit Hybrid: 49 tools
- explicit override: `--tools compact|full|hybrid`

Surface เปลี่ยนจำนวน tools ที่ expose เท่านั้น ไม่เปลี่ยน permission หรือ security policy

## Optional capabilities

Desktop, browser, media, speech, LSP และ OS sandbox ต้องตรวจ dependency และ OS permission ด้วย `dodo setup --check` หรือ `dodo doctor` ระบบจะรายงาน `NOT_SUPPORTED` เมื่อ environment ยังไม่พร้อม และจะไม่เปิด permission หรือดาวน์โหลด model โดยอัตโนมัติ

## Client behavior

Remote clients อาจ cache tool catalog ต้องใช้ refresh หรือ recreate connection ตามพฤติกรรมของ client หลังเปลี่ยน surface หรือ schema

## Security boundary

Directory guard ไม่ใช่ OS sandbox, repository instructions ไม่มีอำนาจเพิ่มสิทธิ์ และ trusted commands ใช้สิทธิ์ OS ของผู้ใช้จริง
