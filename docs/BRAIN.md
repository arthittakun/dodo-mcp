# DODO Project Brain

Project Brain เป็น index โครงสร้าง project ที่สร้างใหม่ได้จาก source ปัจจุบัน เพื่อให้
AI ค้น symbols, references, imports/exports, routes, tests และ dependencies ได้โดยไม่
ต้องอ่านทุกไฟล์ใหม่ทุกครั้ง รุ่น 1 รองรับ TypeScript, TSX, JavaScript, JSX และ
dependency metadata ใน `package.json`

## การใช้งาน

Full surface เรียก operation รายตัว:

```text
project_overview()
brain_status(workspaceId=..., workspaceEpoch=...)
brain_query(workspaceId=..., workspaceEpoch=..., query="UserService", nodeTypes=["symbol"])
brain_symbol(workspaceId=..., workspaceEpoch=..., uri="symbol://...")
```

Compact/Hybrid ใช้ gateway เดิม:

```text
dodo_discover(operation="brain_query")
dodo_assist_read(operation="brain_query", args={query:"UserService"})
dodo_assist_change(operation="brain_rebuild", args={mode:"incremental",waitMs:10000})
```

Maintenance operations มี `brain_rebuild`, `brain_pause` และ `brain_cancel` ทั้งหมด
ต้องใช้ `dodo:exec` และยังผ่าน trust/approval policy ของ target operation

## Incremental model

Indexer ทำงานหลัง bootstrap และ refresh เป็นช่วงแบบ bounded:

1. เดินไฟล์ผ่าน shared ignore/path policy
2. เทียบ size, mtime และ ctime กับ cache
3. snapshot UTF-8 source พร้อมตรวจ file identity และ SHA-256
4. parse เฉพาะ content ที่ cache key ไม่ตรง
5. คำนวณ source ที่ได้รับผลจาก imports และ symbol references
6. commit cache, nodes, edges, run metrics และ freshness ใน transaction เดียว

cache key ประกอบด้วย content SHA-256, parser version, graph schema version และ config
hash การย้ายไฟล์แบบ exact-content ใช้ stable file identity เดิม ทำให้ symbol URI คงเดิม
แม้ path เปลี่ยน แต่ copy ที่ยังมี source เดิมอยู่จะได้ identity ใหม่

ไฟล์ใหญ่เกิน 512 KiB, generated/ignored output และไฟล์เกิน bounded semantic file
limit จะไม่ถูก parse สถานะและ metrics บอกจำนวน scanned, parsed, reused, moved,
removed, skipped และ affected files ตาม run ล่าสุด

## Graph contract

Node types:

- `file`
- `symbol`
- `route` — syntax heuristic พร้อม evidence label
- `test` — `describe`/`it`/`test` syntax heuristic
- `dependency`

Edge types:

- `contains`
- `imports`, `exports`, `dynamic_import`
- `references`
- `depends_on`

ทุก node/edge มี source path, source SHA-256, parser/schema version และ freshness
route/reference ที่เป็น heuristic จะระบุใน details และไม่ถูกยกระดับเป็นข้อสรุป runtime

## Freshness และ recovery

`brain_query` ตัด stale/missing row ออกโดย default ใช้ `includeStale:true` เมื่อ
ต้องการวิเคราะห์ drift โดยผลจะระบุ `freshness` ชัดเจน `brain_symbol` รับ URI เฉพาะ
namespace ของ project ปัจจุบัน

เมื่อพบ interrupted run, parser/schema/config mismatch หรือ row ที่ parse ไม่ได้ ระบบ
mark state ตามจริงและ queue full rebuild committed index เดิมไม่ถูกลบก่อน graph ใหม่
พร้อม การ cancel จะยกเลิก worker/run ก่อน transaction commit

## Security contract

- ไม่มี source, plugin, package script หรือ LSP executable จาก repository ถูก execute
- `.env`, credential/private DODO state, traversal, symlink และ hardlink ถูก shared
  WorkspaceFS policy ปฏิเสธ
- index/URI ไม่ให้สิทธิ์ ทุก query ตรวจ live OAuth grant, client, workspace ACL, scope,
  workspace ID/epoch และ current source hash ซ้ำ
- cursor ใช้ HMAC และผูก query, workspace กับ principal; หมดอายุใน 10 นาที
- graph ไม่คัดลอกข้าม workspace และ service ถูกปิดเมื่อ runtime workspace เปลี่ยน
- repository config และ AGENTS.md ไม่สามารถเพิ่ม permission หรือเปิด parser provider

Project Brain ไม่ใช่ OS sandbox และไม่ได้สรุป architectural decision หรือ execute
refactor เอง การแก้ source ยังต้องใช้ file/change tools พร้อม expected hash, journal,
approval และ rollback ตามเดิม
