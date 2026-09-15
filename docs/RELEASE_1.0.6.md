# DODO MCP 1.0.6

รุ่น 1.0.6 แก้ startup บน platform ที่ไม่มี native Sharp build โดยแยก raster backend
ออกจากเส้นทางเริ่ม CLI และเพิ่ม WebAssembly image backend เป็น optional dependency

## การเปลี่ยนแปลง

- `dodo --version` และคำสั่ง text/code ไม่ import Sharp ระหว่าง startup
- image/resource raster operations โหลด Sharp เมื่อถูกเรียกเท่านั้น
- เมื่อ image backend ไม่มี ระบบตอบ `NOT_SUPPORTED` แบบ typed และไม่เปิดเผย loader error
- เพิ่ม `@img/sharp-wasm32` 0.35.4 เป็น optional dependency ที่ตรงกับ Sharp 0.35.4
- เพิ่มคู่มือ Android/Termux โดยระบุสถานะ experimental และขอบเขตที่ยังไม่รับรอง

## Security

การ fallback ไม่ข้าม OAuth, project/workspace authority, trust, approvals,
path/secret guards, expected hash หรือ sandbox policy WebAssembly backend ใช้เฉพาะ
การประมวลผลภาพเมื่อโหลดได้ และ error ที่ส่งให้ client ไม่รวม path หรือรายละเอียด
native loader ของเครื่อง

## อัปเดต

```bash
npm install -g dodo-mcp@1.0.6 @img/sharp-wasm32@0.35.4
dodo --version
```

## สถานะตรวจรับ

- macOS build/typecheck/lint/core/security/compatibility: `AUTOMATED_PASS`
  (682 passed, 35 skipped, 0 failed)
- packaging: `AUTOMATED_PASS` (16/16)
- การจำลองไม่มี Sharp: `AUTOMATED_PASS` — CLI แสดงเวอร์ชันได้และ image operation
  ตอบ `NOT_SUPPORTED`
- WebAssembly fallback: `AUTOMATED_PASS` — ถอด native macOS backend ออกแล้วสร้าง PNG ได้
- production dependency audit: `AUTOMATED_PASS` — 0 vulnerabilities
- fresh tarball install: รอ immutable package gate
- Android/Termux บนเครื่องจริง: `MANUAL_NOT_RUN` จนกว่าเจ้าของติดตั้ง artifact นี้
- Android optional capabilities: `MANUAL_NOT_RUN`
