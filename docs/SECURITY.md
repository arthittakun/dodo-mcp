# DODO MCP — Security

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

Read-only federation ตรวจ ACL แยกทุก target และรับเฉพาะ project ID จาก registry
ที่ owner สร้าง Remote client ต้องใช้ installation identity grant; legacy token ที่
ผูก workspace เดียวข้ามโปรเจกต์ไม่ได้ รายการโปรเจกต์ใน overview ถูกกรองก่อนส่ง และ
request ที่อ้าง target ไม่มี ACL ถูกปฏิเสธโดยไม่เผย absolute path หรือ metadata

## HTTP and Local Config

MCP และ public route ต้องผ่าน OAuth เสมอ ห้ามใช้ localhost เป็น authentication, ห้ามเปิด CORS เป็น `*`, ห้ามส่ง token ใน query string และห้าม trust proxy headers จากภายนอก

Local Config bind loopback ใช้ private capability token, expiration, Host/Origin checks, forwarded-header rejection และ rate limit ไม่มี Local Config/admin endpoint บน public MCP plane

Project Registry API ใช้ boundary เดียวกันและผูก mutation กับ workspace/epoch ที่
เจ้าของกำลัง review รายการทุกตัวถูก render ด้วย DOM text APIs การแสดงชื่อ/path จึง
ไม่สร้าง HTML จากข้อมูล registry

## Workspace and gateway

ทุก tool ตรวจ active workspace, workspace ID/epoch และ ACL target ปัจจุบัน Gateway ใช้ target tool definition เป็น authority และ route ผ่าน invocation pipeline เดียวกับ direct tool

Gateway ไม่ bypass OAuth, scope, ACL, trust, approval, sandbox, expected hash, path guards หรือ secret guards ไม่สามารถเรียก gateway อื่น, owner IPC, trust management, OAuth approval หรือ server control ได้

Federated read ยังคงตรวจ active workspace ID/epoch ก่อน แล้วตรวจ target readiness,
grant revocation, target ACL และ shared path/secret guards ซ้ำ ผลลัพธ์มี target
identity/source hash แต่ไม่ใช่ permission และใช้เป็น expected hash สำหรับ target
mutation ไม่ได้ เพราะ write/exec federation ยังปิดอยู่

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

## Commands and jobs

child environment เป็น allowlist ไม่ inherit OAuth state, private config tokens, signing keys หรือทั้ง parent environment โดยอัตโนมัติ command sandbox ใช้ตาม owner config และระบบรายงาน unsupported เมื่อ platform ไม่มี adapter

trusted command ใช้สิทธิ์ OS ของผู้ใช้จริงและอาจเข้าถึงสิ่งที่ user เข้าถึงได้ ควรใช้กับ workspace ที่เชื่อถือได้เท่านั้น

## Logging and packaging

ห้าม log access token, refresh token, client secret, OAuth code, private config token หรือ secret file content audit เก็บเฉพาะ metadata ที่ scrubbed

package tarball ต้องไม่มี state DB, private keys, credentials, models, media fixtures หรือ temporary release files

## Cloudflare Tunnel

เจ้าของเป็นผู้สร้าง remotely-managed Tunnel, hostname และ DNS DODO มีโหมด external และ managed โดย managed mode supervise เฉพาะ live `cloudflared` child ที่เริ่มจากคำสั่ง `dodo tunnel start --yes` และไม่ใช้ Cloudflare API

Tunnel token อยู่ใน macOS Keychain, Windows Credential Manager, Linux Secret Service หรือ owner-selected secure environment/file config เก็บเพียง credential reference และ executable path ที่เจ้าของเลือก Token ไม่อยู่ใน CLI argv, child arguments, logs, MCP catalog/response, audit หรือ setup receipt ค่า `TUNNEL_TOKEN` และ `TUNNEL_TOKEN_FILE` ถูกปฏิเสธจาก environment ของ MCP jobs เสมอ

Tunnel route ต้องชี้ทุก public path ไป MCP/OAuth listener `127.0.0.1:21730` เท่านั้น Local Config `21731`, metrics `21732` และ private IPC ไม่ถูก expose readiness บอกสถานะ Cloudflare connection เท่านั้น ไม่ใช่หลักฐานว่า AI client กำลังเชื่อมต่อ

## Setup and existing-state import

`dodo setup --check` และ `dodo setup --plan` เป็น read-only การติดตั้ง dependency ที่ยังขาดต้องมี `--yes` จาก local owner ก่อนเริ่ม installer โดย flag นี้ไม่ข้าม OS elevation, Desktop consent หรือ policy อื่น

`dodo setup --import-state` นำเข้าได้เฉพาะ preference allowlist จาก private `config.json`: config version, MCP/config ports, bounded limits, search backend, log retention และ tool surface เท่านั้น ระบบไม่ copy database, OAuth signing keys, cookies, clients, grants, authorization codes, tokens, workspace ACL, trust, approvals, schedules, public URL/Host/Origin allowlists, web/desktop permissions, LSP commands, environment allowlist หรือ sandbox writable paths

ก่อน commit ระบบตรวจ file type, ownership/ACL, link count, symlink, runtime markers, size และ SHA-256 ซ้ำ หาก source เปลี่ยน, schema ไม่ตรง, มี unknown field หรือมี DODO process ใช้งาน state นั้นอยู่ การนำเข้าจะ fail closed และรักษา source/target เดิมไว้
