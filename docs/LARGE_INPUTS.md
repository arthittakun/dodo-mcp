# DODO Large Coding Inputs

DODO รองรับคำสั่ง, patch และไฟล์ที่มีขนาดใหญ่ขึ้นด้วย bounded budgets และ temporary files ที่อยู่ภายใต้ workspace policy

## Configuration

```bash
dodo limits --profile large
```

การเปลี่ยน limits มีผลหลัง restart process และไม่เปลี่ยน OAuth, ACL, trust, sandbox หรือ secret policy

## Safety

- input และ output มี byte budget แยกกัน
- command ใช้ argv ที่ผ่าน length checks
- file write ใช้ expected hash และ journal
- temporary content ไม่ถูกแสดงใน audit โดยอัตโนมัติ
- repository config และ AGENTS.md ตั้ง limit หรือ grant สิทธิ์เพิ่มไม่ได้

ใช้ limits สูงเมื่อจำเป็นและตรวจ diff ก่อน apply ทุกครั้ง
