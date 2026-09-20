# Native Linux และ Windows CI

`platform-gates` ใช้ GitHub Actions บน self-hosted runners โดยตรง **ไม่ใช้ Docker**
ทดสอบ Node 22 และ 24 ทั้งสองระบบ การ Online หมายถึงรับ job ได้ ยังไม่ใช่ผลทดสอบ PASS

| Job | Runner labels | เริ่มเมื่อ |
|---|---|---|
| Linux native | self-hosted, Linux, X64, linux-ci | Run workflow เลือก linux/all |
| Windows native | self-hosted, Windows, X64, windows-ci 02 | push main หรือ Run workflow เลือก windows/all |

ไม่มี pull_request trigger สำหรับโค้ดที่ยังไม่ผ่านการตรวจ เพราะ self-hosted job
ใช้สิทธิ์ OS ของบัญชี runner เลือกเฉพาะ ref ที่เจ้าของตรวจแล้ว GitHub token เป็น
contents:read, checkout ไม่เก็บ credential และไม่มี npm publish step

## สั่งรัน

GitHub → Actions → platform-gates → Run workflow → เลือก branch และ platform
หรือใช้ GitHub CLI ที่ login แล้ว:

```sh
gh workflow run platform-gates.yml --ref main -f platform=all
gh run list --workflow platform-gates.yml --limit 5
```

โค้ดที่ยังไม่ commit/push ในเครื่องจะไม่อยู่ใน CI เลือกสาขาทดสอบที่ push แล้วได้ด้วย
`--ref <reviewed-branch>` แทน main อย่านำผลคนละ revision มาอ้างแทนกัน

เมื่อ full gate timeout ก่อนสร้าง JSON report สามารถเลือก `windows-diagnostics`
พร้อม `evidence_run` เช่น `35496561994-1` เพื่ออ่านความคืบหน้าที่เก็บไว้บน runner
ผลแสดงเฉพาะชื่อไฟล์ทดสอบที่อยู่ใน repo และตัวเลข ไม่ส่ง log ทั้งก้อนออกมา
คำสั่งตรวจหลักฐานสำเร็จไม่ได้แปลว่า application tests ผ่าน

`windows-focus` ใช้ Node 24 และ worker เดียว ทดสอบเฉพาะ source backup, direct
coding tools และ native ACL owner เพื่อวินิจฉัย Windows failures ผ่าน npm script `ci:windows:focus`
ผลนี้ไม่แทน `windows` ซึ่งยังต้องรัน full gate ทั้ง Node 22/24 ก่อนรับรอง candidate

## เตรียม Linux runner

ใช้บัญชี non-root และต้องมี Git, Python 3, make, g++, ffmpeg, ffprobe และ espeak-ng
ใน PATH Workflow ไม่ติดตั้ง system packages หรือแก้ permission เครื่องโดยอัตโนมัติ
เจ้าของเตรียมรายการดังกล่าวด้วย package manager ของ Linux distribution ที่ใช้อยู่

Workflow ใช้ `npm ci` และ Playwright รุ่นที่อยู่ใน lockfile เพื่อติดตั้ง Chromium
จากนั้นเปิด headless Chromium ด้วย `chromiumSandbox:true` และถ่ายภาพ fixture จริง
ก่อนรัน build/tests ต้องมี Chromium system libraries และ user namespaces/sandbox
ที่ใช้งานได้ หากไม่พร้อมจะหยุดพร้อมข้อความ ไม่มีการใส่ `--no-sandbox` เพื่อให้ผ่าน
ดู [Playwright CI requirements](https://playwright.dev/docs/ci) สำหรับ OS/libraries
ที่รุ่นนั้นรองรับ โดยตรวจ Linux distribution ของ runner ก่อนเตรียมเครื่อง

Media tests บน Linux ถูกบังคับด้วย `DODO_TEST_REQUIRE_LINUX_MEDIA=1`
จึงไม่ข้าม speech/ffmpeg tests เพราะ dependency หาย

## Windows: Online แต่ job ล้มก่อน step แรก

หาก annotation มี `PowerShellPreAmpersandEscape` / `InitializeSecretMasker`
และไม่มี steps เป็นอาการใน GitHub runner ที่รายงานกับ locale ภาษาไทย
ยังไม่ได้ทดสอบ DODO ดู [actions/runner#4686](https://github.com/actions/runner/issues/4686)

สำหรับ runner ที่เปิดด้วย `run.cmd`: หยุดหน้าต่างเดิมด้วย Ctrl+C แล้วเปิด PowerShell
แบบ Administrator ใน **โฟลเดอร์ runner ที่ติดตั้งจริง** จากนั้นรัน:

```powershell
$env:DOTNET_SYSTEM_GLOBALIZATION_INVARIANT = "1"
$env:DOTNET_SYSTEM_GLOBALIZATION_PREDEFINEDCULTURESONLY = "false"
.\run.cmd
```

ค่ามีผลเฉพาะ process นี้ ไม่ใช่การเปลี่ยน locale ของเครื่อง เมื่อเปิดหน้าต่างใหม่ต้อง
ตั้งอีกครั้ง Workflow คืน globalization ปกติให้ขั้นทดสอบ ไม่ใช้ workaround
บังพฤติกรรม locale ของ DODO หาก runner รันเป็น service การตั้งค่าใน PowerShell
อีกหน้าต่างจะไม่เปลี่ยน environment ของ service ต้องให้เจ้าของจัดการ service นั้น
และอย่าเปิด runner ตัวเดียวกันซ้อนกันทั้ง service กับ run.cmd

Windows gate ต้องใช้ enabled Administrator token เพื่อทดสอบ owner/DACL/reparse
บน NTFS โดยไม่ลดข้อกำหนดของ security tests

## หลักฐานและสถานะ

Gate รัน build, typecheck, lint, full tests, packaging, DodoBench, production audit,
immutable tarball และ fresh install โดยไม่เผยแพร่ npm
`test:all` มีเวลา aggregate สูงสุด 60 นาทีบน Windows และ 30 นาทีบนระบบอื่น เพราะ
native Windows มีต้นทุนตรวจ NTFS ACL และชุด Recovery เพิ่มขึ้น ไม่เปลี่ยน timeout
ราย test/hook ไม่ลด assertions และ failure ใด ๆ ยังคงทำให้ gate ไม่ผ่าน
ผลละเอียดอยู่บน runner ใน `<runner-workspace>/.dodo-ci-evidence/<run-id>-<attempt>/<platform>-node-<major>/`
นอก checkout เพื่อไม่ถูก checkout cleanup ลบ จึงไม่ push/pack การ rerun ใช้ directory
ใหม่ ไม่เขียนทับ report เก่า Linux ย้ายสำเนา evidence แบบเก่าที่อยู่ใน checkout
ออกไปก่อน cleanup หากยังมีอยู่ ไม่เขียนทับสำเนาที่มีแล้ว

GitHub log/artifact รับเฉพาะ summary ที่เลือก scalar fields ไว้แล้ว ไม่อัปโหลด raw
test output, keys หรือ state DB กรณี test fail แสดงเฉพาะ path ของ test ใน repo,
ลำดับ assertion (เริ่มที่ 0), หมายเลขบรรทัด และชนิด failure ไม่แสดงชื่อ test,
expected/actual values, ข้อความ error หรือ stack ของเครื่อง รายละเอียด probe
ที่ fail เก็บไว้ให้เจ้าของอ่านบนเครื่อง สรุป failure ก่อนหน้าแสดง revision/run ID
ชัดเจน ไม่ปะปนกับผลรอบปัจจุบัน

- `AUTOMATED_PASS`: gate ของ revision/platform นั้นผ่านครบ
- `AUTOMATED_FAIL`: gate ล้มเหลว ดู step/summary และ private evidence
- ล้มก่อน step แรก: runner startup failure ไม่ใช่ผลทดสอบ application
- `MANUAL_NOT_RUN`: ยังไม่ได้ทำ manual acceptance; CI ผ่านไม่เปลี่ยนสถานะนี้เอง

Linux Docker evidence เดิมยังเป็นประวัติการทดสอบเดิม ไม่ใช้แทน native Linux CI
ตามนโยบายปัจจุบัน Strict gate รวมได้เฉพาะ clean revision/lock/source fingerprint
ตรงกัน และ Linux origin เป็น `github-actions-native`
