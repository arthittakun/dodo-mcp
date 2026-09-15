# DODO MCP 1.0.3

รุ่น 1.0.3 เปลี่ยนการเลือก MCP endpoint ให้เป็นค่า installation แบบถาวรและเลือกได้
เพียงหนึ่งโหมด: `local` หรือ `tunnel`

## พฤติกรรมใหม่

- Local ใช้ `http://127.0.0.1:21730/mcp` เป็น MCP/OAuth endpoint และไม่เริ่ม
  `cloudflared`
- Tunnel ใช้ public HTTPS origin เป็น MCP/OAuth endpoint หลัก และ DODO เริ่ม/หยุด
  process-owned `cloudflared` พร้อม `dodo start`
- Tunnel fail closed เมื่อ public origin, credential, executable หรือ readiness ไม่พร้อม
  โดยไม่ย้อนกลับไปใช้ Local
- Local Config แสดง Active MCP URL จาก runtime จริงและเปลี่ยนโหมดสำหรับการ restart
  ครั้งถัดไปได้
- Cloudflare Tunnel token เป็น write-only และอยู่ใน reviewed OS credential store หรือ
  owner-controlled environment/private-file reference; token ไม่อยู่ใน config, URL,
  process arguments, log หรือ browser storage
- Remote Config ผ่าน `/config` เปิดได้ครั้งละไม่เกินหนึ่งชั่วโมง เฉพาะตอน persistent
  Tunnel ทำงานอยู่

## อัปเดต

```bash
npm install -g dodo-mcp@1.0.3
dodo --version
```

เลือก Local:

```bash
dodo tunnel configure --local
dodo start
```

เลือก Tunnel:

```bash
dodo tunnel configure \
  --tunnel \
  --public-url https://YOUR-DODO-HOST \
  --os-credential
dodo start
```

การอัปเดตไม่เปิด Tunnel เอง Config เดิมที่ใช้ managed credential จะ migrate เป็น Tunnel
ส่วน config เดิมรูปแบบอื่น migrate เป็น Local เพื่อไม่เพิ่มการเปิดเผยเครื่องโดยไม่ตั้งใจ

## การตรวจรับ

- Automated core/security/compatibility: 679 passed, 34 skipped, 0 failed
- Packaging: 16/16 passed
- Chromium Local Config UI: 5/5 passed
- Production dependency audit: 0 vulnerabilities
- Live Cloudflare hostname ด้วย credential ของเจ้าของสำหรับ source นี้:
  **MANUAL_NOT_RUN**
