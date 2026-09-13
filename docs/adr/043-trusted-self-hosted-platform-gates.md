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

Linux runner label `linux-ci` รัน release gate ภายใน Docker image เดิมบน Node 22/24
Windows runner label `windows-ci` รัน native candidate release gate บน Node 22/24
พร้อมตรวจ enabled Administrator token สำหรับ ACL tests ทั้งสอง job upload เฉพาะ
non-secret ignored evidence และไม่มีขั้น publish npm

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
