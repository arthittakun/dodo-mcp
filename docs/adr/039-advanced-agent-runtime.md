# ADR-039 — Capability-narrowing Advanced Agent Runtime

**Status:** Accepted for DODO 1.0.0 Phase 09

## Decision

DODO เพิ่ม durable Agent Runtime สำหรับ goal, immutable plan revisions, bounded parallel
hypotheses, path/symbol/resource intents, metadata snapshots, evidence-backed judgement,
restart recovery และ owner-reviewed reusable guidance

Run เป็น coordination state ที่ผูก principal, workspace และ epoch และมี capabilities
ที่ลดขอบเขตจาก authority เดิมเท่านั้น Managed read/write/exec ต้อง dispatch target จาก
Core catalog ผ่าน `invokeToolDefinition`; target scope, live ACL, trust approval,
WorkspaceFS, expected hash, command sandbox, idempotency และ audit ยังคง authoritative

Effectful path operation ต้องอยู่ใน run `writablePaths` และถือ path intent ที่ครอบ path
นั้น Intent overlap ระหว่าง hypotheses ถูกปฏิเสธ Snapshot ไม่เก็บ contents และ rollback
ได้เฉพาะ exact caller-owned post-snapshot changeset ผ่าน original rollback pipeline

Skill proposal เป็น immutable untrusted guidance ที่ไม่ปรากฏใน search จน owner ตรวจ
exact digest ผ่าน authenticated private IPC Approved version ไม่ executable และไม่เป็น
permission Coordinator pause/cancel ไม่ kill jobs

## Why

Runtime Intelligence มี task/evidence ที่ตรวจสอบย้อนกลับได้ แต่ยังไม่มี contract สำหรับ
แบ่ง hypothesis, ป้องกัน candidate เขียนชนกัน, ผูก completion กับ current evidence หรือ
กู้ coordinator state หลัง restart การเพิ่ม service ที่เก็บ metadata และเรียก target
pipeline เดิมช่วยเพิ่มการประสานงานโดยไม่สร้าง execution authority ชุดที่สอง

## Consequences

- Full surface เพิ่ม 17 operations เป็น 121; Compact/Hybrid คง 19/49
- Core 104 definitions คงชื่อ ลำดับ schema และ behavior เดิม
- SQLite migration เพิ่ม runs/plans/hypotheses/intents/actions/snapshots/judgements และ
  versioned skill proposal/skill tables
- managed exec ใช้ explicit argv/owned handles และมี program/feature/job quotas เพิ่ม
- restart ไม่ replay action; run เก่าเข้า `RECOVERY_REQUIRED`
- owner review มีเฉพาะ private IPC/CLI ไม่มี MCP approval operation

## Rejected alternatives

- generic autonomous super-tool: authority กว้างและ audit target ไม่ชัด
- plan/skill เป็น permission: ทำให้ untrusted stored content เพิ่มสิทธิ์ได้
- automatic rollback/retry หลัง uncertain effect: เสี่ยงทำ side effect ซ้ำ
- cancel coordinator แล้ว kill ทุก job: ละเมิด ownership และอาจหยุดงานอื่น

## Verification

HTTP+OAuth integration fixtures ครอบคลุม immutable plan, conflicting hypotheses,
managed file change, metadata snapshot compare/rollback, current Runtime evidence,
deterministic judgement, exact completion criteria, explicit argv และ restart recovery

Security fixtures ครอบคลุม anonymous/read-only, principal isolation, live ACL revoke,
stale epoch, writable-path + intent checks, secret/traversal/nested-context rejection,
program allowlist, target-bound inspect approval, hostile skill rejection และยืนยันว่า
cancel run ไม่ kill owned job
