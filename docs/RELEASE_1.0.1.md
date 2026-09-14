# DODO MCP 1.0.1

Patch release นี้ปรับความน่าเชื่อถือของ platform/release gates โดยไม่เปลี่ยน runtime
หรือ API contract จาก 1.0.0 ระบบ multi-project, AI provider/profile, owner web workspace
และ Sub-agent controls ยังคงทำงานตาม contract เดิม และไม่เปลี่ยน security authority
ของ OAuth, project ACL, workspace ID/epoch, trust, approval, path/secret guard,
expected hash หรือ command sandbox

## สิ่งที่เปลี่ยน

- เพิ่ม Linux media, tunnel credential และ gate-evidence regression tests
- ทำ source fingerprint และ persistent Windows checkout ให้ deterministic แม้ runner
  เคยใช้ CRLF policy ต่างจาก repository
- ตรวจ canonical tracked bytes และ clean index ก่อนเริ่ม Windows gate
- เก็บ sanitized gate summary ใน log เมื่อ GitHub artifact quota เต็ม โดยไม่ทำให้
  artifact upload กลายเป็นตัวตัดสินผล test

## ติดตั้งและอัปเดต

```bash
npm install -g dodo-mcp@1.0.1
dodo --version
```

หลังอัปเดตให้ restart process ที่กำลังรันอยู่ และให้ MCP client rescan/recreate connection
หาก client เก็บ tool catalog เดิมไว้

## Tool surface

- HTTP ใช้ Compact 19 tools เป็นค่าเริ่มต้น
- STDIO ใช้ Full 121 tools เป็นค่าเริ่มต้น
- เมื่อเจ้าของเปิด Sub-agent MCP exposure แล้ว Full เป็น 125 tools
- Hybrid คง 49 tools

การซ่อนหรือเปิด Sub-agent operations เปลี่ยนเฉพาะ catalog exposure ไม่เพิ่ม OAuth scope,
project ACL, trust, profile authority หรือ approval

## ผลตรวจอัตโนมัติ

- macOS Node 22: core 669 ผ่าน, packaging 16/16, audit 0, benchmark 7/7 และ fresh install ผ่าน
- Windows native Node 22 และ 24: core 671 ผ่านต่อรุ่น, packaging 16/16, audit 0,
  benchmark 7/7 และ fresh install ผ่าน
- Linux Docker ใช้หลักฐาน gate ที่ผ่านก่อนหน้า; release follow-up นี้ไม่ได้รัน Linux ซ้ำ

ผล live provider, external MCP client และ Windows desktop permission จริงยังเป็น
`MANUAL_NOT_RUN` จนกว่าเจ้าของจะทดสอบด้วย credential และ environment จริง
