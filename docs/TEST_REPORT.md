# DODO MCP — Test Report

## Scope

รายงานนี้ใช้กับ DODO MCP 1.0.0 baseline และแยกผล automated กับ manual อย่างชัดเจน

## Automated gates

```bash
npm run build
npm run typecheck
npm run lint
npm run test:all
npm audit --omit=dev
npm pack
```

ผล local gate วันที่ 2026-09-14 (macOS, source checkout):

- build: PASS — full 121, compact 19, hybrid 49 และ config schemas ถูกสร้างสำเร็จ
- typecheck: PASS
- lint: PASS
- core/integration/security/compatibility: 84 files PASS, 2 files platform-skipped; 605 tests PASS, 31 tests platform/prerequisite-skipped
- packaging: 16 tests PASS
- `npm audit --omit=dev`: 0 vulnerabilities (0 low/moderate/high/critical)
- `npm pack`: PASS — required runtime/schemas/docs present and forbidden private state/development artifacts absent; exact final artifact metadata is reported separately so the packaged report does not contain a self-referential checksum
- fresh exact-tarball install: PASS — `dodo --version` = `1.0.0`, Full = 121,
  Compact = 19 และ installed Compact `dodo_assist_read → memory_status`,
  `dodo_assist_change → runtime_session_open` และ `agent_run_open` คืน schemaVersion 1
  จาก fresh state สำเร็จ โดย agent run มี `authority=coordination_only`

macOS owner-flow verification เพิ่มเติมหลังเปลี่ยน Tunnel lifecycle:

- headless Chromium แสดง Local Config จริงที่ 1440px และ 390px; temporary token
  เป็น masked input, ไม่มี external asset และ state มาจาก runtime
- pseudo-terminal fixture เรียก CLI จริงและพิสูจน์ hidden prompt → child environment,
  token ไม่อยู่ใน terminal output/argv/config และ `SIGINT` ปิด owned child พร้อม DODO
- exact tarball fresh install และ global reinstall รายงาน `dodo 1.0.0`; package 408 files
  ไม่มี development docs, state DB, `.env`, model หรือ release evidence
- `dodo setup --check --components all` บน macOS arm64: Git, ripgrep,
  cloudflared, ffmpeg, Whisper/model, Chromium, LSP, speech และ sandbox พร้อม;
  Desktop permission และ outbound web consent ยังไม่เปิดตาม security default

ชุดทดสอบครอบคลุม transport, OAuth, Local Config, workspace switching, ACL, stale context, path/secret guards, changes, jobs, Git, semantic tools, assistance, multimodal, browser, workflow, surface catalog และ packaging

Native candidate regression เพิ่ม lossless NTFS file IDs ผ่าน JSON/SQLite และ
replaced-root checks, LSP drive/URI normalization, portable mid-write rollback,
Windows private-fixture ACL และ writable CAS flush handle ผล local ข้างต้นไม่ใช้
แทนผล native Windows CI; ต้องตรวจ Node 22/24 บน runner `windows-ci 02` แยกกัน

IPC shutdown regression จำลอง endpoint ที่หายไประหว่างตรวจ identity และยืนยันว่า
descriptor ปลอมหรือ ACL ที่เปิดกว้างซึ่งยังอยู่ยังถูกปฏิเสธ Packaging ล้างเฉพาะ
temporary directory ของ suite หลังจบ รวมถึงกรณี test fail เพื่อไม่สะสม native
dependencies และ private fixture state บนเครื่องที่รันทดสอบซ้ำ

Fresh-install smoke รัน installed package ใน process ลูก และให้ parent ลบ fixture
หลังลูก exit เพื่อให้ Windows ปลด native DLL ก่อน cleanup รายงาน `PASS` ถูกเขียน
หลัง verification และ cleanup สำเร็จทั้งคู่เท่านั้น

Setup foundation tests เพิ่มหลักฐานว่า setup plan/check ไม่เขียน state, installer ไม่เริ่มหากไม่มี `--yes`, setup receipt มี schema/kind ที่กำหนด, state import ใช้ allowlist, ตรวจ source hash ซ้ำ, ไม่ merge target เดิม และไม่คัดลอก DB/keys/OAuth/ACL/trust/permission state รวมถึง fail closed ต่อ malformed/unknown config, links และ live IPC markers

Tunnel tests ใช้ fake `cloudflared` และ loopback readiness fixture พิสูจน์ว่า run-scoped token จาก runtime ไม่อยู่ใน config/argv/log/status, child รับผ่าน dedicated environment, job environment ไม่ inherit tunnel variables, owner IPC เป็น singleton ที่ authenticated, readiness มาจาก `/ready`, restart มีเพดาน และ runtime close หยุดเฉพาะ live owned child ไม่มีการใช้ Cloudflare credential, API, DNS หรือ public network จริง

Global launcher และ interactive CLI tests พิสูจน์ว่า `dodo --cli` แสดง/เลือก/เพิ่ม
โปรเจกต์ได้, setup menu ระบุ cloudflared, launcher ไม่ใช้ invocation CWD หรือเผย
private inert root, MCP ถูกปิดด้วย `workspace_required` ก่อนเลือก target, invalid target
ไม่เปิด data plane และ successful switch ใช้ real canonical root พร้อมบันทึก registry
preference Local Config Tunnel fixture พิสูจน์ซ้ำว่า unauthenticated request ถูกปฏิเสธ,
config endpoint ปฏิเสธ raw token, session endpoint ตอบ `tokenStored:false`, raw token
ไม่อยู่ใน response/config/audit และ owner เริ่ม/หยุด process-owned runtime ได้

Project Registry tests ครอบคลุม schema migration, Unicode/spaced canonical paths,
duplicate และ concurrent add, stable project ID, directory relocation, missing/
symlink/replaced readiness, corrupt metadata recovery, transactional audit, reviewed
soft removal, Local Config authentication/XSS boundary, ACL/trust isolation, runtime
workspace switch, Linux inode reuse, fail-closed v1 birth-time migration และ fresh
tarball CLI

Multi-project federation tests ใช้ HTTP + OAuth fixture จริงกับ Project A/B และ
พิสูจน์ concurrent overview/read/search โดย active root/epoch ไม่เปลี่ยน, target
identity/source hash, target-scoped audit, bounded partial failure, installation
identity + per-project ACL, live ACL revocation, stale active epoch, legacy grant
refusal, secret/traversal/replaced-root guards และ strict rejection เมื่อพยายามส่ง
`projectId` เข้า write operation Universal Resource, Project Brain และ Context Engine
operations และ Advanced Agent Runtime ทำให้ surface ปัจจุบันเป็น Full 121 / Compact 19 / Hybrid 49

Universal Resource tests ใช้ HTTP + OAuth และ Compact gateway จริง ครอบคลุม text,
binary range/resume, image/audio MCP blocks, raster transform, PDF/ZIP metadata,
content hash dedup, concurrent ingest, restart persistence, expired-reference GC,
old crash-object recovery, disk/reference quotas, expected hash/MIME, corrupt
decoder input/CAS bytes, anonymous/read-only/revoked ACL, principal ownership,
stale epoch, private config state, secret/traversal/symlink/hardlink และ target-specific
inspect approval รวมถึง SQLite aggregate-quota trigger และ orphan grace ที่กัน GC
ชนกับการสร้าง reference

Project Brain tests ใช้ HTTP + OAuth, Full และ Compact gateway จริง ครอบคลุม bundled
TypeScript AST parser, symbols/references/imports/routes/tests/dependencies, incremental
one-file parse, affected relations, exact-content move ที่รักษา `symbol://` identity,
syntax error, deleted/generated/secret/private files, pagination, cancel/concurrent run,
restart/corruption recovery, source-hash freshness, anonymous/read-only/revoked ACL,
workspace epoch, traversal/symlink/hardlink, principal-bound cursor และ target-specific
inspect approval โดยไม่ execute source หรือ repository plugin

Context Engine tests ใช้ HTTP + OAuth, direct Full และ Compact gateway จริง ครอบคลุม
goal/Thai+identifier terms, deterministic ranking/evidence IDs, byte budget, cursor,
L0–L6 cache hit/metrics, source-hash freshness transition, evidence recheck, active และ
federated A/B retrieval by ID/name, unavailable target partial result, anonymous/live
ACL/revocation, principal/workspace/cursor binding, secret/private-state/symlink guards,
repository instruction เป็น untrusted content, canonical signed cursor, cache corruption
recovery, Memory dependency freshness และ Runtime dependency freshness Fixture
baseline มี precision=1 และ recall=1 สำหรับ source/test/docs ที่กำหนด พร้อม term
coverage=1 และ latency ต่ำกว่า 5 วินาทีใน isolated local fixture (ไม่ใช่ production SLA)

Memory tests ใช้ HTTP + OAuth, Full/Compact assistance gateways และ authenticated
private owner IPC จริง ครอบคลุม evidence-bound proposal, exact digest approval,
CURRENT/STALE retrieval, Context `MEMORY` evidence, source change ก่อน/หลัง approval,
cross-client evidence isolation, live per-project ACL, explicit cross-project visibility,
duplicate/conflict review, credential-shaped text, repository prompt injection,
principal/workspace-bound canonical cursor, retention/prune ที่ไม่ลบ current record หรือ
project file, learning proposal จาก current reviewed memory, non-executable owner review
และ scrubbed owner audit

Runtime Intelligence tests ใช้ HTTP + OAuth และ Compact gateways จริง ครอบคลุม
durable session, nonblocking task start, completed-task reconnect หลัง server restart,
idempotent retry ที่ไม่สร้าง job ซ้ำ, cancel, wall timeout, close refusal ขณะ running,
process/test aggregate evidence, raw-output non-retention, guarded test-report counts,
snapshot staleness, Context `OBSERVATION`, deterministic diagnosis, anonymous/read-only/
revoked ACL, principal isolation, stale epoch, secret/traversal report path และ quota
Headless Chromium fixture พิสูจน์ existing-session-only collection, MCP image passthrough
persisted hashes/counts/bounded navigation timing, WebSocket-blocked policy และการ mark
หลักฐานเดิมเป็น stale หลังหน้าเปลี่ยน โดยไม่มี DOM/console/password/header text

Advanced Agent Runtime tests ใช้ HTTP + OAuth และ Compact gateways จริง ครอบคลุม
immutable plan revision, bounded hypotheses, overlapping intent refusal, managed
write/exec/read, metadata snapshot compare + original-journal rollback, current Runtime
evidence judgement, exact completion criteria, durable restart recovery และ private
owner skill review Security fixtures ครอบคลุม anonymous/read-only, principal isolation,
live ACL revoke, stale epoch, path capability + intent, secret/traversal/nested context,
program allowlist, target-bound inspect approval, hostile skill rejection และยืนยันว่า
cancel coordinator ไม่ kill owned job

Resource และ Project Brain cursor tests ตรวจ canonical Base64URL + HMAC ซ้ำ โดย token
ที่เปลี่ยนอักขระท้ายต้องได้ `INVALID_INPUT` แม้ decoder จะถอด non-canonical text เป็น
byte sequence เดียวกันได้

Headless Chromium fixture เปิด Local Config จริงที่ ephemeral loopback ports เพิ่ม
Project B ผ่าน UI, แสดงผลที่ desktop และ 390px, กดเปิดรายการ และตรวจว่า active
workspace เปลี่ยนเป็น canonical root B สำเร็จ ภาพอยู่ใน local ignored artifacts และ
ไม่ถูก pack การตรวจบน owner browser/config จริงยังคง `MANUAL_NOT_RUN`

## Surface evidence

- Full surface: 121 tools
- Compact surface: 19 tools
- Hybrid surface: 49 tools
- generated schema metric: Full 415,361; Compact 49,071; Hybrid 116,551 bytes
- Compact schema เป็น catalog แยกและลด schema load ตอนเชื่อมต่อ
- Full schema อยู่ใน `schemas/tools.json`
- Compact schema อยู่ใน `schemas/tools.compact.json`
- Hybrid schema อยู่ใน `schemas/tools.hybrid.json`

## DodoBench / release gate

DodoBench core v1 ใช้ isolated real HTTP + OAuth fixtures ประเมิน 7 เคสบนเครื่องที่มี
Chromium: retrieval A/B, safe edit, runtime diagnosis, image resource, restart recovery,
security boundaries และ browser image block ผลแต่ละรอบบันทึก revision/lock/config/OS,
tool calls, serialized bytes, p50/p95, precision/recall, wrong-file rate, cache hit และ
security violations โดย `modelTokens=null` เพราะไม่มี model call

Fresh release smoke ติดตั้ง exact tarball ใน temporary prefix แล้วตรวจ CLI 1.0.0,
STDIO Full 121, HTTP Streamable + OAuth Compact 19 และ write/edit read-backจริง
Release policy ใช้ macOS local และ Linux Docker โดย report ต้องมี revision/lock digest
ตรงกันก่อน strict gate จะผ่าน Linux Docker image ติดตั้ง Playwright Chromium
Dedicated self-hosted GitHub Actions รัน Linux X64 Docker และ Windows X64 native
candidate บน Node 22/24 โดยไม่รับ untrusted pull requests Windows manual acceptance
ยังคง `MANUAL_NOT_RUN`

## Required security scenarios

- anonymous HTTP request ได้ 401
- read-only scope เรียก write/exec ไม่ได้
- token ที่ไม่มี workspace ACL ถูกปฏิเสธ
- workspace mismatch และ stale epoch ถูกปฏิเสธ
- secret, traversal, symlink และ hardlink guard fail closed
- inspect mode ยังคง target approval
- expected hash conflict ไม่ overwrite ไฟล์
- running jobs block workspace switch
- switch failure ทำให้ workspace เดิมใช้งานต่อได้
- gateway ไม่เรียก gateway อื่นหรือ owner controls
- federated target ที่ไม่มี ACL/installation identity ถูกปฏิเสธโดยไม่เผย path
- federated secret/traversal/replaced root fail closed และ write/exec federation ยังปิด
- memory proposal ใช้ evidence ID ข้าม client ไม่ได้และ source-changed proposal fail closed
- AI ไม่มี MCP operation สำหรับ memory approval/prune/learning review; owner action ใช้ private authenticated IPC + digest
- current memory ไม่ถูก prune และ learning approval ไม่ติดตั้ง/execute หรือ grant authority
- runtime handle ข้าม principal/workspace ไม่ได้, revoke มีผลทันที และ inspect exec ยังต้อง target-bound approval
- runtime evidence ไม่เก็บ raw process/browser secret และ changed source ถูก mark stale
- agent run ไม่เพิ่ม authority, managed target ตรวจ live ACL/epoch/scope/policy ซ้ำ และ path write ต้องมี capability + intent
- agent skill ที่ยังไม่ผ่าน exact private owner review ถูกซ่อนและไม่ executable
- agent coordinator cancel/pause ไม่ kill job และ restart ไม่ replay action

## Packaging

ตรวจว่า tarball มี `dist`, `schemas`, `docs`, `README.md`, setup scripts และ native sources ตาม package policy และไม่มี state DB, OAuth credentials, tokens, models หรือ release temp files

## Manual gates

การทดสอบผ่าน ChatGPT, Claude หรือเครื่อง Windows จริงต้องทำใน environment ของผู้ใช้และรายงานแยกเป็น `MANUAL_PASS` หรือ `MANUAL_NOT_RUN` ห้ามสรุปจาก catalog, macOS หรือ Linux Docker เพียงอย่างเดียว

สถานะ manual setup/import บน owner state จริง: `MANUAL_NOT_RUN` การตรวจรับใช้ isolated fixtures และ temporary package เท่านั้น ไม่มีการเปลี่ยน owner config, OAuth state, tunnel, DNS หรือ global installation

สถานะ real Cloudflare Tunnel บน macOS/Windows/Linux: `MANUAL_NOT_RUN`

สถานะ multi-project federation ผ่าน external AI และ owner project จริง: `MANUAL_NOT_RUN`

สถานะ owner-reviewed Memory ผ่าน external AI และ owner repository จริง: `MANUAL_NOT_RUN`

สถานะ Runtime Intelligence ผ่าน external AI และ owner repository จริง: `MANUAL_NOT_RUN`

สถานะ Advanced Agent Runtime ผ่าน external AI และ owner repository จริง: `MANUAL_NOT_RUN`
