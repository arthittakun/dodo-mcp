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

## วิธีอัปเดต

```bash
npm install -g dodo-mcp@1.0.0
dodo --version
```

หลังติดตั้งให้ restart DODO process และ rescan MCP connection ตามข้อกำหนดของ client
