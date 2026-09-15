# DODO MCP — Tunnel Guide

DODO เปิด MCP และ OAuth บน local loopback ผู้ใช้เป็นผู้สร้าง Cloudflare remotely-managed Tunnel, public hostname และ DNS เอง DODO supervise เฉพาะ process `cloudflared` ที่เริ่มในรอบปัจจุบันและไม่ติดตั้งเป็น system service

## Local endpoints

- MCP + OAuth: `http://127.0.0.1:21730`
- MCP endpoint: `http://127.0.0.1:21730/mcp`
- Local Config: `http://127.0.0.1:21731`
- managed readiness/metrics: `http://127.0.0.1:21732` โดยค่าเริ่มต้น

Tunnel ต้อง route public hostname ทุก path ไปยัง listener `21730` เดียวกันเพื่อให้
health, discovery, OAuth และ MCP ทำงานครบ ห้าม route Local Config `21731`, metrics
`21732`, private IPC หรือ debug endpoint ออก public Namespace `/config` บน `21730`
ตอบ 404 ตามค่าเริ่มต้นและเปิดได้ชั่วคราวเฉพาะเมื่อเจ้าของสั่งตามหัวข้อถัดไป

## Public origin

```bash
dodo init --public-url https://mcp.example.com
dodo start --root /path/to/project
```

## เปิดพร้อม DODO ด้วย token ชั่วคราว

```bash
dodo setup --check --components cloudflared
dodo init --public-url https://mcp.example.com
dodo start --root /path/to/project
# Cloudflare Tunnel token (temporary; Enter = local only):
```

`dodo setup --yes` ใช้ component `all` เป็นค่าเริ่มต้นและรวม `cloudflared` บน macOS
หรือเลือกจากเมนู `dodo --cli` ข้อ “ติดตั้ง/ตรวจ dependencies ทั้งหมด” ได้

กรอก Tunnel token ที่ Cloudflare ออกให้สำหรับ remotely-managed Tunnel Token จะอยู่
เฉพาะใน DODO process และ environment ของ child `cloudflared` ระหว่างรอบ เมื่อ DODO
หยุด child จะหยุดตาม กด Enter โดยไม่กรอกหรือใช้คำสั่งต่อไปนี้เพื่อเปิด local MCP เท่านั้น:

```bash
dodo start --no-tunnel
```

หน้า Local Config มีช่อง **Temporary Tunnel token** สำหรับเริ่ม tunnel ใน process ที่
เปิดอยู่ได้ทันที และมีปุ่มหยุดเฉพาะ child ที่ process นี้เป็นเจ้าของ ช่องถูกล้างหลังส่ง
Backend ตอบ `tokenStored:false` และไม่เขียนค่าลง config หรือ credential store

## เปิด Remote Config ผ่าน Tunnel ชั่วคราว

```bash
dodo --web
# Remote Config: https://mcp.example.com/config
# Pairing code (shown once): XXXX-XXXX-XXXX-XXXX

dodo web --status
dodo web --close
```

`dodo --web` ทำงานได้สองกรณี: ถ้ายังไม่มี DODO process จะเริ่ม MCP ที่พอร์ต 21730,
Local Config ที่ 21731 และ Tunnel แล้วเปิด Remote Config; ถ้า process กำลังรันอยู่จะ
ใช้ authenticated private IPC เพื่อเปิดหรือต่ออายุ lease โดยไม่ restart MCP หาก
process เดิมเริ่มแบบ local-only คำสั่งจะถาม run-scoped Tunnel token แบบซ่อนและส่งให้
process ที่รันอยู่ครั้งเดียว Token ไม่ถูกบันทึกและไม่อยู่ใน argv หรือ audit

URL ไม่มี query/fragment secret ผู้ใช้ต้องกรอก pairing code ที่ terminal แสดง Code
มีอายุไม่เกิน 10 นาทีและใช้ได้ครั้งเดียว จากนั้น server ออก session cookie ที่เป็น
`Secure`, `HttpOnly`, `SameSite=Strict` และ `Path=/config` ตัว lease ปิดอัตโนมัติ
ภายใน 1 ชั่วโมง เมื่อหมดอายุ `/config`, assets และ owner API ใต้ namespace นี้กลับ
เป็น 404 การรัน `dodo --web` อีกครั้งยกเลิก code/session เดิมและออกชุดใหม่

Remote Config เป็น authenticated bridge ไปยัง Local Config เดิม การเขียนทุกครั้งยัง
ตรวจ workspace ID/epoch, owner validation และ policy ของ Local Config ไม่มี MCP tool
สำหรับเปิด lease และ `dodo web --close` ปิดเฉพาะหน้าเว็บ โดยไม่หยุด MCP หรือ Tunnel

ถ้ามี external tunnel ที่เจ้าของรันอยู่แล้วและไม่ต้องการให้ DODO เริ่ม cloudflared ใช้
`dodo start --web --no-tunnel` จาก interactive terminal การเลือกนี้บอกเพียงว่า route
ภายนอกมีอยู่แล้ว; DODO ไม่กล่าวอ้างหรือสร้าง route/DNS ให้เอง

คำสั่งตรวจสถานะที่ไม่มี secret:

```bash
dodo tunnel status
dodo tunnel doctor
dodo tunnel logs --lines 100
dodo tunnel stop
```

`status` ใช้ authenticated owner IPC และไม่อ่าน credential ส่วน `doctor` เป็นคำสั่งตรวจแบบ explicit: ตรวจ executable, credential availability, local `/healthz`, managed `/ready` และ public `/healthz` แยกกัน Public health ที่ผ่านไม่ได้แปลว่า AI client เชื่อมต่ออยู่

## ขอบเขตของ token

DODO ไม่รับ token เป็น CLI argument และไม่ใส่ token ใน `cloudflared` argv เส้นทาง
มาตรฐานไม่ใช้ macOS Keychain, Windows Credential Manager, Linux Secret Service,
token file หรือ shell environment Token จาก terminal และ Local Config ถูกส่งผ่าน
environment ของ child ที่สร้างเองเท่านั้น Tunnel diagnostics ถูกจำกัดขนาดและ redact
ก่อนเขียนลง private state MCP jobs จะไม่ได้รับ `TUNNEL_TOKEN` หรือ
`TUNNEL_TOKEN_FILE` แม้ owner จะใส่ชื่อไว้ใน environment allowlist

คำสั่ง `dodo tunnel configure/start` และ credential reference รุ่นเดิมยังคงอยู่เพื่อ
advanced/headless compatibility แต่ไม่ถูกเรียกโดย `dodo start`, `dodo --cli` หรือ
Local Config และต้องเกิดจากคำสั่ง owner โดยตรง

runtime ใช้ bounded restart หลัง `cloudflared` จบ retry ของตัวเอง และ `stop` ส่งสัญญาณเฉพาะ live child handle ที่ supervisor เป็นผู้สร้าง ไม่มีการ kill saved PID หรือ process ชื่อเหมือนกัน

## Client setup

1. ใช้ `https://mcp.example.com/mcp` ใน MCP client
2. เลือก OAuth
3. คัดลอก exact callback จาก client
4. ลงทะเบียนด้วย `dodo auth add-client --redirect-uri ...`
5. ทำ browser authorization และ approve interaction จาก terminal
6. scan tools และตรวจ surface ที่ client รายงาน

## หลายโปรเจกต์

หนึ่ง DODO process มี default workspace หนึ่งตัว แต่ Installation Runtime Manager เปิด
explicit target runtimes หลายโปรเจกต์พร้อมกันได้ภายใต้ project registry และ target
authority เดียวกัน จึงไม่ต้องสร้าง Tunnel แยกต่อโปรเจกต์ งานแต่ละ target ใช้
workspace identity/epoch, jobs และ mutation queue ของตัวเอง

## Security

ห้ามปิด OAuth, ใช้ Tunnel token แทน MCP OAuth, ส่ง token/pairing/session ใน URL หรือ
เปิด CORS กว้าง Tunnel provider ไม่ได้แทน owner consent ของ DODO และ DODO ไม่เรียก
Cloudflare API, ไม่จัดการ DNS, ไม่สร้าง/ลบ Tunnel และไม่เปิด firewall
