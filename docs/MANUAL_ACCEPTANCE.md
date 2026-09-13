# DODO MCP — Manual Acceptance

ผล manual ต้องบันทึกเป็น `MANUAL_PASS` หรือ `MANUAL_NOT_RUN` พร้อมวันเวลาและ environment ห้ามเดาผลจาก automated test

## Local Config

1. รัน `dodo start` จาก fixture project
2. เปิด Local Config URL จาก terminal
3. ตรวจ root, absolute path, MCP status, OAuth status และ config listener
4. เปลี่ยนไปยัง fixture project B
5. ตรวจว่า overview จาก MCP เห็น B จริง
6. ตรวจ workspace ID/epoch เปลี่ยน และหน้าเว็บแจ้งให้โหลด context ใหม่
7. กลับไป A แล้วตรวจว่า ACL/trust ไม่ปะปน

## Workspace safety

1. เริ่ม job ที่ยังทำงานอยู่
2. ลองเปลี่ยน workspace
3. ต้องถูกปฏิเสธพร้อมบอกให้รอหรือ cancel job
4. ทำให้ target bootstrap ล้มเหลว
5. ตรวจว่า workspace เดิมยังเรียก tool ได้

## HTTP Compact

1. เชื่อม MCP ด้วย OAuth
2. ตรวจ `listTools` มี 19 tools และมี `project_overview`, `dodo_discover`, gateways
3. เรียก overview
4. discover `write_file`
5. สร้างไฟล์ fixture ผ่าน `dodo_write`
6. อ่านกลับผ่าน `dodo_read`
7. แก้ด้วย expected hash
8. ทำ external change แล้วตรวจ conflict
9. ลบ fixture

## STDIO Full

1. รัน `dodo stdio --root /absolute/fixture`
2. ตรวจ full catalog 74 tools
3. ทดสอบ project overview, read, write และ edit

## Security

- anonymous HTTP ต้อง 401
- read-only token ต้องถูกปฏิเสธเมื่อเรียก write/exec
- client ที่ไม่มี ACL ต้องถูกปฏิเสธ
- inspect mode ต้องมี owner approval
- secret paths และ traversal ต้องถูกปฏิเสธ
- ห้ามแสดง client secret, access token หรือ private config token

## External clients

เพิ่ม MCP connection ใน client ที่ต้องการ ใช้ OAuth, scan tools และบันทึกจำนวน tools ที่ client แสดงจริง หาก catalog ถูก cache ให้ recreate connection ตาม client instructions
