# DODO MCP — Release Notes

## 1.3.1 — Independent Remote Config sessions

`dodo --web` now creates an independent one-hour owner session even after the local
eight-hour link expires. No MCP restart is needed to reopen the domain dashboard.
AI owner requests and queued actions use the same remote session deadline and
revocation. Adds [AI platform connection instructions](MCP_CONNECTIONS.md) and
[upgrade details](RELEASE_1.3.1.md).

## 1.3.0 — Recovery & Local Git Safety

- Default-on independent source backups for registered projects, with caller-owned
  sessions, reviewed previews, journaled restore and durable retry/restart receipts.
- Detect external content drift; preserve separate emergency copies and private Git
  checkpoints without changing the owner's index/branch. Named/pinned checkpoints,
  evidence-bound verification and reviewed retention are available in Web/CLI.
- Owner-registered Docker Compose deployment with sealed build source, image/container
  provenance, health/stabilization, known-good pointers, exact reviewed image rollback,
  guarded source recovery and bounded image/probe cleanup.
- Read-only SQLite migration compatibility rules. Separate owner-opt-in encrypted
  private configuration backups with OS-held keys, redacted preview, rotation and
  before-restore ciphertext. No generic database rollback or secret exposure to MCP.
- Full158 (default154 when Sub-agents are hidden), Compact20, Hybrid49. OAuth, target
  ACL, context, approval, sandbox, secret/path/hash guards remain authoritative.
- Windows private ACL checks use an inbox .NET helper when available, rereading actual
  permissions on every invocation; fallback preserves the same fail-closed policy.
- Native Linux/Windows CI and macOS release gates, immutable tarball and fresh install
  verification. Detailed [scope and upgrade notes](RELEASE_1.3.0.md).

Verify publication through the npm registry and revision-bound native gate evidence;
release notes describe scope and are not a publish receipt.

## 1.2.1 — สร้าง Agent แบบง่ายและ error ที่แก้ได้ตรงจุด

- ลดขั้นตอนสร้าง Agent เหลือเลือกประเภท, Provider connection และ Model ID แล้วสร้างได้เลย
- รายชื่อโมเดลที่โหลดจาก Provider ถูกนำมาให้เลือกใน Agent form ทันที; endpoint ที่ไม่มี
  model-list ยังพิมพ์ Model ID เองได้
- เพิ่ม Coding, Review และ Research presets โดยค่าละเอียดอยู่ในส่วนพับได้
- ตรวจ Model ID, connection และขีดจำกัดตัวเลขใน browser ก่อนส่ง จึงไม่เหลือข้อความ
  `invalid request` แบบไม่บอกสาเหตุสำหรับกรณีข้อมูลฟอร์มไม่ครบ
- Owner API คืนเฉพาะชื่อ field ที่ไม่ถูกต้อง ไม่สะท้อน API key หรือค่าที่ผู้ใช้กรอก
- เพิ่มหน้า Settings สำหรับเปิด/ปิด operation รายตัวใน Compact/Hybrid พร้อมค้นหา,
  สวิตช์รายรายการ, เปิด/ปิดทั้งหมวด และตัวนับที่มีผลจริง
- operation ที่ปิดหายจาก `dodo_discover`, gateway enum และ Hybrid direct duplicate;
  gateway ที่ว่างจะไม่ถูกส่งให้ client ส่วน Full/STDIO ไม่เปลี่ยน
- การตั้งค่านี้เปลี่ยนเฉพาะ visibility ไม่ grant OAuth scope, project access, trust,
  approval, sandbox หรือข้าม guards และต้อง restart/rescan หลังบันทึก

รุ่นนี้เตรียมเป็น patch `1.2.1`; การ publish และ live-provider manual test เป็น gate แยก

## 1.2.0 — Cloudflare Local และสิทธิ์ต่อโปรเจกต์ที่มองเห็นได้

- แยกการเชื่อมต่อเป็นสามโหมด: เฉพาะเครื่อง (Loopback), Cloudflare Local ที่ผู้ใช้
  รัน `cloudflared` เอง และ DODO Tunnel ที่ DODO ดูแล process
- Cloudflare Local ใช้ public MCP/OAuth URL โดยไม่รับ/อ่าน Tunnel token และไม่รายงาน
  supervisor connected จาก config อย่างเดียว
- หน้า Projects แสดงและบันทึกระดับ `read` / `edit` / `full` ของทุกโปรเจกต์จริง
  ในโหมดส่วนตัว ไม่ต้องตามหา Trust/Client ACL หลายส่วน
- ระดับโปรเจกต์เป็นเพดานที่ intersect กับ OAuth/grant/managed ACL เท่านั้น ไม่เพิ่ม
  สิทธิ์ ไม่ข้าม approval, sandbox, workspace context หรือ file guards
- Remote Config เปิดผ่าน public Cloudflare ได้ทั้ง owner-managed และ DODO-owned mode;
  loopback-only ยังคงปฏิเสธ

ติดตั้งด้วย `npm install -g dodo-mcp@1.2.0` แล้ว restart DODO

## 1.1.0 — Android device tools through owner-approved ADB

- เพิ่ม Full 13 `android_*` operations และ Compact `dodo_mobile` gateway สำหรับ
  device info, screenshot/UI, logcat/packages/files, input/app actions, APK install,
  file push และ bounded device-side ADB
- เพิ่ม exact-serial `off|view|control` policy ผ่าน CLI และ Local Config โดย persistent
  permission เป็นระดับ installation และ temporary permission ผูก workspace/epoch
- screenshot คืน MCP image block พร้อม caller-bound snapshot; UI password ถูก redact
- APK/push บังคับ expected SHA-256 และ private staging copy ภายใต้ shared file guards
- เพิ่ม `adb` setup component, docs, unit/security/HTTP+OAuth/Chromium/packaging tests
- Complete Full 138, live Full default 134, Compact 20 และ Hybrid คง 49 tools

ติดตั้งด้วย `npm install -g dodo-mcp@1.1.0` แล้ว restart DODO และ refresh/recreate MCP
connection เพื่อโหลด catalog ใหม่ การ pair/connect และยืนยัน RSA ยังเป็น owner action

## 1.0.6 — Android-safe CLI startup

- เปลี่ยน raster image backend เป็น lazy load เพื่อให้ core CLI, transport และ
  text/code tools เริ่มได้บน platform ที่ไม่มี native Sharp build
- เพิ่ม `@img/sharp-wasm32` เวอร์ชันตรงกับ Sharp เป็น optional dependency
- image/resource operations ตอบ typed `NOT_SUPPORTED` เมื่อ backend ไม่พร้อม โดยไม่
  ทำให้ `dodo --version` หรือทั้ง process ล้ม
- เพิ่มคู่มือ Android/Termux พร้อมระบุสถานะ experimental และ manual gates ตามจริง

ติดตั้งด้วย `npm install -g dodo-mcp@1.0.6 @img/sharp-wasm32@0.35.4`

## 1.0.5 — ChatGPT connection guide

- เพิ่มขั้นตอนเชื่อม ChatGPT ไว้บนหน้าแรก ตั้งแต่ Public MCP URL, Cloudflare Tunnel,
  static OAuth client, Developer mode, tool scan และ owner approval
- แยกความหมายของ MCP Server URL (`https://HOST/mcp`) ออกจาก OAuth callback
  (`https://chatgpt.com/connector_platform_oauth_redirect`) อย่างชัดเจน
- เพิ่มคำสั่ง `dodo auth add-client` ที่คัดลอกไปรันได้โดยไม่มี Markdown ปน พร้อม
  troubleshooting สำหรับ empty pending request, redirect mismatch, OAuth 404 และ cache
- ไม่มีการเปลี่ยน runtime, tool surface, OAuth policy หรือ permission model

ติดตั้งหรืออัปเดตด้วย `npm install -g dodo-mcp@1.0.5` แล้ว restart DODO process
ก่อน Refresh หรือสร้าง ChatGPT MCP connection ใหม่

## 1.0.4 — Windows setup guidance and actionable recovery

- เพิ่มคู่มือ Windows Setup สำหรับติดตั้ง components, `cloudflared`, Desktop/Web
  permission และตรวจผลแบบแยก `missing`/`needs-permission`/`ready`
- อธิบาย private state ACL, default `%LOCALAPPDATA%\dodo`, สาเหตุที่พบบ่อย และวิธี
  ใช้ `DODO_CONFIG_DIR` กับ fresh local NTFS path โดยไม่ลบหรือทำ ACL เดิมให้อ่อนลง
- CLI และเมนูแสดง recovery ของ typed setup error แทนการทิ้งคำแนะนำที่ปลอดภัย
- แก้ข้อความเมนูให้ชัดว่า Windows ต้องติดตั้ง signed `cloudflared` package จาก
  Cloudflare ก่อน; DODO ไม่ติดตั้งเป็น Windows service เพราะ supervise child เอง

ติดตั้งหรืออัปเดตด้วย `npm install -g dodo-mcp@1.0.4` แล้วเปิด terminal ใหม่และ
restart DODO process ที่กำลังรันอยู่

## 1.0.3 — Persistent connection mode

- เพิ่ม installation setting `connectionMode=local|tunnel` เป็นแหล่งความจริงเดียว
- `dodo start` ใช้โหมดที่บันทึกไว้ทุกครั้ง: Local ไม่เริ่ม `cloudflared`; Tunnel เริ่ม
  และหยุด DODO-owned `cloudflared` พร้อม process และ fail closed เมื่อไม่พร้อม
- Tunnel token บันทึกแบบ write-only ใน reviewed OS credential store หรืออ้างอิง
  owner-controlled env/private file; ไม่รับ token ชั่วคราวผ่าน startup/IPC อีกต่อไป
- Local Config เลือกโหมดและบันทึก token ได้โดยไม่ส่งค่ากลับ หน้า Connection แสดง
  Active MCP URL จาก runtime จริง ค่าใหม่มีผลหลัง restart
- Remote Config หนึ่งชั่วโมงใช้ได้เฉพาะเมื่อ persistent Tunnel mode กำลังทำงาน
- เพิ่ม integration/security regression สำหรับ Local OAuth/MCP, endpoint selection,
  config migration, credential non-disclosure และ no-fallback supervisor behavior

ติดตั้งหรืออัปเดตด้วย `npm install -g dodo-mcp@1.0.3` แล้ว restart DODO
process ที่กำลังรันอยู่

## 1.0.2

> พฤติกรรม token ชั่วคราวของรุ่นนี้ถูกแทนที่ใน source ปัจจุบันด้วย persistent
> connection mode ดูหัวข้อ 1.0.3 และ ADR-048

### Temporary Remote Config

- เพิ่ม `dodo --web`, `dodo web --status` และ `dodo web --close` สำหรับเปิดหน้า Config
  ผ่าน public Tunnel ที่พอร์ต 21730 ครั้งละไม่เกิน 1 ชั่วโมง โดยพอร์ต 21731 ยังคง bind
  loopback เท่านั้น
- ใช้ pairing code แบบครั้งเดียวและ Secure/HttpOnly/SameSite cookie ที่จำกัด path
  `/config`; route ปิดเป็น 404 ก่อนเปิด หลังปิด และเมื่อหมดอายุ
- process ที่เริ่ม local-only สามารถรับ run-scoped Tunnel token ผ่าน authenticated
  installation IPC โดยไม่ restart MCP และไม่บันทึก credential
- เพิ่มเมนู Remote Config ใน `dodo --cli`, security/integration/Chromium tests และ
  ADR-047 โดยไม่เปลี่ยน OAuth, project authority, workspace context หรือ owner policy

ติดตั้งหรืออัปเดตด้วย `npm install -g dodo-mcp@1.0.2` จากนั้น restart process ที่กำลัง
รันอยู่ การเปิด Remote Config ผ่าน public hostname จริงยังต้องตรวจด้วย tunnel/DNS ของ
เจ้าของและไม่ถือว่าผ่านจาก automated fixture เพียงอย่างเดียว

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
