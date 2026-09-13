# DODO Windows Support

DODO MCP 1.0.0 รองรับการเตรียม environment, coding tools, HTTP, STDIO, Local Config และ workspace policy บน Windows ตาม dependency และ backend ที่ติดตั้งจริง

## ตรวจเครื่อง

```powershell
dodo setup --check
dodo doctor
```

คำสั่งตรวจจะรายงานสถานะ Git, ripgrep, LSP, media, speech, browser, desktop และ command sandbox แยกกัน ไม่เปิด permission หรือดาวน์โหลด model เอง

## การทำงานหลัก

- MCP HTTP ใช้ OAuth และ bind local loopback ก่อน owner จะนำไปวางหลัง HTTPS tunnel
- STDIO ใช้ full tool surface เป็นค่าเริ่มต้น
- Local Config ใช้ owner authentication และ named-pipe/loopback transport ตาม platform
- workspace path ต้องเป็น absolute path และผ่าน canonicalization, ACL และ secret/path guards
- jobs ใช้ Windows process tree และ environment allowlist
- file changes ใช้ expected hash, journal, atomic replace และ rollback

## Optional backends

Desktop, speech, browser และ command sandbox ต้องผ่าน probe และ owner permission หาก backend ไม่พร้อมระบบตอบ `NOT_SUPPORTED` ตามจริง

## Native support gate

ระบบจะประกาศ native support ได้เมื่อผ่าน named-pipe identity, NTFS reparse/ADS/8.3 guards, ACL enforcement, PATHEXT resolution, shell strategy, process cancellation, read-only/antivirus file behavior, Windows argv limits, Chromium environment, LSP และ CI บน `windows-latest` ครบตามหลักฐานจริง

## Manual acceptance

ต้องทดสอบบน Windows 11 จริง แยกจาก CI: OAuth/HTTP, STDIO, workspace isolation, ACL, file conflict, rollback, jobs, setup และ package installation ผลที่ยังไม่ได้ทำให้บันทึกเป็น `MANUAL_NOT_RUN`
