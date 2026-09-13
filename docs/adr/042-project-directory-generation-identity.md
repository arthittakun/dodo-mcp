# ADR-042: Bind registered projects to a directory generation

Status: Accepted

## Context

Project Registry เดิมระบุ directory ด้วย canonical path, device และ inode การรัน
Linux gate ใน Docker พบว่า filesystem สามารถนำ inode เดิมกลับมาใช้ทันทีหลังลบแล้ว
สร้าง directory ใหม่ที่ path เดิม ทำให้ tuple เดิมไม่พอพิสูจน์ว่าเป็น directory
generation เดิม ความคลาดเคลื่อนนี้อาจทำให้ registry รายงาน replacement ว่า ready

## Decision

Project Registry metadata v2 เก็บ `root_birthtime_ns` เพิ่มจาก canonical realpath,
device และ inode ทุก readiness check และ federation cache key ต้องตรวจ marker นี้ด้วย
การ relocate รักษา opaque project ID ได้ต่อเมื่อทั้งสามค่าตรงกับรายการเดิม

Migration เพิ่ม column ใหม่แต่ไม่ auto-upgrade row v1 เพราะไม่มี birth time เดิมให้
เปรียบเทียบ และการเห็น device/inode เดิมในปัจจุบันยังแยก inode reuse ไม่ได้ Row นั้น
จึงคง metadata v1 และถูกอ่านเป็น `invalid` จนเจ้าของ review, remove และ add path ใหม่

การเพิ่มโปรเจกต์ใหม่บน filesystem ที่ไม่มี stable directory birth time จะได้
`NOT_SUPPORTED` พร้อมคำแนะนำให้ย้ายไป local filesystem ที่รองรับ ข้อจำกัดนี้ไม่เพิ่ม
สิทธิ์และไม่เปลี่ยน active-workspace ACL, OAuth, trust หรือ path guards

## Consequences

Directory replacement ถูกปฏิเสธแม้ numeric inode ถูก reuse และ federation context
ไม่ reuse cache ข้าม directory generation แลกกับการไม่รองรับ durable Project Registry
บน filesystem บางชนิดที่รายงาน birth time ไม่ได้

## Evidence

`tests/unit/projectRegistry.test.ts` จำลอง inode reuse แบบ deterministic และทดสอบ
v1-to-v2 migration ส่วน Linux Docker gate รัน Project Registry, federation,
security และ packaging suites บน Linux จริง
