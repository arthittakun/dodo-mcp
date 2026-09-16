# DODO MCP — Authentication

## MCP OAuth

> **Simple Project Access Policy** — นอกจาก OAuth scopes และ client ACL แล้ว โปรเจกต์
> ที่ลงทะเบียนแต่ละตัวมีระดับของตัวเอง (`read`/`edit`/`full`) ที่เป็นเพดานเพิ่มอีกชั้น
> สิทธิ์จริง = token scopes ∩ grant scopes ∩ (personal ? grant : client ACL) ∩ ระดับโปรเจกต์
> ระดับนี้บีบได้อย่างเดียว ไม่เคยขยาย และไม่แทนที่ OAuth ดู
> [docs/PROJECTS.md](PROJECTS.md)

MCP HTTP ใช้ OAuth 2.1 authorization code + PKCE S256:

1. client discover protected resource metadata
2. client discover authorization server metadata
3. owner registers static client ใน Local Config/CLI
4. client เริ่ม authorize พร้อม exact redirect URI และ PKCE
5. owner ตรวจ interaction และ approve ผ่าน `dodo auth approve` จาก directory ใดก็ได้
6. client แลก code เป็น access token
7. login สร้าง installation identity และ scope ceiling
8. โหมดส่วนตัวใช้ scope นี้กับทุกโปรเจกต์ที่ owner ลงทะเบียน; โหมด managed ให้ owner เพิ่ม client access แยกต่อโปรเจกต์
9. ทุก MCP request ตรวจ token, scope, resource audience, installation identity, access mode และ target policy ปัจจุบัน

ไม่มี dynamic client registration เป็นค่าเริ่มต้น และไม่มี client-credentials flow สำหรับ owner tools

## Scopes และ access mode

OAuth scope เป็นเพดานความสามารถระดับกว้าง:

- `dodo:read` อ่าน/วิเคราะห์
- `dodo:write` แก้ resource ที่ policy อนุญาต
- `dodo:exec` รัน command/job หรือ effectful operation ที่ policy อนุญาต

ค่าเริ่มต้น `personal` เหมาะกับเครื่องเจ้าของคนเดียว: client ที่ owner อนุมัติใช้
โปรเจกต์ที่ owner ลงทะเบียนได้ตาม scopes โดยไม่ต้องสร้าง workspace ACL ซ้ำ และ
effective trust เป็น `trusted` ส่วน `managed` ใช้ intersection ของ OAuth scope,
workspace ACL และ trust ต่อโปรเจกต์ Profile ลด scopes ได้เสมอและเพิ่มสิทธิ์ไม่ได้

ทั้งสองโหมดยังคงตรวจ workspace ID/epoch, path/secret/link guards, expected hash,
idempotency, live grant/revocation และ command sandbox การ revoke grant ทำให้ request
ใหม่ถูกปฏิเสธ และ resource handle ที่ sensitive ต้อง re-check ตาม service contract

OAuth client registration, pending consent, approve, deny และ revoke เป็นระดับ installation
ไม่ขึ้นกับ CWD หรือโปรเจกต์ที่หน้าเว็บกำลังเลือก `tools/list` จึงใช้เชื่อมต่อและ scan
catalog ได้ก่อนเลือก default project ใน personal mode โปรเจกต์พร้อมใช้ทันทีหลัง owner
ลงทะเบียน path; managed mode จะได้ `WORKSPACE_ACCESS_REQUIRED` จนกว่า owner ให้ ACL

## Local Config owner auth

Local Config ใช้ capability token ที่ส่งผ่าน fragment/secure local flow ไม่ส่ง token ให้ server ใน query string ระบบตรวจ loopback bind, Host/Origin, forwarded headers, expiration และ rate limit

อย่าใส่ URL ที่มี token ใน chat, issue, log หรือ screenshot

## Workspace switch

OAuth login และ installation identity คงอยู่ได้ แต่ target authority และ workspace
context ถูกประเมินใหม่เมื่อ active/default workspace เปลี่ยน Client ต้องเรียก
`project_overview` เพื่อรับ ID/epoch ใหม่

## Troubleshooting

- 401: ตรวจ OAuth discovery และ token
- workspace access required: เพิ่ม target ลง Project Registry; ถ้าใช้ managed mode ให้ owner เพิ่ม client ACL ด้วย
- stale workspace: เรียก overview ใหม่หลัง restart/switch
- approval required: ตรวจ pending approval และอนุมัติ exact digest จาก terminal
- redirect mismatch: ลงทะเบียน callback แบบ exact string
