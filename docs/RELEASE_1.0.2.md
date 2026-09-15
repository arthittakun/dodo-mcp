# DODO MCP 1.0.2

Patch release นี้เพิ่ม Temporary Remote Config สำหรับเจ้าของที่ต้องการเปิดหน้า Config
ผ่าน Cloudflare Tunnel ชั่วคราว โดยคง Local Config ที่พอร์ต 21731 ไว้บน loopback และ
คง MCP/OAuth ที่พอร์ต 21730 ตามเดิม

## สิ่งที่เปลี่ยน

- เพิ่ม `dodo --web`, `dodo web --status` และ `dodo web --close`
- เปิด `/config` บน public listener ครั้งละไม่เกินหนึ่งชั่วโมงและปิดเป็น 404 เมื่อไม่มี
  lease, หลังปิด หรือเมื่อหมดอายุ
- ใช้ pairing code แบบครั้งเดียวกับ session cookie ที่เป็น Secure, HttpOnly,
  SameSite=Strict และจำกัด path ที่ `/config`
- ต่ออายุ Remote Config ผ่าน authenticated owner IPC ได้โดยไม่ restart MCP
- รองรับการส่ง temporary Cloudflare Tunnel token ไปยัง process ที่รันอยู่ผ่าน private
  IPC โดยไม่เก็บ token ลง config, audit, URL หรือ command arguments
- เพิ่มเมนู Temporary Remote Config ใน `dodo --cli` พร้อม security, integration,
  browser และ packaging coverage

## ขอบเขตความปลอดภัย

Remote Config ไม่เพิ่ม OAuth scope, project ACL, trust หรือ approval และไม่เพิ่ม MCP
tool สำหรับเปิดหน้า owner เส้นทาง public จะ proxy ไปยัง Local Config ด้วย capability
ภายใน process หลังผ่าน pairing/session เท่านั้น พร้อมคง Host/Origin, workspace/epoch,
validation, policy และ audit ของ Local Config

## ติดตั้งและอัปเดต

```bash
npm install -g dodo-mcp@1.0.2
dodo --version
```

หลังอัปเดตให้ restart DODO process ที่กำลังรันอยู่ จากนั้นใช้ `dodo --web` เมื่อ public
origin และ tunnel route พร้อมใช้งาน

## ผลตรวจ

- `npm run test:all`: **AUTOMATED_PASS** — 677 passed, 34 skipped, 0 failed;
  packaging 16/16
- Chromium desktop 1440×900 และ mobile 390×844: **AUTOMATED_PASS** ใน fixture
- `npm audit --omit=dev`: **AUTOMATED_PASS** — 0 vulnerabilities
- public Cloudflare hostname → Remote Config จากอุปกรณ์ภายนอก: **MANUAL_NOT_RUN**

ผลจาก automated fixture ไม่ยืนยันสถานะ DNS, Tunnel หรือการเชื่อมต่อจาก AI client
ของเจ้าของ
