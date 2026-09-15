# DODO MCP 1.1.0

รุ่น 1.1.0 เพิ่ม Android ADB tool family ให้ AI ตรวจและควบคุม physical device หรือ
emulator ที่เจ้าของอนุญาต พร้อม Local Config และ CLI สำหรับ exact-device permission

## ความสามารถใหม่

- Full surface เพิ่ม 13 operations: status, device list/info, screenshot, UI hierarchy,
  logcat, packages, bounded file read, input action, app action, APK install, file push
  และ advanced device-side ADB
- HTTP Compact เพิ่ม `dodo_mobile` gateway ทำให้ Compact มี 20 tools และยังเข้าถึง
  capability definitions ครบ 138 รายการ; Hybrid คง 49 tools
- `android_capture` คืน MCP PNG image block จริง และสร้าง snapshot อายุ 30 วินาทีที่
  ผูก client/device/policy สำหรับ tap/swipe/text/key
- หน้า Local Config ค้นหาอุปกรณ์ เลือก exact serial และตั้ง `view`/`control` ได้
- CLI เพิ่ม `dodo android devices|status|allow|disable`
- setup เพิ่ม component `adb` และ deep capability probe ที่เรียกเฉพาะ `adb version`

## Security

- ADB ปิดโดยค่าเริ่มต้น และ trusted/bypass ไม่เปิดสิทธิ์นี้
- view/control grant ทำได้เฉพาะ local owner; persistent grant จำระดับ installation
  ส่วน temporary grant ผูก workspace/epoch
- ทุก MCP call ยังผ่าน OAuth, `dodo:exec`, project/workspace context, trust/approval,
  idempotency, audit และ exact serial allowlist
- input action ใช้ fresh client-bound screenshot; password UI values ถูก redact
- APK/push source ผ่าน workspace path/secret/symlink/hardlink guards, expected SHA-256
  และ private staging copy ที่ลบหลังจบ
- ไม่ expose pair/connect/root, ADB server management หรือ port forwarding ให้ MCP
- device-side shell มีผลด้วยสิทธิ์ Android shell user และไม่ใช่ sandbox

## Tool surfaces

| Surface | จำนวน |
|---|---:|
| Complete Full schema | 138 |
| Full live default (ซ่อน Sub-agent 4 operations) | 134 |
| Compact HTTP | 20 |
| Hybrid | 49 |

Generated tools/list-equivalent schema sizes:

- Full: 475,008 bytes
- Compact: 55,373 bytes
- Hybrid: 125,901 bytes

## อัปเดตและเริ่มใช้

```bash
npm install -g dodo-mcp@1.1.0
dodo setup --check --components adb
dodo android devices
dodo android allow --device SERIAL --mode control --persist --yes
dodo start
```

หลัง restart ให้ remote MCP client refresh/recreate connection ตามพฤติกรรมของ client
เพื่อรับ `dodo_mobile` และ schema ใหม่ ดูขั้นตอนทั้งหมดใน [ANDROID.md](ANDROID.md)

## ผลตรวจรับ

- build/typecheck/lint: `AUTOMATED_PASS`
- core/integration/security/compatibility: `AUTOMATED_PASS` — 698 passed,
  35 skipped, 0 failed
- packaging: `AUTOMATED_PASS` — 16/16
- Android focused unit/security/HTTP+OAuth/UI: `AUTOMATED_PASS`
- production dependency audit: `AUTOMATED_PASS` — 0 vulnerabilities
- physical Android device/emulator with owner hardware: `MANUAL_NOT_RUN`
- Android/Termux host platform acceptance: `MANUAL_NOT_RUN`
