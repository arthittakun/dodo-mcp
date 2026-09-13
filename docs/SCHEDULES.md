# DODO Schedules

DODO รองรับการสร้าง schedule proposal สำหรับคำสั่งที่เจ้าของตรวจและ approve เอง

## Flow

```text
schedule_propose
→ owner reviews exact digest
→ dodo schedule approve ID
→ bounded job runs under current workspace policy
```

proposal ไม่ใช่ permission และไม่สามารถขยาย scope, trust, workspace หรือ command sandbox ได้ การเปลี่ยน workspace หรือ revoke access ทำให้ proposal/resource ที่ไม่ valid ถูกปฏิเสธ

ตรวจ proposal ที่ค้างอยู่ด้วย:

```bash
dodo schedule show ID
dodo approve ID
```

ระบบไม่ execute proposal ที่ยังไม่ผ่าน owner approval และไม่ kill jobs เดิมอย่างเงียบ ๆ
