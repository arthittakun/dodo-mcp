# DODO MCP 1.0.0

นี่คือ release แรกของ DODO MCP ในชื่อ package `dodo-mcp` และ CLI `dodo`

## การติดตั้ง

```bash
npm install -g dodo-mcp@1.0.0
dodo --version
```

## ความสามารถหลัก

- MCP HTTP + OAuth และ Local Config แบบ loopback
- `dodo --cli` interactive owner menu และ global launcher ที่ไม่ใช้ CWD เป็น workspace
- startup project จาก owner registry; หากยังไม่เลือก MCP/OAuth ปฏิเสธด้วย `workspace_required`
- Compact HTTP surface 19 tools
- Full STDIO surface 121 tools
- Hybrid surface 49 tools
- direct coding tools, gateway dispatch และ operation discovery
- workspace switching จาก Local Config พร้อม readiness และ rollback
- OAuth scopes, workspace ACL, trust, approval, path/secret guards และ audit
- file changes แบบ hash-verified, journaled และ rollback ได้
- jobs, Git, semantic tools, LSP และ task assistance
- multimodal, browser, game, workflow และ schedule tools ตาม prerequisite
- setup แบบ plan-first: installer ที่ยังขาดต้องยืนยันด้วย `--yes`
- existing-state import ที่นำเข้าเฉพาะ non-authority preferences และสร้าง security identity ใหม่
- Cloudflare Tunnel แบบ external หรือ managed foreground พร้อม OS credential references, authenticated control IPC, bounded retry/readiness และ redacted diagnostics
- Local Config ตั้ง Tunnel token ผ่าน OS credential store ได้โดยไม่ echo/persist ค่า raw
- owner-curated multi-project read federation สำหรับ overview/list/read/search สูงสุด 8 โปรเจกต์ พร้อม target ACL, readiness, source hash และ target-scoped audit
- Universal Resource Layer + private SHA-256 CAS พร้อม bounded range/resume,
  deterministic extraction และ MCP image/audio preview
- Project Brain แบบ incremental พร้อม AST symbols/references/import graph,
  routes/tests/dependencies, stable semantic URI และ current-source verification
- Context Engine แบบ goal-driven พร้อม evidence provenance/confidence/freshness,
  deterministic budget/cursor และ caller-scoped L0–L6 dependency cache
- owner-reviewed Memory พร้อม source evidence, confidence, retention, CURRENT/STALE,
  explicit cross-project visibility และ non-executable workflow/skill proposals
- Runtime Intelligence พร้อม durable/reconnectable tasks, bounded process/test/browser
  evidence, guarded snapshot, source revalidation และ fact/observation/inference diagnosis
- Advanced Agent Runtime พร้อม immutable plans, bounded parallel hypotheses, path intents,
  managed target dispatch, snapshot rollback, evidence-backed completion, restart recovery
  และ owner-reviewed non-executable skills
- DodoBench แบบ revision-bound และ release gate ที่ตรวจ real HTTP/OAuth Compact,
  STDIO Full, security regressions, immutable package checksum และ fresh tarball install
- platform evidence ใช้ macOS local, Linux Docker และ dedicated self-hosted GitHub
  Actions สำหรับ Linux/Windows trusted main; Windows manual gate ยังเป็น
  `MANUAL_NOT_RUN`
- Project Registry ผูก directory generation ด้วย device/inode/birthtimeNs เพื่อกัน
  inode reuse บน Linux โดย state v1 ที่พิสูจน์ generation ไม่ได้ต้องให้เจ้าของ review

## ลำดับการใช้ Compact

```text
project_overview
→ dodo_discover
→ selected gateway
```

Compact ลด schema load ตอนเชื่อมต่อ แต่ยังใช้ target authorization และ policy เดิมทุกข้อ

## Setup ที่ปลอดภัย

```bash
dodo setup --check
dodo setup --plan --components git,ripgrep,ffmpeg
dodo setup --yes --components git,ripgrep,ffmpeg
```

`--check` และ `--plan` ไม่เขียน config หรือเริ่ม installer การใช้ `--import-state` จะเก็บ source เดิมและไม่คัดลอก OAuth, token, database, ACL, trust หรือ permission-bearing configuration

## Tunnel

```bash
dodo setup --check --components cloudflared
dodo init --public-url https://mcp.example.com
dodo tunnel configure --managed --os-credential
dodo tunnel start --yes
```

DODO ไม่สร้าง Tunnel/DNS และไม่ใช้ Cloudflare API Token ค่า Tunnel token ไม่ถูกบันทึกใน config หรือส่งเป็น process argument

## Security

Gateway ไม่ grant สิทธิ์, ไม่ bypass OAuth, ACL, workspace ID/epoch, trust, approval, path guard, secret guard หรือ command sandbox การเรียก operation ทุกครั้งถูกตรวจโดย target tool definition

Memory เป็น untrusted evidence เท่านั้น AI approve/prune เองไม่ได้ และ reviewed
learning ไม่ถูกติดตั้งหรือ execute อัตโนมัติ

Runtime task ใช้ execution approval และ command sandbox เดิม Evidence IDs ไม่ใช่
สิทธิ์ และ runtime store ไม่เก็บ raw stdout/stderr, browser DOM/console, cookies,
authorization headers หรือ environment secrets

Advanced Agent Runtime เป็น coordination-only และจำกัด authority เพิ่มจาก caller ทุก
managed operation ยังผ่าน target scope/ACL/epoch/trust/approval/path/secret/hash/sandbox
เดิม Skill ที่ owner review แล้วยังเป็น untrusted guidance และ cancel run ไม่ kill job

## ตรวจรับ

```bash
npm run build
npm run typecheck
npm run lint
npm run test:all
npm run test:linux:docker
npm pack
```

การเชื่อมต่อ ChatGPT, Claude หรือ client ภายนอกต้องทำ manual scan/rescan และยืนยัน write/edit ด้วย workspace fixture แยกต่างหาก ผลที่ยังไม่ได้ทำต้องรายงานเป็น `MANUAL_NOT_RUN`
