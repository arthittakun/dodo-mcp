# DODO บน Android / Termux

สถานะ: **ทดลองใช้ (experimental)** ใน DODO 1.0.6

DODO รองรับการเริ่ม core CLI และ MCP สำหรับงาน text/code บน Node.js ที่ตรงกับ
`engines` โดยไม่บังคับให้ Android มี native Sharp runtime ตั้งแต่ startup การมี Git,
ADB และ `cloudflared` ใน Termux ช่วยเปิด workflow บางส่วนได้ แต่ยังไม่เท่ากับการผ่าน
Android platform acceptance ทั้งระบบ

## ติดตั้ง

```bash
pkg update
pkg install nodejs-lts git ripgrep
npm install -g dodo-mcp@latest @img/sharp-wasm32@0.35.4
dodo --version
```

`@img/sharp-wasm32` เป็น optional image backend หากติดตั้งไม่ได้ ให้ลอง DODO ต่อได้:
คำสั่งพื้นฐาน, transport และเครื่องมือ coding ต้องไม่ crash เพราะ Sharp ส่วน
image preview/capture/transform จะตอบ `NOT_SUPPORTED` จนกว่าจะมี backend ที่โหลดได้

ตรวจ installation โดยไม่ถือว่ารายการ optional ที่ขาดเป็น success:

```bash
dodo --version
dodo doctor
dodo setup --check
```

## ขอบเขตที่คาดว่าใช้ได้

- CLI, HTTP/STDIO MCP, OAuth และ Local Config เมื่อ Termux อนุญาต loopback/network
- อ่าน ค้นหา และแก้ไฟล์ภายใน path ที่ Termux เข้าถึงได้ตาม Android storage permission
- Git, ripgrep และ command jobs เมื่อ executable อยู่ใน trusted PATH
- Cloudflare Tunnel เมื่อ `cloudflared` binary สำหรับเครื่องนั้นผ่าน capability probe
- เครื่องมือภาพเมื่อ WebAssembly/libvips backend โหลดและ probe ได้จริง

## สิ่งที่ยังไม่ประกาศรองรับ

- `dodo setup --yes` แบบติดตั้ง dependencies อัตโนมัติสำหรับ Android
- macOS Keychain, Windows Credential Manager หรือ Linux Secret Service integration
- OS command sandbox สำหรับ Android
- native desktop capture/control, microphone หรือ system audio
- Playwright Chromium/browser automation บน Android
- background survival หลัง Termux ถูก Android หยุด process

ฟังก์ชันที่ไม่มี backend ต้องตอบ `NOT_SUPPORTED` ตามจริง DODO จะไม่ลด OAuth,
project/workspace context, path/secret guard, expected hash, approval หรือ command
sandbox policy เพื่อทำให้ probe ผ่าน

## การรายงานปัญหา

แนบเฉพาะข้อมูลที่ไม่เป็นความลับ:

```bash
node --version
npm --version
dodo --version
uname -a
```

ห้ามแนบ Tunnel token, OAuth client secret, API key, Local Config URL ที่มี fragment,
state database หรือเนื้อหาไฟล์ส่วนตัว หาก `dodo --version` ผ่านแต่ capability หนึ่ง
ตอบ `NOT_SUPPORTED` ให้แยกรายงาน capability และ dependency นั้น ไม่สรุปว่า CLI ทั้งตัวพัง
