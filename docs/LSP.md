# DODO Language Server Integration

DODO มี TypeScript/JavaScript intelligence ในตัวและรองรับ language server เพิ่มเติมที่เจ้าของติดตั้งเอง

## Register a server

```bash
dodo lsp add python --command pyright-langserver --args --stdio --ext .py --ext .pyi
dodo lsp list
dodo lsp remove python
```

DODO start process ของ language server ด้วย argv ที่ระบุ, environment ที่ scrubbed และ workspace root ที่ตรวจแล้ว ไม่มี shell expansion จาก input ของ AI

## Lifecycle

LSP เปิดเมื่อ operation ต้องใช้และปิดเมื่อ workspace shutdown/switch ระบบมี initialization/progress gate และทำลาย child process/resource อย่างถูกต้อง

## Unsupported languages

ถ้าไม่มี registry entry ระบบคืน `UNSUPPORTED_LANGUAGE` พร้อมคำแนะนำให้ owner เพิ่ม server เอง ไม่ดาวน์โหลดหรือรัน server ที่ไม่ได้ลงทะเบียนโดยอัตโนมัติ
