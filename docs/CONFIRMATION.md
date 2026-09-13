# DODO Confirmation and Approvals

DODO ใช้ permission จาก OAuth connection, workspace ACL, trust mode และ local approval ของ owner เป็นหลัก ไม่มี approval แบบรวมที่ทำให้ทุก operation ผ่านได้

Effectful operations ใน `inspect` ต้องสร้าง pending approval ที่ผูกกับ target tool, action, workspace, epoch, policy version, digest และ expiration เจ้าของต้องตรวจรายการและ approve exact request ผ่าน Local Config หรือ CLI

```bash
dodo pending
dodo approve REQUEST_ID
dodo deny REQUEST_ID
```

Gateway ใช้ approval ของ target operation ไม่ใช่ approval เดียวของ gateway และการเปลี่ยน workspace/revoke access ทำให้ approval เก่าถูกปฏิเสธ
