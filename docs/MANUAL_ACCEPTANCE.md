# DODO MCP — Manual Acceptance

ผล manual ต้องบันทึกเป็น `MANUAL_PASS` หรือ `MANUAL_NOT_RUN` พร้อมวันเวลาและ environment ห้ามเดาผลจาก automated test

สถานะ release 1.2.0: UI/authority/connection-mode fixtures ผ่านอัตโนมัติ แต่การใช้
**Cloudflare Local** และ **DODO Tunnel** ผ่าน public hostname จริงยัง
`MANUAL_NOT_RUN` จนกว่าเจ้าของจะทดสอบด้วย Tunnel/DNS/credential จริง

สถานะล่าสุดของ owner-state setup/import gate: `MANUAL_NOT_RUN` (2026-09-14) ชุด automated ใช้ fixture แยกและไม่แตะ config/OAuth/tunnel ของผู้ใช้

สถานะ live Cloudflare connection smoke ของรุ่น 1.0.2: `MANUAL_PASS` (2026-09-15) บน
macOS arm64, Linux x64 และ Windows x64 โดยใช้ secret fixture แบบชั่วคราว; ทั้งสาม platform รายงาน
connected, stability 3 วินาที, clean stop และ credentialPersisted=false ใน
[GitHub run 34908481066](https://github.com/arthittakun/dodo-mcp/actions/runs/34908481066)
การตรวจ public DNS → MCP/OAuth และ Remote Config ผ่าน hostname จริงยัง
`MANUAL_NOT_RUN` และ persistent credential flow ของรุ่น 1.0.3 ยังต้องรันใหม่;
connection smoke เดิมไม่ได้อ้างว่า AI client เชื่อมต่อแล้ว

## Cloudflare Tunnel

1. สร้าง remotely-managed Tunnel และ public hostname ใน Cloudflare ด้วยบัญชีเจ้าของ
2. route ทุก path ของ hostname ไป `http://127.0.0.1:21730` และยืนยันว่าไม่มี route ไป `21731`/`21732`
3. รัน `dodo setup --check --components cloudflared`
4. รัน `dodo tunnel configure --tunnel --public-url https://... --os-credential` และกรอก token ใน hidden prompt
5. ตรวจ config JSON มีเพียง `connectionMode=tunnel` และ opaque credential ref ไม่มี token
6. รัน `dodo start`; ตรวจว่ารอ readiness สำเร็จและ Active MCP URL เป็น public HTTPS
7. หยุดแล้วเริ่มใหม่โดยไม่กรอก token ซ้ำ; ตรวจว่าอ่านจาก OS store และ Tunnel เริ่มตาม
8. ทำ credential ให้ใช้ไม่ได้ใน fixture แล้วเริ่มใหม่; ต้อง fail closed และไม่เปิด Local fallback
9. ตรวจ `dodo tunnel status` ว่า `credentialSource=configured` และ connected หลัง `/ready` ตอบจริง
10. ตรวจ `dodo tunnel doctor` แยก local/public health และไม่กล่าวว่า AI client connected
11. ตรวจ process list ว่า argv ไม่มี token และ `dodo tunnel logs`/audit/config ไม่มี token
12. ทดสอบ OAuth + MCP ผ่าน public origin แล้วหยุด DODO; ยืนยัน owned child หยุดตาม
13. เปิด Local Config เลือก **เฉพาะเครื่อง (Loopback)** แล้ว restart; ตรวจว่าไม่เริ่ม cloudflared และ Active MCP URL เป็น loopback
14. เลือก **Cloudflare Local (ติดตั้งในเครื่อง)** พร้อม public origin; ตรวจว่าช่อง token ถูกปิด, DODO ไม่เริ่ม/หยุด cloudflared และ endpoint เป็น public หลัง restart
15. เลือก **DODO Tunnel** พร้อม write-only token แล้ว restart; ตรวจว่าช่องไม่ถูกเติมกลับและ endpoint เป็น public
16. บันทึก macOS และ Linux Docker แยก environment; Windows manual result แยกตามเครื่องจริง

## Remote Config ผ่าน Cloudflare

Automated Chromium fixture ผ่านแล้วทั้ง 1440×900 และ 390×844 โดยใช้ isolated
loopback public-origin fixture: จับคู่, dashboard/assets/API, workspace-bound mutation,
หมดอายุและปิดเป็น 404 ทำงานจริง การตรวจผ่าน public Cloudflare hostname จริงยัง
`MANUAL_NOT_RUN`

1. ทดสอบสองรอบ: (ก) Cloudflare Local โดยเจ้าของรัน tunnel เอง และ (ข) DODO Tunnel จน `dodo tunnel status` รายงาน connected
2. จาก terminal อื่นรัน `dodo --web`; คำสั่งต้องไม่ถามหรือส่ง Tunnel token ผ่าน IPC
3. ตรวจว่า process ไม่ restart และ MCP/OAuth/workspace epoch เดิมไม่เปลี่ยน
4. เปิด URL `/config` จากอีกอุปกรณ์ ตรวจว่า URL ไม่มี query/fragment secret
5. กรอก pairing code ครั้งเดียว; ใช้ซ้ำต้องถูกปฏิเสธ
6. ตรวจ browser cookie เป็น Secure/HttpOnly/SameSite=Strict และ Path `/config`
7. เปลี่ยนค่าที่ไม่กระทบข้อมูลจริงใน fixture แล้วตรวจ workspace ID/epoch binding
8. รัน `dodo --web` อีกครั้ง ตรวจ session เดิมถูกยกเลิกและได้ code ใหม่
9. รัน `dodo web --close` ตรวจ `/config`, assets และ API เป็น 404 แต่ `/healthz`, OAuth และ `/mcp` ยังอยู่
10. เปิดใหม่แล้วรอ 1 ชั่วโมง ตรวจ namespace ปิดเองโดยไม่หยุด MCP/Tunnel
11. เปลี่ยน persistent mode เป็นเฉพาะเครื่อง (Loopback) แล้ว restart; `dodo --web` ต้องถูกปฏิเสธและไม่เริ่ม Tunnel เอง
12. ตรวจ config, audit, tunnel log, browser local/session storage และ process argv ว่าไม่มี Tunnel token, pairing code หรือ session token

## Setup foundation

1. ใช้ config directory ชั่วคราวและรัน `dodo setup --check` กับ `dodo setup --plan`
2. ตรวจว่าไม่มี config, tools, receipt หรือ project file ถูกสร้าง
3. เลือก dependency ที่ยังขาดแล้วรันโดยไม่มี `--yes`
4. ตรวจว่า installer ไม่เริ่มและไม่มี state ถูกเขียน
5. รันใหม่ด้วย `--yes` เฉพาะใน fixture ที่อนุญาต แล้วตรวจ receipt schema/version และ readiness probe

### Windows private state และ setup recovery

สถานะสำหรับ release 1.0.4: **MANUAL_NOT_RUN**

1. เปิด terminal ด้วย Windows account ปกติที่ใช้ DODO ประจำ และตรวจว่า default
   `%LOCALAPPDATA%\dodo` บน local NTFS ผ่าน `dodo setup --yes --components speech`
2. สร้าง fixture state ที่ owner เป็น SID อื่นหรือเป็น junction แล้วตรวจว่า setup
   ปฏิเสธด้วย `PATH_DENIED` พร้อม recovery โดยไม่แก้ owner/DACL และไม่ลบ fixture
3. ตั้ง `DODO_CONFIG_DIR=%LOCALAPPDATA%\dodo-private` แล้วตรวจว่า fresh state ผ่าน,
   directory เดิมไม่เปลี่ยน และ installation identity ใหม่ไม่รับ OAuth/project/tunnel
   authority จาก state เดิม
4. ตรวจ `dodo --cli` เมนู 5 แสดง recovery เดียวกับ command mode และ JSON output มี
   field `recovery` โดยไม่มี path content, credential หรือ stack trace ที่ไม่จำเป็น
5. เมื่อ `cloudflared` ไม่มีใน PATH ให้ตรวจว่า DODO ไม่ติดตั้ง service/ไม่เปิด Tunnel
   และแนะนำ signed official package; หลังติดตั้งเองให้ `where cloudflared`,
   `cloudflared --version` และ `dodo setup --check --components cloudflared` ผ่าน
6. ทดสอบ Desktop/UAC/sandbox จาก interactive session แยกจาก runner service และบันทึก
   `MANUAL_PASS` เฉพาะ component ที่ readiness/confinement probe ผ่านจริง

## Existing-state import

1. สร้าง fixture source ที่มี config preferences, OAuth/key fixture และ state DB fixture
2. รัน plan และตรวจว่ารายการ import มีเฉพาะ safe config fields
3. รัน `--import-state` และตรวจว่า source ยังอยู่ครบ
4. ตรวจ target ไม่มี DB, keys, tokens, ACL, trust, approvals หรือ permission-bearing config
5. เปลี่ยน source หลัง plan แล้วตรวจว่า import ถูกปฏิเสธและ target ไม่ถูกสร้าง
6. ทดสอบ malformed/unknown config, symlink และ active IPC marker ให้ fail closed

## Local Config

0b. โปรเจกต์และระดับการเข้าถึง (2026-09-16) — **MANUAL_NOT_RUN**:
   บนเครื่อง Windows จริงที่ใช้ tunnel จริง ให้ตรวจว่า
   (ก) เพิ่มโปรเจกต์จากหน้า Projects ด้วย path + ชื่อ + ระดับเดียว แล้วใช้งานได้ทันที
       โดยไม่ต้องตั้ง client ACL/trust เพิ่ม
   (ข) สั่ง AI ว่า "ใช้ DODO แก้โปรเจกต์ auto-upload" แล้ว AI resolve ชื่อได้เอง
       และแก้ไฟล์ในโปรเจกต์ที่ถูกต้อง
   (ค) ตั้งระดับเป็น `read` แล้วคำสั่งเขียน/รันถูกปฏิเสธจริง
   (ง) แถบสถานะ Tunnel ไม่กระพริบระหว่างใช้งานต่อเนื่อง และ `dodo tunnel status`
       แสดง phase/`lastReadyAt` ที่สอดคล้องกับความเป็นจริง
   (จ) banner ตอน start ไม่พูดถึง ACL เมื่ออยู่ในโหมดส่วนตัว

0. UI ใหม่ (2026-09-14): ตรวจบนเครื่องจริงว่า (ก) nav 8 หน้าใช้ได้ทั้ง desktop และมือถือ
   (ข) tooltip `?` เปิดด้วยการแตะบนอุปกรณ์ touch จริงและ screen reader อ่านได้
   (ค) กล่องยืนยัน SweetAlert แสดงก่อนการลบ/ยกเลิก/เปลี่ยนโหมดทุกครั้ง
   (ง) ผลทดสอบ Provider แสดงชื่อ connection, โมเดล, ชนิดการทดสอบ และเวลา
   — สถานะปัจจุบัน: ผ่านใน Chromium fixture (ดู TEST_REPORT); อุปกรณ์ touch จริงและ
   screen reader จริงยัง **MANUAL_NOT_RUN**
1. จาก directory ที่ไม่ใช่โปรเจกต์และ config ใหม่ รัน `dodo` แล้วตรวจว่า anonymous MCP ได้ 401,
   OAuth login และ authenticated `tools/list` ใช้ได้ แต่ `project_overview` ได้
   `WORKSPACE_ACCESS_REQUIRED` และไม่เผย private inert root
2. เปิด Local Config URL จาก terminal
3. ตรวจว่าไม่มี root จาก CWD ปรากฏ และ Project Registry ยังเพิ่ม/เลือก path ได้
4. เพิ่ม fixture A โดยเลือก “เปิดโปรเจกต์นี้ทันที” แล้วตรวจ root, MCP/OAuth และ config listener
5. ปิดแล้วเปิด `dodo` จาก directory อื่น ตรวจว่า A ถูกเลือกจาก registry preference
6. เปลี่ยนไปยัง fixture project B
7. ตรวจว่า overview จาก MCP เห็น B จริง
8. ตรวจ workspace ID/epoch เปลี่ยน และหน้าเว็บแจ้งให้โหลด context ใหม่
9. กลับไป A แล้วตรวจว่า ACL/trust ไม่ปะปน

## Interactive CLI

1. รัน `dodo --cli` จาก Home/Desktop และตรวจว่าแสดง project ที่เลือกล่าสุด
2. เลือก project เดิมและเพิ่ม fixture ใหม่ด้วย absolute path
3. ตรวจว่า server ใช้ root ที่เลือก ไม่ใช่ CWD
4. เลือก setup check และตรวจว่ารายการมี cloudflared
5. เลือกเปิด Tunnel แบบ temporary แล้วตรวจ process list/config/log/audit ว่าไม่มี token
   ไม่มี token จากนั้นลบ credential ผ่าน Local Config

สถานะ owner-browser/terminal สำหรับ launcher และเมนูใหม่: `MANUAL_NOT_RUN`

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
9. ตรวจ owner-reviewed CURRENT memory แสดงเป็น `MEMORY`; runtime และ federated graph
   ที่ยังไม่มี provider แสดง unavailable/partial ตามจริง

Automated HTTP/OAuth fixtures ผ่าน contract หลักแล้ว แต่ยังไม่เปลี่ยนสถานะ manual
จนกว่าจะทดสอบกับ external AI และ repository ที่เจ้าของเลือกจริง

## Memory และ reviewed learning

สถานะ: **MANUAL_NOT_RUN** สำหรับ external AI และ owner repository จริง

1. ให้ AI เรียก `context_query` แล้วเสนอ `memory_propose` จาก current evidence ID
2. ตรวจว่า `memory_search` ยังไม่คืน proposal ก่อน owner approval
3. ใช้ `dodo memory show` ตรวจ claim, provenance, conflicts และ digest แล้ว approve
4. เริ่ม conversation ใหม่และตรวจว่า `memory_search`/`context_query` พบ memory ที่
   owner reviewed พร้อม `evidence_only` และ `untrusted_content`
5. แก้ source แล้วตรวจว่า memory เป็น STALE และไม่ปรากฏใน current-only search
6. ให้ client อื่นลองใช้ evidence ID เดิมและ memory ของ project ที่ไม่มี ACL ต้องถูกปฏิเสธ
7. เสนอ learning จาก successful memory สองรายการ ตรวจ owner review และยืนยันว่าไม่มี
   skill/workflow ถูกติดตั้งหรือ execute
8. prune stale fixture แล้วตรวจว่า CURRENT memory และ project files ยังอยู่

Automated fixtures ผ่าน contract หลักแล้ว แต่ยังไม่เปลี่ยนสถานะ manual จนกว่าจะใช้
external AI และ owner-selected fixture จริง

## Runtime Intelligence

สถานะ: **MANUAL_NOT_RUN** สำหรับ external AI และ owner repository จริง

1. เปิด runtime session แล้วเริ่ม test task แบบ `program + args` ผ่าน Compact gateway
2. ตัด/reconnect MCP ระหว่างงาน ตรวจ session/task เดิมและไม่เกิด process ซ้ำเมื่อ retry key เดิม
3. observe task แล้วตรวจ evidence มี status/count/hash แต่ไม่มี raw stdout/stderr หรือ secret fixture
4. ทดสอบ cancel และ wall timeout จาก task แยกกัน
5. สร้าง snapshot แก้ fixture ภายนอก แล้ว revalidate ต้องได้ `STALE`
6. เปิด owned workspace browser session, collect evidence และตรวจ MCP image จริง
7. ตรวจฐานข้อมูล runtime ไม่มี DOM, console, cookie, authorization header หรือ input value
8. ถอน workspace ACL ระหว่าง session แล้ว handle เดิมต้องใช้ไม่ได้
9. ใช้ `context_query` ค้น current runtime evidence และตรวจ source เป็น `dodo-runtime://...`
10. ปิด session ขณะ task running ต้องถูกปฏิเสธ; cancel/wait แล้วจึงปิดได้

Automated HTTP/OAuth/Chromium fixtures ผ่าน contract หลักแล้ว แต่ไม่ถือเป็น manual
external-client acceptance

## Advanced Agent Runtime

สถานะ: **MANUAL_NOT_RUN** สำหรับ external AI และ owner repository จริง

1. เปิด run พร้อม completion criteria, writable paths, explicit programs และ quota ที่แคบ
2. สร้าง plan revision และ hypotheses สองตัว; ให้ path intents overlap แล้วต้องปฏิเสธตัวที่สอง
3. snapshot → managed write/edit → verify → compare → rollback exact changeset
4. ตัด/restart server ระหว่าง action แล้วตรวจ `RECOVERY_REQUIRED`; อ่าน status ก่อน recover
5. ใช้ current Runtime evidence judge hypotheses และ complete เฉพาะเมื่อ criteria ครบ
6. ถอน workspace ACL ระหว่าง run แล้ว handle เดิมต้องถูกปฏิเสธทันที
7. เสนอ skill ที่มี hostile instruction ตรวจว่าหายจาก search จน owner review exact digest
8. approve safe skill แล้วตรวจ progressive search/inspect และยืนยันว่าไม่มี code ถูกติดตั้ง/รัน
9. เริ่ม long job แล้ว pause/cancel coordinator; job ต้องยังอยู่จน owner/caller หยุดโดย explicit handle
10. ตรวจ audit แยก coordinator operation, target operation และ private owner review

Automated HTTP/OAuth/restart/security fixtures ผ่าน contract หลักแล้ว แต่ไม่ถือเป็น
manual external-client acceptance

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
2. ตรวจ full catalog ค่าเริ่มต้น 121 tools และไม่มี `subagent_*`
3. ทดสอบ project overview, read, write และ edit

## Sub-agent MCP exposure

Automated catalog/API/Chromium/fresh-package fixtures: **AUTOMATED_PASS**

1. เปิด Local Config → Settings และตรวจว่าสวิตช์ “เปิดให้ MCP clients เห็น Sub-agent tools” ปิดเป็นค่าเริ่มต้น
2. ตรวจ Full live catalog มี 121 tools; Compact/Hybrid มี 19/49 ชื่อและ discover หา `subagent_spawn` ไม่พบ
3. ตรวจ Chat & Tasks ยังสร้างและดูงานได้จากหน้าเว็บ
4. เปิดสวิตช์ ยืนยันผ่าน dialog แล้วตรวจข้อความว่าต้อง restart/rescan
5. restart fixture เท่านั้น แล้วตรวจ Full มี 125 และ Compact discover/gateway มี `subagent_spawn/status/result/control`
6. ปิดสวิตช์อีกครั้ง restart และตรวจว่า run history ยังอยู่ แต่ MCP definitions ถูกซ่อน

การ restart server จริงและ rescan ผ่าน ChatGPT/remote client จริง: **MANUAL_NOT_RUN**

## Security

- anonymous HTTP ต้อง 401
- read-only token ต้องถูกปฏิเสธเมื่อเรียก write/exec
- managed mode: client ที่ไม่มี ACL ต้องถูกปฏิเสธ; personal mode: unregistered target ต้องถูกปฏิเสธ
- inspect mode ต้องมี owner approval
- secret paths และ traversal ต้องถูกปฏิเสธ
- ห้ามแสดง client secret, access token หรือ private config token

## External clients

เพิ่ม MCP connection ใน client ที่ต้องการ ใช้ OAuth, scan tools และบันทึกจำนวน tools ที่ client แสดงจริง หาก catalog ถูก cache ให้ recreate connection ตาม client instructions

## Android / ADB

ใช้ fixture device/emulator ที่ไม่มีข้อมูลเจ้าของ แล้วบันทึก serial แบบ redact เมื่อเผยแพร่:

1. ตรวจ `dodo setup --check --components adb` และ `dodo android devices`
2. เปิด view ชั่วคราวให้ exact serial แล้วทดสอบ info, capture, UI, logcat, packages และ bounded file read
3. ยืนยันว่า serial อื่นและ read-only OAuth token เข้าไม่ได้
4. เปิด control แล้วทดสอบ tap/key/app launch บน fixture app โดย capture ใหม่หลังทุก action
5. สร้าง APK/file fixture ใน workspace อ่าน SHA-256 แล้วทดสอบ install/push
6. เปลี่ยน source หลังอ่าน hash และตรวจว่า `FILE_CHANGED` เกิดก่อน ADB effect
7. ทดสอบ advanced device-side shell กับ harmless `echo` และยืนยันว่า pair/connect/root ถูกปฏิเสธ
8. ถอนสิทธิ์ระหว่าง session แล้วตรวจ action ถัดไปถูกปฏิเสธ
9. ตรวจ Local Config ที่ desktop และ 390px รวม keyboard/focus/error state
10. ลบ fixture app/file และรัน `dodo android disable`

Physical Android device/emulator: **MANUAL_NOT_RUN** จนกว่าจะทำรายการนี้บน hardware
หรือ emulator จริง Automated FakeAdb ไม่เปลี่ยนสถานะ manual gate

## DodoBench และ release gate

Automated fixtures: รัน `npm run bench`, `npm run release:gate` บน macOS และ
`npm run test:linux:docker` สำหรับ Linux แล้วตรวจ `gate-report.json` ใต้ ignored
`release-evidence/` Self-hosted GitHub Actions รัน Linux Docker และ Windows native
candidate บน trusted main/manual เท่านั้น Manual external AI, owner repository และ
Windows 11 ต้องรายงานแยกตาม environment จริง ห้ามเปลี่ยน `MANUAL_NOT_RUN` จากผล
automated บน macOS, Linux Docker หรือ Windows runner

## AI Providers / Multi-project owner acceptance

ใช้ fixture A/B แยกจาก source ของเจ้าของ ไม่ทดสอบ paid inference โดยไม่มีเจ้าของตั้ง
credentials ผ่าน private UI ผลต้องแยกตาม provider/model/platform ไม่รวมเป็น PASS เดียว

- เพิ่ม provider/model/profile ผ่านเว็บ เลือก session/Keychain และ grant project/client/egress
- ทดสอบ synthetic inference และ tool calling ด้วยปุ่มแยก เก็บเวลา/model/ผล ไม่มี key
- MCP caller A spawn บน A พร้อม web owner run บน B; read-back/diff/test receipts ต้องตรง
- Read-only เขียนหรือ spawn ไม่ได้; managed mode ที่ไม่มี target ACL ถูกปฏิเสธ และ inspect ขอ approval เฉพาะ operation
- แก้ไฟล์ภายนอกระหว่าง read/edit ต้อง conflict ไม่ overwrite
- Pause/cancel, ปิด browser/reconnect, expiry/revoke, restart/Resume ไม่ replay side effects
- Unknown inference/action outcome ต้องรอ review ไม่ส่งซ้ำเงียบ ๆ
- ตรวจ Keychain dialog และ local Ollama metadata รวมกรณี cloud model บน loopback
- ตรวจภาพจาก explicit resource paths และตอบกลับ text/tool results ไม่มี raw reasoning/key
- ตรวจ desktop/390px/theme/keyboard, history search/delete/retention และ advanced owner controls

Live OpenAI, Gemini, Claude, MiniMax, GLM, Kimi, Ollama: MANUAL_NOT_RUN สำหรับงานนี้
จนกว่าจะมีหลักฐานจาก account/model จริง Browser automation และ synthetic Keychain
round-trip เป็น AUTOMATED_PASS ไม่ใช้แทน MANUAL_PASS ของ provider

## Unreleased Recovery R00–R02

Automation uses separate fixture projects, including Chromium desktop/narrow
owner policy controls. Manual owner-device use and native Windows are
`MANUAL_NOT_RUN`. R02 adds automated fixture HTTP/owner browser/restore/crash
coverage. Before a release, an owner should create a fixture checkpoint, edit two
files, preview one-file and session undo, inspect exact-mirror deletions, verify
read-back, and inspect journal status after reconnect. Test backup opt-out,
external-edit conflict and restart with fresh context. Do not exercise this manual
gate on a production database or count automated browser tests as MANUAL_PASS.

## Unreleased R03 — MANUAL_NOT_RUN on owner projects

In disposable projects: capture dirty/staged/untracked source; externally overwrite files while preserving size/mtime; verify target writes refuse and unrelated edits remain available. Review paginated drift, reject stale digest/epoch, then explicitly acknowledge or preview/restore. Verify emergency snapshots do not replace the baseline. Run a command that changes source and check unknown-author attribution after job completion. Confirm independent Git refs/objects, unchanged working index/HEAD/branch, and no hooks/filter markers. Remove the selected backup volume: expect refusal without fallback. Delete source and working `.git` while retaining root identity: preview/restore source only. Root replacement, real removable volumes, native Windows/Android and owner live projects require separate manual acceptance. Browser fixture automation is reported as AUTOMATED_PASS only after it runs.


## Unreleased Recovery R04

Fixture browser automation covers project registration, default-on recovery, actual recipe evidence, owner names/pins, stale files, restore read-back and quota-blocked UI on desktop/narrow screens. Before a release, an owner should separately test their own project/storage and restart/reconnect workflow, inspect retained pins/names, and re-run required recipes after source/config changes. Live owner projects, Windows/Android and production/database recovery are MANUAL_NOT_RUN for this phase. Do not label a manual owner name as tested or production-known-good.

## Unreleased Docker deployment and recovery

AUTOMATED_PASS (disposable local daemon fixture, native Node): real build/image
source verification, deploy/health/stabilization, failure preserving known-good,
reviewed image rollback, source restore without restarting service, unchanged
SQLite rows/migration metadata/private fixture config in an existing named volume,
image pin/review conflicts and exact cleanup. These results are separate from
native Windows/Linux release gates and do not certify a user's daemon/context.

MANUAL_NOT_RUN: owner production, remote Docker contexts, Windows/Linux Docker
engines, long-duration stabilization and manual browser deployment. Before opting
in, review the target's daemon authority and use a disposable project/service to
exercise interrupted build/deploy, live observation, probe cleanup, reconnect,
expired approval and reviewed rollback. Source/database recovery remain distinct.

## Unreleased database/config recovery — MANUAL_NOT_RUN on owner data

Use disposable SQLite and a synthetic private `.env`, never production secrets.
Enable the migration adapter through the project page; verify unbound UNKNOWN,
owner-rule COMPATIBLE, and mismatched IDs blocking restore without changing rows.
Check external migration drift during a source restore, and explicitly review the
warning-only alternative if selected. Database undo/PITR remains unsupported.

For each OS credential provider, opt in a synthetic file, verify actual key-store
access, encrypted backup, redacted preview and exact read-back. Rotate; verify old
copies still need old keys. Lock/refuse the OS store and confirm no fallback.
Stop dependent fixture services before in-place restore. Test restart/reconnect
using the recorded receipt; UNKNOWN must not repeat writes. Review retention,
missing-file disable and recovery from the encrypted before-copy. Confirm no
secrets in MCP, public routes, browser storage, logs, source snapshots or tarball.

Automated browser/protocol tests are AUTOMATED_PASS only when reported. A real
Keychain fixture round-trip is not a manual Windows Credential Manager or Linux
Secret Service pass. Android encryption-provider support is NOT_SUPPORTED. Record
each OS and owner-production/manual case independently; no generic DB rollback
or disaster-recovery success is implied.
