# ติดตั้งและแก้ปัญหา DODO Setup บน Windows

คู่มือนี้ใช้กับ DODO MCP 1.0.4 บน Windows X64 โดยเน้นการติดตั้งผ่าน
`dodo setup`, การเตรียม `cloudflared` และข้อผิดพลาดเรื่อง private state ACL

> สถานะ Windows ยังเป็น native candidate จนกว่าจะผ่าน manual acceptance บน
> Windows 11 ครบตาม [WINDOWS.md](WINDOWS.md) ผลจาก CI ไม่ได้แทน permission,
> desktop session หรือ network ของเครื่องผู้ใช้

## เริ่มแบบสั้น

เปิด **Command Prompt หรือ PowerShell ด้วย Windows account ที่จะใช้รัน DODO
ประจำ** แล้วทำงานจาก `%USERPROFILE%` ไม่จำเป็นต้องอยู่ในโฟลเดอร์โปรเจกต์

```bat
cd /d "%USERPROFILE%"
dodo setup --plan
dodo setup --yes --components git,ripgrep,ffmpeg,whisper,model,chromium,lsp,speech,desktop,sandbox
dodo setup --check
dodo doctor
```

`--plan` และ `--check` ไม่ติดตั้งหรือเปิด permission ส่วน `--yes` ยืนยันเฉพาะ
installer ที่ DODO แสดงไว้ ไม่ข้าม UAC, Desktop consent หรือ security policy
เมนู 5 และ `--components all` ตรวจ `cloudflared` ด้วย แต่จะรายงานให้ติดตั้ง signed
package เองบน Windows ตามหัวข้อด้านล่าง

## อะไรติดตั้งอัตโนมัติได้

| Component | Windows behavior |
|---|---|
| Git, ripgrep, FFmpeg, Whisper | DODO ติดตั้ง portable binary ที่ตรึงเวอร์ชันและ checksum ลง private state |
| Whisper model | ดาวน์โหลด `ggml-tiny.bin` ที่ตรึงขนาดและ SHA-256 |
| Chromium | ใช้ revision ที่ตรงกับ Playwright และตรวจ browser sandbox |
| LSP | ติดตั้ง language servers ที่ตรึงเวอร์ชันและลงทะเบียน executable |
| Speech | ใช้ Windows SAPI เมื่อ probe สร้างเสียงจริงสำเร็จ |
| Desktop | ติดตั้ง backend ได้ แต่ต้องอนุญาตจาก interactive desktop session |
| Sandbox | อาจเปิด UAC และต้องผ่าน file/network confinement probe จริง |
| Web fetch | software มีอยู่แล้ว แต่ต้องเปิดด้วยคำสั่ง owner แยกต่างหาก |
| cloudflared | **ไม่ติดตั้งอัตโนมัติบน Windows** ต้องติดตั้ง signed package จาก Cloudflare |

หากต้องการติดตั้งเฉพาะสิ่งที่ DODO จัดการเองก่อน:

```bat
dodo setup --yes --components git,ripgrep,ffmpeg,whisper,model,chromium,lsp,speech,desktop,sandbox
dodo desktop setup --request-permissions
dodo setup --enable-web
```

การเปิด `web` เป็นสิทธิ์ส่งข้อมูลออกผ่าน SSRF-guarded fetch จึงไม่ถูกเปิดจาก
`--yes` หรือเมนู setup โดยอัตโนมัติ

## ติดตั้ง cloudflared

ดาวน์โหลด Windows 64-bit MSI หรือ executable จาก
[Cloudflare Downloads](https://developers.cloudflare.com/tunnel/downloads/) แล้วให้
`cloudflared.exe` อยู่ใน user/system `PATH` จากนั้นเปิด terminal ใหม่และตรวจ:

```bat
where cloudflared
cloudflared --version
dodo setup --check --components cloudflared
```

DODO เป็นผู้เริ่มและหยุด child `cloudflared` พร้อม `dodo start` เมื่อเลือก Tunnel
mode จึง **ไม่ต้อง** รัน `cloudflared service install` สำหรับ flow นี้ Windows ไม่มี
automatic update ของ `cloudflared`; เจ้าของต้องอัปเดต package เอง

หลัง executable พร้อม ให้ตั้ง Tunnel ผ่าน Local Config หรือ:

```bat
dodo tunnel configure --tunnel --public-url https://YOUR-DODO-HOST --os-credential
dodo start
```

อย่าวาง Tunnel token ใน command line, repository หรือไฟล์ config DODO จะรับ token
ผ่าน hidden prompt และเก็บแบบ write-only ใน Windows Credential Manager

## ข้อผิดพลาด private Windows state ACL

ข้อความนี้เป็นการปฏิเสธแบบ fail closed:

```text
private Windows state ACL could not be established or verified
```

ค่าเริ่มต้นของ state คือ:

```text
%LOCALAPPDATA%\dodo
```

DODO ยอมใช้ directory เมื่อเป็น local NTFS directory, ไม่ใช่ symlink/junction/reparse
point, มี owner ที่ตรวจได้ และ DACL อนุญาตเฉพาะ Windows user ปัจจุบัน, `SYSTEM`
และ local `Administrators` เท่านั้น ระบบจะไม่ลด ACL เป็น `Everyone`, ยึด directory
ของ user อื่น หรือลบ state เพื่อให้ setup ผ่าน

สาเหตุที่พบบ่อย:

- state ถูกสร้างจาก Windows account คนละบัญชี
- เคยรันบางครั้งแบบ Administrator และบางครั้งแบบ user อื่น
- `DODO_CONFIG_DIR` ชี้ไป network drive, synced folder, junction หรือ filesystem
  ที่ไม่รักษา Windows ACL แบบที่ตรวจได้
- ย้าย/คัดลอก state มาจากเครื่องอื่นแล้ว owner SID เปลี่ยน

### วิธีเริ่มใหม่โดยไม่ลบ state เดิม — Command Prompt

```bat
cd /d "%USERPROFILE%"
set "DODO_CONFIG_DIR=%LOCALAPPDATA%\dodo-private"
dodo setup --yes --components speech
setx DODO_CONFIG_DIR "%LOCALAPPDATA%\dodo-private"
```

`set` มีผลกับหน้าต่างปัจจุบัน ส่วน `setx` มีผลกับ terminal ที่เปิดใหม่ หลังปิดและ
เปิด terminal ใหม่ให้ตรวจ:

```bat
echo %DODO_CONFIG_DIR%
dodo setup --plan
dodo setup --yes --components git,ripgrep,ffmpeg,whisper,model,chromium,lsp,speech,desktop,sandbox
```

### วิธีเดียวกัน — PowerShell

```powershell
Set-Location $env:USERPROFILE
$env:DODO_CONFIG_DIR = Join-Path $env:LOCALAPPDATA 'dodo-private'
dodo setup --yes --components speech
[Environment]::SetEnvironmentVariable('DODO_CONFIG_DIR', $env:DODO_CONFIG_DIR, 'User')
```

เปิด PowerShell ใหม่แล้วรัน:

```powershell
$env:DODO_CONFIG_DIR
dodo setup --plan
dodo setup --yes --components git,ripgrep,ffmpeg,whisper,model,chromium,lsp,speech,desktop,sandbox
```

วิธีนี้ไม่แตะ `%LOCALAPPDATA%\dodo` เดิม แต่ `dodo-private` เป็น installation ใหม่:
OAuth identity, clients, project registry, tunnel credential และ state เดิมจะไม่ถูก
คัดลอกอัตโนมัติ ต้องตั้งค่าใหม่ตามที่ต้องการ

### หากต้องรักษา installation identity เดิม

อย่าลบ directory, อย่าใช้ `icacls /grant Everyone` และอย่าคัดลอก database/keys ไปมา
เอง ให้ตรวจ path, owner, reparse status และ filesystem ก่อนใน PowerShell:

```powershell
$state = if ($env:DODO_CONFIG_DIR) { $env:DODO_CONFIG_DIR } else { Join-Path $env:LOCALAPPDATA 'dodo' }
whoami /user
Get-Item -LiteralPath $state -Force | Format-List FullName,Attributes,LinkType,Target
Get-Acl -LiteralPath $state | Format-List Owner,AreAccessRulesProtected,AccessToString
$drive = [IO.Path]::GetPathRoot($state).Substring(0,1)
Get-Volume -DriveLetter $drive | Select-Object DriveLetter,FileSystem
```

ผลที่ควรได้คือ path บน local `NTFS`, ไม่มี `ReparsePoint` และ owner เป็น account/SID
เดียวกับที่รัน DODO หากไม่ตรง ให้ผู้ดูแล Windows ตรวจ ownership และ provenance ของ
state ก่อนแก้ ACL DODO ไม่มีคำสั่ง takeover อัตโนมัติเพราะ directory อาจมี OAuth keys,
credentials และ private history

## ตรวจผลหลังติดตั้ง

```bat
dodo setup --check
dodo doctor
dodo --version
dodo --cli
```

`[missing]`, `[needs-permission]` และ `[needs-backend]` มีความหมายต่างกัน:

- `missing` — executable/model/runtime ไม่มีหรือ probe ไม่ผ่าน
- `needs-permission` — software มีแล้ว แต่เจ้าของยังไม่ได้เปิดสิทธิ์นั้น
- `needs-backend` — platform/backend ที่รองรับยังไม่มี
- `ready` — capability probe ของ component นั้นผ่านบนเครื่องนี้

สถานะ `ready` ของ Tunnel หมายถึง process/readiness ที่ DODO ตรวจได้ ไม่ใช่หลักฐานว่า
ChatGPT หรือ AI client เชื่อมแล้ว การตรวจ public hostname และ OAuth/MCP ผ่าน network
จริงยังต้องทำแยกตาม [MANUAL_ACCEPTANCE.md](MANUAL_ACCEPTANCE.md)
