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

## Read-only federation

MCP อ่านโปรเจกต์ที่ลงทะเบียนไว้ได้โดยไม่เปลี่ยน active workspace ผ่าน tools เดิม:

- `project_overview({projectId})`
- `list_files({projectId, ...})`
- `read_files({projectId, ...})`
- `search_code({projectId, ...})`
- `search_code({projectIds: [...]})` สำหรับค้นพร้อมกันสูงสุด 8 โปรเจกต์

ใน Compact/Hybrid surface ให้ใส่ fields เหล่านี้ใน `args` ของ `dodo_read`
ตาม schema ที่ `dodo_discover` คืนมา จำนวน tools ปัจจุบันเป็น Full 86, Compact 19
และ Hybrid 49

`project_overview()` ของ active workspace แสดง `federation.projects` เฉพาะ
รายการที่ client มี live `dodo:read` ACL เท่านั้น สำหรับ HTTP ต้องเป็น OAuth
installation identity รุ่นปัจจุบันด้วย legacy workspace-bound grant ใช้ข้าม
โปรเจกต์ไม่ได้ ส่วน local STDIO เป็น owner process และอ่านรายการที่ owner
ลงทะเบียนได้

ทุก target ถูกตรวจซ้ำก่อนอ่าน:

1. project ID ต้องมาจาก owner registry
2. canonical path และ directory identity ต้องมีสถานะ `ready`
3. grant ต้องไม่ถูก revoke และ client ต้องมี `dodo:read` ใน target workspace
4. shared ignore/path/secret policy ของ target ถูกสร้างใหม่จาก global policy
5. request ยังต้องใช้ active workspace ID/epoch ที่ถูกต้อง

ผล federated มี target project ID, workspace ID, federation epoch และ source hash
แยกจาก envelope ของ active workspace การค้นหลายโปรเจกต์ใช้ quota รวมแบบ bounded;
target ที่ owner อนุญาตแต่ unavailable ถูกระบุเป็น partial failure ส่วน target ที่
ไม่มี ACL ทำให้ทั้ง request ถูกปฏิเสธและไม่เผย path/metadata

Federation นี้ไม่เปลี่ยน `process.cwd()`, ไม่เปลี่ยน active workspace และไม่เปิด
write/exec ข้ามโปรเจกต์ เจ้าของต้องเปิด target ผ่าน Local Config และให้ client
อ่าน context ใหม่ก่อน mutation/command

## การนำรายการออก

`dodo project remove` เป็น soft removal ของ registry metadata เท่านั้น ระบบไม่ลบ:

- ไฟล์หรือ directory ของโปรเจกต์
- workspace history, changesets หรือ audit เดิม
- trust mode หรือ client ACL
- OAuth installation identity, clients หรือ grants

การเพิ่ม canonical root เดิมภายหลังจะได้ project ID ใหม่ แต่ workspace authority
ยังเป็นไปตาม workspace identity contract เดิม

## ขอบเขต

process หนึ่งยัง serve active workspace เดียวสำหรับ write, jobs, plans, approvals,
Desktop และ resource ownership Read-only federation ไม่ใช่ multi-agent coordinator
และไม่ค้น path ทั้งเครื่องอัตโนมัติ Effectful federation จะเปิดได้ต่อเมื่อมี
per-project lock, stale-context, approval, journal/rollback และ job ownership ที่
พิสูจน์ด้วย tests ครบ
