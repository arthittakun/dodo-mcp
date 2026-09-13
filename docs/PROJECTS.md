# DODO Project Registry

Project Registry เป็นทะเบียนโปรเจกต์ระดับ installation สำหรับเจ้าของเครื่อง ใช้
project ID แบบ opaque และคงที่เพื่ออ้างอิงโปรเจกต์โดยไม่ใช้ path เป็น identity
เพียงอย่างเดียว Registry ไม่ใช่ MCP tool และไม่ให้สิทธิ์แก่ AI

## คำสั่ง

```bash
dodo project add /absolute/path/to/project
dodo project add /absolute/path/to/project --name "Web application"
dodo project list
dodo project info prj_xxxxxxxxxxxx
dodo project remove prj_xxxxxxxxxxxx --yes
```

ทุกคำสั่งรองรับข้อมูล local owner เท่านั้น `list`, `info` และ `add` รองรับ
`--json`; `remove` ต้องมี `--yes` หลังตรวจ project ID และ path แล้ว

## Identity

- `projectId` เป็น opaque random ID และไม่เผย path
- `workspaceId` ยังคงสร้างจาก installation identity + canonical root ตาม contract
  เดิม และเป็น authority key สำหรับ trust/client ACL
- Registry เก็บ canonical realpath, directory identity, display name, metadata
  version และเวลา created/updated
- หาก directory ถูก rename ภายใน filesystem เดิม แล้วเจ้าของเรียก `project add`
  ที่ path ใหม่ DODO จะรักษา projectId เมื่อพิสูจน์ dev/inode เดิมได้ แต่จะใช้
  workspaceId ของ path ใหม่ จึงไม่คัดลอก trust หรือ client ACL ตามไป

## Readiness

รายการแต่ละตัวรายงานสถานะตาม filesystem ปัจจุบัน:

- `ready`: canonical path และ directory identity ตรงกับที่บันทึก
- `missing`: path เดิมหายไป
- `symlinked`: path เดิมถูกแทนด้วย symbolic link
- `replaced`: path เดิมชี้ไป directory identity อื่น
- `inaccessible`: ตรวจ path/identity ไม่ได้
- `invalid`: metadata version หรือข้อมูล registry ไม่ผ่าน validation
- `removed`: เจ้าของนำรายการออกแล้ว แต่ history/authority ยังอยู่

DODO ไม่ถือว่า `missing`, `symlinked`, `replaced`, `inaccessible` หรือ `invalid`
พร้อมใช้งาน และไม่ย้าย authority อัตโนมัติ

## Local Config

หน้า Local Config แสดงรายการและ readiness เพิ่มโปรเจกต์ เปิดโปรเจกต์ที่พร้อม
ผ่าน workspace switch lifecycle เดิม และนำรายการออกหลังยืนยันได้ API เหล่านี้
อยู่บน listener loopback ของ Local Config เท่านั้น ใช้ private capability,
Host/Origin checks, rate limit และ workspace/epoch headers เดิม ไม่มี route นี้บน
MCP/public listener

## การนำรายการออก

`dodo project remove` เป็น soft removal ของ registry metadata เท่านั้น ระบบไม่ลบ:

- ไฟล์หรือ directory ของโปรเจกต์
- workspace history, changesets หรือ audit เดิม
- trust mode หรือ client ACL
- OAuth installation identity, clients หรือ grants

การเพิ่ม canonical root เดิมภายหลังจะได้ project ID ใหม่ แต่ workspace authority
ยังเป็นไปตาม workspace identity contract เดิม

## ขอบเขต

Registry รุ่นนี้ยังไม่ให้ AI query หลายโปรเจกต์พร้อมกัน และ process หนึ่งยัง serve
active workspace เดียว Multi-project federation ต้องใช้ isolation layer แยกต่างหาก
