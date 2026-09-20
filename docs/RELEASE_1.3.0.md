# DODO MCP 1.3.0 — Recovery & Local Git Safety

สถานะ: **release candidate** ยังไม่อ้างว่า npm เผยแพร่แล้ว ผลตรวจชุดรวมและ platform
ต้องดู [TEST_REPORT](TEST_REPORT.md) แยกจากผลของ candidate รอบก่อน

## สิ่งที่เพิ่ม

Source backup เปิดเป็นค่าเริ่มต้นสำหรับโปรเจกต์ที่ลงทะเบียน ก่อนงานที่เปลี่ยนไฟล์
และคำสั่งที่อาจเปลี่ยน source พร้อม immutable checkpoints, caller-owned sessions,
preview, journaled restore, hash verification และ receipt ที่อ่านต่อได้หลัง restart
การกู้คืนรักษาไฟล์ที่ไม่อยู่ในแผน ไม่อนุมัติ action แทนเจ้าของ

หน้า Projects แสดง Recovery history, external drift, ขอบเขตสำเนาและ quota,
หลักฐาน test ที่ผูกกับ source/recipe, named/pinned checkpoints และ retention preview
สำเนา Git อยู่ใน private state แยกจาก index/branch เดิม และไม่ push อัตโนมัติ

Owner สามารถเปิด Docker deployment adapter เพื่อ build จาก source ที่ตรวจแล้ว
ตรวจ image/container bytes, health และ stabilization ก่อนเปลี่ยน known-good
มี reviewed image rollback, source preview จาก image ที่พิสูจน์ได้ และ cleanup เฉพาะ
image/probe ที่อยู่ในแผน ไม่ใช้ force prune และไม่ลบ volumes

Database/config เป็น opt-in แยก: ตรวจ SQLite migration metadata แบบอ่านอย่างเดียว
กับกฎที่ owner ผูก checkpoint และสำรองไฟล์ config ลับแบบ AES-256-GCM โดยเก็บ key
ใน Keychain/Credential Manager/Secret Service UI แสดง preview แบบไม่เปิดเนื้อหา
AI ไม่มี tool สำหรับอ่านหรือกู้ secrets เหล่านี้

## ขอบเขตที่ต้องทราบ

- Source restore ไม่ย้อน database rows, secrets, volumes หรือผลภายนอก
- Migration compatibility หมายถึงตรงกฎ ID ที่ owner ระบุเท่านั้น; ไม่มี adapter/rule คือ UNKNOWN
- ไม่มี generic SQL rollback, PITR หรือการ restart services อัตโนมัติ
- Private config restore เขียนไฟล์เดิม หลังเก็บ encrypted before-copy; process crash
  อาจทิ้งไฟล์บางส่วนและ receipt UNKNOWN เจ้าของต้องตรวจ ไม่ replay เอง
- Key สูญหายถอดรหัสไม่ได้ ไม่มี plaintext fallback หรืออัปโหลดกุญแจ
- Local backup ไม่ใช่สำเนานอกเครื่องหรือการรับรองป้องกัน disaster/ransomware
- Android/Termux recovery และ owner production/ChatGPT manual acceptance ยังต้องตรวจแยก

## Tool surface

Full definitions158; ค่าเริ่มต้นซ่อน Sub-agent4 จึงส่ง154 tools ส่วน HTTP Compact
ไม่เกิน20 และ Hybridไม่เกิน49 การซ่อน tools ไม่ปิด automatic source backup
หรือเพิ่ม OAuth/ACL/trust/sandbox/approval สิทธิ์ใด ๆ

## อัปเกรดหลัง release พร้อม

```sh
npm install -g dodo-mcp@1.3.0
dodo --version
dodo --cli
```

หยุด foreground process เดิมอย่างเรียบร้อยเมื่อไม่มีงาน แล้วเริ่ม DODO ใหม่ด้วย
ค่าของเจ้าของ ไม่เปิด process ซ้ำแย่ง port Refresh/recreate MCP connection ตาม client
และเรียก project_overview ใหม่สำหรับ epoch ใหม่

โปรเจกต์เดิมที่ไม่เคยกำหนด policy จะเปิด source recovery ค่าเริ่มต้น การ opt-out เดิม
ยังคงอยู่; read ยังทำงานเมื่อ backup blocked แต่ mutation จะรอแก้สาเหตุให้สำรองได้
ก่อน ใช้ `dodo recovery status` หรือ Projects → Recovery ตรวจ readiness
เริ่มทำงานอาจใช้เวลาสร้าง baseline และใช้พื้นที่ private state เพิ่ม

อ่านวิธีใช้ Web/CLI และข้อจำกัดทั้งหมดใน [Recovery](RECOVERY.md)
Native CI ไม่รัน Docker container เป็น test runner; disposable Docker acceptance
เป็นการตรวจ product deployment adapter แยกจาก platform gate
