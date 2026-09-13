# DODO Task Assistance

DODO มี tools สำหรับช่วยทำความเข้าใจงานก่อนแก้ไข code และตรวจผลหลังแก้ โดยทุก operation ยังอยู่ภายใต้ workspace, scope, trust และ approval policy

## Capabilities

- `context_for_task`: รวบรวมไฟล์และสัญลักษณ์ที่เกี่ยวข้องแบบ bounded
- `analyze_impact`: วิเคราะห์ references และผลกระทบที่คาดได้
- `read_symbol`: อ่าน definition และ context ของ symbol
- `preview_refactor`: สร้างแผน refactor แบบ preview-only
- `verify_changes`: ตรวจ diff, diagnostics, tests และ recipe ตาม policy

## Compact usage

ใช้ `dodo_discover` ค้น operation แล้วเรียก `dodo_assist_read` หรือ `dodo_assist_change` โดยใส่ args ตาม schema ที่ discover คืนมา

Preview ไม่ apply เอง และ verify ที่รัน command ยังคงใช้ exec scope, trust, sandbox และ approval ของ target operation

## Safe workflow

```text
project_overview
→ context_for_task
→ analyze_impact
→ read_symbol
→ preview_refactor
→ owner reviews changes
→ verify_changes
```

ผล assistance เป็นข้อมูลประกอบการตัดสินใจ ไม่ใช่ permission และไม่สามารถขยาย workspace scope ได้
