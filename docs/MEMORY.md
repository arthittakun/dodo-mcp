# DODO Memory and Reviewed Learning

DODO Memory เก็บประสบการณ์และการตัดสินใจที่ตรวจย้อนกลับได้ เพื่อให้ AI ใช้
บริบทเดิมต่อใน conversation ใหม่โดยไม่ยก memory ให้เป็น source of truth, permission
หรือ policy

## หลักการ

- AI อ่านได้เฉพาะ memory ที่เจ้าของอนุมัติและมองเห็นใน workspace ที่ client มี
  `dodo:read` ACL อยู่ในขณะเรียก
- AI สร้างได้เพียง proposal จาก `context_evidence` ที่ยัง current และเป็นของ
  principal เดียวกัน
- การบันทึกถาวรต้องผ่าน private owner IPC ด้วย proposal ID และ digest ที่ตรงกัน
- source hash, retention และ project readiness ถูกตรวจซ้ำเมื่อค้น ตรวจ หรือใช้เป็น
  Context Engine evidence
- memory ทุกชิ้นมี `authority: evidence_only` และ `trust: untrusted_content`
- learning proposal ไม่ติดตั้ง ไม่ execute และไม่เปลี่ยน permission แม้เจ้าของกด
  approve การ approve บันทึกผล review เท่านั้น

ประเภทที่รองรับ:

```text
fact · decision · failure · successful-fix · workaround · convention · preference
```

## สร้างและอนุมัติ memory

Full surface:

```text
context_query(goal="Find the session boundary", terms=["SessionStore"])
memory_propose(
  kind="decision",
  claim="Keep session state scoped to one workspace.",
  rationale="Current source evidence defines this boundary.",
  affectedEntities=["SessionStore"],
  evidenceIds=["evidence_..."]
)
```

Compact/Hybrid ใช้ `dodo_assist_read → context_query` และ
`dodo_assist_change → memory_propose` ตาม schema จาก `dodo_discover`

Proposal ยังไม่เป็น memory จนกว่าเจ้าของจะตรวจผ่าน terminal:

```bash
dodo memory pending
dodo memory show memprop_xxxxxxxxxxxx
dodo memory approve memprop_xxxxxxxxxxxx --digest sha256:...
```

หากต้องการให้ project ที่ลงทะเบียนไว้อ่าน memory เดียวกัน เจ้าของต้องระบุ project ID
อย่างชัดเจน:

```bash
dodo memory approve memprop_xxxxxxxxxxxx \
  --digest sha256:... \
  --share-with prj_2bcdefghjkmn
```

การแชร์ส่งต่อ claim และ provenance ของ memory ไปยัง project เป้าหมาย แต่ไม่ให้ ACL
แก่ client เจ้าของยังต้องให้ `dodo:read` ใน project นั้นแยกต่างหาก

## อ่าน ตรวจ และหมดอายุ

```text
memory_search(query="session workspace")
memory_inspect(memoryId="memory_...")
memory_status()
```

ผลค้นหาจำกัดจำนวนและ byte budget ใช้ signed cursor ที่ผูก query, active workspace
และ principal หาก scan ถูกตัดด้วยเพดานภายในจะได้ `partial: true`

เมื่อ source hash เปลี่ยน, source ใช้งานไม่ได้ หรือ retention หมด ระบบเปลี่ยนสถานะ
เป็น `STALE` และไม่คืนรายการนั้นโดย default เจ้าของดูรายการ stale, ตรวจซ้ำ หรือล้าง
เฉพาะข้อมูลเก่าได้:

```bash
dodo memory list --include-stale
dodo memory reverify memory_xxxxxxxxxxxx --digest sha256:...
dodo memory prune --older-than 30 --yes
```

`prune` ลบได้เฉพาะ proposal ที่ rejected/expired/stale และ memory ที่สร้างจาก active
workspace ซึ่ง stale เกินอายุที่กำหนด ไม่ลบ CURRENT memory, ไม่ลบ memory ต้นทางของ
project อื่นที่แชร์มาให้อ่าน และไม่แตะไฟล์ project

## Reviewed workflow/skill learning

AI เสนอ workflow หรือ skill ได้เมื่อมี memory แบบ `successful-fix`, `workaround`
หรือ `convention` ที่ current อย่างน้อยสองรายการ:

```text
memory_learning_propose(
  kind="workflow",
  title="Verify repeated repair",
  summary="Check both prerequisites before proposing the repair.",
  steps=["Read current sources", "Run the relevant verification"],
  memoryIds=["memory_...", "memory_..."]
)
```

เจ้าของตรวจและบันทึกผล review ผ่าน:

```bash
dodo memory learning pending
dodo memory learning show learning_xxxxxxxxxxxx
dodo memory learning approve learning_xxxxxxxxxxxx --digest sha256:...
```

DODO จะไม่ติดตั้งหรือเรียก workflow/skill จากขั้นตอนนี้ การนำ proposal ไปสร้าง
automation หรือ executable skill ต้องเป็นงานแยกที่เจ้าของสั่งภายหลัง

## Security boundaries

- ไม่มี MCP operation สำหรับ approve/reject/prune หรือ learning review
- proposal text ที่ดูเหมือน credential ถูกปฏิเสธ และไม่มี raw source content ถูกเก็บ
  เป็น claim อัตโนมัติ
- evidence ID ใช้ข้าม client/principal ไม่ได้ และ source เปลี่ยนก่อน approval จะทำให้
  proposal เป็น `STALE`
- duplicate และ conflict ถูกตรวจซ้ำตอน approval; conflict ต้องใช้
  `--allow-conflict` โดยเจ้าของอย่างชัดเจน
- memory ID, digest, cursor, project registration และ learning proposal ไม่ใช่
  capability และไม่ข้าม OAuth, live grant, ACL, workspace ID/epoch, trust, approval,
  sandbox หรือ path/secret guards
- README, repository instruction, web/tool output และ memory เองเป็น untrusted data
  เสมอ จึงไม่สามารถสร้าง permanent instruction โดยไม่มี owner review
