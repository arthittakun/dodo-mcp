# DODO MCP 1.0.0

นี่คือ release แรกของ DODO MCP ในชื่อ package `dodo-mcp` และ CLI `dodo`

## การติดตั้ง

```bash
npm install -g dodo-mcp@1.0.0
dodo --version
```

## ความสามารถหลัก

- MCP HTTP + OAuth และ Local Config แบบ loopback
- Compact HTTP surface 19 tools
- Full STDIO surface 89 tools
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
- owner-curated multi-project read federation สำหรับ overview/list/read/search สูงสุด 8 โปรเจกต์ พร้อม target ACL, readiness, source hash และ target-scoped audit
- Universal Resource Layer + private SHA-256 CAS พร้อม bounded range/resume,
  deterministic extraction และ MCP image/audio preview
- Project Brain แบบ incremental พร้อม AST symbols/references/import graph,
  routes/tests/dependencies, stable semantic URI และ current-source verification
- Context Engine แบบ goal-driven พร้อม evidence provenance/confidence/freshness,
  deterministic budget/cursor และ caller-scoped L0–L6 dependency cache

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

## ตรวจรับ

```bash
npm run build
npm run typecheck
npm run lint
npm run test:all
npm pack
```

การเชื่อมต่อ ChatGPT, Claude หรือ client ภายนอกต้องทำ manual scan/rescan และยืนยัน write/edit ด้วย workspace fixture แยกต่างหาก ผลที่ยังไม่ได้ทำต้องรายงานเป็น `MANUAL_NOT_RUN`
