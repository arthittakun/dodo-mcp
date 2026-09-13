# ADR-041: Local macOS and Docker Linux release gates

Status: Superseded by ADR-043

## Context

GitHub-hosted jobs ไม่ได้เริ่มทำงานจริงและจึงไม่ใช่หลักฐานทดสอบ การแสดง workflow
สีเขียวจาก allow-failure อาจทำให้เข้าใจผิด ขณะเดียวกันทีมต้องการพัฒนา core ต่อบน
macOS และตรวจ portability บน Linux ก่อน โดยเลื่อน Windows native ไปช่วงสุดท้าย

## Decision

ลบ GitHub Actions test workflows ใช้ macOS checkout เป็น platform แรก และสร้าง Linux
Docker image จาก checkout เป็น platform ที่สอง Image ใช้ Node 22, ติดตั้ง Chromium,
รัน build/typecheck/lint/full tests/DodoBench/audit/package/fresh-install smoke
เหมือน release gate หลัก

Docker build context ตัด Git metadata, credentials, local state, models, release evidence
และ private development documents ออก Runner อ่าน revision/dirty state จาก host Git,
ส่งเข้า container เป็น source attestation และตรวจ report กลับกับ package-lock digest

Strict gate ต้องมี `AUTOMATED_PASS` จาก macOS และ Linux บน revision/lock เดียวกัน
Linux report ต้องมาจาก clean source ที่มี `docker-host-git` provenance และผ่าน fresh
tarball install จึงไม่สามารถนำ dirty candidate หรือ evidence จาก runner อื่นมาแทนได้
Windows มีสถานะ `DEFERRED_MANUAL_NOT_RUN` และไม่อยู่ใน required platform set จนกว่า
native Windows phase จะถูกเปิดอย่างชัดเจน

## Consequences

ผล Linux ทำซ้ำได้โดยไม่พึ่งสถานะ GitHub account และ browser fixture รันใน container
จริง แต่ Docker Linux ยังใช้ kernel/architecture ของ Docker Desktop และไม่แทนเครื่อง
Windows หรือ manual external-AI acceptance ไม่มีสคริปต์ใด publish npm
