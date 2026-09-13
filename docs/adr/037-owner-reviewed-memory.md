# ADR-037 — Evidence-backed owner-reviewed memory

**Status:** Accepted for DODO 1.0.0 Phase 07

## Decision

DODO แยก durable memory ออกจาก Context cache และ Project Brain โดยมี seven explicit
kinds, source evidence snapshot, confidence, retention, CURRENT/STALE lifecycle และ
project visibility แยกต่อ record

MCP caller สร้างได้เฉพาะ non-permanent proposal จาก current `context_evidence` ของ
principal เดียวกัน Permanent memory เกิดได้ผ่าน authenticated private owner IPC เมื่อ
proposal ID และ digest ตรงกัน และเมื่อ source/conflict set ยังตรงกับตอนเสนอ

Cross-project visibility ต้องระบุ project IDs ตอน owner approval และไม่ grant client
ACL Learning proposal ต้องอ้าง current reviewed memory อย่างน้อยสองรายการ การ review
learning ไม่ติดตั้ง ไม่ execute และไม่สร้าง authority

Memory search ใช้ target tool pipeline, live OAuth/grant/ACL, bounded scan/budget และ
principal/workspace/query-bound HMAC cursor Context Engine ใช้ memory เป็น evidence class
`MEMORY` และผูก memory content hash/manifest เป็น cache dependency

## Why

Cache ลดงานซ้ำในช่วงสั้น แต่ไม่เหมาะกับการเก็บ decision หรือ successful fix ข้าม
conversation ส่วน graph อธิบายโครงสร้าง code มากกว่าประสบการณ์ การมี store แยกทำให้
owner ตรวจ provenance, conflict, freshness และ retention ได้โดยไม่ยอมให้ repository
content กลายเป็น policy

## Consequences

- Full surface เพิ่มห้า operations เป็น 94 tools; Compact/Hybrid คง 19/49 และ route
  ผ่าน assistance gateways
- SQLite migration เพิ่ม proposal, memory, visibility และ learning-review tables
- source ที่เปลี่ยนหรือ retention หมดทำให้ memory stale และ Context cache ที่พึ่งพา
  memory นั้นใช้ต่อไม่ได้
- owner approval/prune/review มี scrubbed audit และไม่อยู่บน public MCP listener
- v1 ไม่มี autonomous skill installation, self-modifying policy หรือ cross-user sharing

## Verification

Unit, HTTP+OAuth integration และ security fixtures ครอบคลุม proposal/approval digest,
retrieval, Context integration, source staleness, client/ACL/project isolation,
duplicate/conflict, retention/prune, credential-shaped input, prompt injection,
learning review และ owner audit
