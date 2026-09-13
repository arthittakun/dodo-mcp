# DODO MCP — Authentication

## MCP OAuth

MCP HTTP ใช้ OAuth 2.1 authorization code + PKCE S256:

1. client discover protected resource metadata
2. client discover authorization server metadata
3. owner registers static client ใน Local Config/CLI
4. client เริ่ม authorize พร้อม exact redirect URI และ PKCE
5. owner ตรวจ interaction และ approve ผ่าน `dodo auth approve`
6. client แลก code เป็น access token
7. ทุก MCP request ตรวจ token, scope, resource audience, installation identity และ workspace ACL

ไม่มี dynamic client registration เป็นค่าเริ่มต้น และไม่มี client-credentials flow สำหรับ owner tools

## Scopes and ACL

scope เป็นเพียงความสามารถระดับกว้าง ส่วนสิทธิ์ที่มีผลจริงต้องผ่าน workspace ACL และ local policy ด้วย:

- `dodo:read` อ่าน/วิเคราะห์
- `dodo:write` แก้ resource ที่ policy อนุญาต
- `dodo:exec` รัน command/job หรือ effectful operation ที่ policy อนุญาต

การ revoke grant ทำให้ request ใหม่ถูกปฏิเสธ และ resource handle ที่ sensitive ต้อง re-check ตาม service contract

## Local Config owner auth

Local Config ใช้ capability token ที่ส่งผ่าน fragment/secure local flow ไม่ส่ง token ให้ server ใน query string ระบบตรวจ loopback bind, Host/Origin, forwarded headers, expiration และ rate limit

อย่าใส่ URL ที่มี token ใน chat, issue, log หรือ screenshot

## Workspace switch

OAuth login และ installation identity คงอยู่ได้ แต่ workspace ACL และ workspace context ถูกประเมินใหม่เมื่อ active workspace เปลี่ยน client ต้องเรียก `project_overview` เพื่อรับ ID/epoch ใหม่

## Troubleshooting

- 401: ตรวจ OAuth discovery และ token
- workspace access required: owner ต้องให้ client access ใน Local Config
- stale workspace: เรียก overview ใหม่หลัง restart/switch
- approval required: ตรวจ pending approval และอนุมัติ exact digest จาก terminal
- redirect mismatch: ลงทะเบียน callback แบบ exact string
