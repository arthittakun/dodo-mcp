# DODO MCP 1.0.5

รุ่น 1.0.5 เพิ่มคู่มือเชื่อม DODO กับ ChatGPT ที่ทำตามได้จากหน้าแรกของโปรเจกต์
และขยายเอกสาร Web Clients โดยไม่เปลี่ยน runtime หรือ security model

## การเปลี่ยนแปลง

- เพิ่ม Quick Start สำหรับ ChatGPT ใน README
- ระบุว่า Public MCP URL ต้องลงท้ายด้วย `/mcp`
- ระบุว่า `https://chatgpt.com/connector_platform_oauth_redirect` เป็น OAuth callback
  สำหรับ `dodo auth add-client` ไม่ใช่ MCP Server URL
- เพิ่มขั้นตอนเปิด Developer mode, กรอก static OAuth credentials, scan tools และ
  อนุมัติผ่าน `dodo auth pending` / `dodo auth approve REQUEST_ID`
- เพิ่ม troubleshooting สำหรับ Tunnel route, OAuth discovery, callback mismatch,
  pending request และ client tool cache

## อัปเดต

```bash
npm install -g dodo-mcp@1.0.5
dodo --version
```

หลังอัปเดตให้ restart DODO แล้ว Refresh หรือสร้าง MCP connection ใน ChatGPT ใหม่
เมื่อ client ยังเก็บ catalog หรือ metadata เดิม

## Security

รุ่นนี้ไม่ลด OAuth, target/workspace authority, trust, approvals, path/secret guards,
expected-hash protection, command sandbox หรือ Tunnel credential policy คู่มือย้ำว่า
ห้ามส่ง client secret, OAuth token, Tunnel token หรือ Local Config URL ลง chat และ
ให้ตรวจ request ID/วลีบน browser ก่อน owner อนุมัติ

## Verification

Automated release gate ตรวจ source, packaging และ fresh tarball install แยกจาก manual
ChatGPT acceptance การเห็นคู่มือหรือผ่าน server tests ไม่ถือว่า ChatGPT live connection
ผ่านจนกว่าจะเชื่อม public hostname และทำ OAuth/tool call จริง
