# DODO Project Registry

Project Registry เป็นทะเบียนโปรเจกต์ระดับ installation สำหรับเจ้าของเครื่อง ใช้
project ID แบบ opaque และคงที่เพื่ออ้างอิงโปรเจกต์โดยไม่ใช้ path เป็น identity
เพียงอย่างเดียว Registry ไม่ใช่ MCP tool และไม่ให้สิทธิ์แก่ AI

## คำสั่ง

```bash
dodo project add /absolute/path/to/project --name "auto-upload" --access full
dodo project add "C:\\Users\\User\\Desktop\\auto-upload" --name "auto-upload" --access edit
dodo project access "auto-upload" --mode edit
dodo project list
dodo project info prj_xxxxxxxxxxxx
dodo project remove prj_xxxxxxxxxxxx --yes
```

`dodo project access` รับได้ทั้ง **ชื่อโปรเจกต์** และ project ID เว็บ Local Config
และ CLI เรียก owner-administration service ตัวเดียวกัน (`src/projects/ownerAdmin.ts`)
จึงใช้ validation, การยืนยันและ audit ชุดเดียวกัน ไม่มี permission logic แยกสองชุด

## Simple Project Access Policy

ตอนเพิ่มโปรเจกต์ให้เลือก **ระดับการเข้าถึง** เพียงค่าเดียว:

| ระดับ | ความหมาย | OAuth scopes ที่เป็นเพดาน |
|---|---|---|
| `read` | อ่านอย่างเดียว — อ่าน ค้นหา วิเคราะห์ | `dodo:read` |
| `edit` | แก้ไข — อ่านและแก้ไฟล์ | `dodo:read` + `dodo:write` |
| `full` | ทำงานเต็มรูปแบบ — อ่าน แก้ไฟล์ และรันคำสั่ง/ทดสอบ | `dodo:read` + `dodo:write` + `dodo:exec` |

ระดับนี้เป็น **เพดาน ไม่ใช่การให้สิทธิ์** สิทธิ์จริงคือส่วนที่ทับกันของ

```text
OAuth token scopes ∩ grant scopes ∩ (personal ? grant : client ACL ของ workspace) ∩ ระดับของโปรเจกต์
```

ดังนั้น token ที่มีแค่ `dodo:read` จะยังอ่านได้อย่างเดียวแม้โปรเจกต์เป็น `full`
และโปรเจกต์ `read` ก็เขียนไม่ได้แม้ token จะมี `dodo:write` การเปลี่ยนระดับไม่แตะ
OAuth, trust, approval, path/secret guards, expected hash, sandbox หรือ audit

ใน **โหมดส่วนตัว** (ค่าเริ่มต้น) เพิ่มโปรเจกต์แล้วใช้ได้ทันที ไม่ต้องตั้ง client ACL
หรือ trust ซ้ำต่อโปรเจกต์ ใน **โหมดแยกสิทธิ์** ยังต้องอนุญาต client ต่อโปรเจกต์ตามเดิม
และระดับของโปรเจกต์จะบีบให้แคบลงอีกชั้น (ไม่เคยขยาย)

### การอัปเกรดจากรุ่นก่อนหน้า

โปรเจกต์ที่ลงทะเบียนไว้ก่อนมีนโยบายนี้จะได้ระดับ `full` — เพราะ `full` **ไม่บีบอะไรเพิ่ม**
สิทธิ์จริงจึงเท่าเดิมทุกประการ (ยังถูกจำกัดด้วย OAuth scopes, client ACL ในโหมดแยกสิทธิ์,
trust และ guards ทั้งหมด) การบีบให้แคบลงเงียบ ๆ จะเป็นการถอนสิทธิ์ที่เจ้าของไม่ได้สั่ง
ระดับจะแสดงในหน้า Projects และ `dodo project list` เพื่อให้ลดลงได้เอง

## เรียกโปรเจกต์ด้วยชื่อ

ชื่อโปรเจกต์ต้องไม่ซ้ำกัน (เทียบแบบไม่สนตัวพิมพ์) เพราะใช้อ้างอิงโปรเจกต์ในการสั่งงาน AI

พูดกับ AI ได้ตรง ๆ ว่า **"ใช้ DODO แก้โปรเจกต์ auto-upload"** แล้ว AI จะ:

1. เรียก `project_overview` พร้อม `targetProject: "auto-upload"` — DODO resolve ชื่อ
   เป็นโปรเจกต์เดียวที่ client นั้นมีสิทธิ์เห็น
2. รับ `workspaceId` / `workspaceEpoch` ของโปรเจกต์นั้นกลับมา
3. ส่ง `targetProject` พร้อม context นั้นไปกับทุก operation ถัดไป

```jsonc
project_overview({ targetProject: "auto-upload" })

dodo_write({
  targetProject: "auto-upload",
  workspaceId: "ws_…", workspaceEpoch: "boot_…",
  operation: "edit_file",
  args: { /* … */ }
})
```

กฎของการ resolve:

- เทียบชื่อแบบตัดช่องว่างหัวท้ายและไม่สนตัวพิมพ์
- ค้นเฉพาะโปรเจกต์ที่ principal นั้นอ่านได้อยู่แล้ว จึงไม่เปิดเผยชื่อหรือ path
  ของโปรเจกต์ที่ไม่มีสิทธิ์
- ชื่อกำกวม (เช่นข้อมูลเก่าที่ชื่อซ้ำ) → error พร้อมรายชื่อ candidate ที่เห็นได้ ไม่เดา
- ส่งทั้ง `targetProjectId` และ `targetProject` ที่ชี้คนละโปรเจกต์ → ปฏิเสธ
- `targetProject` อยู่ระดับบนสุดเท่านั้น ใส่ใน `args` ที่ซ้อนอยู่จะถูกปฏิเสธ
- หลัง resolve แล้วผ่าน invocation/security pipeline เดิมครบทุกด่าน

เจ้าของไม่ต้องรู้หรือพิมพ์ project ID เอง (`targetProjectId` ยังใช้ได้ตามเดิมเพื่อ
ความเข้ากันได้ย้อนหลัง)

ทุกคำสั่งรองรับข้อมูล local owner เท่านั้น `list`, `info` และ `add` รองรับ
`--json`; `remove` ต้องมี `--yes` หลังตรวจ project ID และ path แล้ว

## Identity

- `projectId` เป็น opaque random ID และไม่เผย path
- `workspaceId` ยังคงสร้างจาก installation identity + canonical root ตาม contract
  เดิม และเป็น authority key สำหรับ trust/client ACL
- Registry เก็บ canonical realpath, directory identity แบบ
  `device + inode + birthtimeNs`, display name, metadata version และเวลา
  created/updated การผูก birth time ป้องกัน Linux นำเลข inode เดิมกลับมาใช้กับ
  directory ที่สร้างใหม่แล้วถูกเข้าใจผิดว่าเป็นโปรเจกต์เดิม
- หาก directory ถูก rename ภายใน filesystem เดิม แล้วเจ้าของเรียก `project add`
  ที่ path ใหม่ DODO จะรักษา projectId เมื่อพิสูจน์ directory generation เดิมได้
  ครบ แต่จะใช้ workspaceId ของ path ใหม่ จึงไม่คัดลอก trust หรือ client ACL ตามไป

Project Registry ปฏิเสธ filesystem ที่ไม่เปิดเผย birth time ที่เสถียร โดยไม่เดา
identity จาก path หรือ inode เพียงอย่างเดียว Active workspace ปกติยังใช้ root policy
เดิม; ข้อกำหนดนี้ใช้กับการเพิ่มโปรเจกต์ลง durable registry

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

`dodo --cli` ใช้ registry เดียวกันสำหรับเลือกหรือเพิ่มโปรเจกต์ และบันทึก
`startupProjectId` เป็น preference ระดับ installation ค่านี้ไม่ข้าม OAuth scope หรือ
filesystem guards และต้อง resolve registry + ตรวจ readiness ใหม่ทุกครั้งที่เปิด server

`dodo` และ `dodo start` ไม่ยึด process CWD เป็น workspace โดยอัตโนมัติอีกต่อไป:

- ถ้าโปรเจกต์ที่เลือกล่าสุดยัง `ready` จะเปิด root นั้น
- ถ้ายังไม่เลือกหรือรายการไม่พร้อม จะเปิด launcher mode โดยไม่มี active AI workspace
- เจ้าของเลือก path แรกจาก Local Config, `dodo --cli` หรือ `dodo start --root PATH`
- `dodo stdio --root PATH` ยังคง explicit เพราะ STDIO lifecycle ถูก client เป็นผู้สร้าง

launcher mode ใช้ directory ภายใน private config เป็น resource ชั่วคราวเท่านั้น
directory นี้ไม่ถูกส่งเป็น project root และ MCP/OAuth data plane ตอบ
OAuth login และ authenticated catalog ใช้ได้ระหว่างยังไม่มี default workspace แต่
ทุก operation ต้องรอ real workspace พร้อม โหมดส่วนตัวพร้อมใช้หลัง owner ลงทะเบียน
path; โหมด managed ต้องมี owner-granted ACL เพิ่มด้วย

## Read-only federation

MCP อ่านโปรเจกต์ที่ลงทะเบียนไว้ได้โดยไม่เปลี่ยน active workspace ผ่าน tools เดิม:

- `project_overview({projectId})`
- `list_files({projectId, ...})`
- `read_files({projectId, ...})`
- `search_code({projectId, ...})`
- `search_code({projectIds: [...]})` สำหรับค้นพร้อมกันสูงสุด 8 โปรเจกต์

ใน Compact/Hybrid surface ให้ใส่ fields เหล่านี้ใน `args` ของ `dodo_read`
ตาม schema ที่ `dodo_discover` คืนมา จำนวน tools ปัจจุบันเป็น Full 125, Compact 19
และ Hybrid 49

`project_overview()` ของ active workspace แสดง `federation.projects` เฉพาะรายการ
ที่ client อ่านได้ โหมดส่วนตัวใช้ live `dodo:read` จาก owner-approved installation
grant กับ registry; โหมด managed ต้องมี live target ACL เพิ่ม สำหรับ HTTP ต้องเป็น
OAuth installation identity รุ่นปัจจุบันด้วย Legacy workspace-bound grant ใช้ข้าม
โปรเจกต์ไม่ได้ ส่วน local STDIO เป็น owner process

ทุก target ถูกตรวจซ้ำก่อนอ่าน:

1. project ID ต้องมาจาก owner registry
2. canonical path และ directory identity ต้องมีสถานะ `ready`
3. grant ต้องไม่ถูก revoke และต้องมี `dodo:read`; managed mode ตรวจ target ACL เพิ่ม
4. shared ignore/path/secret policy ของ target ถูกสร้างใหม่จาก global policy
5. request ยังต้องใช้ active workspace ID/epoch ที่ถูกต้อง

ผล federated มี target project ID, workspace ID, federation epoch และ source hash
แยกจาก envelope ของ active workspace การค้นหลายโปรเจกต์ใช้ quota รวมแบบ bounded;
target ที่ owner อนุญาตแต่ unavailable ถูกระบุเป็น partial failure ส่วน target ที่
ไม่มี authority ตาม access mode ปัจจุบันทำให้ทั้ง request ถูกปฏิเสธและไม่เผย path/metadata

Federation นี้ไม่เปลี่ยน `process.cwd()` หรือ default workspace สำหรับ write/exec
ข้ามโปรเจกต์ใช้ `targetProjectId` แยกจาก read federation ตามหัวข้อถัดไป

## การนำรายการออก

`dodo project remove` เป็น soft removal ของ registry metadata เท่านั้น ระบบไม่ลบ:

- ไฟล์หรือ directory ของโปรเจกต์
- workspace history, changesets หรือ audit เดิม
- trust mode หรือ client ACL
- OAuth installation identity, clients หรือ grants

การเพิ่ม canonical root เดิมภายหลังจะได้ project ID ใหม่ แต่ workspace authority
ยังเป็นไปตาม workspace identity contract เดิม

## ขอบเขต

หนึ่ง process มี default workspace หนึ่งตัว และ runtime เป้าหมายแยกกันได้สูงสุด
16 secondary projects Owner เพิ่ม path เท่านั้น ไม่มีการค้นทั้งเครื่องอัตโนมัติ

## Explicit target routing

Full/Compact รับ `targetProjectId` ระดับบนร่วมกัน เรียก overview ของ target เพื่อรับ
workspace ID/epoch ก่อนอ่าน/เขียน/รัน การเลือก runtime เกิดก่อน target scope/context
และ managed ACL checks; client ที่ไม่มีสิทธิ์ default ยังได้รับรายชื่อเฉพาะ projects ที่ได้รับอนุญาต
เพื่อเลือก target ได้ การไม่ส่ง target คง default behavior เดิม ห้ามผสม target กับ
`projectId/projectIds` และห้าม nested target/context ใน gateway args

Runtime แต่ละตัวมี epoch, services, workers, jobs, trust และ resource ownership ของตัวเอง
ถือ private project lease ก่อน bootstrap/recovery และตรวจ readiness ใหม่ก่อน acquire
Job/agent/request ที่ยังใช้อยู่ทำให้การปิด/ถอด project ถูกปฏิเสธ งาน mutation ทั้งจาก
MCP/agent/schedule ใช้ queue เดียวต่อ project; command ถือ queue จน job จบ อ่านขนานได้
และแต่ละ project รันพร้อมกันได้ Hash ยังตรวจตอนถึง queue เพื่อป้องกัน external edits

Projects ในเว็บเลือกหน้าจอแยกจากการตั้ง default Personal mode ใช้ trusted policy กับ
registered projects โดยตั้งใจ ส่วน managed mode ไม่คัดลอก trust/ACL/approval/run
override ระหว่าง projects คู่มือ AI/profile permission อยู่ที่ [AI Providers](AI_PROVIDERS.md)
