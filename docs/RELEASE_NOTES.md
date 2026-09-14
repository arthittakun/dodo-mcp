# DODO MCP — Release Notes

## 1.0.1

### Platform และ release hardening

- เพิ่ม Linux Docker gate และ Windows native self-hosted gates สำหรับ Node 22/24
- ทำ Windows checkout/fingerprint ให้ deterministic เมื่อ runner ถูกใช้ซ้ำและมีนโยบาย
  CRLF ต่างจาก repository โดยตรวจ tracked tree ให้สะอาดก่อนเริ่ม gate
- release gate ตรวจ typecheck, lint, core/security/compatibility, packaging, production
  dependency audit, DodoBench และ fresh exact-tarball install
- เพิ่ม regression tests สำหรับ Linux media, tunnel credential handling และการจัดการ
  gate evidence โดยไม่เปลี่ยน runtime/API contract จาก 1.0.0
- ไม่มีการลด OAuth, project ACL, workspace context, approval, path/secret guard,
  expected-hash conflict protection หรือ command sandbox

## วิธีอัปเดตเป็น 1.0.1

```bash
npm install -g dodo-mcp@1.0.1
dodo --version
```

หลังติดตั้งให้ restart DODO process และ rescan/recreate MCP connection เมื่อ client cache
tool catalog เดิม

## 1.0.0

### Global launcher และ interactive CLI

- เพิ่ม `dodo --cli` เป็นเมนู owner สำหรับเลือก/เพิ่มโปรเจกต์ เปิด server + Tunnel
  ด้วย token ชั่วคราว และ setup dependencies รวม cloudflared
- `dodo`/`dodo start` ใช้โปรเจกต์ที่ owner เลือกล่าสุด หรือเปิด launcher mode ที่ไม่มี
  active AI workspace แทนการใช้ CWD โดยอัตโนมัติ; `--root` เลือกและจำ root แบบ explicit
- Local Config เพิ่มโปรเจกต์แล้วเปิดได้ทันที และรองรับสถานะก่อนเลือก workspace
- `dodo start` และ Local Config รับ Cloudflare token แบบ run-scoped ไม่บันทึกลงเครื่อง และหยุด child พร้อม DODO
- เพิ่ม personal mode เป็นค่าเริ่มต้น: owner เพิ่ม project, connection และ profile แล้วใช้
  ได้ทันทีตาม OAuth/profile scopes โดยไม่ตั้ง ACL/trust/egress ซ้ำ; managed mode เดิมยังมี
- persistent Desktop/Chrome named-app consent เป็นระดับ installation อนุญาตครั้งเดียว
  จาก directory ใดก็ได้ ขณะที่ OS permission, scopes, snapshots และ app allowlist ยังตรวจครบ
- เพิ่มสวิตช์ Settings สำหรับ expose Sub-agent operations ให้ MCP โดยค่าเริ่มต้นปิด;
  หน้าเว็บ Chat & Tasks ยังใช้ agent ได้ และการเปิดสวิตช์ไม่เพิ่มสิทธิ์ใด ๆ

### DodoBench และ release evidence

- เพิ่ม deterministic DodoBench baseline ครอบคลุม cross-project retrieval, safe edit,
  runtime diagnosis, resource image, durable recovery, authorization และ optional browser
- เพิ่ม candidate/strict release gate พร้อม audit, manifest policy, checksum และ fresh
  exact-tarball smoke ของ CLI, STDIO Full และ HTTP/OAuth Compact
- รายงานผูกกับ Git revision, dataset, dependency lock, configuration และ platform;
  model token เป็น `null` เมื่อไม่มี model call และ manual/platform status ไม่ถูกแต่งขึ้น
- ใช้ macOS local + Linux Docker เป็น release gate และเพิ่ม dedicated self-hosted
  GitHub Actions สำหรับ Linux/Windows Node 22/24 เฉพาะ trusted main/manual โดย
  Windows manual gate ยังคง `MANUAL_NOT_RUN`
- Project Registry metadata v2 ผูก canonical path กับ device/inode/birthtimeNs เพื่อ
  ปฏิเสธ directory replacement แม้ Linux reuse inode โดย row v1 ที่ไม่มี birth time
  จะไม่ถูก auto-upgrade และต้องให้เจ้าของ review/remove/add ใหม่

- เปิดตัว package `dodo-mcp` และ CLI `dodo`
- เพิ่ม config foundation ที่ใช้ `DODO_CONFIG_DIR` และ safe existing-state preference import แบบ explicit
- เพิ่ม `dodo tunnel configure/status/start/stop/restart/doctor/logs` สำหรับ external และ managed Cloudflare Tunnel โดยไม่จัดการ Cloudflare account/DNS
- เส้นทางหลักใช้ temporary Tunnel token ที่ไม่อยู่ใน config/credential store/argv/logs/MCP jobs; secure references คงไว้เฉพาะ advanced compatibility commands
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
  `memory_learning_propose`; catalog หลัง Phase 08 เป็น
  Full 104 tools ส่วน Compact/Hybrid คง 19/49
  ผ่าน assistance gateways Permanent memory ต้องผ่าน private owner review + exact
  digest, ตรวจ source/retention/ACL ซ้ำ และ learning review ไม่ติดตั้งหรือ execute เอง
- เพิ่ม Runtime Intelligence 10 operations สำหรับ durable session, reconnectable
  process/test/container task, bounded task/browser evidence, guarded snapshot,
  evidence revalidation และ deterministic diagnosis ทำให้ Full ณ Phase 08 เป็น 104 tools
  ขณะที่ Compact/Hybrid คง 19/49 ผ่าน gateways เดิม
- Runtime task ใช้ JobManager, execution approval, idempotency, environment allowlist,
  timeout และ command sandbox เดิม Runtime store ไม่เก็บ raw stdout/stderr, DOM,
  console, cookie, authorization header หรือ environment secret
- เพิ่ม Advanced Agent Runtime 17 operations สำหรับ immutable plan, bounded parallel
  hypotheses, intent locks, managed read/write/exec, metadata snapshot compare/rollback,
  Runtime-evidence judgement, restart recovery และ reviewed skills ทำให้ Full เป็น 121
  tools ขณะที่ Compact/Hybrid คง 19/49
- Agent capabilities ลดสิทธิ์จาก caller เท่านั้น Managed target ยังผ่าน invocation
  pipeline เดิม Skill proposal ต้องผ่าน private owner review exact digest และยังเป็น
  non-executable untrusted guidance; coordinator cancel/pause ไม่ kill jobs
- บังคับ canonical Base64URL ก่อนตรวจ HMAC ของ Resource และ Project Brain cursors
  เพื่อไม่ให้ token string ที่ถูกแก้ไข alias เป็น byte sequence เดิมจาก decoder ที่ permissive

## วิธีอัปเดต

```bash
npm install -g dodo-mcp@1.0.0
dodo --version
```

หลังติดตั้งให้ restart DODO process และ rescan MCP connection ตามข้อกำหนดของ client
