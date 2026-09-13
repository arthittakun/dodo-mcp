# ADR-038 — Caller-scoped Runtime Intelligence

**Status:** Accepted for DODO 1.0.0 Phase 08

## Decision

DODO เพิ่ม durable runtime session, task reference และ immutable evidence store ต่อ
active workspace Session/evidence ผูก digest ของ `grantId + clientId`, workspace และ
expiration และตรวจ live OAuth/client/workspace ACL ซ้ำทุก access

Runtime task ใช้ `JobManager` และ invocation pipeline เดิมเท่านั้น: explicit
program+argv, policy approval, idempotency, environment allowlist, timeout และ
owner-selected command sandbox Browser collector ใช้ owned `BrowserService` session
เดิมและไม่มี operation เปิด browser/web/permission เอง

Persist เฉพาะ safe structured metadata, aggregate counts และ hashes ไม่ persist raw
stdout/stderr, DOM/console text, request headers, cookies, credentials หรือ environment
values Evidence เปลี่ยนเป็น STALE เมื่อ source recheck ไม่ตรง Snapshot เป็น metadata
manifest และ rollback candidates; rollback จริงยังใช้ change journal เดิม

Context Engine รับ current caller-owned runtime evidence เป็น `OBSERVATION` และใช้
evidence content hash + caller-specific runtime manifest เป็น dependency Runtime
diagnosis แยก FACT/OBSERVATION/INFERENCE และไม่มี effectful handler

## Why

JobManager ทำให้งานอยู่รอดข้าม protocol reconnect อยู่แล้ว แต่ไม่มี task grouping,
bounded evidence provenance หรือ safe path เข้า Context Engine การสร้าง runtime layer
บน service เดิมรักษา execution authority หนึ่งชุดและป้องกัน divergence ระหว่าง job,
browser, sandbox และ gateway policy

## Consequences

- Full surface เพิ่ม 10 operations เป็น 104; Compact/Hybrid คง 19/49
- SQLite migration เพิ่ม runtime sessions/tasks/evidence พร้อม FK, quota และ expiry
- server restart รักษา completed task/evidence metadata แต่ไม่ reattach หรือ signal PID
- raw debugging output ยังใช้ bounded `job_output`; runtime evidence ไม่ทำสำเนา
- v1 ไม่มี autonomous watcher, permission grant, hidden-input capture หรือ automatic fix

## Verification

HTTP+OAuth fixtures ครอบคลุม start/observe/cancel/timeout/idempotent retry,
disconnect/restart reconnect, snapshot staleness, Context retrieval, browser image
passthrough, raw-output non-retention, live ACL revoke, principal isolation,
secret/traversal path guards, inspect approval และ evidence quotas Packaging fixture
ยืนยัน runtime code/docs และ compact dispatch จาก tarball ที่ติดตั้งใหม่
