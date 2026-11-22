# Creative Media

DODO รองรับสร้างภาพ ครอป/แบ่งภาพเป็นตาราง และลบพื้นหลังจากแชตโดยไม่ต้องสร้างหรือเลือกโปรเจกต์ ตั้งค่าได้ทั้ง OpenAI ทางการ, Google Gemini ทางการ และบริการภายนอกที่ใช้รูปแบบ API ที่รองรับ OpenAI เป็นค่าเริ่มต้นที่แก้ไขได้ เจ้าของกรอกชื่อ provider, API Base URL, คีย์ และโมเดลใน Local Config ได้โดยตรงแล้ว AI เรียกสร้างภาพได้ทันที ส่วนวิดีโอมี adapter สำหรับปลายทางที่รองรับ create/status/content/edit/extend แบบเข้ากันได้ และเริ่มปิดไว้ เครื่องมือ MCP ไม่รับ URL, key หรือ remote task ID แต่ AI ระบุ `model` สำหรับสร้างภาพ ลบพื้นหลัง และสร้างวิดีโอในแต่ละคำขอได้ งานครอปทำในเครื่องโดยไม่เรียกโมเดล

ตรวจเอกสารทางการเมื่อ 17 พฤศจิกายน 2026: OpenAI ระบุว่า Sora 2 และ Videos API ปิดบริการเมื่อ 24 กันยายน 2026 และไม่มี API ทดแทนตรงตัว จึงไม่ตั้ง `sora-2` เป็นค่าเริ่มต้นหรือส่งวิดีโอไปที่ OpenAI โดยอัตโนมัติ ดู [ประกาศยุติบริการ](https://developers.openai.com/api/docs/deprecations#2026-03-24-sora-2-video-generation-models-and-videos-api) และ [คู่มือวิดีโอที่เก็บไว้เป็นประวัติ](https://developers.openai.com/api/docs/guides/video-generation)

## ตั้งค่า

1. เปิด Local Config แล้วไปที่ **Providers & Profiles → Creative Media**
2. เปิด **เพิ่ม / แก้ไข Provider สำหรับสร้างภาพ** เลือก preset OpenAI, Google Gemini หรือ Custom แล้วกรอกชื่อ connection, รูปแบบ API, API Base URL และคีย์ เลือก **Env ถาวรในเครื่องที่รัน DODO** เพื่อเก็บคีย์ข้ามรีสตาร์ต หรือเลือก Session/Keychain ตามที่เซิร์ฟเวอร์รองรับ รุ่นใหม่ตั้งโมเดลเป็น **Auto** จึงบันทึก Custom ด้วย URL/key ได้โดยยังไม่ต้องรู้ Model ID ทุก preset แก้ไขได้และไม่บังคับ hostname ของงานภาพ
3. กด **บันทึก Provider สำหรับภาพ** ระบบเลือก connection และบันทึกโมเดลให้พร้อมใช้งานจากแชต ไม่ต้องเลือกโปรเจกต์หรือเปิดอนุญาตงานภาพเพิ่มเติม หน้าเว็บโหลดและแสดงรายชื่อโมเดลให้อัตโนมัติเมื่อมี connection ที่เลือก หลังเปิดหน้า เปลี่ยน connection หรือบันทึกค่าการเชื่อมต่อ เลือก Auto, โมเดลในรายการ หรือพิมพ์ Model ID เองได้ หากโหลดไม่สำเร็จยังกรอกเองได้โดยไม่บล็อกฟอร์ม และใช้ **โหลดโมเดลสำหรับภาพ** เพื่อโหลดใหม่ การมีชื่อในรายการไม่รับรองว่าโมเดลนั้นสร้างภาพได้
4. ในแชตที่เชื่อม DODO MCP สั่ง AI เช่น **สร้างภาพแมวใส่ชุดนักบินอวกาศ อัตราส่วน 1:1** ได้เลย หากเปลี่ยน connection หรือโมเดลในฟอร์มหลักให้กด **บันทึก Creative Media** ก่อนเรียกงานใหม่
5. สำหรับวิดีโอ ให้เลือก connection ที่ตรวจแล้วว่ารองรับ video API เปิด `videoEnabled` และกรอก `videoModel` เอง ค่าเริ่มต้นคือปิดและโมเดลว่าง การเชื่อมต่อ OpenAI ทางการเปิดวิดีโอไม่ได้

การสร้างภาพต้องมี connection ที่เปิดใช้และคีย์ที่ใช้งานได้ ส่วน client ต้องเชื่อมต่อ DODO พร้อม OAuth scope ของ operation นั้น งานภาพไม่ใช้รายการโปรเจกต์ที่อนุญาต สวิตช์เปิดงานภาพ หรือสวิตช์อนุญาตอัปโหลดภาพเดิม การลบพื้นหลังและงานที่ใช้ภาพอ้างอิงส่งเฉพาะภาพที่ AI ระบุในคำขอ การตั้งค่าหรือโหลดรายชื่อโมเดลไม่สร้างภาพและไม่ถือเป็นการตรวจรับ inference การโหลดรายชื่อเป็นคำขอ API แบบอ่านแยกต่างหาก งานสร้างสื่ออาจมีค่าใช้จ่ายและขึ้นกับสิทธิ์โมเดลของบัญชี Connection ที่สร้างจาก Creative Media ใช้ credential store เดียวกับ AI Providers และไม่ต้องสร้าง Agent Profile

บันทึก provider ที่ปิดใช้งานไว้เป็นฉบับร่างได้ โดยไม่เปลี่ยน connection สำหรับงานสื่อที่เลือกอยู่ ต้องเปิด connection ก่อนเลือกใช้งาน หากต้องการปิด connection ที่ใช้งานอยู่ ให้เลือก connection อื่นหรือยกเลิกการเลือกแล้วบันทึก Creative Media ก่อน

ตั้งแต่ 1.8.0 การเรียกแบบ global ใช้ได้กับ client ที่ยืนยันตัวตนระดับ installation และมี OAuth scopes ตรงกับ operation รวม managed mode โดยไม่ตรวจรายการ client ของโปรเจกต์หรือขอ project trust approval การเปลี่ยนนี้มีผลกับ provider ที่เลือกไว้ก่อนอัปเกรดด้วย legacy login ที่ผูก root ต้อง reconnect ส่วน delegated agent ที่ถูกจำกัดโปรเจกต์ใช้ global ไม่ได้ ฟิลด์เดิม `enabled`, `allowImageUpload`, `projectIds` ยังรับเพื่อความเข้ากันได้ แต่ไม่ใช้จำกัดงานภาพอีก: ค่าที่อ่าน/บันทึกจะเป็น `enabled` ตามการเลือก connection, `allowImageUpload:true`, `projectIds:[]` ผลงานยังแยกตามผู้เรียกเดิม

ตั้งแต่ 1.9.0 **Auto — ให้ AI เลือกโมเดลตามงาน** เป็นค่าเริ่มต้นของ config/preset ใหม่ AI เรียก `creative_models` เพื่ออ่านค่าเริ่มต้นและรายชื่อจาก API แล้วเลือกโมเดลที่เหมาะกับคำขอโดยส่ง `model` ใน `image_generate`, `image_remove_background` หรือ `video_generate` การเลือกนี้ไม่เปลี่ยนค่าตั้ง หากผู้ใช้ระบุโมเดลให้ใช้ ID นั้น และหากตั้งค่าเริ่มต้นแบบเจาะจงไว้ AI ใช้ค่านั้นเมื่อไม่มีคำสั่งเลือกอย่างอื่น รายชื่อเป็นข้อมูลจาก provider; `mediaHint` เป็นเพียงคำใบ้จากชื่อ ไม่ใช่ผลทดสอบความสามารถ ราคา ความเร็ว หรือคุณภาพ

`creative_models` ใช้ `query`, `limit`, `cursor` เพื่อค้นและอ่านหน้าถัดไปได้ คืนเฉพาะข้อมูลโมเดล ไม่มี API URL หรือคีย์ หากปลายทางไม่รองรับ model-list ยังส่ง ID ที่ทราบเองได้และไม่บังคับให้ ID อยู่ในรายการ hardcoded สำหรับ Gemini native ระบบตัด `models/` นำหน้า ID ก่อนเรียก API

หาก client ไม่ส่ง `model` หรือส่ง `auto` DODO ยังใช้โมเดลเริ่มต้นที่บันทึกไว้ และเมื่อค่านั้นเป็น Auto จะเลือก image model ที่รู้จักจากรายชื่อ API ตามลำดับสำรองเดิม นี่เป็นการรองรับ client ที่ไม่เลือกโมเดลเอง หากไม่มีตัวเลือกที่รู้จักให้ส่ง Model ID เอง ไม่ส่งคำว่า `auto` ไปยัง provider ผล `creative_job.model` แสดงโมเดลที่ใช้จริง หากเกิดข้อผิดพลาดระบบไม่สลับโมเดลแล้วส่งงานเสียเงินซ้ำ

เลือก connection แล้วกด **แก้ไข connection ที่เลือก** เพื่อเปลี่ยนชื่อ, URL, protocol, model หรือวิธีเก็บคีย์ ช่องคีย์ไม่เติมค่ากลับจาก server เว้นว่างได้เมื่อคง URL/protocol/storage/ชื่อตัวแปร Env เดิม หากเปลี่ยนค่าใดค่าหนึ่งต้องกรอกคีย์ใหม่ก่อนบันทึก ระบบไม่ส่งคีย์เดิมต่อไปยัง endpoint ใหม่

API Base URL ต้องจบที่ฐาน API เช่น `/v1` หรือ `/v1beta` ไม่ต่อ `/images/generations`, `/images/edits`, `/interactions` หรือ operation อื่น Public endpoint ต้องเป็น HTTPS; loopback/LAN ต้องอนุญาต private endpoint แยกต่างหาก ระบบตรวจ DNS และไม่ตาม redirect พร้อม credentials ไม่มี provider ทดสอบส่วนตัวหรือคีย์ตัวอย่างจริงฝังใน preset

Env ถาวรใช้ไฟล์ส่วนตัวใต้ `DODO_CONFIG_DIR/credentials/ai` บนเครื่องที่รัน DODO จึงใช้ได้หลังรีสตาร์ตบน Windows, Linux และ macOS โดยไม่ต้องใส่คีย์ใหม่ ชื่อตัวแปรเว้นว่างให้ DODO สร้างได้ ไฟล์เก็บค่าเป็นข้อความที่จำกัดสิทธิ์ ไม่ใช่ OS vault และไม่เปลี่ยน Env ทั้งเครื่องหรือเก็บคีย์ในเบราว์เซอร์ ฟอร์มใหม่เลือก Env เมื่อเซิร์ฟเวอร์รองรับ ส่วน connection เดิมและค่าเริ่มต้นของ Provider API ยังคงเดิม

ถ้าใช้ตัวแปรที่ provision ไว้ใน inherited environment ของเซิร์ฟเวอร์แล้ว ให้ระบุชื่อและเว้นคีย์ว่างสำหรับ connection ใหม่ ระบบอ่าน Env ภายนอกเฉพาะเมื่อไม่มีไฟล์ที่ DODO เก็บเอง ไฟล์ที่มีปัญหาไม่ทำให้สลับแหล่งคีย์ การเปลี่ยนค่า Env ภายนอกต้องบันทึกยืนยัน connection ใหม่ก่อนใช้งาน การลบ connection ลบเฉพาะไฟล์ของ DODO และไม่ unset ตัวแปรภายนอก ดู [credential storage](AI_PROVIDERS.md#credential-และ-endpoint)

Session key อยู่ในหน่วยความจำและต้องกรอกใหม่หลัง DODO รีสตาร์ต ส่วน macOS Keychain ใช้เก็บคีย์ข้ามรอบได้บนเซิร์ฟเวอร์ Mac การตั้งค่าโมเดลยังอยู่ใน private state เมื่อไม่มีคีย์ ระบบรายงานข้อผิดพลาดโดยไม่เปลี่ยนไปใช้ connection อื่นเอง งานสื่อแบบ global ไม่ต้องมีสิทธิ์ AI รายโปรเจกต์

หากการบันทึกคีย์และ connection ไม่สำเร็จครบ ระบบจะพักการใช้ connection นั้นและขอให้กรอกคีย์ใหม่ แม้รีสตาร์ตแล้วก็จะไม่ส่งคีย์ที่อาจจับคู่กับ URL ผิดออกไป เมื่อยืนยัน URL/protocol/storage/Env reference และบันทึกคีย์ใหม่สำเร็จจึงใช้งานต่อได้

## รูปแบบ API สำหรับภาพ

| Preset / รูปแบบ | ค่าเริ่มต้น | วิธีส่งคำขอ |
|---|---|---|
| OpenAI / OpenAI-compatible Images | `https://api.openai.com/v1` · Auto | `POST /images/generations`, multipart `POST /images/edits`; Bearer key |
| Google Gemini / Gemini Interactions | `https://generativelanguage.googleapis.com/v1beta` · Auto | `POST /interactions`; `x-goog-api-key`, inline PNG |
| Custom / API ภายนอก | เจ้าของกรอก URL · Auto หรือ Model ID เอง | เลือกรูปแบบ OpenAI-compatible Images หรือ Gemini Interactions ให้ตรงกับปลายทาง |

เลือกรูปแบบตาม API ที่บริการนั้นรับจริง ไม่เดาจากชื่อ provider หรือชื่อโมเดล ตัวอย่างเช่น gateway ที่ให้โมเดล Gemini ผ่าน `/images/generations` ต้องเลือก OpenAI-compatible Images ส่วน Gemini native ใช้ Interactions โหลดรายชื่อ Gemini แล้วระบบตัด `models/` ออกจากชื่อ resource เพื่อใช้เป็น Model ID AI เลือก ID ที่เหมาะกับงานจากรายชื่อจริงได้ ส่วนตัวสำรองสำหรับ client ที่ไม่ส่งโมเดลเลือกเฉพาะ image IDs ที่ระบบรู้จักและพบในรายการ การระบุ `model` รายคำขอไม่ถูกจำกัดด้วยรายชื่อสำรองนี้ และไม่เปลี่ยนค่า Model ID ที่บันทึกเอง

อ่านรูปแบบและข้อจำกัดจาก [OpenAI image generation](https://developers.openai.com/api/docs/guides/image-generation) และ [Google Gemini image generation](https://aistudio.google.com/docs/image-generation) การรองรับวิดีโอต้องตรวจจากปลายทางที่เลือกเอง Gemini image protocol ไม่ถือว่ารองรับ video compatibility เอกสาร OpenAI Videos API เป็นข้อมูลรูปแบบเดิม ไม่ใช่การรับรองว่าปลายทางนั้นยังเปิดบริการ

## เครื่องมือ

| Operation | ผลลัพธ์ |
|---|---|
| `creative_models` | อ่านรายชื่อโมเดลจาก API และค่าเริ่มต้น เพื่อให้ AI เลือกโมเดลตามงาน ไม่มีการสร้างสื่อ |
| `image_generate` | สร้างภาพจาก `prompt` พร้อม `model` ที่เลือกได้ แล้วคืน `jobId` สำหรับอ่านผล PNG |
| `image_crop` | ครอป 1–16 บริเวณด้วย `regions` หรือแบ่งเป็น `grid` แล้วคืน PNG resources ทันที |
| `image_remove_background` | ส่งภาพที่เลือกเพื่อแยกวัตถุหลักบนพื้นโปร่งใส แล้วคืน `jobId` |
| `video_generate` | สร้างวิดีโอจากข้อความ พร้อมภาพอ้างอิงที่เลือกได้ แล้วคืน `jobId` |
| `video_edit` | สร้างงานแก้ไขวิดีโอจาก `jobId` ที่เสร็จแล้วของผู้เรียก โดยส่งคำสั่งใหม่ |
| `video_extend` | สร้างงานต่อวิดีโอจาก `jobId` ที่เสร็จแล้วของผู้เรียก พร้อมข้อความและระยะเวลาที่เลือก |
| `creative_job` | อ่านสถานะและรับ resource ของงานเดิม โดยไม่เริ่มสร้างใหม่ |
| `creative_jobs` | ดูเฉพาะประวัติงานของผู้เรียก หรือค้นด้วย `idempotencyKey` เดิมหลัง response หาย |
| `creative_job_control` | `retry_save` กู้ผลที่สร้างแล้วโดยไม่ render ซ้ำ; `stop_tracking` หยุดติดตามในเครื่อง |
| `animation_catalog` | อ่าน preset ตัวละคร เอฟเฟกต์ รูปแบบไฟล์ และสถานะความพร้อมของเครื่องยนต์แอนิเมชันในเครื่อง ไม่ render |
| `animation_image` | ทำภาพนิ่งหนึ่งภาพให้เป็นลูป: เอฟเฟกต์ทั้งภาพ หรือกะพริบตา/โบกมือ พร้อมคำบรรยายภาษาไทยได้ |
| `animation_rig` | ขยับตัวละครแบบมีโครง (preset หรือ rig เอง) พร้อม spring physics การกะพริบตา และผลตรวจลูป |
| `animation_sprite` | ประกอบ pose sheet 4×2 หรือ 4×4 แบบโปร่งใสเป็นลูปเดินหรือโบกมือ |
| `animation_job` | รับผลงานแอนิเมชันที่ยัง render อยู่ โดยไม่เริ่มงานใหม่ |
| `animation_frames_plan` | เตรียมให้โมเดลสร้างภาพวาดเฟรม: ภาพนำทาง (ตัวละครในช่องแรก), mask, prompt ทีละช่อง และ layout ทำในเครื่อง ไม่เสียเงิน |
| `image_edit` | วาดภาพใหม่จากภาพอ้างอิง 1–4 ภาพ พร้อม mask ที่ให้วาดเฉพาะบางส่วนได้ (งานเสียเงินหนึ่งครั้ง คืน `jobId`) |
| `animation_banner` | แบนเนอร์ข้อความไทย/อังกฤษแบบนีออน มีป้ายสถานะ ดาวหางวิ่งรอบกรอบ และท่าขยับ 5 แบบ วาดด้วย Pillow + HarfBuzz ไม่ต้องใช้เบราว์เซอร์ |
| `animation_scene` | ฉากหลายเลเยอร์: preset ระบบสุริยะ หรือฉากหลัง + เลเยอร์ภาพนิ่ง/ภาพเคลื่อนไหวสูงสุด 20 ชั้น เดินผ่าน โคจร หมุน หรือเต้น ส่งออก GIF/MP4 |
| `media_save` | บันทึก resource ที่สร้างแล้วลงโปรเจกต์ ผ่าน hash checks และ journal/rollback เดิม (PNG/MP4 และผลแอนิเมชัน GIF/WebP/APNG/WebM/JSON) |
| `download_link_create` | สร้าง URL แบบ token สำหรับ resource ที่เป็นเจ้าของ เลือกอายุ 1, 2, 7, 14 หรือ 30 วัน |
| `download_link_list` | ดู metadata ของลิงก์ที่เป็นเจ้าของ โดยไม่ส่ง token/URL กลับ |
| `download_link_revoke` | ยกเลิกลิงก์ที่เป็นเจ้าของก่อนหมดอายุ |

Full surface มีเครื่องมือรายตัว ส่วน Compact/Hybrid ใช้ operations เดียวกันผ่าน `dodo_media` ตรวจ schema ล่าสุดด้วย `dodo_discover` ได้ เครื่องมือสร้างภาพ/วิดีโอ ครอป ลบพื้นหลัง รับผลงาน อ่าน resource และสร้างลิงก์ดาวน์โหลดเรียกแบบ global ได้: ไม่ต้องส่ง `workspaceId`/`workspaceEpoch` หรือเรียก `project_overview` ก่อน ผลงานยังแยกตามผู้เรียกเดิม การส่ง workspace context หรือ target อย่างชัดเจนจะเลือกทำงานในโปรเจกต์นั้น ส่วน `media_save` สำหรับเขียนไฟล์ลงโปรเจกต์ยังต้องมี context ของปลายทาง ไม่มีเครื่องมือสร้างโมเดล 3D ในฟีเจอร์นี้

ตัวอย่างให้ AI เลือกโมเดลแล้วสร้างภาพผ่าน Compact/Hybrid โดยไม่ใช้โปรเจกต์:

```text
dodo_media(operation="creative_models",args={limit:50})
  → models, imageModel, videoModel, nextCursor

# ใช้ Model ID จริงจากผลก่อนหน้า ไม่ใช้ข้อความตัวอย่างนี้ตรง ๆ
dodo_media(
  operation="image_generate",
  args={prompt:"A cat astronaut, illustration",model:"<chosen model ID>",size:"1024x1024",idempotencyKey:"chat-image-0001"}
)
dodo_media(operation="creative_job",args={jobId:"creative_…"})
```

ใช้ `jobId` ที่ได้จริงจากคำขอแรกเพื่อรับผลจากงานเดิม ไม่เริ่มงานสร้างซ้ำเพื่อดูสถานะ

รุ่น 1.11.1 มี Full 185 capabilities (ค่าเริ่มต้นซ่อน sub-agent 4 tools จึงเห็น 181), Compact 20 และ Hybrid 49 การสร้างลิงก์ใช้ HTTP server และ origin ที่ตั้งไว้ ไม่ต้องตั้ง provider หรือใช้คีย์ภาพเพิ่ม

งานสร้างภาพใช้ขนาด `1024x1024`, `1536x1024`, `1024x1536` หรือ `auto` รูปแบบ OpenAI ส่ง size/quality/background ตามที่เลือก ส่วน Gemini native รองรับ `quality=auto` และขอภาพระดับ `1K` โดยแปลง size เป็นอัตราส่วน `1:1`, `3:2`, `2:3` หรือปล่อยอัตโนมัติ ขนาด PNG ที่โมเดลคืนมาอาจต่างจากจำนวนพิกเซลใน size; metadata ของผลลัพธ์เป็นขนาดจริง Adapter สร้างวิดีโอรองรับ `1280x720`/`720x1280` และ 4, 8, 12, 16 หรือ 20 วินาทีตามปลายทาง ไม่มีการเปลี่ยนโมเดลหรือเรียกสร้างใหม่เพื่อเลี่ยงข้อผิดพลาดเอง

OpenAI-compatible Images ต้องคืน PNG แบบ `b64_json`; Gemini ต้องคืน inline base64 PNG จาก Interactions ไม่ดาวน์โหลดภาพจาก URL ที่ปลายทางส่งกลับ ไม่ตาม redirect และไม่ส่ง credentials ต่อไปยัง URL อื่น การตั้งค่าผ่านหรือการที่ text chat ใช้ได้ไม่รับรอง operation ภาพ/วิดีโอ หากรูปแบบไม่รองรับจะรายงานปัญหาโดยไม่ส่งงานซ้ำ การตรวจรับ Google Gemini native ใช้ protocol fixtures และยังไม่มี live acceptance ด้วยคีย์ทางการในการตรวจรับครั้งนี้ ดู [Test report](TEST_REPORT.md)

## แอนิเมชันวนลูปในเครื่อง (Gift engine)

`animation_*` ใช้เครื่องยนต์แอนิเมชันของโปรเจกต์ Gift ที่ฝังไว้ใน `engines/animation` render บนเครื่องที่รัน DODO ทั้งหมด ไม่เรียกโมเดลหรือ API และไม่มีค่าใช้จ่าย ผลงานเป็น resource ของผู้เรียกเหมือน `image_crop` จึงใช้ `media_save` หรือ `download_link_create` ต่อได้ทันที

**ตั้งค่าครั้งเดียว** (เลือกอย่างใดอย่างหนึ่ง):

- `dodo-media-setup --install-animation` สร้าง Python venv ส่วนตัวใน DODO config directory (`animation/venv`) และติดตั้งแบบ wheel-only โดย pin dependency หลักสามตัว: `Pillow==13.0.0`, `pydantic==2.14.4`, `uharfbuzz==0.57.0` ต้องมี Python 3.11+ บน trusted PATH และ build DODO แล้ว dependency ทางอ้อมยังเป็นช่วงเวอร์ชันตามแพ็กเกจต้นทาง คำสั่งนี้ไม่เปลี่ยนการตั้งค่าสิทธิ์ของ DODO และไม่ซ่อม path เดิมที่ไม่ปลอดภัยโดยอัตโนมัติ
- หรือเริ่ม DODO พร้อม `DODO_ANIMATION_PYTHON` เป็น absolute path ของ Python ที่มีแพ็กเกจเหล่านี้แล้ว (เช่น `.venv` ของโปรเจกต์ Gift) path ต้องอยู่นอก workspace

ไฟล์ `webm`, `mp4` และ `telegram` ต้องมี FFmpeg บน trusted PATH ส่วน `gif`, `webp`, `apng`, `spritesheet` และ `line` ไม่ต้องใช้ ตรวจสถานะด้วย `animation_catalog` หรือ `dodo-media-setup --check`

| งาน | เครื่องมือ | หมายเหตุ |
|---|---|---|
| ภาพนิ่ง → ลูป | `animation_image` | `actions` เลือกเอฟเฟกต์ทั้งภาพหนึ่งอย่าง (`wiggle`, `zoom`, `pan`, `bounce`, `float`, `sway`, `heartbeat`, `shake`, `spin`, `jelly`) หรือ `blink`/`wave` กับภาพวาดหันหน้าตรง ระบุ `eyes`/`arm` แบบ normalized ได้ |
| ตัวละครมีโครง | `animation_rig` | `preset`: `orange_cat`, `orange_cat_ik`, `orange_cat_idle`, `orange_cat_jump`, `fox_girl_idle`, `fox_girl_bounce`, `fox_girl_jump` หรือ `rig` รูปแบบเดียวกับที่ Gift rig editor บันทึก (snake_case) บนภาพต้นฉบับ ใส่ `seeds` ในชิ้นส่วนเพื่อตัดตามเส้นภาพและไม่ให้ขาด |
| pose sheet → ลูป | `animation_sprite` | ภาพโปร่งใส 4 คอลัมน์ × 2 แถว (8 ท่า) หรือ × 4 แถว (16 ท่า) เรียงจากซ้ายไปขวา |

ทุกงานรับ `format` (`gif` ค่าเริ่มต้น, `webp`, `apng`, `webm`, `mp4`, `spritesheet`, `line`, `telegram`), `caption` สำหรับข้อความสติกเกอร์ภาษาไทยหรืออังกฤษ (ฟอนต์ Sarabun ที่แนบมา จัดรูปสระและวรรณยุกต์ด้วย HarfBuzz โดยไม่ต้องมีเบราว์เซอร์), `maxSide` (128–800 px ย่อให้ไฟล์เบาสำหรับแชต), `edgeMatte`, `gifDither`, `background` และ `loops` GIF ยาว 3 วินาทีที่ 800 px อาจเกินงบ 8 MiB ของ `media_save` ให้ใช้ `maxSide` เช่น 480, ใช้ `webp` หรือส่งผ่าน `download_link_create` ซึ่งไม่จำกัดด้วยงบนี้

ใช้ได้ดีกับภาพที่สร้างจาก `image_generate`: ส่ง `resourceId` ของผลงานต่อให้ `animation_*` ได้ทันที ขอพื้นหลังโปร่งใส (`background:"transparent"`) และเส้นขอบชัด engine ตัดชิ้นส่วนตามเส้นของภาพจาก `seeds` จึงรับเส้นขอบหนาแบบภาพ AI ได้ทั้งเส้น polygon ที่วาดชิดขอบเกินไปเล็กน้อยไม่ทิ้งขอบหูหรือหางไว้บนตัว และหากชิ้นส่วนที่แกว่ง (หู หาง มือ) จะหลุดขอบภาพ engine เติมพื้นที่โปร่งใสให้อัตโนมัติพร้อมย้ายพิกัดทุกจุดตาม รูปแบบ `line` ปรับให้ตรงกฎ LINE Creators Market (≤320×270, 5–20 เฟรม, วินาทีเต็ม, รวม ≤4 วินาที, <1 MB) ส่วน `telegram` ตรงกฎ video sticker (512 px VP9 WebM, ≤3 วินาที, ≤30 FPS, ≤256 KB)

ผลลัพธ์มี `animation` (resource หลัก), `companions` (JSON ของ sprite sheet), `preview` (contact sheet 6 เฟรมที่ส่งเป็นภาพใน MCP ด้วย), `details` และสำหรับ `animation_rig` มี `checks`/`passed` จากการตรวจลูปของ Gift: รอยต่อลูป, ตัวไม่ไหล, แขนขาไม่หลุด, ชิ้นส่วนไม่ขาด และเท้าไม่ลื่นเมื่อใช้ IK ให้ AI แจ้งผู้ใช้เมื่อมี check ไม่ผ่านหรือมี `notes` งานปกติใช้เวลา 5–40 วินาที เครื่องมือรอได้ตาม `waitMs` (ค่าเริ่มต้น 120 วินาที) หากยังไม่เสร็จให้เรียก `animation_job` ด้วย `jobId` เดิม

```text
dodo_media(operation="animation_catalog")
dodo_media(operation="animation_rig",
  args={preset:"fox_girl_idle",format:"line",caption:{text:"สวัสดีค่ะ"},idempotencyKey:"fox-hello-line-0001"})
dodo_media(operation="animation_image",
  args={resourceId:"res_…",actions:["jelly"],format:"telegram",idempotencyKey:"jelly-sticker-0001"})
dodo_media(operation="media_save",
  args={resourceId:"res_…",expectedSha256:"sha256:…",path:"stickers/fox-hello.png",idempotencyKey:"save-fox-0001"})
```

### แบนเนอร์และฉากหลายเลเยอร์

`animation_banner` ทำแบนเนอร์วนลูปจาก `text` (หัวข้อ) และ `label` (ป้ายเล็ก เช่น ONLINE, SALE) เลือก `motion` (`bounce`, `pulse`, `slide`, `shake`, `still`), ขนาด, `background` (สี หรือ `transparent`), `accent`, `textColor` และรูปแบบไฟล์ได้เหมือนเครื่องมืออื่น วาดด้วย Pillow และจัดรูปภาษาไทยด้วย HarfBuzz จึงไม่ต้องติดตั้งเบราว์เซอร์

`animation_scene` ประกอบฉาก: `preset:"solar_system"` (ดวงอาทิตย์และดาวเคราะห์ 8 ดวงโคจร) หรือ `background` + `layers` เรียงจากหลังไปหน้า แต่ละชั้นรับภาพจาก `resourceId`/`assetId`/`path` ทั้งภาพนิ่งและภาพเคลื่อนไหว (เช่น ผลจาก `animation_rig`) วางด้วย `x`/`y` (0–1 และเกินขอบได้) และ `width` เคลื่อนด้วย `endX`/`endY` (เริ่มและจบนอกจอเพื่อเดินผ่านแบบวนลูป), `orbit`, `spinTurns`, `pulse`, `mirror` ส่งออก `gif` หรือ `mp4` เช่น สร้างฉากหลังด้วย `image_generate` แล้วให้ตัวละครจาก `animation_rig` เดินผ่าน

```text
dodo_media(operation="animation_banner", args={text:"ยินดีต้อนรับ",label:"NEW",motion:"bounce",accent:"#FF7AB6",idempotencyKey:"welcome-banner-1"})
dodo_media(operation="animation_scene", args={background:{resourceId:"res_ฉากหลัง"},width:960,height:640,format:"mp4",
  layers:[{image:{resourceId:"res_ตัวละครเคลื่อนไหว"},x:-0.15,y:0.66,endX:1.15,width:0.24,animationLoops:2}],idempotencyKey:"meadow-walk-1"})
```

### วาดเฟรมด้วยโมเดลสร้างภาพ (frame by frame)

แทนที่จะขยับภาพเดิม ให้โมเดลสร้างภาพวาดท่าใหม่ทุกเฟรม แล้ว Gift ตรวจและประกอบเป็นลูป ใช้กับท่าที่ rig ทำไม่ได้ เช่น เดินหันข้าง กระโดดตัวลอย หรือท่าที่กำหนดเอง มีเงื่อนไขกำกับให้แม่นยำทั้งก่อนและหลังวาด:

`image_edit` รับภาพอ้างอิง 1–4 ภาพ โดยขนาดรวมของภาพอ้างอิงและ mask หลังแปลงเป็น PNG ต้องไม่เกิน **16 MiB** (เป็นงบรวม ไม่ใช่ต่อภาพ) Mask ต้องเป็น PNG ที่มี alpha channel มีพื้นที่โปร่งใสเต็มที่ให้วาดใหม่ และมีขนาดพิกเซลตรงกับภาพแรก ระบบตรวจเงื่อนไขเหล่านี้ก่อนสร้างงานหรือส่งคำขอที่มีค่าใช้จ่าย Mask ที่เป็น JPEG, ทึบทั้งหมด หรือมีเพียงความโปร่งใสบางส่วนโดยไม่มีพิกเซล alpha เป็นศูนย์จะถูกปฏิเสธ

1. `animation_frames_plan` (ในเครื่อง ไม่เสียเงิน) รับภาพตัวละครพื้นโปร่งใสหนึ่งภาพ แล้วสร้าง sheet 4×2 (8 ท่า, 1536×1024) หรือ 4×4 (16 ท่า, 1024×1536) โดยวางตัวละครในช่องแรกด้วยขนาดและเส้นพื้นที่ทุกเฟรมต้องใช้ พร้อม **mask** ที่ให้โมเดลวาดได้เฉพาะด้านในช่องที่เหลือ ช่องแรกและร่องระหว่างช่องจึงคงเดิม prompt ระบุเงื่อนไขตัวตน ขนาด เส้นพื้น และท่าทีละช่องตามลำดับลูป `motion`: `wave`, `walk`, `idle` (หายใจและกะพริบตา), `jump` (เว้นที่ด้านบนให้ตัวลอย) หรือ `custom` พร้อม `customPoses`
2. `image_edit` ส่ง `images:[plan.guide, ตัวละคร]`, `mask: plan.mask`, `prompt: plan.prompt`, `size: plan.size`, `background:"transparent"` เป็นงานเสียเงินครั้งเดียว แล้วรับผลด้วย `creative_job`
3. `animation_sprite` ส่ง sheet ที่ได้ พร้อม `motion`, `poses`, `layout: plan.layout` และ `reference` (ตัวละคร) ระบบตรวจก่อนประกอบ: `transparent_background`, `one_figure_per_cell` (ไม่หลุดขอบหรือล้นช่อง), `consistent_size`, `ground_line` (เทียบเส้นพื้นของแถวเดียวกัน เพราะโมเดลอาจเลื่อนทั้งแถวซึ่งไม่กระทบผล ส่วนท่ากระโดดช่องจุดสูงสุดต้องลอยจริง และตอนประกอบจะยึดเส้นพื้นที่วัดได้ ตัวละครจึงลอยขึ้นจริงไม่ถูกดึงลงพื้น), `same_character` (สีตรงกับตัวละคร), `distinct_poses` และ `smooth_sequence` (เตือน) จากนั้นปรับขนาดที่คลาดเล็กน้อยให้เท่าช่องแรกเพื่อไม่ให้ตัวละครเต้นขยายหด ถ้ามี check ไม่ผ่าน ผลยังประกอบให้ดูแต่ `passed:false` และ `notes` บอกสาเหตุ ให้ AI แจ้งผู้ใช้ก่อนสั่งวาดใหม่ เพราะ `image_edit` ครั้งใหม่มีค่าใช้จ่าย

```text
dodo_media(operation="animation_frames_plan", args={resourceId:"res_ตัวละคร",motion:"jump",idempotencyKey:"bunny-jump-plan-1"})
dodo_media(operation="image_edit", args={images:[{resourceId:"<plan.guide>"},{resourceId:"res_ตัวละคร"}],mask:{resourceId:"<plan.mask>"},prompt:"<plan.prompt>",size:"1536x1024",background:"transparent",quality:"high",idempotencyKey:"bunny-jump-draw-1"})
dodo_media(operation="creative_job", args={jobId:"creative_…"})
dodo_media(operation="animation_sprite", args={resourceId:"<sheet>",motion:"jump",poses:8,layout:<plan.layout>,reference:{resourceId:"res_ตัวละคร"},format:"line",idempotencyKey:"bunny-jump-line-1"})
```

ขอบเขตความปลอดภัย: แต่ละงานรันเป็น owned job ของ JobManager โดยขอ `network:false` การปิดเครือข่ายในระดับ OS ต้องใช้ command sandbox ที่รองรับ ส่วน renderer ที่ให้มาประมวลผลในเครื่องและไม่มีคำสั่งเรียกเครือข่าย Python isolated mode เพียงอย่างเดียวไม่ใช่ network sandbox Worker ของ Node เรียก Python แบบ isolated (`-I -B -X utf8`) ใน temp directory ส่วนตัว ภาพต้นทางถูกคัดลอกเป็นชื่อคงที่ และชื่อไฟล์ผลลัพธ์ทุกไฟล์ถูกกำหนดโดย bridge ไม่รับ path หรือฟอนต์จาก client ไฟล์ของ engine ถูก pin ด้วย SHA-256 ใน `engines/animation/MANIFEST.json` และตรวจก่อน render ครั้งแรกของแต่ละ process หาก engine ถูกแก้ไขจะปฏิเสธงาน อัปเดต engine จากโปรเจกต์ Gift ด้วย `node scripts/vendor-animation.mjs --from <path ของ Gift>`

## แชร์ไฟล์ด้วยลิงก์ชั่วคราว

ใช้ `resourceId` และ `sha256` จากผล `creative_job` หรือ `image_crop` สร้างลิงก์ได้โดยไม่ต้องบันทึกภาพ/วิดีโอลง workspace ก่อน:

```text
dodo_media(
  operation="download_link_create",
  args={
    resourceId:"res_…",
    expectedSha256:"sha256:…",
    expiresInDays:7,
    fileName:"generated.png"
  }
)
```

เลือกอายุเป็น 1, 2, 7, 14 หรือ 30 วัน (เริ่มต้น 7) ผลคืน `linkId`, URL, hash และเวลาหมดอายุ URL อยู่บนโดเมนของ HTTP server ที่รันจริง เช่น `https://mcp.example.com/file/<token>/generated.png` ผู้ที่มี URL ดาวน์โหลดได้ จึงต้องเก็บ URL เป็นความลับ ลิงก์ผูกกับสำเนา CAS ที่ไม่เปลี่ยนตามไฟล์ต้นฉบับและมีอายุแยกจาก resource reference 24 ชั่วโมง

`download_link_list` ดูลิงก์ที่ยังไม่หมดอายุของผู้เรียกโดยไม่แสดง token/URL; `download_link_revoke(linkId="dl_…")` ยกเลิกก่อนกำหนด การสร้างต้องมีสิทธิ์ read/write ส่วนยกเลิกต้องมี write งาน global ใช้คำขอของ AI ที่ยืนยันตัวตนแล้วโดยไม่ต้องขอ project trust approval ส่วนการส่ง context ของโปรเจกต์ยังใช้ policy ของโปรเจกต์นั้น ลิงก์อยู่ข้ามรีสตาร์ต/เปลี่ยน workspace แต่หยุดเมื่อหมดอายุ ถูกยกเลิก หรือสิทธิ์ต้นทางถูกถอน การสร้างลิงก์ไม่เรียก image/video API เพิ่มและไม่ retry เอง STDIO อย่างเดียวสร้าง URL ที่ให้บริการไฟล์ไม่ได้ ดู [Temporary token download links](RESOURCES.md#temporary-token-download-links) สำหรับ HTTP/tunnel, permissions และข้อจำกัดทั้งหมด

## ครอปและลบพื้นหลัง

`image_crop` และ `image_remove_background` รับต้นฉบับอย่างใดอย่างหนึ่ง: workspace `path`, `assetId` ของภาพที่ผู้เรียกเป็นเจ้าของ หรือ `resourceId` ของภาพที่ผู้เรียกเข้าถึงได้ งาน global ใช้ resource ของผลงานที่สร้างในแชตได้โดยตรง หากอ่าน `path` จากโปรเจกต์ให้ส่ง context ของโปรเจกต์นั้น Path ยังผ่าน workspace, secret และ regular-file guards เดิม

ครอปใช้ PNG/JPEG/WebP/GIF ขนาดไม่เกิน 16 MiB และ 40 ล้านพิกเซล ใช้เฟรมแรกสำหรับภาพเคลื่อนไหว พิกัดอ้างพิกเซลที่เข้ารหัสในไฟล์ **ก่อนหมุนตาม EXIF** ไม่ใช่พิกัดภาพ preview ที่ถูกย่อ ผลเป็น lossless PNG รักษา alpha ไม่ขยายภาพ และไม่เติมรายละเอียดใหม่ จำนวนพิกเซลรวมของ crops ต่อครั้งไม่เกิน 40 ล้าน

เลือก `regions` หรือ `grid` อย่างใดอย่างหนึ่ง `grid` รับ `rows`, `columns`, `gap` และ `margin` เป็นจำนวนเต็มพิกเซล ค่า gap/margin เริ่มต้นเป็น 0 และมีได้ไม่เกิน 16 ช่องรวม เรียงผลจากซ้ายไปขวาแล้วลงแถวถัดไป เมื่อหารพิกเซลไม่ลงตัว ช่องต้นแถว/คอลัมน์จะรับส่วนเกิน ทำให้ขนาดต่างกันไม่เกิน 1 พิกเซลและไม่ทิ้งพื้นที่ที่แบ่งได้

การลบพื้นหลังใช้ generative image edit จึงอาจเปลี่ยนรายละเอียดของวัตถุได้ แต่ละบริการ/โมเดลอาจรองรับ transparency และการปรับคุณภาพไม่เท่ากัน ระบบตรวจว่าผล PNG มีพิกเซลโปร่งใสจริง หากได้ภาพทึบจะรายงานปัญหาและไม่อ้างว่าลบพื้นหลังสำเร็จ ไม่มีการส่งภาพอื่นหรือทั้งโปรเจกต์เพิ่มเอง

ตัวอย่างครอปผ่าน Compact surface:

```text
dodo_media(
  workspaceId="…", workspaceEpoch="…",
  operation="image_crop",
  args={
    path:"assets/source.png",
    regions:[{left:0,top:0,width:256,height:256}],
    idempotencyKey:"crop-source-top-left-0001"
  }
)
```

เปลี่ยน `regions` เป็น `grid:{rows:2,columns:3,gap:0,margin:0}` เพื่อแบ่งภาพเป็นหกส่วน หาก margin/gap ทำให้ช่องใดไม่มีพิกเซล หรือจำนวนช่องเกิน 16 ระบบจะปฏิเสธก่อนครอป

## วิดีโอจากภาพ แก้ไข และต่อคลิป

เมื่อเปิด video compatibility แล้ว `video_generate` รับ `reference` แบบ `{path:"assets/reference.png"}`, `{assetId:"asset_…"}` หรือ `{resourceId:"res_…"}` ได้หนึ่งต้นฉบับ ภาพยังผ่าน path/secret/ownership guards ระบบแปลงเป็น PNG ก่อนส่งและตรวจว่าขนาดตรงกับ `size` ที่ขอ เช่น `1280x720` โดยไม่ย่อหรือครอปให้อัตโนมัติ

`video_edit` และ `video_extend` รับ `jobId` ของวิดีโอที่เสร็จแล้วใน scope เดิมและเป็นของผู้เรียกเดียวกัน พร้อม `prompt` และ `idempotencyKey` ส่วน extend รับ `seconds` ตาม schema ด้วย ต้นฉบับต้องมี remote handle ที่บันทึกไว้และใช้ connection/configuration เดิม ระบบไม่รับ remote URL หรือ ID ที่ผู้เรียกกรอกเอง แต่ละ operation สร้างงานลูกใหม่ ไม่แก้ receipt หรือไฟล์ต้นฉบับ

```text
dodo_media(
  workspaceId="…", workspaceEpoch="…",
  operation="video_generate",
  args={
    prompt:"The camera moves slowly around the subject",
    reference:{path:"assets/reference.png"},
    size:"1280x720", seconds:4,
    idempotencyKey:"video-reference-0001"
  }
)
```

ใช้ `creative_job` กับ job ที่คืนมาเพื่อรับ MP4 ของงานใหม่ หากปลายทางไม่มี edit/extend หรือไม่ให้สิทธิ์โมเดลนั้น ระบบรายงานข้อผิดพลาดโดยไม่ลดไปเรียก create แทน ไม่เปิด billing ของงานใหม่จากการ polling

## งาน asynchronous และรีสตาร์ต

`image_generate`, `image_remove_background`, `video_generate`, `video_edit` และ `video_extend` คืน `jobId` ก่อนงานเสร็จ จากนั้นเรียก `creative_job` ด้วย ID เดิม เมื่อสร้างภาพสำเร็จจะได้ resource ของ PNG พร้อม MCP image preview; วิดีโอสำเร็จจะได้ MP4 resource โดยไม่มีการอ้างว่า preview เป็นวิดีโอเต็ม

ส่งงานสร้างหนึ่งครั้งต่อหนึ่ง `idempotencyKey` หาก response หาย ให้ใช้ key และ args เดิมเพื่อรับ receipt เดิมได้แม้ DODO รีสตาร์ตแล้ว อย่าสร้าง key ใหม่เพียงเพื่อตรวจความคืบหน้า ไม่มี automatic retry ของงานที่อาจคิดเครดิต การอ่านสถานะวิดีโออ้าง remote render เดิมและไม่ส่ง create ใหม่

หน้า **Creative Media → ประวัติงานภาพและวิดีโอ** ให้เจ้าของเลือก Global หรือโปรเจกต์ที่ลงทะเบียนไว้ เพื่อดูงานของ clients ในพื้นที่นั้นและกู้การบันทึกผลหรือหยุดติดตามผ่าน owner session ได้ การเลือกโปรเจกต์ตรวจสิทธิ์และสถานะโปรเจกต์อีกครั้ง ส่วน MCP ยังคงเห็นเฉพาะงานของผู้เรียกเอง

หากแชตทำ `jobId` หาย ใช้ `creative_jobs` เพื่อดูงานของผู้เรียกเอง หรือค้นด้วย `idempotencyKey` เดิม ผลไม่เปิดเผยงานของ client อื่น ตัวอย่าง Compact/Hybrid:

```text
dodo_media(operation="creative_jobs",args={limit:25,idempotencyKey:"chat-image-0001"})
dodo_media(operation="creative_job_control",args={jobId:"creative_…",action:"retry_save"})
```

`retry_save` ทำเฉพาะการบันทึก/เชื่อมผลที่สร้างเสร็จแล้ว ไม่เรียกสร้างภาพหรือ render วิดีโอใหม่ ระบบเก็บผลชั่วคราวและตรวจ provenance/hash เพื่อซ่อม receipt หลังการบันทึกล้มหรือรีสตาร์ตได้ ควรตรวจงานเดิมก่อนตัดสินใจสร้างใหม่

`stop_tracking` หยุดการติดตามหรือการรอในเครื่อง ไม่ใช่หลักฐานว่า provider ยกเลิก render หรือคืนเงิน งานที่ส่งออกไปแล้วอาจยังใช้เครดิตได้

งานที่ยังไม่จบจะไม่ถูกลบเพียงเพราะครบ 24 ชั่วโมง ประวัติงานที่จบแล้วมี retention แยกจาก active jobs และ resource มี `expiresAt` ของตัวเอง จำนวนงาน completed/failed ไม่ใช่เพดานสร้างงาน 32 ครั้งต่อวัน ระบบตรวจและจองช่องผลลัพธ์/งบเก็บข้อมูลก่อนส่งคำขอเสียเงิน พร้อมตรวจสถานะ remote jobs ที่ค้างก่อนแจ้งว่าคิวเต็ม

Token ที่ใช้ส่งคำขอหมดอายุระหว่าง render ไม่ทำให้ทิ้งผลที่ได้รับแล้ว ผู้เรียกใช้ token ใหม่เพื่อรับผลงานเดิมได้ การเพิกถอน grant/client หรือสิทธิ์ปัจจุบันยังถูกตรวจและไม่ทำให้ผู้ที่ถูกเพิกถอนเข้าถึงผลได้

การเปลี่ยนชื่อ connection หรือโมเดลเริ่มต้นสำหรับงานใหม่ไม่บล็อกการรับผลวิดีโอเดิม งานยังผูกกับ transport/บัญชีและโมเดลจริงของตัวเอง การเปลี่ยน endpoint/protocol/account ต้องตรวจแยก ไม่ส่งคีย์เดิมไปปลายทางใหม่

### ตรวจเหตุที่งานไม่พร้อมหรือล้ม

`multimodal_status` คืน `serverVersion`, readiness และ `blockers`/`videoBlockers` เช่น connection หายหรือปิด, credential หาย/ต้องกรอกใหม่, protocol ไม่รองรับ หรือ scope ไม่พอ สถานะนี้ตรวจการตั้งค่าในเครื่องและไม่เรียกสร้างภาพ

ใน Local Config ใช้ **ทดสอบการเชื่อมต่อ (ไม่สร้างภาพ)** เพื่อตรวจคีย์ผ่าน metadata API พร้อมจำนวนโมเดล เวลา และ latency ผลผ่านไม่ได้ยืนยันว่าสร้างภาพ/วิดีโอได้หรือมีเครดิต บาง provider ไม่เปิด model-list แต่ยังใช้ explicit Model ID ที่รองรับได้

งานที่ล้มมี `diagnostics` แบบจำกัดขนาดและกรองความลับ: HTTP status, provider code/message, request ID, retry-after, phase และผลลัพธ์ `rejected`/`not_sent`/`unknown` การปฏิเสธที่ชัดเจน เช่น quota/rate limit ใช้ `failed`; คำขอที่ส่งแล้วแต่ไม่ทราบผลยังใช้ `uncertain` ห้ามอนุมานว่าทุก 429 ของทุก provider รับรองว่าจะไม่คิดเงิน และห้ามสลับโมเดลเพื่อ retry งานเสียเงินเอง

### บันทึกตั้งค่าโดยไม่รีเซ็ตช่องอื่น

Owner `POST /api/ai/media` อัปเดตเฉพาะ field ที่ส่งมา Field ที่ขาดคงค่าเดิม; `connectionId:null` ล้างการเลือก connection อย่างชัดเจน การอ่าน state คืน `revision` และหน้าเว็บส่ง `expectedRevision` ทุกครั้ง หากแท็บอื่นบันทึกก่อน จะตอบ 409 ให้ refresh แทนเขียนทับ การ audit เก็บผู้เปลี่ยน revision และชื่อ field โดยไม่เก็บ API key/URL/ค่าลับ

รายการโมเดลโหลดหลายหน้าของ provider ได้สูงสุด 10 หน้า, 2,000 IDs และ 8 MiB ต่อการค้นชุดหนึ่ง; `creative_models`/owner models-page บอก `truncated` และจำนวนหน้าที่โหลดเมื่อยังไม่ครบ ID ที่ยาวหรือเป็น URL ถูกปฏิเสธแทนตัดเป็นชื่อที่ไม่มีจริง

## อ่านและบันทึกผล

ผลสร้างและครอปเข้า immutable Resource Layer/CAS พร้อม `resourceId`, MIME, byte count, `sha256` และ expiry ใช้ `resource_preview` เพื่อดูภาพย่อ หรือ `resource_read_range` เพื่ออ่านไบต์แบบแบ่งช่วงไม่เกิน 256 KiB พร้อม resume token ภาพย่อไม่ใช่ไฟล์ต้นฉบับ ส่วน MP4 ให้ใช้ไบต์ของ resource หรือบันทึกไฟล์เพื่อเล่น

`media_save` รับเฉพาะ PNG/MP4 ที่สร้างผ่านฟีเจอร์นี้ รวมถึง resource ของผู้เรียกที่สร้างแบบ global เมื่อต้องการเขียนลงโปรเจกต์ ให้รับ `workspaceId`/`workspaceEpoch` ของปลายทางจาก `project_overview` แล้วส่ง context นั้น ต้องมี `dodo:write` และ `dodo:exec`, ส่ง `expectedSha256` ของ resource และใช้ workspace-relative path ที่ลงท้าย `.png` หรือ `.mp4` หาก path มีไฟล์อยู่แล้ว ต้องส่ง `expectedHash` ของไฟล์เดิมด้วย ค่า hash ไม่ตรงจะไม่เขียนทับ

```text
dodo_media(
  workspaceId="…", workspaceEpoch="…",
  operation="media_save",
  args={
    resourceId:"res_…",
    expectedSha256:"sha256:…",
    path:"assets/generated.png",
    idempotencyKey:"save-generated-image-0001"
  }
)
```

การบันทึกใช้ mutation queue, plan/journal, expected hashes และ rollback เดิม พร้อม byte budget ของ installation ไฟล์สื่อที่ดาวน์โหลดได้ไม่ได้หมายความว่าจะเขียนลงโปรเจกต์ได้เสมอ: หากเกิน budget ให้ใช้ bounded range สำหรับนำไฟล์ออก หรือให้เจ้าของปรับ budget ตามงาน Recovery อัตโนมัติที่สำรองไม่ได้ยังทำงานแบบ best-effort ตาม [Recovery](RECOVERY.md)

เอกสารนี้อธิบาย contract ของ implementation ไม่ใช่หลักฐานว่าได้ทดสอบทุกโมเดลหรือ live provider แล้ว ดูผลตรวจรับที่ [Test report](TEST_REPORT.md)
