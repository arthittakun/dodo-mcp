# DODO Desktop Access

Desktop tools ทำงานกับ application ที่เจ้าของอนุญาตแบบ explicit เท่านั้น ระบบไม่เปิด Screen Recording, Accessibility, microphone หรือ system audio permission เอง

## Operations

- `desktop_status`
- `desktop_windows`
- `desktop_capture`
- `desktop_accessibility`
- `desktop_action`

ใน Compact surface ใช้ `dodo_desktop_view` และ `dodo_desktop_control`

## Permission flow

1. ตรวจด้วย `dodo setup --check`
2. ให้ OS permission เองตาม platform
3. เพิ่ม app identifier แบบ exact ผ่าน Local Config หรือ CLI
4. เรียก status/view ก่อน action
5. ทุก action ต้องใช้ target scope, owner permission, trust และ approval ตาม policy

Desktop action เป็น effectful operation ใช้ idempotency และ observation freshness เพื่อป้องกัน action กับหน้าต่างที่เปลี่ยนไปแล้ว หากผลลัพธ์ไม่แน่นอน ระบบไม่ retry เอง

## Limitations

ถ้า backend หรือ permission ไม่พร้อม ระบบตอบ `NOT_SUPPORTED`/permission error ตามจริง ไม่รายงานว่าควบคุม desktop ได้เพียงเพราะมี executable ติดตั้งอยู่
