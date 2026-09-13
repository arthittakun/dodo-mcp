# DODO Windows Candidate — Deferred

DODO MCP 1.0.0 ยังไม่ประกาศ native Windows support โค้ดและ tests สำหรับ Windows
บางส่วนมีอยู่เป็น candidate สำหรับ phase สุดท้าย แต่ยังไม่มีหลักฐานจาก Windows 11 จริง
และ Linux Docker ไม่สามารถใช้แทนหลักฐาน Windows ได้

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

## งานที่ต้องผ่านก่อนประกาศรองรับ

ระบบจะประกาศ native support ได้เมื่อผ่าน named-pipe identity, NTFS
reparse/ADS/8.3 guards, ACL enforcement, PATHEXT resolution, shell strategy,
process cancellation, read-only/antivirus file behavior, Windows argv limits,
Chromium environment, LSP, full automated suite และ packaging บน Windows จริง

## Manual acceptance

ต้องทดสอบบน Windows 11 จริง: OAuth/HTTP, STDIO, workspace isolation, ACL, file
conflict, rollback, jobs, setup และ package installation ผลปัจจุบันคือ
`MANUAL_NOT_RUN` Dedicated `windows-ci 02` self-hosted runner ใช้เก็บ automated native
candidate evidence บน Node 22/24 แต่ไม่เปลี่ยน manual status เอง Workflow เลือก
label `windows-ci 02` โดยเฉพาะ และเลิกใช้ runner 01 แล้ว
