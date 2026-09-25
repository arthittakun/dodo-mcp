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

Windows filesystem sharing-lock retries are bounded syscall retries. The journaled
writer revalidates paths and expected bytes before each replacement, deletion or
move attempt, including compensation. A concurrent external edit stops the retry
and is preserved for review; the entire tool/action is never repeated implicitly.
Internal OS error causes remain private and are omitted from MCP error envelopes.

Windows private-directory initialization rereads owner/DACL on each invocation.
An exact current-user-owned, protected, three-principal FullControl ACL is left
unchanged instead of re-propagating identical permissions into live descendants
while other owner CLI processes initialize them. This is not a permission cache;
unexpected owners and permissive verification paths still fail closed. Native
and PowerShell implementations apply the same checks, including final revalidation.

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

Local Config bind loopback ใช้ private capability token, expiration, Host/Origin checks,
forwarded-header rejection และ rate limit Public listener ไม่มี owner route ที่ active
ตามค่าเริ่มต้น เมื่อเจ้าของสั่ง `dodo --web` จะเปิดเฉพาะ namespace `/config` แบบ
process-memory lease ไม่เกิน 1 ชั่วโมง และกลับเป็น 404 เมื่อปิดหรือหมดอายุ

Remote Config ใช้ pairing code สุ่มแบบใช้ครั้งเดียว เก็บใน server เฉพาะ SHA-256 digest
และแลกเป็น session token ที่ server เก็บเฉพาะ digest Cookie เป็น `Secure`, `HttpOnly`,
`SameSite=Strict`, `Path=/config`; code/session ไม่อยู่ใน URL, config, browser storage,
log หรือ audit Proxy ส่งต่อไป Local Config ด้วย capability ภายใน และลอก client
Authorization/Cookie/Origin/Cloudflare/forwarded headers ออกก่อน ทุก mutation จึงยัง
ต้องผ่าน workspace/epoch binding และ owner API validation เดิม มี rate limit ที่
pairing endpoint และ CSP/no-store/frame denial บนทุก response ไม่มี MCP operation เปิด
หรือยืด lease ได้; เฉพาะ authenticated private IPC/CLI ของเจ้าของเท่านั้น

UI assets เสิร์ฟจากแพ็กเกจเองทั้งหมดรวมถึง SweetAlert2 ที่ vendor แบบ pin version (ไม่มี CDN; CSP ยังเป็น `script-src 'self'; style-src 'self'` โดยไม่มี `unsafe-inline`/`unsafe-eval`) เส้นทาง `/assets` เป็น fail-closed: path ที่ decode แล้วต้องตรงรูปแบบเข้มงวด (ลึกได้หนึ่งระดับเฉพาะ `ui/`, `vendor/`), นามสกุลอยู่ใน allowlist (`.css/.js/.svg`), ปฏิเสธ `..`, backslash, NUL และไฟล์ที่ resolve ออกนอก UI directory ทั้งหมดตอบ 404 ข้อความจาก server/paths/client/provider ทุกตัว render ผ่าน `textContent` (SweetAlert ใช้ `titleText`/`text` เท่านั้น ไม่ใช้ `html`) กล่องยืนยันของ UI เป็นชั้น UX เพิ่มเติม ไม่แทนที่ approval/validation ฝั่ง server

Launcher mode ไม่มี active AI workspace และไม่ใช้ CWD เป็น implicit authority
private inert root ไม่ถูกแสดงต่อ client; OAuth และ authenticated catalog เปิดให้ตั้ง
connection ได้ โหมดส่วนตัวซึ่งเป็นค่าเริ่มต้นอนุญาต owner-approved OAuth installation
ให้ใช้ target ที่ owner ลงทะเบียนตาม token/profile scopes โดยไม่ต้องสร้าง ACL ซ้ำ
Simple Project Access Policy เพิ่มเพดานอีกหนึ่งชั้นต่อโปรเจกต์ (`read`/`edit`/`full` →
`dodo:read` / `+dodo:write` / `+dodo:exec`) บังคับที่จุดเดียวใน
`src/security/projectAuthority.ts` โดย intersect กับ token scopes, grant scopes และ
client ACL สิทธิ์จริงจึงเป็นส่วนที่ทับกันทั้งหมด ระดับนี้ **บีบได้อย่างเดียว ไม่เคยขยาย**:
token ที่มีแค่ `dodo:read` ยังเขียนหรือ exec ไม่ได้แม้โปรเจกต์เป็น `full` workspace ที่
ไม่ได้อยู่ใน registry (launcher root, stdio cwd) ไม่ถูกบีบเพิ่ม และค่าที่อ่านไม่ออกจะถูก
ตีเป็น `read` (fail closed) การเพิ่มโปรเจกต์กับการตั้งระดับ commit ใน transaction เดียว
จึงไม่มีโปรเจกต์ที่ลงทะเบียนครึ่งเดียว

`targetProject` (ชื่อโปรเจกต์) route เหมือน `targetProjectId` ทุกประการ: resolve ก่อน
เข้า pipeline, ค้นเฉพาะโปรเจกต์ที่ principal อ่านได้อยู่แล้ว (ไม่เปิดเผยโปรเจกต์ที่ไม่มีสิทธิ์),
ชื่อกำกวมหรือ id/ชื่อขัดกันถูกปฏิเสธ, รับเฉพาะ top level และถูกปฏิเสธใน nested args
ผ่านรายการ routing key ชุดเดียวกัน (`ROUTING_CONTEXT_KEYS`) ทุก dispatcher

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

### Per-operation Compact/Hybrid visibility

`disabledDiscoverOperations` เป็นการตั้งค่าของเจ้าของใน private Local Config และมีผล
เฉพาะ Compact/Hybrid catalog operation ที่ปิดจะไม่อยู่ใน `dodo_discover`, gateway enum
หรือ direct duplicate ของ Hybrid และ gateway ที่ไม่เหลือ operation จะไม่ถูก register
Full/STDIO direct definitions ไม่ถูกลบด้วยค่านี้ รายชื่อที่บันทึกต้องตรงกับ operation
จริงและ owner API ปฏิเสธชื่ออื่น การซ่อนหรือเปิดกลับไม่ grant OAuth scope, project ACL,
trust, approval, sandbox หรือสิทธิ์อื่น และ target ที่ยังเปิดอยู่ผ่าน invocation pipeline
เดิมทุกชั้น

## Android / ADB access

ADB ปิดโดยค่าเริ่มต้น การมี `adb` หรืออุปกรณ์ที่เชื่อมอยู่ไม่ใช่ permission เจ้าของต้อง
เลือก `view` หรือ `control` พร้อม exact serial ผ่าน private Local Config/CLI ก่อน
temporary policy ผูก workspace/epoch ส่วน persistent policy ผูก installation และถอนได้
ด้วย `dodo android disable` ทุก MCP operation ยังตรวจ live OAuth grant, `dodo:exec`,
target project/workspace context, trust/approval, idempotency และ audit ตามปกติ

การจับภาพสร้าง snapshot อายุสั้นที่ผูก caller, serial และ policy; input action ใช้และ
invalidate snapshot ก่อน dispatch UI hierarchy ปิดบัง password field แต่ข้อมูลจาก
อุปกรณ์ทั้งหมดถือเป็น private untrusted content และไม่ถูกเขียนลง audit log

`android_install`/`android_push` ตรวจ source ผ่าน shared workspace/secret/link policy,
บังคับ expected SHA-256 และส่ง private staging copy ให้ ADB Pair/connect/root, server
management และ port forwarding เป็น owner action นอก MCP `android_adb` รับเฉพาะ
device-side command families แบบ bounded และใช้ `shell:false` ที่ฝั่ง host อย่างไรก็ตาม
device-side shell สามารถเปลี่ยนข้อมูลด้วยสิทธิ์ Android shell user ได้และไม่ใช่ sandbox

## Cloudflare Tunnel

เจ้าของเป็นผู้สร้าง remotely-managed Tunnel, hostname และ DNS DODO ไม่ใช้ Cloudflare
API DODO บันทึกการเลือกแบบ exclusive หนึ่งค่าใน private global config: `local` คือ
loopback-only, `external` คือ Cloudflare Local ที่เจ้าของรัน `cloudflared` เอง และ
`tunnel` คือ DODO-owned process เฉพาะ `tunnel` เท่านั้นที่ DODO อ่าน credential,
เริ่ม child, ตรวจ readiness และหยุด child พร้อม DODO หาก credential/readiness ไม่พร้อม
startup จะ fail closed และไม่ fallback ไปโหมดอื่น

ใน `external` DODO ใช้ public HTTPS origin เป็น OAuth issuer/MCP URL แต่ไม่รับ token,
ไม่ค้น process และไม่อ้างว่า Tunnel connected จากค่า config เพียงอย่างเดียว เจ้าของ
ต้องดูแล process และ route เอง `dodo tunnel doctor` แยก public health ออกจาก process
ownership และ public health ไม่ใช่หลักฐานว่า AI client เชื่อมอยู่

Token ถูกเก็บใน macOS Keychain, Windows Credential Manager หรือ Linux Secret Service
เมื่อใช้ `--os-credential`; config เก็บ opaque locator เท่านั้น Owner-controlled
headless deployment อาจเลือก env/private-file reference โดย DODO ไม่คัดลอกค่า Token
ไม่อยู่ใน CLI argv, child arguments, config JSON, logs, MCP catalog/response, audit,
browser storage หรือ setup receipt ค่า `TUNNEL_TOKEN` และ `TUNNEL_TOKEN_FILE` ถูก
ปฏิเสธจาก environment ของ MCP jobs เสมอ

Local Config รับ token แบบ write-only เฉพาะเมื่อเลือก DODO Tunnel และ POST ผ่าน private capability,
Host/Origin/proxy checks, rate limit และ control-context headers จากนั้นส่งตรงไปยัง
reviewed OS credential provider และล้าง request field Response/config/audit ส่งกลับ
เฉพาะ credential presence/provider ไม่มี MCP tool สำหรับส่ง token, เปลี่ยน connection
mode หรือควบคุม owner Tunnel การเลือก Cloudflare Local จะปิดช่อง token และ backend
ไม่รับหรืออ่าน credential สำหรับโหมดนั้น

Tunnel route ต้องชี้ทุก public path ไป MCP/OAuth listener `127.0.0.1:21730` เท่านั้น
Local Config `21731`, metrics `21732` และ private IPC ไม่ถูก expose `/config` ที่
listener 21730 เป็น bounded bridge ที่ปิดเป็น 404 โดยค่าเริ่มต้นและไม่ทำให้พอร์ต 21731
รับ network ภายนอก readiness บอกสถานะ Cloudflare connection เท่านั้น ไม่ใช่หลักฐานว่า
AI client กำลังเชื่อมต่อ

## Setup and existing-state import

`dodo setup --check` และ `dodo setup --plan` เป็น read-only การติดตั้ง dependency ที่ยังขาดต้องมี `--yes` จาก local owner ก่อนเริ่ม installer โดย flag นี้ไม่ข้าม OS elevation, Desktop consent หรือ policy อื่น

บน Windows private state ต้องอยู่ใน dedicated local path ที่ไม่ใช่ reparse point และ
ผ่าน owner/DACL verification DODO ไม่ใช้ permissive ACL หรือ takeover directory ของ
account อื่นเมื่อ setup ล้มเหลว Recovery ที่รองรับคือแก้ ownership หลังตรวจ provenance
โดยผู้ดูแลเครื่อง หรือเลือก fresh local NTFS directory ผ่าน `DODO_CONFIG_DIR` โดยเก็บ
state เดิมไว้ ดู [WINDOWS_SETUP.md](WINDOWS_SETUP.md)

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
อยู่ใน reviewed OS store/reference และไม่ถูกส่งกลับให้ browser การเริ่ม DODO,
ปลดล็อก Keychain และให้ macOS permissions ต้องผ่านเจ้าของ

## Verified recovery and staged-index boundaries

`rollback_changes` is restricted to the principal that owns the committed
changeset. A write scope alone does not authorize another caller's undo. This
matches the agent snapshot contract. Cross-caller recovery is an explicit owner
operation, `recover.rollback`, on authenticated private administration, with a
current workspace/epoch, idempotency receipt and audit. It is not an MCP tool or
an input flag that an AI can set. Existing changesets retain their recorded
owner; no ownership migration or automatic transfer occurs.

Before source mutation, DODO verifies stored before-image bytes, file identity,
path policy and current hashes. Restore uses the same engine with an inverse
plan and its own pre-restore backups. A durable write intent is saved before the
filesystem operation; startup verifies actual bytes rather than trusting a
journal status alone. Mixed, damaged or unverifiable state requires owner review;
startup never replays filesystem writes. Unknown historical rollback direction
is treated as recovery-required. Final hash checks preserve conflicting human
edits rather than reporting a successful restore.

`git_commit` validates the entire staged diff, including previously staged files,
against workspace and denied-path rules. Staging uses a separate candidate index;
a refused stage/commit leaves the user's index unchanged. Allowed pre-existing
staged changes remain part of normal Git commit semantics. A commit whose result
or index publication is uncertain requires inspection instead of silent retry.
Git hooks/filters still execute under the existing exec policy and OS account:
this protection is not a sandbox against arbitrary hooks or other local programs.

Current recovery covers journaled file edits, not every effect of shell commands,
package installs, directory creation, browser/desktop/device actions, databases
or external editors. File mode bits are preserved where supported; this is not
a full ACL/xattr/ownership backup. Portable path rechecks reduce races but do not
provide filesystem confinement against a hostile process with the same OS user.
The source snapshot/session UI uses the boundaries below.

## Automatic source snapshots

Recovery policy is private owner state; repository settings, MCP calls, discover
visibility and trust overrides cannot disable it. Explicit opt-out is confirmed
and audited. Source/backup identity and hashes are checked before effects.
Caller authority and schedule approvals are rechecked after asynchronous backup.
No credential echo, extra OAuth scope or approval bypass is introduced.
See [Recovery boundaries](RECOVERY.md): this does not restore DBs, secrets, remote
effects or all metadata, and same-user TOCTOU and tampering limits still apply.


Reviewed restore binds plans to caller/project/root identity/epoch and
requires write scope plus the existing exact-action approval in inspect mode.
Source selection, backup integrity and current hashes are checked again under the
shared mutation queue. Private owner cross-caller access is not an MCP argument.
Session receipt chains reject interleaved edits; unknown shell authorship is never
claimed as exclusively owned. Restore status and durable idempotency support
reconnect without repeating uncertain effects. See [ADR-052](adr/052-reviewed-source-restore.md).

## Recovery R03

Expected source state is separate from observed backups. External target drift fails closed; only verified committed journals or exact, live owner acknowledgement can advance the baseline. MCP read access cannot acknowledge drift. Acknowledgement never grants OAuth/trust/exec authority. Private Git copies use captured bytes and an empty private index; no working Git history/config, hooks, filters, remotes or helpers are imported. Selected backup paths must be dedicated private directories, outside project/state/credential namespaces, with pinned identity; unavailable volumes do not fall back. Content and Git bytes share quotas. Job observations remain unknown-author data and hold the mutation ticket until their bounded scan finishes. See ADR 053 for scope and root-replacement limits.


## Recovery R04

Recovery names/pins are private owner actions, with current project/epoch, confirmation and live authority checks. They never promote test results or grant permissions. No public mark/purge endpoint exists. Caller-owned evidence retains target ACL checks; current inspection compares snapshot/recipes/runtime and never consumes model-supplied success. Truncated/unknown/skipped test evidence cannot certify a snapshot. Raw test logs and environment values are excluded from Recovery metadata. Source integrity, expected hashes, approvals and sandbox remain unchanged. Names and diffs use text-only DOM rendering. Production/DB protection is not implied.

## registered deployment adapters

Docker daemon access is explicitly owner registered and still subject to target
OAuth scope/ACL, current workspace/epoch, exec approval, source hashes and the
configured command sandbox. Snapshot creation grants none of those rights.
No repository Compose hooks, arbitrary Docker arguments, bind mounts, privileged
mode or permission fallback are accepted. Archive extraction verifies bytes in
memory without executing or copying mounted data. Health requests use declared
network scope and reject redirects/metadata/admin URLs, including actual private
listener ports. No provider credentials or `allowWebFetch` permission are reused.

Owner maintenance cannot be discovered/invoked through MCP. Exact review hashes,
live state and expiry bind cleanup/uncertainty acknowledgement. No force deletion,
volume prune, silent retry, database downgrade or automatic health success is
performed. Private job output is not exposed through normal job output tools.
Generic shell/other daemon clients remain outside this adapter's deployment guard;
a workspace boundary is not an OS or Docker security sandbox.

## private data recovery

Database/config opt-ins do not inherit from default-on source backup. Read-only
SQLite metadata and owner-authored compatibility rules never execute migrations
or grant generic SQL rollback. Rule checks before and after the source backup
reduce drift; an external database is not part of the source transaction.

Encrypted config uses dedicated private state and OS-only AES-256-GCM keys, with
project/root/target/revision-bound associated data. Registered inputs must already
be private, source-denied files. Owner-only preview is redacted; MCP/discover cannot
configure, decrypt or restore those copies. Keys never travel in argv/config JSON
or logs; OS-store failure has no plaintext fallback. Lost keys are unrecoverable.

Restore writes an existing file in place after an encrypted before-copy and durable
UNKNOWN receipt. A crash may leave partial bytes; it never silently retries or
restarts services. Owner/context/content checks and same-user filesystem race
limits apply. Key rotation retains old references; retention protects referenced
backups and does not promise physical secure erasure. See [ADR 056](adr/056-owner-data-recovery.md).

## Config session isolation (1.3.1)

Local Config retains its eight-hour process capability. Each owner CLI opening of
Remote Config creates a distinct, random internal capability bounded by that
one-hour lease. It never renews or reuses the local browser token. Closing, expiry
or reopening revokes the old remote capability and cookie. No credential is sent
in a remote URL or returned by state APIs. AI owner principals, streaming requests
and queued owner revalidation use the authenticated request session, not the
server start time. Loopback, Host/Origin, proxy-header rejection, rate limits,
workspace/epoch checks and public MCP OAuth remain enforced.

### Reviewed Recovery maintenance

Storage status and previews are bounded and reveal no credentials or private backup
paths. MCP checkpoint access remains caller-owned and workspace-bound. Cleanup/settings
apply requires `dodo:write`, live ACL/context and a separate exact owner approval even
in trusted mode. A review or discover result does not authorize apply. Settings are
limited to project quota, retention and canonical relative exclusions; they cannot
turn off Recovery, acknowledge drift or change private storage/installation authority.

The private owner dashboard requires its authenticated, expiring session and current
workspace context for confirmed apply. Public MCP has no administration endpoints.
Cleanup protects current baselines, pins, names and active references, and never edits
source files. Pending cleanup only processes stored private references, not paths
supplied by callers. Shared objects and active installation captures block reclamation;
I/O failure is reported as pending rather than successful deletion. No integrity
failure is silently repaired by accepting the current source.
