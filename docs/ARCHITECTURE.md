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

Local owner CLI ──► authenticated tunnel IPC ──► bounded cloudflared supervisor

Local owner CLI/Config ──► project registry ──► projectId + workspace reference
```

## Bootstrap and workspace lifecycle

`bootstrapWorkspace` เปิด database, store, root policy, ignore engine, planner/applier, jobs, Git, search, intelligence และ optional services สำหรับ root เดียว

`WorkspaceHost` ถือ active workspace เดียวต่อ process การเปลี่ยน workspace ทำแบบ prepare → readiness → drain/teardown → commit และ rollback เมื่อขั้นตอน prepare ล้มเหลว ทุก request resolve active workspace ตอนเริ่ม request และตรวจ identity/epoch ซ้ำใน invocation pipeline

running jobs, in-flight requests, stale Local Config headers และ duplicate server ownership ถูกตรวจเป็น precondition การสลับจะไม่ kill jobs เงียบ ๆ

## Project registry

Project Registry อยู่ใน installation SQLite และใช้ opaque random project ID แยกจาก
path-derived workspace ID รายการเก็บ canonical root, directory identity, display
metadata และ readiness เท่านั้น ไม่ใช่ authority store และไม่มี MCP/public route

การ relocate ที่พิสูจน์ directory identity เดิมได้รักษา project ID แต่คำนวณ
workspace ID จาก path ใหม่ ทำให้ trust และ client ACL ไม่ถูกคัดลอก Registry mutation
และ audit commit ใน transaction เดียวกัน การ remove เป็น soft removal และไม่ลบไฟล์
workspace history หรือ security state

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

Global config อยู่นอก workspace ใน platform config directory และรองรับ `DODO_CONFIG_DIR` เป็น explicit override

`dodo setup --import-state` ใช้ state-import pipeline แยกจาก runtime bootstrap โดยอ่านได้เฉพาะ `config.json` ที่เป็น private regular file, validate ด้วย config schema, เลือกเฉพาะ non-authority allowlist, ตรวจ SHA-256 ซ้ำก่อนเขียน และ commit target ด้วย atomic rename การนำเข้าจะไม่เปิด SQLite เดิมหรืออ่าน/copy keys, tokens, ACL, trust, approvals, schedules, executable registrations หรือ runtime state

Repo config เป็น hints-only และไม่สามารถ widen permissions, change OAuth, disable guards หรือ grant client access

## Tunnel lifecycle

Tunnel config อยู่ใน global owner config และมีเฉพาะ mode, opaque credential reference, canonical executable selection, loopback metrics port และ bounded restart count Credential provider แยกตาม OS ส่วน token ถูก resolve เฉพาะตอน start และส่งผ่าน child environment โดยไม่เข้า argv

managed supervisor เป็น foreground process มี state machine `starting → connecting → connected/backoff → stopped/failed`, private bounded/redacted log และ authenticated singleton IPC `status/logs/stop` การ stop อ้างอิง live `ChildProcess` ที่ supervisor ถืออยู่เท่านั้น External mode ไม่ spawn process และ `doctor` ตรวจ local/public health โดยไม่จัดการ Cloudflare account หรือ DNS

## Optional services

Optional services ถูกสร้างจาก config และ probe readiness ก่อน expose capability ได้แก่ LSP, desktop, media, browser, game, speech และ workflow ทุก operation ใช้ policy gate เดิม

## Observability

startup log แสดง transport, selected surface, tool count และ schema bytes แบบ bounded ไม่ log request args, token หรือ file content
