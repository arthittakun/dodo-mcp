# DODO MCP 1.2.0

รุ่น 1.2.0 แก้ความกำกวมระหว่าง MCP เฉพาะเครื่องกับ `cloudflared` ที่ติดตั้งในเครื่อง
และนำสิทธิ์ `อ่าน / แก้ไข / เต็ม` กลับมาแสดงในการ์ดของทุกโปรเจกต์

## การเชื่อมต่อสามโหมด

| หน้าเว็บ | ค่า config | ผู้ดูแล `cloudflared` | ใช้ Tunnel token ใน DODO |
|---|---|---|---|
| เฉพาะเครื่อง (Loopback) | `local` | ไม่มี | ไม่ใช้ |
| Cloudflare Local (ติดตั้งในเครื่อง) | `external` | ผู้ใช้ | ไม่รับและไม่อ่าน |
| DODO Tunnel | `tunnel` | DODO | write-only ผ่าน OS credential store |

```bash
# AI ในเครื่องเท่านั้น
dodo tunnel configure --loopback

# เจ้าของติดตั้งและรัน cloudflared เอง
dodo tunnel configure --cloudflare-local --public-url https://mcp.example.com

# DODO เริ่มและหยุด cloudflared พร้อมตัวเอง
dodo tunnel configure --tunnel --public-url https://mcp.example.com --os-credential
```

ทั้ง Cloudflare Local และ DODO Tunnel ใช้ public origin เป็น OAuth issuer/MCP URL
แต่มีเพียง DODO Tunnel ที่แตะ credential หรือ supervisor Cloudflare Local ไม่อ้างว่า
connected เพียงเพราะบันทึก URL และ `dodo tunnel doctor` รายงาน process ownership แยก
จาก public health

## สิทธิ์แต่ละโปรเจกต์

หน้า **โปรเจกต์** แสดงระดับของแต่ละรายการเสมอ:

- `read` — อ่าน ค้นหา วิเคราะห์
- `edit` — เพิ่มสิทธิ์แก้ไฟล์
- `full` — เพิ่มสิทธิ์รันคำสั่งและทดสอบ

ระดับเป็นเพดานเท่านั้น สิทธิ์จริงยังเป็น intersection ของ OAuth token, live grant,
managed ACL (เมื่อเปิดโหมด managed) และระดับโปรเจกต์ จึงไม่ทำให้ read-only token เขียน
ได้ และไม่ข้าม workspace ID/epoch, approval, sandbox, path/secret guards, expected hash,
idempotency หรือ audit

โปรเจกต์เดิม migrate เป็น `full` เพื่อไม่ถอนสิทธิ์เงียบ ๆ เจ้าของลดระดับได้จากการ์ด
โปรเจกต์หรือ CLI:

```bash
dodo project access "ชื่อโปรเจกต์" --mode read
dodo project access "ชื่อโปรเจกต์" --mode edit
dodo project access "ชื่อโปรเจกต์" --mode full
```

## อัปเดต

```bash
npm install -g dodo-mcp@1.2.0
dodo --version
dodo start
```

หลังอัปเดตให้ restart DODO ค่า connection mode หรือ public origin ที่เปลี่ยนจากหน้าเว็บ
ไม่มีผลกับ process เดิมจนกว่าจะ restart

## ผลตรวจรับ

- typecheck/lint: `AUTOMATED_PASS`
- focused connection/project/OAuth/security/Chromium tests: `AUTOMATED_PASS` —
  92 passed, 1 skipped, 0 failed
- core/integration/security/compatibility: `AUTOMATED_PASS` — 726 passed,
  35 skipped, 0 failed
- packaging: `AUTOMATED_PASS` — 16/16
- production dependency audit: `AUTOMATED_PASS` — 0 vulnerabilities
- immutable release gate และ fresh registry install: ดูผลล่าสุดใน
  [TEST_REPORT.md](TEST_REPORT.md) (ยังไม่อ้างว่าผ่านจนกว่าจะ publish/verify จริง)
- Cloudflare Local ผ่าน public hostname จริง: `MANUAL_NOT_RUN`
- DODO Tunnel credential/public hostname จริงของ 1.2.0: `MANUAL_NOT_RUN`
