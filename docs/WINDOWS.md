# DODO Windows Candidate — Deferred

DODO MCP 1.0.3 ยังไม่ประกาศ native Windows support โค้ดและ tests สำหรับ Windows
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

การแก้ candidate สำหรับ native CI:

- directory identity ใช้ bigint เมื่ออ่าน NTFS; ค่าที่เกิน JavaScript safe integer
  เก็บเป็น `u64:<decimal>` ใน JSON/SQLite เพื่อไม่ให้ file ID คนละค่าถูกปัดรวมกัน
  ค่า integer เดิมยังอ่านได้ และการตรวจ replaced root/ACL/trust ยังคงมีผล
- resource buffer เปิด staging file ด้วย writable handle ก่อน fsync ตามข้อกำหนด Windows
- LSP เทียบ URI ที่ normalize drive letter และ percent encoding แล้ว โดยไม่เปลี่ยน case ของชื่อไฟล์
- private fixture ตรวจ Windows ACL; fault injection แบบ filesystem error ตรวจ rollback
  ได้ทุก platform เพิ่มจาก POSIX chmod test และจำกัด Windows file workers ที่สองตัว
- `dodo kill` ตรวจและหยุด authenticated IPC endpoints ทีละรายการบน Windows
  เพื่อไม่ให้ synchronous PowerShell ACL probes ขวางการรับ IPC response ของอีก
  endpoint โดยยังตรวจ identity/epoch และรอ shutdown จริง ไม่ใช้ PID จาก state เพื่อส่ง signal
- หาก endpoint ถูกปิดระหว่างตรวจ IPC identity จะตรวจยืนยันว่า descriptor และ
  locator หายไปจริง ก่อนรายงานว่าไม่มี endpoint; ข้อมูลเสียหรือ ACL ที่ไม่ปลอดภัย
  ของ endpoint ที่ยังอยู่ยังเป็น error ตามเดิม

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

Workflow เตรียม Portable Git for Windows ใน temp ของ job หากไม่มี Git ใน PATH
โดยตรึง official release และตรวจ SHA-256 ก่อนแตกไฟล์ เพื่อให้ checkout ได้ `.git`
และตรวจ source revision จริง PowerShell ของ job ใช้ `RemoteSigned` แบบ process scope
สำหรับสคริปต์ที่ runner สร้าง ไม่แก้ execution policy ถาวรของเครื่อง และยังบังคับ
enabled Administrator token สำหรับชุดตรวจ ACL

## เริ่ม self-hosted runner บนเครื่องที่พบปัญหา locale

หาก runner ล้มก่อน step แรกด้วย `PowerShellPreAmpersandEscape` ให้หยุด runner แล้ว
รันใน PowerShell ที่โฟลเดอร์ runner เดิม:

```powershell
$env:DOTNET_SYSTEM_GLOBALIZATION_INVARIANT = "1"
$env:DOTNET_SYSTEM_GLOBALIZATION_PREDEFINEDCULTURESONLY = "false"
.\run.cmd
```

ค่ามีผลเฉพาะหน้าต่างนี้; เมื่อเปิดใหม่ต้องตั้งอีกครั้ง Workflow คืน globalization
ตามปกติให้ขั้นทดสอบ เพื่อไม่ใช้ workaround ของ runner มาบังปัญหา locale ใน DODO
อาการและ workaround อ้างอิง [actions/runner#4686](https://github.com/actions/runner/issues/4686)
