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

- build: PASS — full 86, compact 19, hybrid 49 และ config schemas ถูกสร้างสำเร็จ
- typecheck: PASS
- lint: PASS
- core/integration/security/compatibility: 69 files PASS, 2 files platform-skipped; 544 tests PASS, 30 tests platform/prerequisite-skipped
- packaging: 14 tests PASS
- `npm audit --omit=dev`: 0 vulnerabilities (0 low/moderate/high/critical)
- `npm pack`: PASS — required runtime/schemas/docs present and forbidden private state/development artifacts absent; exact final artifact metadata is reported separately so the packaged report does not contain a self-referential checksum
- fresh exact-tarball install: PASS — `dodo --version` = `1.0.0`, Full = 86,
  Compact = 19 และ `dodo_assist_change → brain_rebuild` ตามด้วย
  `dodo_assist_read → brain_query` พบ symbol `packedBrain` พร้อม
  `sourceVerified:true` จาก installed artifact สำเร็จ

ชุดทดสอบครอบคลุม transport, OAuth, Local Config, workspace switching, ACL, stale context, path/secret guards, changes, jobs, Git, semantic tools, assistance, multimodal, browser, workflow, surface catalog และ packaging

Setup foundation tests เพิ่มหลักฐานว่า setup plan/check ไม่เขียน state, installer ไม่เริ่มหากไม่มี `--yes`, setup receipt มี schema/kind ที่กำหนด, state import ใช้ allowlist, ตรวจ source hash ซ้ำ, ไม่ merge target เดิม และไม่คัดลอก DB/keys/OAuth/ACL/trust/permission state รวมถึง fail closed ต่อ malformed/unknown config, links และ live IPC markers

Tunnel tests ใช้ fake `cloudflared` และ loopback readiness fixture พิสูจน์ว่า token ไม่อยู่ใน config/argv/log, job environment ไม่ inherit tunnel variables, private file/link policy fail closed, owner IPC เป็น singleton ที่ authenticated, readiness มาจาก `/ready`, restart มีเพดาน และ stop ใช้ live owned child เท่านั้น ไม่มีการใช้ Cloudflare credential, API, DNS หรือ public network จริง

Project Registry tests ครอบคลุม schema migration, Unicode/spaced canonical paths,
duplicate และ concurrent add, stable project ID, directory relocation, missing/
symlink/replaced readiness, corrupt metadata recovery, transactional audit, reviewed
soft removal, Local Config authentication/XSS boundary, ACL/trust isolation, runtime
workspace switch และ fresh tarball CLI

Multi-project federation tests ใช้ HTTP + OAuth fixture จริงกับ Project A/B และ
พิสูจน์ concurrent overview/read/search โดย active root/epoch ไม่เปลี่ยน, target
identity/source hash, target-scoped audit, bounded partial failure, installation
identity + per-project ACL, live ACL revocation, stale active epoch, legacy grant
refusal, secret/traversal/replaced-root guards และ strict rejection เมื่อพยายามส่ง
`projectId` เข้า write operation Universal Resource และ Project Brain operations ทำให้
surface ปัจจุบันเป็น Full 86 / Compact 19 / Hybrid 49

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

Headless Chromium fixture เปิด Local Config จริงที่ ephemeral loopback ports เพิ่ม
Project B ผ่าน UI, แสดงผลที่ desktop และ 390px, กดเปิดรายการ และตรวจว่า active
workspace เปลี่ยนเป็น canonical root B สำเร็จ ภาพอยู่ใน local ignored artifacts และ
ไม่ถูก pack การตรวจบน owner browser/config จริงยังคง `MANUAL_NOT_RUN`

## Surface evidence

- Full surface: 86 tools
- Compact surface: 19 tools
- Hybrid surface: 49 tools
- generated schema metric: Full 290,795; Compact 47,583; Hybrid 115,063 bytes
- Compact schema เป็น catalog แยกและลด schema load ตอนเชื่อมต่อ
- Full schema อยู่ใน `schemas/tools.json`
- Compact schema อยู่ใน `schemas/tools.compact.json`
- Hybrid schema อยู่ใน `schemas/tools.hybrid.json`

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

## Packaging

ตรวจว่า tarball มี `dist`, `schemas`, `docs`, `README.md`, setup scripts และ native sources ตาม package policy และไม่มี state DB, OAuth credentials, tokens, models หรือ release temp files

## Manual gates

การทดสอบผ่าน ChatGPT, Claude หรือเครื่อง Windows จริงต้องทำใน environment ของผู้ใช้และรายงานแยกเป็น `MANUAL_PASS` หรือ `MANUAL_NOT_RUN` ห้ามสรุปจาก catalog เพียงอย่างเดียว

สถานะ manual setup/import บน owner state จริง: `MANUAL_NOT_RUN` การตรวจรับใช้ isolated fixtures และ temporary package เท่านั้น ไม่มีการเปลี่ยน owner config, OAuth state, tunnel, DNS หรือ global installation

สถานะ real Cloudflare Tunnel บน macOS/Windows/Linux: `MANUAL_NOT_RUN`

สถานะ multi-project federation ผ่าน external AI และ owner project จริง: `MANUAL_NOT_RUN`
