# DODO MCP — เชื่อม ChatGPT และ Web Clients

## สิ่งที่ต้องแยกให้ออกก่อน

| ค่า | ใช้ตรงไหน | ตัวอย่าง |
|---|---|---|
| Public origin | โดเมน HTTPS ที่ Cloudflare Tunnel ของเจ้าของให้บริการ | `https://dodo.example.com` |
| MCP Server URL | กรอกในหน้าเพิ่ม MCP ของ ChatGPT | `https://dodo.example.com/mcp` |
| OAuth callback | ลงทะเบียนกับ DODO ผ่าน `auth add-client` | `https://chatgpt.com/connector_platform_oauth_redirect` |

OAuth callback ไม่ใช่ URL สำหรับเปิดหรือติดตั้ง MCP และต้องคัดลอกเป็น URL ธรรมดา
ห้ามใส่ `[https://...](https://...)` เพราะนั่นเป็น Markdown ไม่ใช่ URI

## เชื่อม ChatGPT แบบครบขั้นตอน

### 1. อัปเดตและตรวจ DODO

```bash
npm install -g dodo-mcp@latest
dodo --version
dodo setup --check
```

### 2. ตั้ง Public MCP ผ่าน DODO Tunnel

เจ้าของต้องสร้าง Cloudflare Tunnel, public hostname และ DNS ไว้ก่อน โดย route
**ทุก path** ไปที่ `http://127.0.0.1:21730` ห้าม route Local Config `21731` หรือ
metrics `21732` ออกสาธารณะ

```bash
dodo tunnel configure \
  --tunnel \
  --public-url https://dodo.example.com \
  --os-credential
```

แทน `https://dodo.example.com` ด้วย hostname จริงของคุณ Prompt จะรับ Tunnel token
ผ่าน OS credential store; token ไม่ควรอยู่ใน command line, chat หรือ repository

### 3. ลงทะเบียน ChatGPT OAuth client

คัดลอกคำสั่งนี้ตรง ๆ อย่าเติม `\` หน้า `--` และอย่าวาง Markdown link แทน URL:

```bash
dodo auth add-client \
  --name "ChatGPT" \
  --redirect-uri "https://chatgpt.com/connector_platform_oauth_redirect"
```

DODO รองรับ RFC 9207 issuer identification จึงใช้ stable callback นี้ได้ คำสั่งจะ
แสดง `client_id` และ `client_secret` เพียงครั้งเดียว เก็บทั้งสองค่าใน client config
ของ ChatGPT และห้ามส่งให้ผู้อื่น หากทำหายให้สร้าง client ใหม่แทนการค้น secret เดิม

### 4. เปิด DODO

```bash
dodo start
```

ให้ terminal นี้เปิดค้างไว้ ใน Tunnel mode DODO จะเริ่มและดูแล `cloudflared` ของตัวเอง
ตรวจสถานะได้โดยไม่เปิดเผย credential:

```bash
dodo tunnel status
dodo tunnel doctor
```

### 5. เพิ่ม MCP ใน ChatGPT

1. เปิด ChatGPT web แล้วไปที่ **Settings → Security and login**
2. เปิด **Developer mode**
3. ไปที่ <https://chatgpt.com/plugins> แล้วกด `+`
4. ตั้งชื่อ เช่น `DODO MCP`
5. กรอก **MCP Server URL** เป็น `https://dodo.example.com/mcp`
6. เลือก Authentication เป็น **OAuth**
7. กรอก OAuth Client ID และ Client Secret ที่ได้จากขั้นตอน 3
8. กด Connect, Create หรือ Scan Tools ตามข้อความที่หน้า ChatGPT แสดง

ชื่อเมนูย่อยอาจเปลี่ยนตามแผนบัญชีหรือ workspace policy แต่ MCP URL ต้องเป็น public
HTTPS URL ที่ลงท้ายด้วย `/mcp` และ Authentication ต้องเป็น OAuth เสมอ

### 6. อนุมัติ OAuth จากเครื่องเจ้าของ

หลัง ChatGPT เริ่ม authorization และหน้า browser กำลังรอ เปิด terminal อีกหน้าต่าง:

```bash
dodo auth pending
```

ตรวจ request ID และวลีเทียบกับหน้า browser แล้วอนุมัติเฉพาะรายการที่ตรงกัน:

```bash
dodo auth approve REQUEST_ID
```

ไม่ต้องใส่ `--` หน้า ID หาก `pending` ไม่พบรายการ แปลว่า ChatGPT ยังไม่ได้เริ่ม
authorization, DODO ไม่ได้รัน หรือ public OAuth routes เข้าไม่ถึง

### 7. ทดสอบใน ChatGPT

กลับไปให้ tool scan เสร็จ เริ่ม conversation ใหม่ เลือก DODO จาก Developer mode แล้วส่ง:

```text
ใช้ DODO MCP เรียก project_overview แล้วรายงานชื่อโปรเจกต์ toolSurface และจำนวน tools
```

หากยังไม่มี project ให้เปิด `dodo --cli` หรือ Local Config URL ที่ startup แสดง แล้ว
เพิ่ม absolute path ภายหลังได้ OAuth client ไม่ผูกกับ CWD ที่ใช้รัน `auth add-client`

## แก้ปัญหาที่พบบ่อย

| อาการ | วิธีตรวจและแก้ |
|---|---|
| ChatGPT ต่อไม่ได้ | รัน `dodo tunnel doctor` และตรวจว่า hostname route ทุก path ไป `127.0.0.1:21730` |
| Redirect URI mismatch | ลบ client ที่ลงทะเบียนผิดแล้วสร้างใหม่ด้วย callback แบบ exact string ตาม code block |
| `dodo auth pending` ว่าง | กด Connect/Scan Tools ใน ChatGPT ก่อน และให้ `dodo start` ยังรันอยู่ |
| ได้ 404 จาก OAuth หรือ discovery | Tunnel route มาเฉพาะ `/mcp`; แก้ให้ route ทุก path เพราะ OAuth ใช้ `/.well-known/...`, `/auth`, `/interaction`, `/token` และ `/jwks` ด้วย |
| เห็น tools เก่า/เรียกแล้ว not found | เปิด connection ใน ChatGPT แล้ว Refresh; หาก cache ยังไม่เปลี่ยนให้ลบและสร้าง connection ใหม่ |
| ยังไม่เห็น Sub-agent operations | เปิด **Settings → Sub-agent tools ใน MCP** ใน Local Config แล้ว restart DODO และ rescan/recreate connection |
| operation ที่ต้องการหายจาก discover/gateway | ตรวจ **Settings → Tools ที่ AI มองเห็น** แล้วเปิด operation, restart DODO และ rescan/recreate connection |

ห้ามส่ง `client_secret`, access token, refresh token, Cloudflare Tunnel token หรือ URL
ของ Local Config ให้ผู้ช่วย AI เพื่อแก้ปัญหา ใช้เฉพาะสถานะและ redacted logs จาก
`dodo tunnel status`, `dodo tunnel doctor` และ `dodo tunnel logs`

## Compact behavior

HTTP default เป็น Compact surface สูงสุด 20 tools ประกอบด้วย overview, `dodo_discover` และ gateways client จะค้น operation ที่ต้องการจาก discover แล้วเรียก gateway พร้อม top-level workspace context จำนวนจริงอาจต่ำลงเมื่อเจ้าของปิด operations ครบทั้ง gateway

Compact ไม่ลด security และไม่ได้รวมสิทธิ์หลาย operation เป็น approval เดียว target operation ยังคงมี scope, ACL, trust, approval, hash และ path policy ของตัวเอง

เจ้าของซ่อน operation ที่ไม่ใช้จาก **Settings → Tools ที่ AI มองเห็น** ได้ การเปลี่ยนนี้
ลด schema ของ Compact/Hybrid จริงและเอา direct duplicate ออกจาก Hybrid แต่ไม่เปลี่ยน
Full/STDIO หรือ permission ใด ๆ ต้อง restart server และ rescan/recreate client หลังบันทึก

## Client cache

client บางตัว cache tool catalog หลังสร้าง connection หาก schema หรือ surface เปลี่ยน ให้ refresh ตาม client หรือ recreate connection เมื่อ refresh ไม่ได้ล้าง catalog เดิม

## Manual evidence

บันทึกจำนวน tools ที่ client แสดงจริง, response ของ overview, write/edit read-back และ error cases แยกจาก automated test อย่ารายงานว่า web client ผ่านจาก server log เพียงอย่างเดียว

## Delegate งานด้วย AI profile ของเจ้าของ

ค่าเริ่มต้นซ่อน Sub-agent operations จาก MCP เพื่อให้ catalog งานทั่วไปกระชับขึ้น ก่อน
delegate จาก ChatGPT/remote MCP ให้เจ้าของเปิด **Settings → Sub-agent tools ใน MCP**
แล้ว restart DODO และ rescan/recreate connection หน้าเว็บ Chat & Tasks ใช้ได้แม้สวิตช์ปิด

เมื่อเปิดแล้ว ChatGPT/remote MCP ใช้ `project_overview(targetProjectId)`
เพื่อรับ context และ `ai.profiles` เฉพาะที่อนุญาต แล้ว `dodo_discover` หา
`subagent_spawn` ผ่าน `dodo_assist_change` ตรวจผลด้วย `subagent_result` ผ่าน
`dodo_assist_read` รูปแบบ top-level target/context เหมือน read/write tools
ไม่ใส่ key ในแชตหรือ tool args; เจ้าของตั้งผ่าน private Local Config เท่านั้น

การมี MCP OAuth scopes ไม่ได้อนุญาต provider egress โดยอัตโนมัติ ต้องมี target ACL,
profile/client allowlist และ trust/approval เดิม งานหลาย projects สร้างหนึ่ง run ต่อ
project; ผลลัพธ์คืน run ID/receipts ไม่มี internal reasoning และ retry ด้วย key เดิม
ไม่สร้างงานซ้ำ โปรด rescan/recreate connector หากยังไม่เห็น schema ใหม่
