# DODO MCP — Architecture

## Overview

DODO แบ่งเป็น data plane สำหรับ MCP tools และ owner control plane สำหรับ Local Config/CLI ทั้งสอง plane ใช้ state และ workspace lifecycle เดียวกัน แต่ public MCP ไม่มี admin endpoint

```text
AI client
   │ OAuth + MCP
   ▼
HTTP MCP 127.0.0.1:21730 ──► surface registry ──► policy/invocation pipeline
                                      │
                                      ├─ workspace services
                                      ├─ changes and jobs
                                      ├─ Git/intelligence/LSP
                                      └─ assistance/multimodal/workflow

Owner browser/CLI
   │ loopback + capability token / IPC
   ▼
Local Config 127.0.0.1:21731 ──► WorkspaceHost ──► active workspace lifecycle
```

## Bootstrap and workspace lifecycle

`bootstrapWorkspace` เปิด database, store, root policy, ignore engine, planner/applier, jobs, Git, search, intelligence และ optional services สำหรับ root เดียว

`WorkspaceHost` ถือ active workspace เดียวต่อ process การเปลี่ยน workspace ทำแบบ prepare → readiness → drain/teardown → commit และ rollback เมื่อขั้นตอน prepare ล้มเหลว ทุก request resolve active workspace ตอนเริ่ม request และตรวจ identity/epoch ซ้ำใน invocation pipeline

running jobs, in-flight requests, stale Local Config headers และ duplicate server ownership ถูกตรวจเป็น precondition การสลับจะไม่ kill jobs เงียบ ๆ

## Tool invocation

ทุก direct tool และ gateway ใช้ pipeline กลาง:

1. resolve principal
2. ตรวจ active workspace และ ACL
3. ตรวจ workspace ID/epoch
4. ตรวจ required OAuth scope
5. parse input schema แบบ strict
6. ตรวจ trust/action/approval และ idempotency
7. เรียก handler
8. validate output และส่ง content blocks
9. บันทึก audit แบบ scrubbed

Gateway ไม่เรียก handler ตรง ๆ และไม่สามารถเรียก gateway อื่น, project overview หรือ owner controls

## Tool surfaces

- Full catalog 74 individual definitions
- Compact catalog 19 definitions: overview, discover และ gateways
- Hybrid catalog 49 definitions: compact core ตามด้วย direct tools

`schemas/tools.json` เป็น full schema ส่วน compact และ hybrid เป็น schema แยก การเลือก surface เปลี่ยนการ expose เท่านั้น ไม่เปลี่ยน permission

## State and security

SQLite ใช้ durable migrations, WAL ตาม platform และ transaction ที่เหมาะสม Changesets มี immutable plan, journal, backups และ recovery marker

Global config อยู่นอก workspace ใน platform config directory รองรับ `DODO_CONFIG_DIR` เป็น override หลัก และรักษา legacy override เพื่อ migration แบบ explicit

Repo config เป็น hints-only และไม่สามารถ widen permissions, change OAuth, disable guards หรือ grant client access

## Optional services

Optional services ถูกสร้างจาก config และ probe readiness ก่อน expose capability ได้แก่ LSP, desktop, media, browser, game, speech และ workflow ทุก operation ใช้ policy gate เดิม

## Observability

startup log แสดง transport, selected surface, tool count และ schema bytes แบบ bounded ไม่ log request args, token หรือ file content
