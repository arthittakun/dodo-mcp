# DODO Context Engine

Context Engine ช่วยให้ AI ขอข้อมูลตามเป้าหมายและ byte budget โดยไม่ต้องเลือก
เครื่องมือค้นหาระดับล่างทุกตัวเอง ระบบรวม lexical search, Project Brain, Git และ
read-only project federation แล้วคืนหลักฐานที่ตรวจย้อนกลับได้

## เริ่มใช้งาน

Full surface:

```text
context_query(
  goal="Fix login callback",
  terms=["loginCallback", "OAuth"],
  projects=["Frontend", "Backend"],
  budget=24000,
  maxItems=24
)
```

Compact/Hybrid surface:

```text
dodo_discover(operation="context_query")
dodo_assist_read(operation="context_query", args={...})
```

`projects` รับ project ID, workspace ID, exact display name หรือ `active` ได้สูงสุด
8 รายการ รายการว่างหมายถึง active workspace เท่านั้น Project Registry ไม่ได้ให้
สิทธิ์เอง ทุก target ต้องมี live `dodo:read` ACL ของ client ก่อน

## Evidence contract

ผลลัพธ์แยกข้อมูลเป็นห้ากลุ่มเสมอ:

- `FACT` — โครงสร้างที่ parser ระบุและตรวจ source hash แล้ว
- `OBSERVATION` — ข้อความ source/test/docs/config หรือ Git metadata ที่อ่านโดยตรง
- `MEMORY` — ว่างใน Phase 06; memory จะเพิ่มใน Phase 07
- `INFERENCE` — ความสัมพันธ์หรือ syntax heuristic ที่ยังต้องยืนยัน
- `HYPOTHESIS` — ว่างจนกว่าจะมีระบบสร้างสมมติฐานโดยมีหลักฐานรองรับ

แต่ละ record มี project/workspace identity, source kind, opaque resource URI,
relative path, SHA-256, line, commit (ถ้ามี), confidence, ranking reasons,
`generatedAt`, `lastVerifiedAt`, freshness และข้อจำกัด Source text ทุกชนิดมี
`trust: untrusted_content`; README, repository instruction, tool output หรือผลค้นหา
ไม่สามารถเพิ่ม permission หรือเปลี่ยน policy ได้

ใช้ `context_evidence(evidenceId=...)` เพื่อตรวจหลักฐานชิ้นเดิมอีกครั้ง ระบบตรวจ
OAuth/grant/client ACL และ source hash ปัจจุบันใหม่ทุกครั้ง หาก source เปลี่ยนจะคืน
`freshness: stale` โดยไม่อ้างว่าเนื้อหาเดิมยังเป็นปัจจุบัน Evidence ID, source URI,
hash และ cursor ไม่ใช่ bearer capability

## Ranking, budget และ cursor

Ranking เป็น deterministic ภายใต้ query, ACL และ source/index version เดียวกัน
โดยให้เหตุผลต่อ record เช่น parsed graph entity, source/test/docs category และ
literal term match ระบบส่งเฉพาะ evidence ที่พอดีกับ budget, จำกัด candidate/result,
ตัด excerpt แบบ UTF-8 safe และคืน signed cursor เมื่อยังมีผลต่อ Cursor ผูก query,
index version, active workspace และ principal และหมดอายุภายใน 10 นาที

ระบบไม่ dump repository ทั้งก้อน แหล่งที่ยังไม่มี เช่น memory/runtime หรือ graph
ของ federated project จะแสดง `unavailable`/`partial` และ limitation ตามจริง

## Cache L0–L6

Context cache แยกขั้นตั้งแต่ normalized plan (`L0`) ถึง ranked final context (`L6`)
และผูก active workspace, principal และ query hash ทุกชั้นที่อาศัย source เก็บ
dependency path/hash ก่อนใช้ `L6` ซ้ำ ระบบ re-authorize target และตรวจ hash ทุก
dependency หากเปลี่ยนจะลบ derived cache `L1–L6`, mark evidence เดิมเป็น stale และ
สร้างผลใหม่ `L0` ไม่เก็บ source content ที่เป็น authority

Cache มีอายุ 10 นาทีและจำกัด 140 rows ต่อ principal/workspace Evidence มีอายุ
24 ชั่วโมงและจำกัด 1,000 rows `context_status` แสดงจำนวน cache/evidence, hit rate,
latency และ source availability แบบไม่มี query text, path, content, token หรือ owner
state ผล query แสดง term coverage และจำนวน source kinds เพื่อให้วัด retrieval quality
ของ fixture เดิมซ้ำได้

## ขอบเขตของ Phase 06

- semantic graph ใช้ Project Brain ของ active workspace; project อื่นใช้ guarded
  lexical federation และระบุ graph ว่า partial
- Git history ใช้ active workspace เท่านั้น
- memory retrieval และ runtime evidence ยังไม่เปิด และไม่ถูกสร้างขึ้นแทน
- context เป็นข้อมูลช่วยตัดสินใจ ไม่ใช่สิทธิ์เขียน/รันคำสั่ง การแก้ไขยังต้องผ่าน
  target tool, workspace ID/epoch, scope, trust, approval, hash และ path/secret guard
