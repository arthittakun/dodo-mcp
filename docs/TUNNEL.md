# DODO MCP — Tunnel Guide

DODO เปิด MCP และ OAuth บน local loopback ผู้ใช้เป็นผู้จัดการ HTTPS tunnel และ DNS เอง

## Local endpoints

- MCP: `http://127.0.0.1:21730/mcp`
- Local Config: `http://127.0.0.1:21731`
- health/discovery/OAuth paths ต้อง route ไปยัง MCP listener เดียวกัน

ห้าม route Local Config, private IPC หรือ debug endpoint ออก public

## Public origin

```bash
dodo init --public-url https://mcp.example.com
cd /path/to/project
dodo trust --mode edit
dodo start
```

Tunnel ต้อง route ทุก path ของ host เดียวกัน เพื่อให้ protected-resource discovery, authorization server metadata, authorize, token และ MCP ทำงานบน origin เดียวกัน

## Client setup

1. ใช้ `https://mcp.example.com/mcp` ใน MCP client
2. เลือก OAuth
3. คัดลอก exact callback จาก client
4. ลงทะเบียนด้วย `dodo auth add-client --redirect-uri ...`
5. ทำ browser authorization และ approve interaction จาก terminal
6. scan tools และตรวจ surface ที่ client รายงาน

## หลายโปรเจกต์

หนึ่ง process มี active workspace เดียว ถ้าต้องการทำงานพร้อมกันหลายโปรเจกต์ ให้เปิดหลาย DODO processes ด้วย port, public origin และ config directory ที่แยกกัน ระบบจะไม่ให้ process หนึ่ง takeover root ที่อีก process กำลัง serve

## Security

ห้ามปิด OAuth, ใช้ service token แทน MCP OAuth โดยเดาเอง, ส่ง token ใน URL หรือเปิด CORS กว้าง tunnel provider ไม่ได้แทน owner consent ของ DODO
