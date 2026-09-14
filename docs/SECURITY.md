# DODO MCP — Security

## Release evidence privacy

The DODO release-gate and Linux Docker-driver scripts capture child stdout/stderr and failure diagnostics in private
ignored logs. CI readiness does not dump Docker/host details. Only an explicitly
allowlisted `public-summary.json` is uploaded, with seven-day retention: revision,
lock/code fingerprint, platform/architecture/Node, step exit codes, test counts
including skips, audit counts and package hashes. Arbitrary error messages,
command arguments, test names, owner paths and runner identity are not copied.
Raw evidence is not suitable for public upload. GitHub's automatic Set up job
machine-name output and previously published logs require separate owner action;
these changes do not erase historical disclosures.

## Security model

DODO ใช้หลายชั้นร่วมกัน:

- OAuth 2.1 + authorization code + PKCE S256 สำหรับ MCP
- static client registration และ owner-controlled consent
- installation identity แยกจาก workspace client ACL
- OAuth scopes `dodo:read`, `dodo:write`, `dodo:exec`
- trust modes `inspect`, `edit`, `trusted`
- local approval สำหรับ effectful actions
- workspace ID/epoch validation
- shared root/path policy และ secret deny list
- expected hash, journal, atomic write และ rollback
- bounded jobs, scrubbed environment และ audit

การผ่านชั้นใดชั้นหนึ่งไม่ grant สิทธิ์ชั้นอื่น

Project Registry เป็น owner metadata แยกจาก authority: project ID หรือ readiness
ไม่ grant OAuth scope, workspace ACL หรือ trust และ AI ไม่มี MCP tool สำหรับเพิ่ม ลบ
หรือเปลี่ยนรายการโปรเจกต์

Registry ตรวจ canonical realpath กับ device, inode และ directory birth time ทุกครั้ง
ก่อนถือว่า target พร้อมใช้งาน จึง fail closed เมื่อ path ถูกแทน แม้ Linux จะนำเลข
inode เดิมกลับมาใช้ Migration ไม่ auto-upgrade row เก่าที่ไม่มี birth time เพราะไม่มี
หลักฐานพอแยก inode reuse; row นั้นคงเป็น invalid จนเจ้าของ review, remove และ add ใหม่

Read-only federation ตรวจ ACL แยกทุก target และรับเฉพาะ project ID จาก registry
ที่ owner สร้าง Remote client ต้องใช้ installation identity grant; legacy token ที่
ผูก workspace เดียวข้ามโปรเจกต์ไม่ได้ รายการโปรเจกต์ใน overview ถูกกรองก่อนส่ง และ
request ที่อ้าง target ไม่มี ACL ถูกปฏิเสธโดยไม่เผย absolute path หรือ metadata

## HTTP and Local Config

MCP และ public route ต้องผ่าน OAuth เสมอ ห้ามใช้ localhost เป็น authentication, ห้ามเปิด CORS เป็น `*`, ห้ามส่ง token ใน query string และห้าม trust proxy headers จากภายนอก

Local Config bind loopback ใช้ private capability token, expiration, Host/Origin checks, forwarded-header rejection และ rate limit ไม่มี Local Config/admin endpoint บน public MCP plane

UI assets เสิร์ฟจากแพ็กเกจเองทั้งหมดรวมถึง SweetAlert2 ที่ vendor แบบ pin version (ไม่มี CDN; CSP ยังเป็น `script-src 'self'; style-src 'self'` โดยไม่มี `unsafe-inline`/`unsafe-eval`) เส้นทาง `/assets` เป็น fail-closed: path ที่ decode แล้วต้องตรงรูปแบบเข้มงวด (ลึกได้หนึ่งระดับเฉพาะ `ui/`, `vendor/`), นามสกุลอยู่ใน allowlist (`.css/.js/.svg`), ปฏิเสธ `..`, backslash, NUL และไฟล์ที่ resolve ออกนอก UI directory ทั้งหมดตอบ 404 ข้อความจาก server/paths/client/provider ทุกตัว render ผ่าน `textContent` (SweetAlert ใช้ `titleText`/`text` เท่านั้น ไม่ใช้ `html`) กล่องยืนยันของ UI เป็นชั้น UX เพิ่มเติม ไม่แทนที่ approval/validation ฝั่ง server

Launcher mode ไม่มี active AI workspace และไม่ใช้ CWD เป็น implicit authority
private inert root ไม่ถูกแสดงต่อ client; OAuth และ authenticated catalog เปิดให้ตั้ง
connection ได้ โหมดส่วนตัวซึ่งเป็นค่าเริ่มต้นอนุญาต owner-approved OAuth installation
ให้ใช้ target ที่ owner ลงทะเบียนตาม token/profile scopes โดยไม่ต้องสร้าง ACL ซ้ำ
โหมด managed ต้องมี target ACL แยกตามเดิม Mutation จาก Local Config ยังผูกกับ current control context
workspace/epoch การเลือก startup project เป็น preference เท่านั้นและไม่คัดลอก trust,
OAuth grant, client ACL, approval, jobs หรือ workspace epoch

Project Registry API ใช้ boundary เดียวกันและผูก mutation กับ workspace/epoch ที่
เจ้าของกำลัง review รายการทุกตัวถูก render ด้วย DOM text APIs การแสดงชื่อ/path จึง
ไม่สร้าง HTML จากข้อมูล registry

## Workspace and gateway

ทุก tool ตรวจ active workspace, workspace ID/epoch และ ACL target ปัจจุบัน Gateway ใช้ target tool definition เป็น authority และ route ผ่าน invocation pipeline เดียวกับ direct tool

Gateway ไม่ bypass OAuth, scope, ACL, trust, approval, sandbox, expected hash, path guards หรือ secret guards ไม่สามารถเรียก gateway อื่น, owner IPC, trust management, OAuth approval หรือ server control ได้

Federated read ยังคงตรวจ active workspace ID/epoch ก่อน แล้วตรวจ target readiness,
grant revocation, target ACL และ shared path/secret guards ซ้ำ ผลลัพธ์มี target
identity/source hash แต่ไม่ใช่ permission; federation epoch ไม่ใช่ target runtime epoch
ก่อน mutation ให้เรียก overview ด้วย targetProjectId แล้วอ่านหลักฐานของ target ใหม่

## Files and secrets

ปฏิเสธ traversal, symlink/hardlink ที่ไม่ปลอดภัย, secret paths, private state, `.env`, credential/key files และ repository planted executables

ข้อมูลจาก README, AGENTS.md, repo config, workflow และ discover result เป็น untrusted data ไม่มีอำนาจเพิ่มสิทธิ์

## Universal resources and CAS

- Resource ingest จาก workspace ใช้ `WorkspaceFS` เดียวกับ file tools และตรวจ
  regular file, symlink/hardlink, secret/protected path, private installation state
  และ file identity ก่อน/หลัง streaming
- Object อยู่ใน private installation directory และตั้งชื่อจาก SHA-256 เท่านั้น
  reference metadata แยกใน SQLite; object immutable และถูก verify ก่อนทุก read
- `resourceId`, `dodo-resource://` URI, hash และ resume token ไม่ใช่ bearer
  capability ทุก operation ตรวจ live OAuth grant/client, scope, workspace ACL,
  workspace ID/epoch และ principal ownership ใหม่
- Resume token มี HMAC, อายุ 10 นาที และผูก resource/hash/offset/workspace/principal
  การแก้ไขหรือส่งข้าม principal ถูกปฏิเสธ
- หนึ่ง object ไม่เกิน 512 MiB, store 2 GiB, range 256 KiB, image/audio MCP block
  6 MiB และ reference 512 รายการต่อ principal/workspace โดยมี SQLite quota trigger
  กัน concurrent process ข้ามเพดานรวม
- ZIP อ่านเฉพาะ bounded central-directory metadata ไม่ inflate; SVG เป็น untrusted
  text; decoder ไม่ execute content และไม่เรียก shell/network
- CAS publish เฉพาะ fsynced staging inode ด้วย create-if-absent hard link ไม่
  overwrite winner และ GC ลบ expired refs ก่อน ลบเฉพาะ object ที่ไม่มี reference
  และพ้น grace หนึ่งชั่วโมงแล้ว

## Project Brain

Project Brain ใช้ `WorkspaceFS.walk/readTextFile/assertRegularFileForDirectAccess`
จึงไม่ index secret-denied/protected/ignored output, traversal, symlink หรือ hardlink
parser อยู่ใน bounded worker และใช้ TypeScript ที่มากับ DODO ไม่โหลดหรือรัน source,
repository compiler plugin, LSP command หรือ package script

index row, graph edge และ `symbol://` URI เป็น evidence เท่านั้น ไม่ใช่ capability
read ทุกครั้งตรวจ OAuth scope, live grant, client, workspace ACL, workspace ID/epoch,
path policy และ current source SHA-256 ซ้ำ ผล stale/missing ถูกระบุและตัดออกโดย
default maintenance operations (`brain_rebuild`, `brain_pause`, `brain_cancel`) ต้องมี
`dodo:exec` และผ่าน trust/target-specific local approval เดิม

## Context retrieval and evidence

Context Engine ใช้ `dodo:read` และยังผ่าน invocation pipeline เดิม ก่อนค้นข้าม
project ระบบ resolve เฉพาะรายการที่ caller มี live target ACL และ installation
identity เท่านั้น Unauthorized selector ถูกปฏิเสธโดยไม่คืน absolute path หรือข้อมูล
project Cache hit ไม่ข้ามการตรวจ ACL และ source hash ทุก dependency

Evidence ID, source URI, hash และ signed cursor ไม่ใช่ capability และผูกกับ principal,
request workspace, query/index version และ expiry ตามชนิด Source เปลี่ยนจะ mark stale
และ invalidate derived cache ข้อมูลจาก source, docs, repository instruction, tool
output หรือ index เป็น `untrusted_content` เสมอ ไม่สามารถ grant scope/ACL/trust,
approve action, ปิด sandbox หรือข้าม path/secret guard ได้ Diagnostics ไม่คืน query,
path, content, token หรือ private owner state

## Memory and reviewed learning

Memory proposal ต้องอ้าง current Context evidence ของ principal เดียวกันและเก็บเฉพาะ
non-secret summary/provenance ไม่มี MCP tool สำหรับ approve, reject, prune หรือ learning
review Owner control ใช้ private authenticated IPC และ exact digest; ก่อนอนุมัติจะตรวจ
source hash, conflicts และ target project readiness ซ้ำ

Approved memory มี `authority: evidence_only` และ `trust: untrusted_content` เสมอ
Memory ID/digest/cursor ไม่ใช่ capability การค้นข้าม project ต้องผ่าน live installation
identity + target ACL และ explicit owner visibility ทุกครั้ง Source เปลี่ยนหรือ retention
หมดจะถูก mark stale Learning approval ไม่ติดตั้ง ไม่ execute และไม่ grant scope, ACL,
trust, approval, sandbox exception หรือ executable policy

## Runtime Intelligence

Runtime session, task และ evidence ผูก digest ของ `grantId + clientId`, active
workspace และ expiry Opaque IDs ไม่ใช่สิทธิ์ ทุก operation ตรวจ live grant/client/ACL
และ target scope ใหม่ งาน process/test/container ใช้ `JobManager` เดิมด้วย explicit
program+argv, execution approval, caller idempotency, environment allowlist, timeout
และ command sandbox ที่เจ้าของตั้งไว้ Runtime ไม่มี generic shell หรือ owner control

Runtime tables เก็บเฉพาะ status/exit/timestamps, byte counts, aggregate test counts และ
SHA-256 ไม่เก็บ raw stdout/stderr, DOM/console text, cookies, authorization headers,
input values หรือ environment secrets Browser evidence ใช้ owned browser session เดิม;
collector เปิด browser/web/desktop/microphone/system audio ไม่ได้ Snapshot เก็บ metadata
manifest และ rollback candidate IDs เท่านั้น การ rollback ยังต้องผ่าน
`rollback_changes` พร้อม journal/hash conflict checks

Source เปลี่ยนหรือ recheck ไม่ได้จะ mark evidence เดิม stale โดยไม่เขียนทับ hash
Context Engine อ่านเฉพาะ current caller/workspace evidence และถือเป็น untrusted data
Runtime diagnosis ไม่มี side effect และไม่สามารถ grant scope/trust/approval

## Advanced Agent Runtime

Agent run, plan, hypothesis, intent, snapshot, judgement และ skill ID ไม่ใช่ capability
ทุก request ตรวจ principal, live grant/client/workspace ACL, target scope และ active
workspace epoch ใหม่ Run capabilities ลดสิทธิ์เท่านั้น: project ต้องอ่านได้อยู่แล้ว,
writable path ผ่าน WorkspaceFS policy, executable ผ่าน allowlist/resolver และ optional
network/browser/desktop/media/workflow ปิดเป็นค่าเริ่มต้น `secretAccess` เป็น false เสมอ

Managed dispatcher เรียก target definition ผ่าน invocation pipeline เดิม Target-bound
trust approval, strict schema, expected hash, path/secret/symlink/hardlink guards,
command sandbox, idempotency และ audit จึงยังมีผล Coordinator ไม่มี owner control,
ไม่มี unrestricted shell, ไม่ approve action และ pause/cancel run ไม่ kill jobs

Intent เป็น coordination lock ไม่ใช่ filesystem permission Snapshot ไม่เก็บ contents
และ rollback ได้เฉพาะ caller-owned changeset หลัง exact snapshot ผ่าน journal/conflict
checks เดิม Judgement/completion ต้องอ้าง current Runtime evidence ของ caller Skill
proposal ถูกซ่อนจน private owner review exact digest; approved skill เป็น versioned
`untrusted_guidance`, ไม่ execute และไม่ grant authority

## Commands and jobs

child environment เป็น allowlist ไม่ inherit OAuth state, private config tokens, signing keys หรือทั้ง parent environment โดยอัตโนมัติ command sandbox ใช้ตาม owner config และระบบรายงาน unsupported เมื่อ platform ไม่มี adapter

trusted command ใช้สิทธิ์ OS ของผู้ใช้จริงและอาจเข้าถึงสิ่งที่ user เข้าถึงได้ ควรใช้กับ workspace ที่เชื่อถือได้เท่านั้น

## Logging and packaging

ห้าม log access token, refresh token, client secret, OAuth code, private config token หรือ secret file content audit เก็บเฉพาะ metadata ที่ scrubbed

package tarball ต้องไม่มี state DB, private keys, credentials, models, media fixtures หรือ temporary release files

## Evaluation boundary

DodoBench ใช้ OAuth, workspace ACL, scope, epoch, trust, approval และ path/secret guards
ชุดเดียวกับ runtime จริง ไม่มี benchmark bypass หรือ privileged principal ผลและ release
evidence ไม่มี token, OAuth code, client secret, private config capability, source content
หรือ state database และถูก ignore จาก Git/npm Release gate บล็อก high/critical
production dependency findings แต่ไม่ publish package หรือเปลี่ยน owner configuration

### Optional Sub-agent MCP exposure

`exposeSubagentsToMcp` ปิดเป็นค่าเริ่มต้นและควบคุมเฉพาะ tool catalog ของ MCP เมื่อปิด
Full จะไม่ register สี่ Sub-agent definitions และ Compact/Hybrid จะไม่ใส่ operations
เหล่านี้ใน gateway enum, server instructions หรือ `dodo_discover` หน้าเว็บ owner-only
ยังสร้างและจัดการ agent ได้ การเปิดสวิตช์ไม่ grant `dodo:exec`, ไม่เพิ่ม project ACL,
ไม่เปลี่ยน trust/profile policy และไม่ข้าม approvals, sandbox, path/secret guards หรือ
workspace context ทุก call ที่เปิดให้เห็นยังผ่าน invocation pipeline เดิมทั้งหมด

## Cloudflare Tunnel

เจ้าของเป็นผู้สร้าง remotely-managed Tunnel, hostname และ DNS DODO ไม่ใช้ Cloudflare API เมื่อรัน `dodo start` ใน terminal ระบบถาม Tunnel token แบบซ่อนและ supervise เฉพาะ live `cloudflared` child ของ process นั้น หรือเจ้าของเริ่ม/หยุดรอบเดียวกันจาก Local Config ที่ผ่าน owner authentication

เส้นทางหลักใช้ token แบบ run-scoped เท่านั้น: token อยู่ในหน่วยความจำของ DODO และ environment ของ child `cloudflared` ระหว่างรอบ ไม่ถูกบันทึกใน config, Keychain, Credential Manager, Secret Service, CLI argv, child arguments, logs, MCP catalog/response, audit หรือ setup receipt ค่า `TUNNEL_TOKEN` และ `TUNNEL_TOKEN_FILE` ถูกปฏิเสธจาก environment ของ MCP jobs เสมอ Local Config รับ token ผ่าน private loopback capability, ล้าง request field หลังส่ง และตอบกลับเพียง `tokenStored:false`

Local Config รับ token เฉพาะ POST ที่ผ่าน private capability, Host/Origin/proxy checks,
rate limit และ control-context headers แล้วส่งให้ process-owned runtime โดยตรง
Response/config/audit เก็บเฉพาะสถานะที่ไม่มี secret ไม่มี MCP tool สำหรับส่ง token หรือ
ควบคุม tunnel หน้าเว็บเริ่ม network process เฉพาะเมื่อ owner กด “เปิด Tunnel รอบนี้”
และการตั้ง startup preference ไม่เริ่ม network process

Tunnel route ต้องชี้ทุก public path ไป MCP/OAuth listener `127.0.0.1:21730` เท่านั้น Local Config `21731`, metrics `21732` และ private IPC ไม่ถูก expose readiness บอกสถานะ Cloudflare connection เท่านั้น ไม่ใช่หลักฐานว่า AI client กำลังเชื่อมต่อ

## Setup and existing-state import

`dodo setup --check` และ `dodo setup --plan` เป็น read-only การติดตั้ง dependency ที่ยังขาดต้องมี `--yes` จาก local owner ก่อนเริ่ม installer โดย flag นี้ไม่ข้าม OS elevation, Desktop consent หรือ policy อื่น

`dodo setup --import-state` นำเข้าได้เฉพาะ preference allowlist จาก private `config.json`: config version, MCP/config ports, bounded limits, search backend, log retention และ tool surface เท่านั้น ระบบไม่ copy database, OAuth signing keys, cookies, clients, grants, authorization codes, tokens, workspace ACL, trust, approvals, schedules, public URL/Host/Origin allowlists, web/desktop permissions, LSP commands, environment allowlist หรือ sandbox writable paths

ก่อน commit ระบบตรวจ file type, ownership/ACL, link count, symlink, runtime markers, size และ SHA-256 ซ้ำ หาก source เปลี่ยน, schema ไม่ตรง, มี unknown field หรือมี DODO process ใช้งาน state นั้นอยู่ การนำเข้าจะ fail closed และรักษา source/target เดิมไว้

## AI providers และ target projects

Owner-registered `targetProjectId` เลือก runtime ก่อนคำนวณ scope/ACL; token ของ default
project ไม่เป็น authority ของ target Legacy root-bound grant ยังข้ามไม่ได้ ทุก model
operation ผ่าน wrapper เดิมพร้อม live checks หลังรอ queue Profile ทำได้เพียงลดสิทธิ์
และ child run ถูกจำกัดให้ project เดียว ไม่ spawn ต่อหรือเข้าถึง owner controls
Approved workflow, memory, skill, model output และ repository content ไม่เป็น permission

Provider access เป็น egress permission แยกจาก `allowWebFetch` และแยกต่อ project/profile/
client ในโหมด managed ส่วนโหมดส่วนตัวถือว่าการเลือก remote profile เพื่อเริ่ม run เป็น
owner consent สำหรับส่ง bounded context ของ project นั้น ไม่ส่งทั้ง repo/ภาพ/binary อัตโนมัติ
Loopback Ollama ไม่ใช่หลักฐาน local inference ต้องตรวจ metadata ของ model ก่อนใช้
ใน project ที่ไม่อนุญาต source egress; endpoint ของเจ้าของยังเป็น trust boundary

Keys ใช้ session memory หรือ macOS Keychain ผ่าน stdin (ไม่ใส่ argv) State เก็บ ref
เท่านั้น UI ไม่อ่าน key กลับและไม่เก็บใน browser storage Endpoint เปลี่ยนต้องป้อน key
ใหม่และ connection ที่ใช้งานถูกล็อกไม่ให้แก้กลาง run Public endpoint ต้อง HTTPS
Private/LAN ต้อง opt-in; DNS ตรวจทุก address แล้ว pin, metadata/admin endpoint ถูกปฏิเสธ
และ credentials ไม่ตาม redirect Known key echoes ถูกปฏิเสธก่อนบันทึก result/continuation

Run history/continuation อยู่ใน private state แยก workspace/caller ไม่ export reasoning
ให้ UI ไม่มี raw access/refresh token ใน delegation ก่อนแต่ละ model/tool action ตรวจ
lease/grant/ACL/profile ใหม่; revoke หยุดขั้นถัดไปและ resume ไม่เปลี่ยน caller เป็น owner
Unknown outcomes ไม่ auto-retry Queue ไม่แทน expected hash หรือ OS sandbox; shell job
รันด้วยสิทธิ์ OS-user ภายใต้ sandbox/trust ที่เจ้าของตั้งเดิม

Local Config ยังคง loopback, token expiry, Host/Origin/proxy-header/rate checks และ CSP
Admin API ไม่อยู่บน public MCP Events ใช้ authenticated fetch/cursor ไม่ใส่ token ใน URL
ใช้ textContent แสดง path/model/error และไม่ render HTML จากโมเดล Tunnel credential
ยัง run-scoped ตามเดิม การเริ่ม DODO/Keychain/macOS permissions ต้องผ่านเจ้าของ
