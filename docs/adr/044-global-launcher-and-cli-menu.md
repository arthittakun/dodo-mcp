# ADR-044: Global launcher and interactive owner menu

Status: accepted for DODO 1.0.0

## Context

การเปิด HTTP server จาก CWD ทำให้คำสั่งเดียวกันมี authority ต่างกันตาม terminal
directory และทำให้เจ้าของต้องปิด/เปิด process เพื่อเลือกโปรเจกต์แรก ทั้งที่ DODO มี
owner-only Project Registry และ runtime workspace switch ที่ตรวจ readiness อยู่แล้ว

## Decision

`dodo` และ `dodo start` ที่ไม่มี `--root` resolve `startupProjectId` จาก owner registry
หาก entry พร้อมจึงเปิด root นั้น หากไม่มี target ที่พิสูจน์ได้ process เปิด launcher
mode และใช้ private inert directory ใต้ config directory เฉพาะ resource bootstrap

ระหว่าง launcher mode:

- ไม่มี active AI workspace
- `/healthz` รายงาน `workspaceSelected=false`
- MCP/OAuth public data plane ตอบ 503 `workspace_required`
- Local Config ยัง bind loopback และให้ owner เพิ่ม/เลือก absolute path
- private launcher root ไม่ปรากฏใน UI หรือ client response

การ switch แรกใช้ WorkspaceHost pipeline เดิม: shared root policy, prepare/readiness,
in-flight drain, running-job refusal, resource teardown และ fresh workspaceId/epoch
เมื่อสำเร็จจึงบันทึก registry project ID เป็น startup preference เริ่ม schedules และเปิด
data plane หากล้มเหลว launcher ยังคงปิด data plane ไม่มี half-switched state

`dodo --cli` เป็น terminal menu ที่เรียก owner operations เดิม ไม่ใช่ MCP tool
เมนูไม่เปลี่ยน trust, ACL, OAuth grant หรือ OS permission และ Tunnel token ใช้ OS
credential provider prompt ไม่รับค่าใน CLI argv

STDIO คง contract `dodo stdio --root PATH` เพราะ client เป็นเจ้าของ subprocess
lifecycle และต้องกำหนด root อย่างชัดเจน

## Consequences

การเปิด DODO จาก Home, Desktop หรือ directory อื่นไม่กลายเป็น workspace โดยบังเอิญ
เจ้าของต้องเลือก project ครั้งแรก แต่หน้า Local Config ยังพร้อม การจำ project เป็น
ความสะดวกเท่านั้น; registry readiness และ security policy ทุกชั้นยัง authoritative
