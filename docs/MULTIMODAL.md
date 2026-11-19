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

รุ่น 1.10.0 มี Full 176 capabilities (ค่าเริ่มต้น 172 เมื่อซ่อน sub-agent), Compact 20 และ Hybrid 49

## Creative Media

ตั้งค่าที่ **Local Config → Providers & Profiles → Creative Media** ใช้ฟอร์มเพิ่ม/แก้ provider เพื่อกรอกชื่อ, API protocol, Base URL และคีย์ได้เอง มี preset OpenAI, Google Gemini และ Custom ที่แก้ไขได้ config/preset ใหม่เลือกโมเดลเป็น **Auto** จึงบันทึกด้วย URL/key ได้ก่อนรู้ Model ID เดิมที่ผู้ใช้บันทึกเองยังอยู่ เมื่อบันทึก provider ที่เปิดใช้แล้ว AI เรียกสร้างภาพจากแชตแบบ global ได้ทันทีโดยไม่ต้องสร้างหรือเลือกโปรเจกต์ ไม่ต้องส่ง workspace context หรือเปิด media/upload switches ฟิลด์เก่า `enabled`, `allowImageUpload`, `projectIds` ไม่ใช้จำกัดงานภาพอีก ส่วนครอป/แบ่ง grid ทำในเครื่องโดยไม่ต้องมีคีย์

เครื่องมือ creative, resource, download links, `multimodal_status` และ `dodo_discover` ใช้แบบ global ได้กับ client ที่ยืนยันตัวตนระดับ installation และมี OAuth scopes ของ operation รวม managed mode โดยไม่ตรวจ project AI allowlist หรือขอ project trust approval ผลงานยังแยกตามผู้เรียก การส่ง context หรือ target อย่างชัดเจนเลือก runtime และ policy ของโปรเจกต์นั้น `media_save` ยังต้องมี context ของโปรเจกต์ปลายทาง และรับ resource ที่ผู้เรียกสร้างแบบ global ได้ด้วย legacy login ต้อง reconnect ส่วน delegated agent ที่ถูกจำกัดโปรเจกต์ใช้ global ไม่ได้

หน้าเว็บโหลดรายการโมเดลให้อัตโนมัติหลังเปิด/เปลี่ยน/บันทึก connection มีปุ่มโหลดใหม่และพิมพ์ Model ID เองได้หากรายการใช้ไม่ได้ Auto ให้ AI เรียก `creative_models` แล้วเลือก `model` ตามงานในคำขอสร้างภาพ ลบพื้นหลัง หรือสร้างวิดีโอ โดยไม่แก้ค่าที่บันทึกไว้ รายชื่อ/คำใบ้จากชื่อไม่รับรองความสามารถหรือราคา explicit ID ใช้ได้โดยไม่บังคับ model-list หรือรายชื่อ hardcoded หาก client ไม่ส่งโมเดลหรือส่ง `auto` DODO ใช้ค่าเริ่มต้นและตัวเลือกสำรองเดิม ผล `creative_job.model` คืน ID ที่ใช้จริง ไม่มี literal `auto` ส่งถึง provider หรือ paid retry ด้วยโมเดลอื่น

OpenAI-compatible ใช้ Images API ส่วน Gemini native ใช้ Interactions; Gemini ขอภาพระดับ 1K ตามอัตราส่วนและใช้ quality อัตโนมัติ ขนาดจริงและความโปร่งใสต้องตรวจจาก output ไม่ถือว่าทุก provider รองรับตัวเลือกเหมือนกัน แก้ชื่อ/โมเดลได้โดยคงคีย์เดิม แต่การเปลี่ยน URL/protocol/storage/ชื่อตัวแปร Env ต้องกรอกคีย์ใหม่ ไม่มีคีย์เดิมเติมกลับหน้าเว็บ

ทั้ง Providers และ Creative Media เลือก **Env ถาวรในเครื่องที่รัน DODO** ได้บน Windows, Linux และ macOS โดยเก็บคีย์เป็นข้อความในไฟล์ส่วนตัวใต้ `DODO_CONFIG_DIR/credentials/ai` พร้อม private permissions/ACL และอ่านกลับหลังรีสตาร์ต ไม่เปลี่ยน Env ทั้งเครื่อง ไม่เก็บใน browser storage และไม่ส่งคีย์ที่บันทึกไปเป็น Env ของ child jobs หากใช้ตัวแปรภายนอก ให้ระบุชื่อและเว้นคีย์ว่างสำหรับ connection ใหม่ ระบบอ่าน inherited environment เฉพาะเมื่อไม่มีไฟล์ของ connection; เมื่อหมุนคีย์ภายนอกต้องบันทึกยืนยันใหม่ Session และ macOS Keychain ยังเลือกได้ตามความสามารถของเซิร์ฟเวอร์ ดู [credential storage และการลบ/เปลี่ยนคีย์](AI_PROVIDERS.md#credential-และ-endpoint)

เครื่องมือคือ `creative_models` สำหรับให้ AI ดูรายชื่อและค่าเริ่มต้น, `image_generate`, `image_crop`, `image_remove_background`, `video_generate`, `video_edit`, `video_extend` พร้อม `creative_job` สำหรับอ่านผล และ `media_save` สำหรับบันทึกลงโปรเจกต์ งานผ่าน AI อาจมีค่าใช้จ่ายและไม่ retry อัตโนมัติ ภาพ/วิดีโอที่สร้างเสร็จเป็น immutable resources รองรับ preview, bounded range และ hash-verified save การลบพื้นหลังเป็น generative edit ซึ่งอาจเปลี่ยนรายละเอียดภาพได้

วิดีโอเป็น compatibility adapter ที่ต้องเปิด `videoEnabled` และกรอกโมเดลของปลายทางที่รองรับจริง ไม่มีโมเดลวิดีโอเริ่มต้น OpenAI ยุติ Sora 2 และ Videos API แล้วเมื่อ 24 กันยายน 2026 จึงใช้ OpenAI ทางการเพื่อสร้างวิดีโอไม่ได้ ดู [ประกาศยุติบริการ](https://developers.openai.com/api/docs/deprecations#2026-03-24-sora-2-video-generation-models-and-videos-api)

ดูการตั้งค่า ตัวอย่าง schema พิกัดครอป การติดตามงานหลังรีสตาร์ต และข้อจำกัดการบันทึกที่ [Creative Media](CREATIVE_MEDIA.md)

## Temporary downloads

`download_link_create` รับ resource ที่ผู้เรียกเป็นเจ้าของ พร้อม `expectedSha256`, `expiresInDays` เป็น 1/2/7/14/30 (เริ่มต้น 7 วัน) และชื่อไฟล์ที่เลือกได้ ผลเป็น URL เช่น `https://mcp.example.com/file/<token>/image.png` บน origin ของ HTTP server ที่รันจริง ใช้ resource จาก `creative_job`/`image_crop` หรือ `resource_inspect` โดยไม่ส่งภาพไป provider เพิ่ม ต้องมี read/write scopes งาน global ไม่ต้องมีโปรเจกต์หรือ project trust approval ส่วนคำขอที่ระบุ project context ยังผ่าน policy ของโปรเจกต์นั้น

ผู้ที่มี URL ดาวน์โหลดได้ จึงต้องเก็บเป็นความลับ `download_link_list` คืน metadata ที่ยังไม่หมดอายุโดยไม่แสดง token/URL และ `download_link_revoke` ยกเลิกได้ด้วย write scope ลิงก์ชี้สำเนา CAS แบบ immutable มีอายุแยกจาก reference 24 ชั่วโมง และเก็บข้ามรีสตาร์ต/สลับ workspace โดยยังตรวจ current grant; ลิงก์จากโปรเจกต์ตรวจสิทธิ์โปรเจกต์ต้นทางเพิ่ม ส่วนลิงก์ global ไม่พึ่งโปรเจกต์ การใช้ STDIO อย่างเดียวไม่เปิด HTTP download server ส่วน localhost URL ใช้ได้เฉพาะเครื่องนั้น ดู [คู่มือฉบับเต็ม](RESOURCES.md#temporary-token-download-links)

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

## ความพร้อม งานเดิม และการกู้ผล (1.10.0)

`multimodal_status` แสดง `serverVersion`, readiness และ blockers โดยไม่เรียกโมเดล ปุ่มตรวจการเชื่อมต่อใน Creative Media ตรวจ metadata/key เท่านั้น ไม่รับรอง inference หรือเครดิต งานที่รับแล้วเก็บผลต่อได้เมื่อ presentation token หมดอายุ; ตอนรับไฟล์ยังตรวจ live grant/client/scope และต้องใช้ token ที่ใช้ได้

ใช้ `creative_jobs` เพื่อค้นประวัติของผู้เรียกเองหรือกู้ job จาก idempotency key เดิม และ `creative_job_control` กับ `retry_save` เพื่อ finalize ผลเดิมโดยไม่สร้างใหม่ `stop_tracking` หยุดติดตามในเครื่องและไม่รับรองการยกเลิกที่ provider/คืนเงิน ประวัติงานที่เสร็จไม่กิน active slots และงานยังไม่จบไม่ถูกลบเพียงเพราะครบ24ชั่วโมง ดู [รายละเอียด](CREATIVE_MEDIA.md#งาน-asynchronous-และรีสตาร์ต)
