# ADR-043: Trusted self-hosted platform gates

Status: Accepted

## Context

หลัง ADR-041 เจ้าของติดตั้ง dedicated GitHub Actions runners บน Linux X64 และ
Windows X64 สำเร็จ จึงสามารถเก็บ platform evidence จากเครื่องที่ควบคุมได้โดยตรง
Repository เป็น public ทำให้ workflow ที่ execute pull-request code บน persistent
self-hosted runner มีความเสี่ยงต่อเครื่อง, network และ credentials ของเจ้าของ

## Decision

เปิด workflow `platform-gates` สำหรับ `push` ที่ branch `main` และ
`workflow_dispatch` เท่านั้น ไม่มี `pull_request` หรือ `pull_request_target` trigger
ทุก job ใช้ `contents: read`, checkout ไม่ persist credentials และ action dependency
ถูก pin ด้วย full commit SHA

`push main` และ manual dispatch ค่าเริ่มต้นรันเฉพาะ Windows Node 22/24
ยอมรับผล Linux Docker ที่ตรวจในเครื่องได้โดยไม่บังคับทดสอบ Linux X64 ซ้ำ
หากต้องการ remote Linux เพิ่ม เจ้าของเลือก `platform=linux` หรือ `all`
ใน manual dispatch ได้ การเลือก job ไม่เปลี่ยนผลหรือ identity ของ evidence เดิม

Linux runner label `linux-ci` รัน release gate ภายใน Docker image เดิมบน Node 22/24
Windows runner label `windows-ci 02` รัน native candidate release gate บน Node 22/24
พร้อมตรวจ enabled Administrator token สำหรับ ACL tests ทั้งสอง job upload เฉพาะ
`public-summary.json` ที่สร้างด้วย explicit field allowlist และกำหนด retention
7 วัน ไม่ upload raw logs, runner identity, state หรือ evidence directory ทั้งชุด
ไม่มีขั้น publish npm

macOS ยังคงเป็น local release gate Strict release readiness ต้องมี macOS กับ Linux
evidence จาก clean revision และ dependency lock เดียวกัน Windows automated result
ไม่เปลี่ยน manual Windows 11 acceptance และไม่ประกาศ support เอง

## Consequences

Platform regression ทำซ้ำบน dedicated machines และ failure ไม่ถูกซ่อนด้วย
`continue-on-error` แลกกับการไม่รัน untrusted PR บน self-hosted hardware หากต้องการ
PR checks ภายหลังต้องใช้ disposable isolated runner boundary แยกต่างหาก

## Evidence

`.github/workflows/platform-gates.yml`, `scripts/test-linux-docker.mjs` และ
`scripts/release-gate.mjs` บันทึก platform, runner origin, revision, lock digest,
test/package/audit/fresh-install results โดยไม่เก็บ token

## Evidence/privacy update

Readiness ไม่ dump `docker info`; gate/Docker child diagnostics รวม error paths
เก็บเฉพาะใน private logs Public summary ไม่รับ error strings, command arguments,
test names หรือ host identity จากรายงานดิบ และตรวจ machine-test counts กับ
assertion results ก่อนรับรองผ่าน แต่ GitHub runner ยังแสดง Machine name ใน
Set up job ก่อน workflow steps; owner ต้องจัดการ hostname และ logs เก่าแยก
การเปลี่ยน source นี้ไม่ลบสิ่งที่เคยเผยแพร่แล้ว

Gate บันทึก code/test/gate fingerprint สำหรับ dirty candidate เพิ่มจาก HEAD/lock
และตรวจอีกครั้งตอนจบ Docker ตรวจ fingerprint ของไฟล์ที่ COPY จริงกับ host
ไม่ใช้ HEAD เดิมรับรอง uncommitted source คนละชุด และไม่เปลี่ยน release policy
