# เชื่อม DODO MCP กับ AI platforms

คู่มือสำหรับเจ้าของ DODO ตรวจเอกสารของ client เมื่อ 25 กันยายน 2026
ชื่อเมนูอาจต่างตามรุ่นและแผนบัญชี คู่มือนี้ไม่ใช่หลักฐานว่าทดสอบกับบัญชีจริงครบทุกค่าย

## เลือกวิธีเชื่อม

| Client | วิธีในคู่มือนี้ | สิ่งที่ต้องเตรียม |
|---|---|---|
| ChatGPT web | Public HTTPS + OAuth | DODO/Tunnel ที่เปิดอยู่ และ OAuth client ของ ChatGPT |
| Claude web / Desktop Custom Connector | Public HTTPS + OAuth | OAuth client ของ Claude แยกต่างหาก |
| Claude Code | Local STDIO | DODO CLI และ absolute project path |
| Codex CLI | Local STDIO | DODO CLI และ absolute project path |
| Gemini CLI | Local STDIO | DODO CLI และ absolute project path |
| Cursor | Local STDIO | MCP JSON และ absolute project path |
| VS Code / GitHub Copilot | Local STDIO | MCP JSON และ absolute project path |

Gemini CLI ไม่ใช่ Gemini web; Claude Code ไม่ใช่ Claude Desktop Custom Connector
และการเพิ่ม API provider ในหน้า DODO ก็เป็นคนละเรื่องกับการให้ AI ภายนอกเรียก MCP

## URL แต่ละตัวใช้ทำอะไร

| ค่า | ตัวอย่าง | ใช้ทำอะไร |
|---|---|---|
| Public origin | `https://dodo.example.com` | ตั้งโดเมนใน DODO/Tunnel |
| Public MCP URL | `https://dodo.example.com/mcp` | ใส่ช่อง MCP Server URL ใน AI |
| Remote Config | `https://dodo.example.com/config` | เจ้าของตั้งค่า หลังสั่ง `dodo --web` และจับคู่ |
| Local Config | `http://127.0.0.1:21731/` | เจ้าของตั้งค่าบนเครื่อง ผ่าน private link ใน Terminal |
| OAuth callback | URL ของ AI client | ลงทะเบียนด้วย `dodo auth add-client` เท่านั้น |

แทนโดเมนตัวอย่างด้วยโดเมนจริง ห้ามนำ `/config`, private link หรือ OAuth callback
ไปกรอกเป็น MCP Server URL ห้ามวาง Markdown `[ชื่อ](URL)` ในช่อง URI

## เตรียม DODO สำหรับ web clients ครั้งเดียว

1. ติดตั้ง `npm install -g dodo-mcp@latest` แล้วตรวจ `dodo --version`
2. ตั้ง **Cloudflare Local** หากดูแล cloudflared เอง หรือ **DODO Tunnel** หากให้ DODO
   ดูแล โดยใช้ public origin จริง ดู [คู่มือ Tunnel](TUNNEL.md)
3. Tunnel ต้อง route **ทุก path** ของโดเมนไป `http://127.0.0.1:21730`
   เพื่อให้ OAuth discovery/authorize/token เข้าถึงได้ด้วย ไม่เปิด 21731 หรือ 21732
4. รัน `dodo start` และเปิดค้างไว้ ถ้ารันอยู่แล้วไม่ต้องเปิดซ้ำ
5. เพิ่มโปรเจกต์ใน Config พร้อมระดับอ่าน/แก้/รันที่ต้องการ Managed mode ต้องกำหนด
   client ACL ด้วย ส่วน personal mode ใช้ OAuth scopes ร่วมกับ project access level

รันคำสั่ง auth บนเครื่องและ OS user เดียวกับ server ใช้ `DODO_CONFIG_DIR` เดียวกัน
ทำจากโฟลเดอร์ใดก็ได้ อย่าสลับ Admin/User บน Windows แล้วคาดว่าจะเป็น installation เดียวกัน

## ChatGPT web

1. เปิด Developer mode ในบัญชี/องค์กรที่มีสิทธิ์ แล้วเปิดหน้าจัดการ MCP app/plugin
   (ปัจจุบันที่ `https://chatgpt.com/plugins`; บางบัญชียังใช้ Settings → Apps)
2. ตั้งชื่อ `DODO`, URL เป็น Public MCP URL, Authentication เป็น **OAuth**
3. สร้าง client บนเครื่อง DODO ด้วยคำสั่งบรรทัดเดียว:

```text
dodo auth add-client --name "ChatGPT" --redirect-uri "https://chatgpt.com/connector_platform_oauth_redirect"
```

4. กรอก `client_id` และ `client_secret` ที่ได้ในช่อง OAuth Client ID/Secret
   ค่านี้แสดงครั้งเดียว ไม่ใช่ API key ของ OpenAI และไม่ต้องส่งเข้าแชต
5. กด Connect/Scan Tools แล้วทำ [ขั้นตอนอนุมัติ](#อนุมัติการเชื่อมต่อจาก-terminal)
6. เปิดแชตใหม่ เลือก DODO แล้วทดสอบ overview ก่อนแก้ไฟล์

หากหน้า MCP management แสดง callback เฉพาะ connection ให้ลงทะเบียน **ค่าที่แสดงจริง**
แทนคำสั่งตัวอย่าง ห้ามใช้ wildcard หรือเดา callback ID
ดู [OAuth callback และ static client](https://developers.openai.com/plugins/build/auth)
กับ [ขั้นตอนเชื่อม ChatGPT](https://developers.openai.com/plugins/deploy/connect-chatgpt)

## Claude web / Claude Desktop Custom Connector

สร้าง client แยกจาก ChatGPT:

```text
dodo auth add-client --name "Claude" --redirect-uri "https://claude.ai/api/mcp/auth_callback"
```

ใน Claude ไปที่ **Customize → Connectors → + → Add custom connector**
(Team/Enterprise อาจต้องให้ Owner เพิ่ม connector ขององค์กรก่อน)

| ช่อง | ค่า |
|---|---|
| Name | `DODO` |
| Remote MCP server URL | `https://dodo.example.com/mcp` โดยแทนโดเมนจริง |
| Authentication | **Sign in now** |
| OAuth client | **Use your own OAuth client** |
| OAuth Client ID | `client_id` จากคำสั่ง Claude ด้านบน |
| OAuth Client Secret | `client_secret` คู่กัน |
| Request headers | เว้นว่าง |

DODO ใช้ static registration จึงไม่เลือก Register automatically (DCR) หรือ
Use Claude's published identity (CIMD) กด Add → Connect แล้วอนุมัติใน Terminal
เปิดแชตและเลือก **+ → Connectors → DODO**

ถ้า Desktop เปิด `claude.ai/login?returnTo=...` แล้วหน้าว่าง ให้ลองเข้า
`https://claude.ai/` ในเบราว์เซอร์ปกติ ล็อกอินบัญชี/องค์กรเดียวกัน และกด Connect
จากหน้าเว็บ ไม่ต้องสร้าง credentials ใหม่ ตรวจ browser extensions/cookies ถ้าแม้หน้าแรกก็ว่าง
ยังไม่ควรสรุปว่า Tunnel เสียจาก URL หน้า login เพียงอย่างเดียว

แหล่งอ้างอิง: [Claude connector setup](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp),
[callback และ static credentials](https://claude.com/docs/connectors/building)

## อนุมัติการเชื่อมต่อจาก Terminal

เมื่อ browser เปิดหน้ารออนุมัติของ DODO ให้เปิด Terminal อีกหน้าต่างบนเครื่อง DODO:

```text
dodo auth pending
```

ตรวจชื่อ client, callback, scopes และรหัสยืนยันว่าตรงกับการเชื่อมต่อที่เพิ่งเริ่ม แล้วรัน:

```text
dodo auth approve REQUEST_ID
```

แทน `REQUEST_ID` ด้วย ID จริง ไม่ใส่ `< >` หรือ `--` นำหน้า
Browser จะกลับไป AI client เมื่อสำเร็จ ไม่มี pending หมายถึงยังไม่มีคำขอรออนุมัติ
หากขึ้น no running server ให้ตรวจเครื่อง, OS user, state directory และ server ที่เปิดอยู่
เก็บ Client Secret ในช่องตั้งค่า client เท่านั้น ไม่ใส่ URL/headers/log/แชต

## Claude Code และ Codex CLI ในเครื่อง

แทน `/absolute/path/to/project` ด้วยโฟลเดอร์จริง และติดตั้ง DODO ให้เรียกจาก PATH ได้
ให้ AI client เป็นผู้เปิด STDIO subprocess; ไม่ต้องเปิด `dodo start` สำหรับ subprocess นี้
อย่าเปิดหลาย DODO processes ครอบ root เดียวกัน หาก root ถูกใช้อยู่ให้เลือก HTTP connection
หรือปิด process เดิมด้วยเจ้าของก่อน

Claude Code:

```text
claude mcp add --transport stdio --scope user dodo -- dodo stdio --root "/absolute/path/to/project"
```

ตรวจด้วย `claude mcp list` และ `/mcp` ใน Claude Code
อ้างอิง [Claude Code MCP](https://code.claude.com/docs/en/mcp)

Codex CLI:

```text
codex mcp add dodo -- dodo stdio --root "/absolute/path/to/project"
codex mcp list
```

อ้างอิง [Codex MCP](https://developers.openai.com/codex/mcp/)

## Gemini CLI และ Cursor

Gemini CLI: เพิ่ม entry นี้ใน **user** `~/.gemini/settings.json` โดยรวมกับค่าเดิม
อย่าเขียนทับทั้งไฟล์ ส่วน Cursor ใช้ **user** `~/.cursor/mcp.json` รูปแบบเดียวกัน:

```json
{
  "mcpServers": {
    "dodo": {
      "command": "dodo",
      "args": ["stdio", "--root", "/absolute/path/to/project"]
    }
  }
}
```

เปิด client ใหม่ ตรวจ Gemini ด้วย `gemini mcp list` หรือ `/mcp`
และตรวจ Cursor ที่หน้าจัดการ MCP ของ Settings
อ้างอิง [Gemini CLI MCP](https://geminicli.com/docs/tools/mcp-server/)
และ [Cursor MCP](https://cursor.com/docs/mcp)

## VS Code / GitHub Copilot

เปิด Command Palette → **MCP: Open User Configuration** แล้วรวม entry นี้กับ config เดิม:

```json
{
  "servers": {
    "dodo": {
      "type": "stdio",
      "command": "dodo",
      "args": ["stdio", "--root", "/absolute/path/to/project"]
    }
  }
}
```

ใช้ **MCP: List Servers** เริ่ม server แล้วเลือก tools ใน chat
อ้างอิง [VS Code MCP](https://code.visualstudio.com/docs/agent-customization/mcp-servers)

### Windows และ GUI ที่หา dodo ไม่พบ

ใช้ path รูปแบบ `C:/Users/YourName/Projects/demo` ใน JSON เพื่อลดปัญหา backslash
ถ้า client เปิด npm command shim ไม่ได้ ให้ใช้ Node กับ entry point จริง:

1. รัน `where.exe node` และ `npm root -g`
2. ตั้ง `command` เป็น absolute path ของ `node.exe`
3. ตั้ง `args` เป็น `["GLOBAL_NPM_ROOT/dodo-mcp/dist/cli/main.js", "stdio", "--root", "C:/path/to/project"]`
   โดยแทน `GLOBAL_NPM_ROOT` ด้วยผลจริง

macOS/Linux GUI ที่ PATH ต่างจาก Terminal ใช้รูปแบบ Node + absolute entry point ได้เช่นกัน
Local STDIO ใช้ OS-owner principal; trust/approval, sandbox และ file guards ยังมีผล
ไม่ได้เปิด anonymous HTTP หรือข้าม OAuth ของ public MCP

## AI platform อื่น

ใช้ remote MCP ได้เมื่อ client รองรับ Streamable HTTP, OAuth code + PKCE S256
และให้กรอก static Client ID/Secret ได้ คัดลอก callback **จาก client นั้นจริง** แล้วลงทะเบียน:

```text
dodo auth add-client --name "My AI client" --redirect-uri "EXACT_CALLBACK_FROM_CLIENT"
```

ตัวอย่าง callback placeholder ไม่ใช่ URL ใช้งานจริง หาก client บังคับ DCR/CIMD
โดยไม่มี static credentials ให้ตรวจ compatibility ก่อน อย่าแก้ด้วย No sign-in
หรือใช้ token ของหน้า Config เป็น MCP credential

## ทดสอบและแก้ปัญหา

เริ่มด้วย prompt:

> ใช้ DODO เรียก project_overview แล้วบอกโปรเจกต์ที่ฉันเข้าถึงได้ ยังไม่ต้องแก้ไฟล์

จากนั้นเลือกโปรเจกต์ fixture และทดสอบ create → read → edit → read-back → delete
ใช้ `dodo_discover` ใน Compact เมื่อหาความสามารถไม่เจอ

| อาการ | ตรวจอะไร |
|---|---|
| invalid_client | ใช้ ID/Secret คู่เดียวกัน และ client ยังไม่ถูกลบ |
| redirect_uri ไม่ตรง | คัดลอก exact callback ของ client ไม่ใช้ callback ข้ามค่าย |
| ไม่เห็น tools ใหม่ | Refresh/rescan; ถ้ายัง cache เดิมให้สร้าง connection ใหม่ตาม client |
| WORKSPACE_ACCESS_REQUIRED | เพิ่มโปรเจกต์และตรวจ access level/scopes; managed mode ตรวจ ACL |
| STALE_WORKSPACE | เรียก project_overview ใหม่หลัง server restart/เปลี่ยน workspace |
| Remote Config แจ้ง 8 ชั่วโมง | อัปเป็น 1.3.1+, restart เพื่อโหลดแพตช์หนึ่งครั้ง แล้วใช้ dodo --web |
| `/config` เป็น 404 | lease ปิด/หมดอายุ ให้เจ้าของรัน dodo --web และจับคู่ใหม่ |

ตั้งแต่ 1.3.1 `dodo --web` สร้าง session ของโดเมนแยกจาก Local Config 8 ชั่วโมง
เปิดใหม่ได้แม้ process ทำงานหลายวัน แต่ละครั้งอยู่ได้ 1 ชั่วโมงและยังต้อง pairing
การเปิด/ปิด Config ไม่ทำให้ MCP/OAuth/Tunnel หยุด ไม่ต้องต่ออายุหน้าเว็บเพื่อให้ AI ทำงานต่อ

**สถานะตรวจรับ:** server HTTP/OAuth, STDIO และ Config มี automated fixture tests
ส่วนการล็อกอินและเรียก tools จากบัญชีจริงในแต่ละ AI platform เป็น `MANUAL_NOT_RUN`
สำหรับแพตช์นี้ ไม่ถือว่ามีคู่มือแล้วเท่ากับผ่าน live integration
