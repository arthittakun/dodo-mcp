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
