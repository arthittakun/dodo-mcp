# DODO MCP — Loopback, Cloudflare Local และ DODO Tunnel

DODO มีโหมดเชื่อมต่อระดับ installation เพียงหนึ่งโหมดในแต่ละเวลา:

- `local` — **เฉพาะเครื่อง (Loopback)** ใช้ MCP ที่
  `http://127.0.0.1:21730/mcp` และไม่ใช้ Cloudflare
- `external` — **Cloudflare Local (ติดตั้งในเครื่อง)** เจ้าของติดตั้งและรัน `cloudflared` เอง
  DODO advertise public HTTPS origin แต่ไม่รับ token และไม่เริ่ม/หยุด process
- `tunnel` — ใช้ public HTTPS origin เป็น MCP URL หลัก และ DODO เริ่ม/หยุด
  `cloudflared` ของตัวเองพร้อมทุก `dodo start`

การเลือกจะถูกบันทึกใน private global config และไม่มี fallback อัตโนมัติ หากเลือก
`tunnel` แล้ว credential, executable หรือ readiness ไม่พร้อม การเริ่ม DODO จะล้มเหลว
พร้อมคำอธิบาย โดยไม่เปลี่ยนไปเปิด local แทน

## พอร์ตและขอบเขต

| บริการ | ค่าเริ่มต้น | การเปิดเผย |
|---|---:|---|
| MCP + OAuth upstream | `127.0.0.1:21730` | bind loopback เสมอ; Cloudflare ทั้งสองโหมด route มาที่พอร์ตนี้ |
| Local Config | `127.0.0.1:21731` | Loopback เท่านั้นเสมอ |
| Tunnel readiness/metrics | `127.0.0.1:21732` | Loopback เท่านั้นเสมอ |

Cloudflare public hostname ต้อง route **ทุก path** มาที่
`http://127.0.0.1:21730` เพื่อให้ health, OAuth discovery, authorization และ `/mcp`
ทำงานครบ ห้าม route พอร์ต 21731, 21732, private IPC หรือ debug endpoint ออก public

โหมด Cloudflare ทั้งสองแบบยังต้องมี listener 21730 เป็น private upstream ให้
`cloudflared` แต่ DODO จะ advertise public HTTPS URL เป็น endpoint ที่มีผล ส่วน Local Config ยังคง
เข้าผ่าน loopback ยกเว้น bounded `/config` lease ที่เจ้าของเปิดชั่วคราวเอง

## เลือกเฉพาะเครื่อง (Loopback)

```bash
dodo tunnel configure --loopback
dodo start
```

ตรวจค่าที่ใช้อยู่:

```bash
dodo tunnel status
```

Loopback mode ไม่ใช้ public origin และไม่เริ่ม Tunnel หากต้องการกลับไป Cloudflare ต้องเลือก
ใหม่อย่างชัดเจนด้วยคำสั่งหรือหน้า Local Config แล้ว restart DODO

`--local` ยังเป็น alias เดิมของ `--loopback` เพื่อไม่ทำให้สคริปต์เก่าตีความต่างไป

## เลือก Cloudflare Local (ติดตั้งในเครื่อง)

โหมดนี้ใช้เมื่อผู้ใช้ติดตั้งและรัน `cloudflared` เอง เช่นผ่าน terminal, launchd,
systemd หรือ Windows Service DODO ไม่ขอ Tunnel token และไม่อ้างว่า process เชื่อมต่อแล้ว
เพียงเพราะบันทึก public URL

```bash
dodo tunnel configure \
  --cloudflare-local \
  --public-url https://mcp.example.com

# รัน cloudflared ด้วยวิธีที่ผู้ใช้จัดการเอง แล้วจึงเปิด DODO
dodo start
```

Cloudflare ต้อง route ทุก path ไป `http://127.0.0.1:21730` เช่นเดียวกับ DODO Tunnel
ตรวจปลายทางจริงด้วย `dodo tunnel doctor` ค่า public health ที่ผ่านยืนยันเพียงว่า origin
ตอบ DODO health ไม่ได้ยืนยันว่ามี AI client เชื่อมอยู่

## เลือก DODO Tunnel

เจ้าของต้องสร้าง remotely-managed Tunnel, public hostname และ DNS ใน Cloudflare ก่อน
DODO ไม่สร้าง/ลบ Tunnel, เปลี่ยน DNS, เปิด firewall หรือติดตั้ง system service

บน macOS ตรวจหรือติดตั้ง executable ผ่าน setup:

```bash
dodo setup --check --components cloudflared
dodo setup --yes --components cloudflared
```

จากนั้นเลือก Tunnel และบันทึก token ใน macOS Keychain ผ่าน hidden prompt:

```bash
dodo tunnel configure \
  --tunnel \
  --public-url https://mcp.example.com \
  --os-credential

dodo start
```

Windows ใช้ Credential Manager และ Linux ใช้ Secret Service เมื่อเลือก
`--os-credential` สำหรับ headless environment สามารถใช้ owner-controlled reference:

```bash
dodo tunnel configure --tunnel --public-url https://mcp.example.com --token-env DODO_OWNER_TUNNEL_TOKEN
# หรือไฟล์ private regular file ที่เป็น absolute path
dodo tunnel configure --tunnel --public-url https://mcp.example.com --token-file /private/path/tunnel-token
```

ค่า environment/file เป็น reference ที่เจ้าของดูแลเอง คำสั่งตรวจค่าและไฟล์ก่อนบันทึก
แต่ไม่คัดลอก token เข้า config เมื่อใช้หน้า Local Config token จะเป็น write-only และ
ถูกส่งตรงไปยัง OS credential store; หลังบันทึก UI แสดงเพียงว่ามี credential

ทุก `dodo start` ใน Tunnel mode จะอ่าน credential จาก reference เริ่ม `cloudflared`
ผ่าน child environment และรอ readiness ก่อนถือว่า startup สำเร็จ Token ไม่อยู่ใน
CLI argument, config JSON, log, audit, MCP response, browser storage หรือ environment
ของ MCP jobs เมื่อ DODO หยุด child ที่ process นี้เป็นเจ้าของจะหยุดตาม

## เปลี่ยนโหมดจากหน้าเว็บ

เปิด Local Config จาก URL ที่ DODO แสดงบนเครื่องเจ้าของ แล้วใช้ส่วน
**การเชื่อมต่อ MCP**:

1. ตั้ง Public origin เป็น HTTPS origin ของ Tunnel
2. เลือก `Cloudflare Local (ติดตั้งในเครื่อง)` หากจะรัน cloudflared เอง หรือ `DODO Tunnel` หากให้
   DODO ดูแล process
3. ใส่ Cloudflare Tunnel token เฉพาะ `DODO Tunnel`
4. กดบันทึกและ restart DODO

หรือเลือก `เฉพาะเครื่อง (Loopback)` แล้วบันทึกและ restart ค่าในหน้าเว็บไม่เปลี่ยน endpoint ของ process
ที่กำลังรันอยู่ทันที หน้าเว็บจะแสดงสถานะ restart ที่ตรงกับ runtime จริง

## Remote Config ไม่เกินหนึ่งชั่วโมง

Remote Config ใช้ได้เมื่อเลือก Cloudflare Local (ติดตั้งในเครื่อง) หรือ DODO Tunnel:

```bash
dodo --web
# Remote Config: https://mcp.example.com/config
# Pairing code (shown once): XXXX-XXXX-XXXX-XXXX

dodo web --status
dodo web --close
```

ในโหมด Cloudflare Local (ติดตั้งในเครื่อง) เจ้าของต้องรัน tunnel และ route ครบเอง ส่วน DODO Tunnel
จะตรวจว่า supervisor ที่ DODO เป็นเจ้าของกำลังรันก่อนเปิด lease

`/config` ตอบ 404 ตามค่าเริ่มต้น คำสั่ง `dodo --web` เปิดหรือเปลี่ยน lease ผ่าน
authenticated private IPC โดยไม่ restart MCP และไม่รับ Tunnel token ผ่าน IPC URL ไม่มี
query/fragment secret Pairing code มีอายุสั้นและใช้ได้ครั้งเดียว หลังจับคู่ browser ได้
cookie แบบ `Secure`, `HttpOnly`, `SameSite=Strict`, `Path=/config` Lease ปิดเองภายใน
หนึ่งชั่วโมง การเปิดใหม่ยกเลิก code/session เดิม

Remote Config proxy ไปยัง Local Config loopback โดยคง Host/Origin/proxy-header checks,
private capability, rate limit, workspace ID/epoch และ owner policy เดิม การปิด lease
ไม่หยุด MCP หรือ Tunnel และไม่มี MCP tool สำหรับเปิดหน้า owner นี้

## ตรวจสถานะและแก้ปัญหา

```bash
dodo tunnel status
dodo tunnel doctor
dodo tunnel logs --lines 100
dodo tunnel stop
```

### สถานะของ Tunnel (state machine)

`phase` ของ supervisor มีค่าเหล่านี้ และเปลี่ยนตามหลักฐานจริงเท่านั้น:

| phase | ความหมาย |
|---|---|
| `starting` | supervisor เริ่มทำงาน ยังไม่ spawn cloudflared |
| `connecting` | cloudflared รันแล้ว แต่ยัง **ไม่เคย** มีหลักฐาน readiness |
| `connected` | `/ready` ตอบ 200 — ต้องมีหลักฐานจริงเท่านั้นจึงแสดงสถานะนี้ |
| `degraded` | เคย connected แล้ว probe เริ่มล้ม แต่ยังไม่ถึงเกณฑ์ (กำลัง reconnect) |
| `disconnected` | probe ล้มติดกันครบเกณฑ์ หรือ cloudflared exit |
| `backoff` | รอ restart แบบมีขอบเขต |
| `stopping` / `stopped` / `failed` | เจ้าของสั่งหยุด / หยุดแล้ว / restart หมดโควตา |

สถานะยังมี `lastReadyAt`, `lastFailureAt` และ `consecutiveReadyFailures` เพื่อให้ดูได้ว่า
readiness สำเร็จครั้งสุดท้ายเมื่อไร

**ทำไมเมื่อก่อนสถานะกระพริบ** — เดิม probe ทุก 1 วินาทีโดย timeout 1.5 วินาที
จึงซ้อนกันได้ ผลเก่าเขียนทับผลใหม่ และ probe ที่ล้ม **ครั้งเดียว** ก็พลิกสถานะและพิมพ์
`readiness endpoint is not connected` ทันที ตอนนี้:

- probe ทำทีละครั้ง ไม่ซ้อนกัน และมี generation fence ผลจาก child เก่าถูกทิ้ง
- ต้องล้มติดกันครบเกณฑ์จึงจะเป็น `disconnected` — ล้มครั้งเดียวเป็นแค่ `degraded`
  และ `connected` ยังเป็น true เพื่อไม่ให้ UI กระพริบ
- ใช้ socket ใหม่ทุกครั้ง (`agent: false`) กัน keep-alive socket ที่ถูกปิดแล้ว
  กลายเป็น error ปลอม
- เขียน log ของ cloudflared แบบรวมกลุ่ม ไม่เขียนทับไฟล์ 512 KiB ทุกบรรทัด
  (บน Windows การ retry rename ใช้ `Atomics.wait` ซึ่งบล็อก event loop จน probe timeout)
- cloudflared exit → `disconnected` ทันที, restart มีขอบเขตตาม `maxRestarts` เสมอ
- ไม่มี fallback เงียบ ๆ จาก tunnel ไป local และ token ไม่ปรากฏใน log หรือ error

Tunnel เป็นระดับ installation รองรับทุกโปรเจกต์ การเพิ่มหรือเลือกโปรเจกต์ไม่ restart tunnel

`status` ไม่อ่าน credential ส่วน `doctor` ตรวจ executable, local health และ public
health ทุกโหมด แต่ตรวจ credential/supervisor readiness เฉพาะ DODO Tunnel ใน
Cloudflare Local รายงาน process ownership เป็น `owner` และไม่ควบคุม process Public
health ที่ผ่านพิสูจน์เพียงว่า origin ตอบ DODO health ไม่ได้พิสูจน์ว่า AI client
เชื่อมต่อแล้ว `stop` ส่งสัญญาณเฉพาะ live child handle ที่ DODO supervisor ปัจจุบัน
สร้าง ไม่ค้นหรือ kill process ตามชื่อ/PID เก่า

## ตั้งค่า MCP client

1. ใช้ `https://mcp.example.com/mcp`
2. เลือก OAuth
3. คัดลอก exact callback URL จาก client
4. ลงทะเบียนด้วย `dodo auth add-client --redirect-uri <exact-callback>`
5. ทำ browser authorization และ approve interaction จาก owner terminal
6. scan tools และตรวจ surface ที่ client รายงาน

หนึ่ง Tunnel รองรับ project registry ทั้ง installation ไม่ต้องสร้าง Tunnel ต่อโปรเจกต์
แต่ทุก target ยังตรวจ OAuth identity, target ACL/scopes, workspace identity/epoch,
trust/approval, path/secret guards, sandbox และ expected hash ตามเดิม
