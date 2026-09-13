# DODO MCP 1.0.0 — Delivery Summary

DODO MCP เป็น local-first, single-owner, project-scoped coding MCP server สำหรับให้ AI อ่าน วิเคราะห์ แก้ไข และทดสอบ software ใน workspace ของเจ้าของ

## สิ่งที่ส่งมอบ

- package `dodo-mcp` และ CLI `dodo`
- HTTP MCP ที่ loopback พร้อม OAuth 2.1, PKCE และ owner-controlled consent
- Local Config ที่ loopback พร้อม workspace switching จริง
- Full, Compact และ Hybrid tool surfaces
- 74 full tools, 19 compact tools และ 49 hybrid tools
- journaled changes, expected hash, conflict protection และ rollback
- workspace ACL, trust modes, local approvals และ audit history
- bounded jobs, parallel commands, Git, semantic intelligence และ external LSP
- assistance, multimodal, browser, game, workflow และ scheduling integrations
- cross-platform setup probes และ Windows development plan
- test, packaging และ documentation workflow สำหรับ release ที่ตรวจสอบซ้ำได้

## คำสั่งหลัก

```bash
npm install -g dodo-mcp
dodo setup --check
dodo doctor
cd /path/to/project
dodo trust --mode edit
dodo start
```

## Tool surfaces

HTTP เปิด Compact เป็นค่าเริ่มต้นเพื่อลด schema load และให้ AI ค้น operation ผ่าน `dodo_discover` ส่วน STDIO เปิด Full เป็นค่าเริ่มต้นเพื่อคง compatibility กับ local coding clients สามารถเลือก surface ด้วย `--tools compact|full|hybrid`

Surface เป็นเรื่องการ expose tools เท่านั้น ไม่เปลี่ยน OAuth scope, workspace ACL, trust, approval หรือ path policy

## Upgrade policy

`1.0.0` เป็น baseline แรกของ DODO MCP การเปลี่ยนต่อไปควร bump version ตาม semver และบันทึกใน release notes ของรุ่นปัจจุบันเท่านั้น ผู้ใช้ควร restart process และ rescan MCP catalog ตามข้อกำหนดของ client หลังติดตั้ง package ใหม่
