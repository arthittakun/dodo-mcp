# DODO Multimodal

DODO รองรับภาพ เสียง วิดีโอ เบราว์เซอร์ เกม และ speech เมื่อ dependency, model และ owner permission พร้อม ระบบไม่ดาวน์โหลด model หรือเปิด device permission เองตอนติดตั้ง

## Capabilities

- image view และ screen observation
- media open, extract, subtitles, search, read, jobs และ close
- speech synthesis และ transcription ผ่าน engine ที่ owner ติดตั้ง
- isolated browser session, observe และ action
- game session และ step

Compact surface ใช้ `dodo_media`, `dodo_browser` และ `dodo_game` ส่วน Full surface มี tool รายตัวครบ

## Permission and files

media path ต้องผ่าน workspace/path policy, secret guards และ regular-file checks model ต้องเป็นไฟล์ปกติที่ตรวจขนาดและ link safety แล้ว owner ต้องเลือก model path เอง

browser ทำงานใน session ที่ DODO สร้างและจำกัดตาม operation policy action ใช้ observation freshness และ idempotency ไม่ retry side effect ที่ผลลัพธ์ไม่แน่นอน

## Content blocks

gateway ต้องส่ง MCP image/audio content blocks จาก target ต่อไปโดยไม่แปลงเป็น JSON text อย่างเดียว structured output และ `isError` ต้องคง semantics เดิม

## Setup

```bash
dodo setup --check
dodo-media-setup --check
```

เมื่อ capability ไม่พร้อม ให้ใช้ผล `NOT_SUPPORTED` และติดตั้ง dependency/model ด้วย owner action ที่ตรวจสอบแหล่งที่มาเอง
