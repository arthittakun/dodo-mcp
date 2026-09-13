# DODO MCP — Tunnel Guide

DODO เปิด MCP และ OAuth บน local loopback ผู้ใช้เป็นผู้สร้าง Cloudflare remotely-managed Tunnel, public hostname และ DNS เอง DODO เลือกได้ระหว่างสังเกต tunnel ภายนอกกับ supervise เฉพาะ process `cloudflared` ที่เจ้าของสั่ง

## Local endpoints

- MCP + OAuth: `http://127.0.0.1:21730`
- MCP endpoint: `http://127.0.0.1:21730/mcp`
- Local Config: `http://127.0.0.1:21731`
- managed readiness/metrics: `http://127.0.0.1:21732` โดยค่าเริ่มต้น

Tunnel ต้อง route health, discovery, OAuth และ MCP ทุก path ไปยัง listener `21730` เดียวกัน ห้าม route Local Config `21731`, metrics `21732`, private IPC หรือ debug endpoint ออก public

## Public origin

```bash
dodo init --public-url https://mcp.example.com
cd /path/to/project
dodo trust --mode edit
dodo start
```

## เลือกโหมด

โหมด external เหมาะกับ `cloudflared` ที่รันด้วย system service, Docker หรือ terminal อื่น:

```bash
dodo tunnel configure --external
dodo tunnel doctor
```

โหมด managed รัน `cloudflared` ใน foreground และไม่สร้าง background daemon:

```bash
dodo setup --check --components cloudflared
dodo init --public-url https://mcp.example.com
dodo tunnel configure --managed --os-credential
dodo tunnel start --yes
```

เปิด terminal นี้ไว้ตลอดการใช้งาน คำสั่งที่มีให้คือ:

```bash
dodo tunnel status
dodo tunnel doctor
dodo tunnel logs --lines 100
dodo tunnel stop
dodo tunnel restart --yes
```

`status` ใช้ authenticated owner IPC และไม่อ่าน credential ส่วน `doctor` เป็นคำสั่งตรวจแบบ explicit: ตรวจ executable, credential availability, local `/healthz`, managed `/ready` และ public `/healthz` แยกกัน Public health ที่ผ่านไม่ได้แปลว่า AI client เชื่อมต่ออยู่

## การเก็บ Tunnel token

- `--os-credential`: macOS Keychain, Windows Credential Manager หรือ Linux Secret Service
- `--token-env OWNER_SELECTED_NAME`: สำหรับ headless/CI โดย config เก็บเฉพาะชื่อตัวแปร
- `--token-file /absolute/private/path`: owner-private regular file, ห้าม symlink/hardlink

DODO ไม่รับ token เป็น CLI argument และไม่ใส่ token ใน `cloudflared` argv โดยส่งผ่าน environment ของ child ที่สร้างเองเท่านั้น Tunnel diagnostics ถูกจำกัดขนาดและ redact ก่อนเขียนลง private state MCP jobs จะไม่ได้รับ `TUNNEL_TOKEN` หรือ `TUNNEL_TOKEN_FILE` แม้ owner จะใส่ชื่อไว้ใน environment allowlist

managed mode ใช้ bounded restart หลัง `cloudflared` จบ retry ของตัวเอง และ `stop` ส่งสัญญาณเฉพาะ live child handle ที่ supervisor เป็นผู้สร้าง ไม่มีการ kill saved PID หรือ process ชื่อเหมือนกัน

## Client setup

1. ใช้ `https://mcp.example.com/mcp` ใน MCP client
2. เลือก OAuth
3. คัดลอก exact callback จาก client
4. ลงทะเบียนด้วย `dodo auth add-client --redirect-uri ...`
5. ทำ browser authorization และ approve interaction จาก terminal
6. scan tools และตรวจ surface ที่ client รายงาน

## หลายโปรเจกต์

หนึ่ง DODO process มี active workspace เดียว ถ้าต้องการทำงานพร้อมกันหลายโปรเจกต์ ให้เปิดหลาย DODO processes ด้วย port, public origin และ config directory ที่แยกกัน แต่ละ managed tunnel ต้องใช้ metrics port ที่ไม่ซ้ำ ระบบจะไม่ให้ process หนึ่ง takeover root ที่อีก process กำลัง serve

## Security

ห้ามปิด OAuth, ใช้ Tunnel token แทน MCP OAuth, ส่ง token ใน URL หรือเปิด CORS กว้าง Tunnel provider ไม่ได้แทน owner consent ของ DODO และ DODO ไม่เรียก Cloudflare API, ไม่จัดการ DNS, ไม่สร้าง/ลบ Tunnel และไม่เปิด firewall
