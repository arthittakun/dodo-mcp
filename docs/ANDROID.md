# DODO กับ Android และ ADB

DODO รองรับ Android สองรูปแบบซึ่งมีขอบเขตต่างกัน:

1. **รัน DODO บน Android/Termux** — core CLI และ MCP สำหรับ text/code อยู่ในสถานะ
   experimental เพราะ dependency บางตัวไม่มี Android build
2. **ให้ DODO ควบคุมมือถือผ่าน ADB** — ใช้ DODO บน macOS, Linux, Windows หรือ
   Termux ที่มี `adb` แล้วให้ AI ตรวจและควบคุมเฉพาะอุปกรณ์ที่เจ้าของอนุญาต

## ใช้ DODO ควบคุมมือถือผ่าน ADB

ติดตั้ง Android SDK Platform-Tools จากแหล่งทางการ แล้วตรวจว่า `adb` พร้อมโดยไม่
เชื่อมต่อหรือสั่งงานมือถือ:

```bash
dodo setup --check --components adb
adb devices -l
dodo android devices
```

บน macOS ติดตั้งได้ด้วย `dodo setup --yes --components adb` ซึ่งใช้ Homebrew
บน Linux ใช้ package manager ของระบบ ส่วน Windows ให้ติดตั้ง signed Platform-Tools
จาก Android Developers และเพิ่ม directory ของ `adb.exe` ลง PATH ที่เชื่อถือได้

มือถือยังต้องเปิด Developer options และ USB debugging หรือ Wireless debugging
จากนั้นยืนยัน RSA prompt บนมือถือด้วยตัวเอง DODO จะไม่ pair, connect, root, start/stop
ADB server หรืออ่าน pairing code แทนเจ้าของ

อนุญาตแบบดูอย่างเดียวชั่วคราว 60 นาที:

```bash
dodo android allow --device SERIAL --mode view --minutes 60 --yes
```

อนุญาตแบบควบคุมและจำไว้ครั้งเดียวสำหรับ DODO installation นี้:

```bash
dodo android allow --device SERIAL --mode control --persist --yes
```

ใช้ serial ตรงกับผลของ `dodo android devices` เท่านั้น เพิ่มได้หลายเครื่องด้วย
`--device SERIAL_1 SERIAL_2` หน้า Local Config มีปุ่มค้นหาอุปกรณ์และตั้งค่าเดียวกัน
เมื่อไม่ใช้แล้วให้ถอนสิทธิ์ทันที:

```bash
dodo android disable
```

สิทธิ์ ADB นี้ไม่แทน OAuth หรือ project permission ทุก MCP operation ยังต้องมี
`dodo:exec`, project/workspace context ที่ถูกต้อง และผ่าน trust/approval,
idempotency, audit และ policy เดิม โหมด `--bypass` ไม่เปิด ADB ให้เอง

### เครื่องมือที่ AI ใช้ได้

| Tool | ความสามารถ |
|---|---|
| `android_status` | ตรวจ ADB backend และสิทธิ์ที่เจ้าของตั้ง โดยไม่แตะอุปกรณ์ |
| `android_devices` | แสดงเฉพาะ serial ที่เจ้าของอนุญาต |
| `android_device_info` | รุ่น, Android version, display และ battery แบบ bounded |
| `android_capture` | จับหน้าจอ PNG จริงและคืน MCP image block พร้อม snapshot อายุ 30 วินาที |
| `android_ui` | อ่าน UI hierarchy จาก snapshot เดียวกันและปิดบัง password field |
| `android_logcat` | อ่าน logcat แบบจำกัดจำนวนบรรทัดและขนาด |
| `android_packages` | แสดง package names โดยค่าเริ่มต้นเป็น third-party apps |
| `android_file_read` | อ่านไฟล์ absolute path บนอุปกรณ์แบบ bounded เป็น UTF-8 หรือ base64 |
| `android_action` | tap, long press, swipe, text และ key event โดยต้องใช้ snapshot ใหม่ |
| `android_app` | launch/start activity/force-stop/clear app data |
| `android_install` | ติดตั้ง APK จาก workspace หลังตรวจ expected SHA-256 |
| `android_push` | ส่งไฟล์ workspace ไป absolute device path หลังตรวจ expected SHA-256 |
| `android_adb` | device-side `shell`, `exec-out`, `logcat`, `get-state`, `get-serialno`, `features` แบบจำกัดเวลา/ขนาด |

HTTP Compact surface รวมทั้งหมดไว้ใต้ `dodo_mobile`; ใช้ `dodo_discover` หา schema
ของ operation ก่อนเรียก Full surface แสดงชื่อ tool รายตัว

`android_install` และ `android_push` ไม่ส่ง path workspace ตรงให้ ADB ระบบอ่านไฟล์ผ่าน
shared path/secret/symlink/hardlink policy ตรวจ `expectedHash` แล้วสร้าง private staging
copy ที่ลบทันทีหลังจบ หากไฟล์เปลี่ยนระหว่างทางจะตอบ `FILE_CHANGED` และไม่สั่ง ADB

`android_adb` เปิด device-side shell ตามที่เจ้าของร้องขอ จึงแก้หรือลบข้อมูลบนมือถือได้
แต่ไม่รับคำสั่ง host-side เช่น `pair`, `connect`, `root`, `install`, `push`, `pull`,
`forward` หรือ ADB server management กลุ่มเหล่านี้ต้องใช้ owner action หรือ tool เฉพาะ
ที่มี validation ของตัวเอง

DODO serialize คำสั่งต่อ serial เดียวกันข้ามทุก project runtime ใน process เดียว
ดังนั้น AI หลายตัวทำคนละโปรเจกต์พร้อมกันได้ แต่จะไม่สลับคำสั่งบนมือถือเครื่องเดียวกัน

ภาพ, UI text, logcat และไฟล์จากอุปกรณ์เป็นข้อมูลส่วนตัวและ untrusted content
DODO ไม่บันทึกเนื้อหาเหล่านี้ใน audit log และไม่ถือว่า ADB เป็น sandbox ของอุปกรณ์

## รัน DODO บน Android / Termux

สถานะ: **ทดลองใช้ (experimental)**

DODO โหลด raster backend เมื่อจำเป็น จึงเริ่ม core CLI และ MCP สำหรับ text/code ได้
โดยไม่บังคับให้ Android มี native Sharp runtime ตั้งแต่ startup การมี Git, ADB และ
`cloudflared` ใน Termux ช่วยเปิด workflow บางส่วนได้ แต่ยังไม่เท่ากับการผ่าน Android
platform acceptance ทั้งระบบ

```bash
pkg update
pkg install nodejs-lts git ripgrep android-tools
npm install -g dodo-mcp@latest @img/sharp-wasm32@0.35.4
dodo --version
dodo doctor
dodo setup --check
```

`@img/sharp-wasm32` เป็น optional image backend หากโหลดไม่ได้ เครื่องมือภาพจะตอบ
`NOT_SUPPORTED` ส่วน transport และเครื่องมือ coding ต้องไม่ crash การเข้าถึงไฟล์
จำกัดตาม Android storage permission ของ Termux

Termux สามารถเป็น ADB host ผ่าน Wireless debugging ได้เมื่อเจ้าของ pair/connect ด้วย
ตนเองแล้ว หลังจาก `adb devices -l` เห็น serial การอนุญาตให้ AI ใช้ serial นั้นทำด้วย
`dodo android allow` เหมือน platform อื่น

### สิ่งที่ยังไม่ประกาศรองรับบน Android host

- `dodo setup --yes` แบบติดตั้ง dependencies ทั้งหมดอัตโนมัติ
- macOS Keychain, Windows Credential Manager หรือ Linux Secret Service integration
- OS command sandbox สำหรับ Android
- native desktop capture/control, microphone หรือ system audio
- Playwright Chromium/browser automation บน Android
- background survival หลัง Android หยุด process ของ Termux

ฟังก์ชันที่ไม่มี backend ต้องตอบ `NOT_SUPPORTED` ตามจริง DODO จะไม่ลด OAuth,
project/workspace context, path/secret guard, expected hash, approval หรือ command
sandbox policy เพื่อทำให้ probe ผ่าน

## การรายงานปัญหา

แนบเฉพาะข้อมูลที่ไม่เป็นความลับ:

```bash
node --version
npm --version
dodo --version
adb version
adb devices -l
```

ลบ serial ที่ไม่ต้องการเปิดเผยก่อนแนบ ห้ามแนบ Tunnel token, OAuth client secret,
API key, Local Config URL ที่มี fragment, state database, screenshot/logcat หรือเนื้อหา
ไฟล์ส่วนตัว
