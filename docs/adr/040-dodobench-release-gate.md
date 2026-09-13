# ADR-040: Revision-bound DodoBench and release evidence

Status: Accepted

## Context

DODO มีหลาย capability ที่ทำงานร่วมกัน การนับ tool หรือทดสอบ handler แยกไม่พิสูจน์
ว่า HTTP/OAuth, gateway, workspace security, durable state และ package artifact ยังทำงาน
ร่วมกัน การประเมินด้วย AI เพียงครั้งเดียวก็ทำซ้ำยากและไม่ทราบ model/token baseline

## Decision

ใช้ DodoBench แบบ deterministic กับ isolated fixtures และ real HTTP/OAuth เป็น
regression gate เก็บ baseline แบบ versioned และผูก report กับ source revision,
dependency lock, dataset, configuration และ host environment ไม่สร้าง model-token
estimate เมื่อไม่มี model call

Release candidate ต้องผ่าน build/type/lint/test, DodoBench, production audit,
manifest policy, immutable tarball checksum และ fresh exact-tarball install ซึ่งตรวจ
ทั้ง STDIO Full และ HTTP Compact Candidate automation กับ release readiness เป็นคนละค่า:
platform/manual/registry evidence ที่ยังไม่ได้รันต้องแสดงตามจริง

Evidence directory เป็น local ignored output และไม่ถูก pack สคริปต์ release gate ไม่
publish package และไม่รับ authority จาก benchmark result

## Consequences

Regression หลักตรวจซ้ำได้และชี้ revision ชัดเจน แต่ local fixture latency ไม่ใช่ SLA,
browser case ขึ้นกับ Chromium และ external AI/Windows hardware ยังต้องมี separate gate
การเปลี่ยน baseline ต้อง review dataset และ threshold พร้อมกัน

## Addendum — local macOS and Docker Linux evidence

ช่วงก่อนเริ่ม Windows phase ใช้ macOS local และ Linux Docker เป็น required automated
platforms ไม่ใช้ GitHub Actions Docker image ติดตั้ง Chromium และสร้าง package/fresh
install evidence จาก source copy แยก report ต้องตรงกับ host Git revision และ lock digest
Windows แสดงเป็น `DEFERRED_MANUAL_NOT_RUN`; Linux Docker ไม่ใช่ Windows evidence

## Addendum — trusted self-hosted runners

ADR-043 เปิด GitHub Actions กลับมาหลัง dedicated Linux/Windows runners พร้อมใช้งาน
Linux ยังคงรัน Docker gate เดิมและ Windows รัน native candidate gate ส่วน macOS เป็น
local release gate Report ระบุ runner origin และ automated Windows ไม่แทน manual gate
