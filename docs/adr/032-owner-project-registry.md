# ADR-032: Owner-only durable project registry

Status: Accepted

## Context

Workspace identity เดิมเหมาะกับการ enforce authority ของ active root แต่ถูกสร้าง
จาก installation secret และ canonical path จึงไม่ใช่ stable product identity เมื่อ
เจ้าของ rename โปรเจกต์ และไม่สามารถใช้เป็นรายการหลายโปรเจกต์ที่ตรวจ readiness ได้

## Decision

เพิ่ม installation-level SQLite `project_registry` ที่ใช้ opaque random `projectId`
แยกจาก path-derived `workspaceId` Registry เก็บ canonical root, directory identity,
display name, metadata version และ timestamps พร้อม soft removal

CLI และ Local Config เท่านั้นที่เข้าถึง registry ไม่มี MCP tool หรือ public admin
route การ add/remove ไม่เปลี่ยน trust, OAuth, ACL, jobs, plans หรือ history

การ add path ใหม่ที่ path เดิมหายและ dev/inode ตรงกับรายการเดิมถือเป็น relocation:
projectId คงเดิม แต่ workspaceId เปลี่ยนตาม canonical path ใหม่ จึงไม่มี authority
ไหลตาม project identity หาก path เดิมถูกแทนด้วย identity อื่น ระบบ fail closed และ
ต้องให้เจ้าของ remove/add หลัง review

Registry mutation และ scrubbed audit commit ใน SQLite transaction เดียวกัน
metadata ที่ผิดรุ่นถูกแสดงเป็น `invalid` และไม่ถือว่า ready แต่ยังนำออกแบบ reviewed
removal ได้

## Consequences

process หนึ่งยังมี active workspace เดียว Registry เป็น foundation สำหรับ federation
ภายหลังและไม่เปลี่ยน MCP catalog การนำรายการออกไม่ลบ workspace authority/history
เพื่อหลีกเลี่ยง destructive side effects

## Evidence

`tests/unit/projectRegistry.test.ts`, `tests/security/projectRegistry.test.ts`,
`tests/integration/projectRegistry.test.ts`, Local Config/workspace switch regression
tests และ packaging smoke ครอบคลุม migration, duplicate/concurrent add, relocation,
identity replacement, corruption recovery, ACL isolation และ owner boundary
