# DODO Multimodal

DODO รองรับภาพ เสียง วิดีโอ เบราว์เซอร์ เกม และ speech เมื่อ dependency, model และ owner permission พร้อม ระบบไม่ดาวน์โหลด model หรือเปิด device permission เองตอนติดตั้ง

## Capabilities

- image view และ screen observation
- สร้างภาพ, ครอป/แบ่ง grid เป็น PNG ที่รักษาความโปร่งใส, ลบพื้นหลัง และ video compatibility สำหรับสร้าง/แก้ไข/ต่อคลิป ([Creative Media](CREATIVE_MEDIA.md))
- สร้างลิงก์ดาวน์โหลด resource แบบ token เลือกอายุ 1, 2, 7, 14 หรือ 30 วัน พร้อม list/revoke ([Download links](RESOURCES.md#temporary-token-download-links))
- media open, extract, subtitles, search, read, jobs และ close
- speech synthesis และ transcription ผ่าน engine ที่ owner ติดตั้ง
- isolated browser session, observe และ action
- game session และ step

Compact surface ใช้ `dodo_media`, `dodo_browser` และ `dodo_game` ส่วน Full surface มี tool รายตัวครบ

รุ่น 1.7.0 มี Full 173 capabilities (ค่าเริ่มต้น 169 เมื่อซ่อน sub-agent), Compact 20 และ Hybrid 49

## Creative Media

ตั้งค่าที่ **Local Config → Providers & Profiles → Creative Media** ใช้ฟอร์มเพิ่ม/แก้ provider เพื่อกรอกชื่อ, API protocol, Base URL และคีย์ได้เอง มี preset OpenAI, Google Gemini และ Custom ที่แก้ไขได้ config/preset ใหม่เลือกโมเดลเป็น **Auto** จึงบันทึกด้วย URL/key ได้ก่อนรู้ Model ID เดิมที่ผู้ใช้บันทึกเองยังอยู่ เลือก connection/โปรเจกต์ที่อนุญาตแล้วเปิดใช้ งานผ่าน AI ปิดไว้จนเจ้าของเปิด การลบพื้นหลังและภาพอ้างอิงวิดีโอต้องอนุญาตส่งภาพเพิ่ม ส่วนครอป/แบ่ง grid ทำในเครื่องโดยไม่ต้องมีคีย์

หน้าเว็บโหลดรายการโมเดลให้อัตโนมัติหลังเปิด/เปลี่ยน/บันทึก connection มีปุ่มโหลดใหม่และพิมพ์ Model ID เองได้หากรายการใช้ไม่ได้ เมื่อส่งงานด้วย Auto backend ขอรายการใหม่แล้วเลือก image model ที่รู้จัก ส่งภาพเพียงหนึ่งคำขอ และคืน Model ID ที่ใช้จริง ไม่มี literal `auto`, การเดาใช้โมเดลข้อความ หรือ paid retry ด้วยโมเดลอื่น หากไม่มีโมเดลที่รู้จักให้เลือกเอง

OpenAI-compatible ใช้ Images API ส่วน Gemini native ใช้ Interactions; Gemini ขอภาพระดับ 1K ตามอัตราส่วนและใช้ quality อัตโนมัติ ขนาดจริงและความโปร่งใสต้องตรวจจาก output ไม่ถือว่าทุก provider รองรับตัวเลือกเหมือนกัน แก้ชื่อ/โมเดลได้โดยคงคีย์เดิม แต่การเปลี่ยน URL/protocol/storage/ชื่อตัวแปร Env ต้องกรอกคีย์ใหม่ ไม่มีคีย์เดิมเติมกลับหน้าเว็บ

ทั้ง Providers และ Creative Media เลือก **Env ถาวรในเครื่องที่รัน DODO** ได้บน Windows, Linux และ macOS โดยเก็บคีย์เป็นข้อความในไฟล์ส่วนตัวใต้ `DODO_CONFIG_DIR/credentials/ai` พร้อม private permissions/ACL และอ่านกลับหลังรีสตาร์ต ไม่เปลี่ยน Env ทั้งเครื่อง ไม่เก็บใน browser storage และไม่ส่งคีย์ที่บันทึกไปเป็น Env ของ child jobs หากใช้ตัวแปรภายนอก ให้ระบุชื่อและเว้นคีย์ว่างสำหรับ connection ใหม่ ระบบอ่าน inherited environment เฉพาะเมื่อไม่มีไฟล์ของ connection; เมื่อหมุนคีย์ภายนอกต้องบันทึกยืนยันใหม่ Session และ macOS Keychain ยังเลือกได้ตามความสามารถของเซิร์ฟเวอร์ ดู [credential storage และการลบ/เปลี่ยนคีย์](AI_PROVIDERS.md#credential-และ-endpoint)

เครื่องมือใหม่คือ `image_generate`, `image_crop`, `image_remove_background`, `video_generate`, `video_edit`, `video_extend` พร้อม `creative_job` สำหรับอ่านผล และ `media_save` สำหรับบันทึกลงโปรเจกต์ งานผ่าน AI อาจมีค่าใช้จ่ายและไม่ retry อัตโนมัติ ภาพ/วิดีโอที่สร้างเสร็จเป็น immutable resources รองรับ preview, bounded range และ hash-verified save การลบพื้นหลังเป็น generative edit ซึ่งอาจเปลี่ยนรายละเอียดภาพได้

วิดีโอเป็น compatibility adapter ที่ต้องเปิด `videoEnabled` และกรอกโมเดลของปลายทางที่รองรับจริง ไม่มีโมเดลวิดีโอเริ่มต้น OpenAI ยุติ Sora 2 และ Videos API แล้วเมื่อ 24 กันยายน 2026 จึงใช้ OpenAI ทางการเพื่อสร้างวิดีโอไม่ได้ ดู [ประกาศยุติบริการ](https://developers.openai.com/api/docs/deprecations#2026-03-24-sora-2-video-generation-models-and-videos-api)

ดูการตั้งค่า ตัวอย่าง schema พิกัดครอป การติดตามงานหลังรีสตาร์ต และข้อจำกัดการบันทึกที่ [Creative Media](CREATIVE_MEDIA.md)

## Temporary downloads

`download_link_create` รับ resource ที่ผู้เรียกเป็นเจ้าของ พร้อม `expectedSha256`, `expiresInDays` เป็น 1/2/7/14/30 (เริ่มต้น 7 วัน) และชื่อไฟล์ที่เลือกได้ ผลเป็น URL เช่น `https://mcp.example.com/file/<token>/image.png` บน origin ของ HTTP server ที่รันจริง ใช้ resource จาก `creative_job`/`image_crop` หรือ `resource_inspect` โดยไม่ส่งภาพไป provider เพิ่ม ต้องมี read/write และผ่าน execution trust/approval

ผู้ที่มี URL ดาวน์โหลดได้ จึงต้องเก็บเป็นความลับ `download_link_list` คืน metadata ที่ยังไม่หมดอายุโดยไม่แสดง token/URL และ `download_link_revoke` ยกเลิกได้ด้วย write scope ลิงก์ชี้สำเนา CAS แบบ immutable มีอายุแยกจาก reference 24 ชั่วโมง และเก็บข้ามรีสตาร์ต/สลับ workspace โดยยังตรวจ current grant/สิทธิ์โปรเจกต์ต้นทาง การใช้ STDIO อย่างเดียวไม่เปิด HTTP download server ส่วน localhost URL ใช้ได้เฉพาะเครื่องนั้น ดู [คู่มือฉบับเต็ม](RESOURCES.md#temporary-token-download-links)

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
