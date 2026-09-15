# DODO MCP 1.0.4

รุ่น 1.0.4 ทำให้ Windows setup อธิบายและกู้สถานการณ์ private state ACL ได้ชัดเจนขึ้น
โดยไม่ลด security policy ของ DODO

## การเปลี่ยนแปลง

- เพิ่ม [Windows Setup](WINDOWS_SETUP.md) ครอบคลุม CMD/PowerShell, component matrix,
  manual `cloudflared` install, Desktop/Web permission และการตรวจหลังติดตั้ง
- typed setup failures แสดง recovery hint ทั้ง command mode, JSON และ `dodo --cli`
- private state ACL failure แนะนำ local NTFS/current-owner/fresh-state path โดยเก็บ
  directory เดิมไว้และไม่ใช้ permissive ACL
- เมนูระบุว่า Windows ต้องติดตั้ง `cloudflared` จาก Cloudflare ก่อน

## อัปเดต

```bash
npm install -g dodo-mcp@1.0.4
dodo --version
```

เปิด terminal ใหม่หลังเปลี่ยน user environment และ restart DODO process เดิม

## Security

รุ่นนี้ไม่เปลี่ยน OAuth, workspace ACL/context, trust, approvals, path/secret guards,
expected-hash conflict protection, command sandbox หรือ Tunnel credential handling
การตรวจ Windows DACL ยังคง fail closed และไม่ takeover state ของ account อื่น

## Verification

ผล automated release gate และ package/registry verification จะบันทึกใน release
evidence ของ 1.0.4 ก่อน publish ส่วน Windows 11 interactive/manual acceptance ยังคง
รายงานแยกตาม environment จริง
