# DODO Multimodal

DODO รองรับภาพ เสียง วิดีโอ เบราว์เซอร์ เกม และ speech เมื่อ dependency, model และ owner permission พร้อม ระบบไม่ดาวน์โหลด model หรือเปิด device permission เองตอนติดตั้ง

## Capabilities

- image view และ screen observation
- สร้างภาพ, ครอป/แบ่ง grid เป็น PNG ที่รักษาความโปร่งใส, ลบพื้นหลัง และ video compatibility สำหรับสร้าง/แก้ไข/ต่อคลิป ([Creative Media](CREATIVE_MEDIA.md))
- media open, extract, subtitles, search, read, jobs และ close
- speech synthesis และ transcription ผ่าน engine ที่ owner ติดตั้ง
- isolated browser session, observe และ action
- game session และ step

Compact surface ใช้ `dodo_media`, `dodo_browser` และ `dodo_game` ส่วน Full surface มี tool รายตัวครบ

## Creative Media

ตั้งค่าที่ **Local Config → Providers & Profiles → Creative Media** ใช้ OpenAI เป็นค่าเริ่มต้นสำหรับงานภาพ โดยเลือกคีย์, connection, โมเดล และโปรเจกต์ที่อนุญาต งานผ่าน AI ปิดไว้จนเจ้าของเปิดใช้ การลบพื้นหลังและภาพอ้างอิงวิดีโอต้องเปิดอนุญาตส่งภาพที่เลือกแยกต่างหาก ส่วนครอปภาพ/แบ่ง grid ทำในเครื่องโดยไม่ต้องมีคีย์

เครื่องมือใหม่คือ `image_generate`, `image_crop`, `image_remove_background`, `video_generate`, `video_edit`, `video_extend` พร้อม `creative_job` สำหรับอ่านผล และ `media_save` สำหรับบันทึกลงโปรเจกต์ งานผ่าน AI อาจมีค่าใช้จ่ายและไม่ retry อัตโนมัติ ภาพ/วิดีโอที่สร้างเสร็จเป็น immutable resources รองรับ preview, bounded range และ hash-verified save การลบพื้นหลังเป็น generative edit ซึ่งอาจเปลี่ยนรายละเอียดภาพได้

วิดีโอเป็น compatibility adapter ที่ต้องเปิด `videoEnabled` และกรอกโมเดลของปลายทางที่รองรับจริง ไม่มีโมเดลวิดีโอเริ่มต้น OpenAI ยุติ Sora 2 และ Videos API แล้วเมื่อ 24 กันยายน 2026 จึงใช้ OpenAI ทางการเพื่อสร้างวิดีโอไม่ได้ ดู [ประกาศยุติบริการ](https://developers.openai.com/api/docs/deprecations#2026-03-24-sora-2-video-generation-models-and-videos-api)

ดูการตั้งค่า ตัวอย่าง schema พิกัดครอป การติดตามงานหลังรีสตาร์ต และข้อจำกัดการบันทึกที่ [Creative Media](CREATIVE_MEDIA.md)

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
