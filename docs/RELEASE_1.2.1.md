# DODO MCP 1.2.1

รุ่น 1.2.1 แก้ปัญหาหน้า Providers & Profiles ตอบเพียง `invalid request` เมื่อข้อมูล
Agent Profile ไม่ครบ ลดขั้นตอนสร้าง Agent สำหรับการใช้งานส่วนตัว และเพิ่มการเลือก
operation ที่ AI มองเห็นจากหน้าเว็บ

## สร้าง Agent แบบง่าย

1. บันทึก Provider connection และ API key
2. กด **โหลดรายชื่อโมเดล** หรือกรอก Model ID เอง
3. เลือกประเภท Agent: Coding, Review หรือ Research
4. กด **สร้าง Agent**

รายการโมเดลที่โหลดสำเร็จจะเข้า Agent form ทันที ถ้ามีโมเดลเดียว DODO เลือกให้
อัตโนมัติ ค่าที่ใช้ไม่บ่อย เช่น tool calling, ภาพ, token limits, จำนวนรอบ และราคา
อยู่ในส่วน **ตั้งค่าขั้นสูง**

Preset เป็นเพียงค่าตั้งต้นของ profile และทำได้เฉพาะลดขอบเขตจากสิทธิ์จริง ไม่เพิ่ม
OAuth scope, project access, trust หรือ approval และไม่ข้าม sandbox, path/secret
guards, expected hash หรือ audit

## Validation

- Browser ปฏิเสธ Agent ที่ไม่มีชื่อ, connection หรือ Model ID ก่อนส่ง request
- ตัวเลขทุกช่องตรวจช่วงเดียวกับ backend
- Backend ตอบชื่อ field ที่ผิด เช่น `model` โดยไม่สะท้อนค่าที่กรอกหรือ credential
- ปุ่มถูกปิดระหว่างบันทึกเพื่อป้องกันการสร้างซ้ำ

## Tool visibility

หน้า **Settings → Tools ที่ AI มองเห็น** มีสวิตช์ราย operation, ค้นหา, เปิด/ปิดทั้งหมวด
และตัวนับสถานะจริง เมื่อบันทึกแล้ว Compact/Hybrid จะตัด operation ออกจาก discover,
gateway schema และ direct duplicate ใน Hybrid หลัง restart/rescan หากปิดทั้งหมวด gateway
นั้นจะหายด้วย Full/STDIO ยังคงครบและ security checks เดิมไม่เปลี่ยน

## สถานะตรวจรับ

- Typecheck/lint: `AUTOMATED_PASS`
- Chromium end-to-end แบบ desktop และ 390px: `AUTOMATED_PASS`
- Provider/profile/project/agent/tool-call/write-file flow: `AUTOMATED_PASS`
- Tool visibility catalog/HTTP/security/Chromium (desktop และ 320px): `AUTOMATED_PASS`
- Full suite: 731 passed, 35 skipped; packaging 16/16: `AUTOMATED_PASS`
- Security regression ที่เกี่ยวข้อง: `AUTOMATED_PASS`
- Exact tarball install + config schema/UI asset manifest: `AUTOMATED_PASS`
- Production dependency audit: 0 vulnerabilities: `AUTOMATED_PASS`
- Live provider ของเจ้าของ: `MANUAL_NOT_RUN`
- npm publish: `MANUAL_NOT_RUN`
