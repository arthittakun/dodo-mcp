# DODO MCP — Web Clients

## Connection checklist

1. รัน DODO และตั้ง public HTTPS origin
2. ตรวจว่า URL ลงท้ายด้วย `/mcp`
3. เพิ่ม static OAuth client ด้วย exact callback URL
4. เลือก OAuth ใน web client
5. ทำ authorization ใน browser
6. approve interaction ผ่าน `dodo auth pending` และ `dodo auth approve ID`
7. scan tools
8. เรียก `project_overview` และตรวจ `toolSurface`

## Compact behavior

HTTP default เป็น Compact surface 19 tools ประกอบด้วย overview, `dodo_discover` และ gateways client จะค้น operation ที่ต้องการจาก discover แล้วเรียก gateway พร้อม top-level workspace context

Compact ไม่ลด security และไม่ได้รวมสิทธิ์หลาย operation เป็น approval เดียว target operation ยังคงมี scope, ACL, trust, approval, hash และ path policy ของตัวเอง

## Client cache

client บางตัว cache tool catalog หลังสร้าง connection หาก schema หรือ surface เปลี่ยน ให้ refresh ตาม client หรือ recreate connection เมื่อ refresh ไม่ได้ล้าง catalog เดิม

## Manual evidence

บันทึกจำนวน tools ที่ client แสดงจริง, response ของ overview, write/edit read-back และ error cases แยกจาก automated test อย่ารายงานว่า web client ผ่านจาก server log เพียงอย่างเดียว

## Delegate งานด้วย AI profile ของเจ้าของ

ค่าเริ่มต้นซ่อน Sub-agent operations จาก MCP เพื่อให้ catalog งานทั่วไปกระชับขึ้น ก่อน
delegate จาก ChatGPT/remote MCP ให้เจ้าของเปิด **Settings → Sub-agent tools ใน MCP**
แล้ว restart DODO และ rescan/recreate connection หน้าเว็บ Chat & Tasks ใช้ได้แม้สวิตช์ปิด

เมื่อเปิดแล้ว ChatGPT/remote MCP ใช้ `project_overview(targetProjectId)`
เพื่อรับ context และ `ai.profiles` เฉพาะที่อนุญาต แล้ว `dodo_discover` หา
`subagent_spawn` ผ่าน `dodo_assist_change` ตรวจผลด้วย `subagent_result` ผ่าน
`dodo_assist_read` รูปแบบ top-level target/context เหมือน read/write tools
ไม่ใส่ key ในแชตหรือ tool args; เจ้าของตั้งผ่าน private Local Config เท่านั้น

การมี MCP OAuth scopes ไม่ได้อนุญาต provider egress โดยอัตโนมัติ ต้องมี target ACL,
profile/client allowlist และ trust/approval เดิม งานหลาย projects สร้างหนึ่ง run ต่อ
project; ผลลัพธ์คืน run ID/receipts ไม่มี internal reasoning และ retry ด้วย key เดิม
ไม่สร้างงานซ้ำ โปรด rescan/recreate connector หากยังไม่เห็น schema ใหม่
