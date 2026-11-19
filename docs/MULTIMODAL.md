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

ตั้งค่าที่ **Local Config → Providers & Profiles → Creative Media** ใช้ฟอร์มเพิ่ม/แก้ provider เพื่อกรอกชื่อ, API protocol, Base URL, คีย์ และ Model ID ได้เอง มี preset OpenAI, Google Gemini และ Custom ที่แก้ไขได้ เลือก connection/โปรเจกต์ที่อนุญาตแล้วเปิดใช้ งานผ่าน AI ปิดไว้จนเจ้าของเปิด การลบพื้นหลังและภาพอ้างอิงวิดีโอต้องอนุญาตส่งภาพเพิ่ม ส่วนครอป/แบ่ง grid ทำในเครื่องโดยไม่ต้องมีคีย์

โหลดรายชื่อโมเดลหรือกรอก ID เองได้ OpenAI-compatible ใช้ Images API ส่วน Gemini native ใช้ Interactions; Gemini ขอภาพระดับ 1K ตามอัตราส่วนและใช้ quality อัตโนมัติ ขนาดจริงและความโปร่งใสต้องตรวจจาก output ไม่ถือว่าทุก provider รองรับตัวเลือกเหมือนกัน แก้ชื่อ/โมเดลได้โดยคงคีย์เดิม แต่การเปลี่ยน URL/protocol/storage ต้องกรอกคีย์ใหม่ ไม่มีคีย์เดิมเติมกลับหน้าเว็บ

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
