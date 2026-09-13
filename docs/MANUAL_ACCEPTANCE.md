# DODO MCP — Manual Acceptance

ผล manual ต้องบันทึกเป็น `MANUAL_PASS` หรือ `MANUAL_NOT_RUN` พร้อมวันเวลาและ environment ห้ามเดาผลจาก automated test

สถานะล่าสุดของ owner-state setup/import gate: `MANUAL_NOT_RUN` (2026-09-14) ชุด automated ใช้ fixture แยกและไม่แตะ config/OAuth/tunnel ของผู้ใช้

สถานะ Cloudflare Tunnel จริง: `MANUAL_NOT_RUN` (2026-09-14) automated tests ใช้ fake executable และ loopback readiness fixture เท่านั้น ไม่มี Tunnel token, Cloudflare connection, DNS หรือ firewall ใดถูกใช้

## Cloudflare Tunnel

1. สร้าง remotely-managed Tunnel และ public hostname ใน Cloudflare ด้วยบัญชีเจ้าของ
2. route ทุก path ของ hostname ไป `http://127.0.0.1:21730` และยืนยันว่าไม่มี route ไป `21731`/`21732`
3. รัน `dodo setup --check --components cloudflared`
4. รัน `dodo tunnel configure --managed --os-credential` และตรวจว่า config มีเพียง credential reference
5. รัน `dodo tunnel start --yes` ใน foreground
6. ตรวจ `dodo tunnel status` ว่า connected หลัง `/ready` ตอบจริง
7. ตรวจ `dodo tunnel doctor` แยก local/public health และไม่กล่าวว่า AI client connected
8. ตรวจ process list ว่า argv ไม่มี token และ `dodo tunnel logs` ไม่มี token
9. ทดสอบ OAuth + MCP ผ่าน public origin แล้ว stop ด้วย `dodo tunnel stop`
10. ทำซ้ำบน macOS, Windows และ Linux โดยบันทึก `MANUAL_PASS`/`MANUAL_NOT_RUN` แยก OS

## Setup foundation

1. ใช้ config directory ชั่วคราวและรัน `dodo setup --check` กับ `dodo setup --plan`
2. ตรวจว่าไม่มี config, tools, receipt หรือ project file ถูกสร้าง
3. เลือก dependency ที่ยังขาดแล้วรันโดยไม่มี `--yes`
4. ตรวจว่า installer ไม่เริ่มและไม่มี state ถูกเขียน
5. รันใหม่ด้วย `--yes` เฉพาะใน fixture ที่อนุญาต แล้วตรวจ receipt schema/version และ readiness probe

## Existing-state import

1. สร้าง fixture source ที่มี config preferences, OAuth/key fixture และ state DB fixture
2. รัน plan และตรวจว่ารายการ import มีเฉพาะ safe config fields
3. รัน `--import-state` และตรวจว่า source ยังอยู่ครบ
4. ตรวจ target ไม่มี DB, keys, tokens, ACL, trust, approvals หรือ permission-bearing config
5. เปลี่ยน source หลัง plan แล้วตรวจว่า import ถูกปฏิเสธและ target ไม่ถูกสร้าง
6. ทดสอบ malformed/unknown config, symlink และ active IPC marker ให้ fail closed

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

## Project Registry

1. ใช้ `dodo project add /absolute/path --name "Fixture A"` และตรวจว่า `list/info` แสดง canonical path, project ID และ `ready`
2. เพิ่ม path เดิมซ้ำและตรวจว่า project ID ไม่เปลี่ยน
3. เปิด Local Config แล้วตรวจว่ารายการแสดง active/readiness โดยไม่มี client secret หรือ token
4. เพิ่ม Fixture B จากหน้าเว็บ แล้วกดเปิดโปรเจกต์ ตรวจว่า MCP ใช้ B จริงและ AI ต้องเรียก `project_overview` ใหม่
5. ตรวจว่า trust/client ACL ของ A ไม่ปรากฏใน B
6. rename directory fixture แล้วเพิ่ม path ใหม่ ตรวจว่า project ID คงเดิมแต่ workspace ID เปลี่ยน
7. แทน path ด้วย directory identity อื่นและตรวจว่า DODO ปฏิเสธการ takeover
8. นำรายการออกหลังยืนยัน ตรวจว่าไฟล์ ประวัติ trust และ ACL ยังอยู่
9. เปิด Local Config โดยไม่มี private fragment, จาก origin อื่น และผ่าน proxy headers; ทุกกรณีต้องถูกปฏิเสธ

สถานะการตรวจ Project Registry บน browser/owner environment จริง: `MANUAL_NOT_RUN`

## Multi-project federation

1. สร้าง fixture A/B และลงทะเบียนทั้งคู่ด้วย owner CLI/Local Config
2. ให้ client 1 มี `dodo:read` ใน A/B และ client 2 มีเฉพาะ A
3. จาก active A เรียก `project_overview` แล้วตรวจว่าแต่ละ client เห็นเฉพาะรายการที่มี ACL
4. ให้ client 1 เรียก `project_overview({projectId: B})`, `read_files` ของ A/B พร้อมกัน และ `search_code({projectIds:[A,B]})`
5. ตรวจผลทุก project มี project/workspace identity, federation epoch และ source hash โดย active root/epoch ไม่เปลี่ยน
6. ให้ client 2 query B ต้องได้ `FORBIDDEN` และ response ต้องไม่มี path/name/content ของ B
7. อ่าน `.env`, traversal, symlink/hardlink และ replaced root ใน B ต้อง fail closed
8. ทำ B unavailable แล้วค้น A/B ต้องได้ผล A พร้อม partial failure ของ B
9. ส่ง stale active epoch ต้องถูกปฏิเสธก่อนอ่าน target
10. ใส่ `projectId` ใน write/exec args ต้องถูก schema ปฏิเสธ และไฟล์/job ต้องไม่เกิด

สถานะการตรวจ multi-project federation ผ่าน external AI/owner environment จริง: `MANUAL_NOT_RUN`

## Universal Resource Layer

สถานะ: **MANUAL_NOT_RUN** สำหรับ external AI/web client จริง

1. `resource_inspect` ไฟล์ text/image/audio อย่างละหนึ่งไฟล์ใน fixture
2. อ่าน text กลับด้วย `resource_read` และอ่านไฟล์ใหญ่ต่อด้วย resume token
3. ยืนยัน `resource_preview` แสดง MCP image/audio block จริง
4. ใช้ `dodo_discover(operation="resource_read_range")` แล้วเรียกผ่าน `dodo_media`
5. ทดลอง `.env`, path traversal และ resource ID จาก client อื่น ต้องถูกปฏิเสธ
6. revoke workspace access แล้ว resource เดิมต้องอ่านไม่ได้
7. restart fixture server แล้ว reference เดิมยังอ่านได้ด้วย epoch ใหม่

ห้ามใช้ไฟล์จริงที่เป็นความลับและห้ามเปลี่ยน MANUAL_PASS จาก automated test เท่านั้น

## Project Brain

สถานะ: **MANUAL_NOT_RUN** สำหรับ external AI และ owner project จริง

1. เปิด fixture TypeScript project แล้วรอ `brain_status` เป็น `completed`
2. ค้น symbol/import/route/test/dependency ด้วย `brain_query`
3. แก้หนึ่งไฟล์และยืนยัน metrics ว่า `parsedFiles` ไม่เท่ากับทั้ง project
4. ย้ายไฟล์แบบ exact-content และตรวจว่า `symbol://` URI เดิม resolve ไป path ใหม่
5. แก้ source หลัง index แล้วตรวจว่า query default ตัด stale result และ
   `includeStale:true` ระบุ freshness ตามจริง
6. ลอง `.env`, traversal, symlink/hardlink, token read-only, revoked ACL และ stale epoch
7. pause/cancel/rebuild ใน inspect mode และยืนยัน approval ผูก target operation
8. restart ระหว่าง run แล้วตรวจ interrupted recovery และ committed graph เดิม

automated fixtures ผ่านรายการหลักแล้ว แต่ยังไม่ได้วัด performance ระยะยาวกับ repository
ของผู้ใช้หรือ workflow ผ่าน external AI จึงยังเป็น `MANUAL_NOT_RUN`

## Context Engine และ Evidence

สถานะ: **MANUAL_NOT_RUN** สำหรับ external AI และ owner repository จริง

1. เรียก `context_query` ด้วย goal เดียวกันสองครั้งและตรวจ ranking/evidence ID คงเดิม พร้อม cache hit ครั้งที่สอง
2. ใช้ budget เล็กและ cursor อ่านหน้าถัดไปโดยไม่มี evidence ซ้ำหรือข้าม
3. ตรวจทุกผลมี project/source hash, confidence, generated/verified time, freshness และ `untrusted_content`
4. แก้ source หลัง query แล้วตรวจว่า evidence เดิมเป็น stale และ query ใหม่ใช้ hash ใหม่
5. ลงทะเบียน fixture A/B ให้ client อ่านได้ทั้งคู่ แล้ว query ด้วย project name/ID โดย active workspace ไม่เปลี่ยน
6. ถอน ACL ของ B แล้วตรวจ query และ evidence เดิมถูกปฏิเสธโดยไม่เผย absolute path
7. ค้น marker ใน `.env`, private state, symlink/hardlink และตรวจว่าไม่ปรากฏในผล/cache diagnostics
8. ตรวจ `context_status` มี L0–L6 metrics แต่ไม่มี goal, path, source content หรือ credential
9. ตรวจ memory/runtime และ federated graph แสดง unavailable/partial ตามจริง

Automated HTTP/OAuth fixtures ผ่าน contract หลักแล้ว แต่ยังไม่เปลี่ยนสถานะ manual
จนกว่าจะทดสอบกับ external AI และ repository ที่เจ้าของเลือกจริง

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
2. ตรวจ full catalog 89 tools
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
