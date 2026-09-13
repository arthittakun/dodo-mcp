# DODO MCP — Release Notes

## 1.0.0

- เปิดตัว package `dodo-mcp` และ CLI `dodo`
- เพิ่ม config foundation ที่ใช้ `DODO_CONFIG_DIR` และ safe existing-state preference import แบบ explicit
- เพิ่ม `dodo tunnel configure/status/start/stop/restart/doctor/logs` สำหรับ external และ managed Cloudflare Tunnel โดยไม่จัดการ Cloudflare account/DNS
- Tunnel token ใช้ OS credential store หรือ secure env/file reference และไม่อยู่ใน config/argv/logs/MCP jobs
- `dodo setup --check/--plan` เป็น read-only และ dependency installer ต้องได้รับ `--yes` ก่อนเริ่ม
- state import ไม่คัดลอก OAuth material, database, client/workspace authority หรือ permission-bearing config
- เพิ่ม Compact, Full และ Hybrid MCP tool surfaces
- เพิ่ม operation discovery และ gateway dispatch ผ่าน policy pipeline เดียวกับ direct tools
- คง workspace ID/epoch, ACL, trust, approval, expected hash และ secret/path guards
- รองรับ Local Config workspace switching พร้อม drain, readiness และ rollback
- รวม coding, jobs, Git, intelligence, assistance, multimodal, browser, game, workflow และ schedule capabilities
- เพิ่ม Windows compatibility plan และ setup diagnostics
- เพิ่ม owner-only Project Registry พร้อม stable project ID, path readiness, CLI CRUD และ Local Config UI
- Project relocation รักษา project ID เฉพาะเมื่อ directory identity เดิมตรวจได้ และไม่คัดลอก trust/client ACL
- เพิ่ม read-only multi-project federation ผ่าน overview/list/read/search สูงสุด 8 โปรเจกต์ โดยตรวจ installation identity, target ACL/readiness, source hash และ target-scoped audit
- เพิ่ม `resource_inspect`, `resource_read`, `resource_read_range`,
  `resource_preview`, `resource_extract` และ `resource_transform`
- เพิ่ม installation-private immutable SHA-256 CAS, workspace/principal-scoped
  references, bounded range/resume, expected hash/MIME, MCP image/audio preview,
  safe ZIP metadata และ transactional reference-aware GC
- เพิ่ม Project Brain แบบ incremental สำหรับ TypeScript/JavaScript AST,
  symbols/references/imports/routes/tests/dependencies, stable `symbol://` identity,
  source freshness, rebuild/pause/cancel และ corruption/restart recovery; Full เป็น
  86 tools ส่วน Compact/Hybrid คง 19/49 และ route ผ่าน assistance gateways
- เพิ่ม `context_query`, `context_evidence`, `context_status` สำหรับ goal-driven
  retrieval, evidence 5 classes, provenance/confidence/freshness, deterministic
  ranking, budget/cursor และ dependency-aware L0–L6 cache ทำให้ Full เป็น 89 tools
  โดย Compact/Hybrid คง 19/49 ผ่าน `dodo_assist_read`
- เพิ่ม `memory_search`, `memory_inspect`, `memory_status`, `memory_propose` และ
  `memory_learning_propose` ทำให้ Full เป็น 94 tools ส่วน Compact/Hybrid คง 19/49
  ผ่าน assistance gateways Permanent memory ต้องผ่าน private owner review + exact
  digest, ตรวจ source/retention/ACL ซ้ำ และ learning review ไม่ติดตั้งหรือ execute เอง

## วิธีอัปเดต

```bash
npm install -g dodo-mcp@1.0.0
dodo --version
```

หลังติดตั้งให้ restart DODO process และ rescan MCP connection ตามข้อกำหนดของ client
