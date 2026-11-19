# Creative Media

DODO รองรับสร้างภาพ ครอป/แบ่งภาพเป็นตาราง และลบพื้นหลัง ตั้งค่าได้ทั้ง OpenAI ทางการ, Google Gemini ทางการ และบริการภายนอกที่ใช้รูปแบบ API ที่รองรับ OpenAI เป็นค่าเริ่มต้นที่แก้ไขได้ เจ้าของกรอกชื่อ provider, API Base URL, คีย์ และโมเดลใน Local Config ได้โดยตรง ส่วนวิดีโอมี adapter สำหรับปลายทางที่รองรับ create/status/content/edit/extend แบบเข้ากันได้ และเริ่มปิดไว้ เครื่องมือ MCP ไม่รับ URL, key, remote task ID หรือเปลี่ยนโมเดลเป็นรายคำขอ งานครอปทำในเครื่องโดยไม่เรียกโมเดล

ตรวจเอกสารทางการเมื่อ 17 พฤศจิกายน 2026: OpenAI ระบุว่า Sora 2 และ Videos API ปิดบริการเมื่อ 24 กันยายน 2026 และไม่มี API ทดแทนตรงตัว จึงไม่ตั้ง `sora-2` เป็นค่าเริ่มต้นหรือส่งวิดีโอไปที่ OpenAI โดยอัตโนมัติ ดู [ประกาศยุติบริการ](https://developers.openai.com/api/docs/deprecations#2026-03-24-sora-2-video-generation-models-and-videos-api) และ [คู่มือวิดีโอที่เก็บไว้เป็นประวัติ](https://developers.openai.com/api/docs/guides/video-generation)

## ตั้งค่า

1. เปิด Local Config แล้วไปที่ **Providers & Profiles → Creative Media**
2. เปิด **เพิ่ม / แก้ไข Provider สำหรับสร้างภาพ** เลือก preset OpenAI, Google Gemini หรือ Custom แล้วกรอกชื่อ connection, รูปแบบ API, API Base URL, คีย์ และ Model ID ตามบริการที่ใช้ ทุก preset เป็นค่าเริ่มต้นที่แก้ไขได้ ไม่บังคับ hostname ของงานภาพ
3. กด **บันทึก Provider สำหรับภาพ** แล้วเลือก **การเชื่อมต่อสำหรับงานสื่อ** โหลดโมเดลด้วย **โหลดโมเดลสำหรับภาพ** หรือพิมพ์ Model ID เอง การโหลดโมเดลเป็นคำขอตรวจการเชื่อมต่อ แยกจากการสร้างภาพจริง และไม่ได้รับรองว่าโมเดลทุกตัวในรายการสร้างภาพได้
4. เลือกโปรเจกต์ที่อนุญาต เปิดงานสร้างสื่อผ่าน AI แล้วกด **บันทึก Creative Media**
5. หากต้องการลบพื้นหลังหรือสร้างวิดีโอจากภาพอ้างอิง ให้เปิดอนุญาตส่งภาพที่เลือกด้วย
6. สำหรับวิดีโอ ให้เลือก connection ที่ตรวจแล้วว่ารองรับ video API เปิด `videoEnabled` และกรอก `videoModel` เอง ค่าเริ่มต้นคือปิดและโมเดลว่าง การเชื่อมต่อ OpenAI ทางการเปิดวิดีโอไม่ได้

ค่าเริ่มต้นปิดงานผ่าน AI และวิดีโอ, ไม่เลือก connection/โปรเจกต์ และไม่อนุญาตอัปโหลดภาพ การบันทึกตั้งค่าไม่เรียกโมเดลและไม่คิดว่าการเชื่อมต่อผ่านการทดสอบแล้ว งานสร้างสื่ออาจมีค่าใช้จ่ายและขึ้นกับสิทธิ์โมเดลของบัญชี Connection ที่สร้างจาก Creative Media ใช้ credential store เดียวกับ AI Providers และไม่ต้องสร้าง Agent Profile

เลือก connection แล้วกด **แก้ไข connection ที่เลือก** เพื่อเปลี่ยนชื่อ, URL, protocol, model หรือวิธีเก็บคีย์ ช่องคีย์ไม่เติมค่ากลับจาก server เว้นว่างได้เมื่อคง URL/protocol/storage เดิม หากเปลี่ยนค่าใดค่าหนึ่งในสามรายการนี้ต้องกรอกคีย์ใหม่ก่อนบันทึก ระบบไม่ส่งคีย์เดิมต่อไปยัง endpoint ใหม่

API Base URL ต้องจบที่ฐาน API เช่น `/v1` หรือ `/v1beta` ไม่ต่อ `/images/generations`, `/images/edits`, `/interactions` หรือ operation อื่น Public endpoint ต้องเป็น HTTPS; loopback/LAN ต้องอนุญาต private endpoint แยกต่างหาก ระบบตรวจ DNS และไม่ตาม redirect พร้อม credentials ไม่มี provider ทดสอบส่วนตัวหรือคีย์ตัวอย่างจริงฝังใน preset

Session key อยู่ในหน่วยความจำ: ต้องกรอกใหม่หลัง DODO รีสตาร์ต ส่วน macOS Keychain ใช้เก็บคีย์ข้ามรอบได้ การตั้งค่าโมเดล/โปรเจกต์ยังอยู่ใน private state เมื่อไม่มีคีย์ ระบบรายงานข้อผิดพลาดโดยไม่เปลี่ยนไปใช้ connection อื่นเอง ใน managed mode เจ้าของต้องอนุญาต client ในสิทธิ์ AI ของโปรเจกต์ด้วย

หากการบันทึกคีย์และ connection ไม่สำเร็จครบ ระบบจะพักการใช้ connection นั้นและขอให้กรอกคีย์ใหม่ แม้รีสตาร์ตแล้วก็จะไม่ส่งคีย์ที่อาจจับคู่กับ URL ผิดออกไป เมื่อยืนยัน URL/protocol/storage และบันทึกคีย์ใหม่สำเร็จจึงใช้งานต่อได้

## รูปแบบ API สำหรับภาพ

| Preset / รูปแบบ | ค่าเริ่มต้น | วิธีส่งคำขอ |
|---|---|---|
| OpenAI / OpenAI-compatible Images | `https://api.openai.com/v1` · `gpt-image-2.5-flare` | `POST /images/generations`, multipart `POST /images/edits`; Bearer key |
| Google Gemini / Gemini Interactions | `https://generativelanguage.googleapis.com/v1beta` · `gemini-nano-banana-2.1` | `POST /interactions`; `x-goog-api-key`, inline PNG |
| Custom / API ภายนอก | เจ้าของกรอก URL และ Model ID | เลือกรูปแบบ OpenAI-compatible Images หรือ Gemini Interactions ให้ตรงกับปลายทาง |

เลือกรูปแบบตาม API ที่บริการนั้นรับจริง ไม่เดาจากชื่อ provider หรือชื่อโมเดล ตัวอย่างเช่น gateway ที่ให้โมเดล Gemini ผ่าน `/images/generations` ต้องเลือก OpenAI-compatible Images ส่วน Gemini native ใช้ Interactions โหลดรายชื่อ Gemini แล้วระบบตัด `models/` ออกจากชื่อ resource เพื่อใช้เป็น Model ID

อ่านรูปแบบและข้อจำกัดจาก [OpenAI image generation](https://developers.openai.com/api/docs/guides/image-generation) และ [Google Gemini image generation](https://aistudio.google.com/docs/image-generation) การรองรับวิดีโอต้องตรวจจากปลายทางที่เลือกเอง Gemini image protocol ไม่ถือว่ารองรับ video compatibility เอกสาร OpenAI Videos API เป็นข้อมูลรูปแบบเดิม ไม่ใช่การรับรองว่าปลายทางนั้นยังเปิดบริการ

## เครื่องมือ

| Operation | ผลลัพธ์ |
|---|---|
| `image_generate` | สร้างภาพจาก `prompt` แล้วคืน `jobId` สำหรับอ่านผล PNG |
| `image_crop` | ครอป 1–16 บริเวณด้วย `regions` หรือแบ่งเป็น `grid` แล้วคืน PNG resources ทันที |
| `image_remove_background` | ส่งภาพที่เลือกเพื่อแยกวัตถุหลักบนพื้นโปร่งใส แล้วคืน `jobId` |
| `video_generate` | สร้างวิดีโอจากข้อความ พร้อมภาพอ้างอิงที่เลือกได้ แล้วคืน `jobId` |
| `video_edit` | สร้างงานแก้ไขวิดีโอจาก `jobId` ที่เสร็จแล้วของผู้เรียก โดยส่งคำสั่งใหม่ |
| `video_extend` | สร้างงานต่อวิดีโอจาก `jobId` ที่เสร็จแล้วของผู้เรียก พร้อมข้อความและระยะเวลาที่เลือก |
| `creative_job` | อ่านสถานะและรับ resource ของงานเดิม โดยไม่เริ่มสร้างใหม่ |
| `media_save` | บันทึก resource ที่สร้างแล้วลงโปรเจกต์ ผ่าน hash checks และ journal/rollback เดิม |

Full surface มีเครื่องมือรายตัว ส่วน Compact/Hybrid ใช้ operations เดียวกันผ่าน `dodo_media` ตรวจ schema ล่าสุดด้วย `dodo_discover` และรับ `workspaceId`/`workspaceEpoch` จาก `project_overview` ก่อนเรียก ไม่มีเครื่องมือสร้างโมเดล 3D ในฟีเจอร์นี้

งานสร้างภาพใช้ขนาด `1024x1024`, `1536x1024`, `1024x1536` หรือ `auto` รูปแบบ OpenAI ส่ง size/quality/background ตามที่เลือก ส่วน Gemini native รองรับ `quality=auto` และขอภาพระดับ `1K` โดยแปลง size เป็นอัตราส่วน `1:1`, `3:2`, `2:3` หรือปล่อยอัตโนมัติ ขนาด PNG ที่โมเดลคืนมาอาจต่างจากจำนวนพิกเซลใน size; metadata ของผลลัพธ์เป็นขนาดจริง Adapter สร้างวิดีโอรองรับ `1280x720`/`720x1280` และ 4, 8, 12, 16 หรือ 20 วินาทีตามปลายทาง ไม่มีการเปลี่ยนโมเดลหรือเรียกสร้างใหม่เพื่อเลี่ยงข้อผิดพลาดเอง

OpenAI-compatible Images ต้องคืน PNG แบบ `b64_json`; Gemini ต้องคืน inline base64 PNG จาก Interactions ไม่ดาวน์โหลดภาพจาก URL ที่ปลายทางส่งกลับ ไม่ตาม redirect และไม่ส่ง credentials ต่อไปยัง URL อื่น การตั้งค่าผ่านหรือการที่ text chat ใช้ได้ไม่รับรอง operation ภาพ/วิดีโอ หากรูปแบบไม่รองรับจะรายงานปัญหาโดยไม่ส่งงานซ้ำ การตรวจรับ Google Gemini native ใช้ protocol fixtures และยังไม่มี live acceptance ด้วยคีย์ทางการในการตรวจรับครั้งนี้ ดู [Test report](TEST_REPORT.md)

## ครอปและลบพื้นหลัง

`image_crop` และ `image_remove_background` รับต้นฉบับอย่างใดอย่างหนึ่ง: workspace `path`, `assetId` ของภาพที่ผู้เรียกเป็นเจ้าของ หรือ `resourceId` ของภาพที่ผู้เรียกเข้าถึงได้ Path ยังผ่าน workspace, secret และ regular-file guards เดิม

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

เมื่อเปิด video compatibility แล้ว `video_generate` รับ `reference` แบบ `{path:"assets/reference.png"}`, `{assetId:"asset_…"}` หรือ `{resourceId:"res_…"}` ได้หนึ่งต้นฉบับ ภาพยังผ่าน path/secret/ownership guards และต้องได้รับอนุญาตอัปโหลด ระบบแปลงเป็น PNG ก่อนส่งและตรวจว่าขนาดตรงกับ `size` ที่ขอ เช่น `1280x720` โดยไม่ย่อหรือครอปให้อัตโนมัติ

`video_edit` และ `video_extend` รับ `jobId` ของวิดีโอที่เสร็จแล้วใน workspace และเป็นของผู้เรียกเดียวกัน พร้อม `prompt` และ `idempotencyKey` ส่วน extend รับ `seconds` ตาม schema ด้วย ต้นฉบับต้องมี remote handle ที่บันทึกไว้และใช้ connection/configuration เดิม ระบบไม่รับ remote URL หรือ ID ที่ผู้เรียกกรอกเอง แต่ละ operation สร้างงานลูกใหม่ ไม่แก้ receipt หรือไฟล์ต้นฉบับ

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

ส่งงานสร้างหนึ่งครั้งต่อหนึ่ง `idempotencyKey` หาก response หายขณะ context เดิมยังใช้ได้ ให้เรียกด้วย key และ args เดิมเพื่อรับ receipt เดิม อย่าสร้าง key ใหม่เพียงเพื่อตรวจความคืบหน้า ไม่มี automatic retry ของงานที่อาจคิดเครดิต และไม่มีการ polling วิดีโอเบื้องหลัง การเรียก `creative_job` สำหรับวิดีโออ่านสถานะ/เนื้อหาของ remote render เดิมเท่านั้น

Job metadata เก็บใน private SQLite แยก workspace และผู้เรียก มีอายุ 24 ชั่วโมงนับจากส่งงาน Resource มี `expiresAt` ของตัวเอง หลังรีสตาร์ตให้รับ workspace epoch ใหม่แล้วตรวจ `creative_job` เดิม:

- งานที่ยังไม่มี remote video ID และค้างอยู่จะเป็น `interrupted` โดยไม่ส่งสร้างซ้ำ
- วิดีโอที่บันทึก remote ID แล้วสามารถขอสถานะเดิมได้เมื่อผู้เรียกยังมีสิทธิ์, คีย์พร้อม และ connection/model configuration ตรงเดิม
- งานที่ส่งออกแล้วแต่ผลไม่แน่นอนอาจเป็น `uncertain` ซึ่งอาจใช้เครดิตไปแล้ว ต้องตรวจงานก่อนเริ่มงานใหม่

การตัดการเชื่อมต่อของ client ไม่ใช่การยกเลิก billing ของคำขอที่ส่งแล้ว การเปลี่ยนสิทธิ์/โปรเจกต์/connection ถูกตรวจใหม่ก่อนส่งคำขอหรือเผยแพร่ผลที่สร้างเสร็จ

## อ่านและบันทึกผล

ผลสร้างและครอปเข้า immutable Resource Layer/CAS พร้อม `resourceId`, MIME, byte count, `sha256` และ expiry ใช้ `resource_preview` เพื่อดูภาพย่อ หรือ `resource_read_range` เพื่ออ่านไบต์แบบแบ่งช่วงไม่เกิน 256 KiB พร้อม resume token ภาพย่อไม่ใช่ไฟล์ต้นฉบับ ส่วน MP4 ให้ใช้ไบต์ของ resource หรือบันทึกไฟล์เพื่อเล่น

`media_save` รับเฉพาะ PNG/MP4 ที่สร้างผ่านฟีเจอร์นี้ ต้องมี `dodo:write` และ `dodo:exec`, ส่ง `expectedSha256` ของ resource และใช้ workspace-relative path ที่ลงท้าย `.png` หรือ `.mp4` หาก path มีไฟล์อยู่แล้ว ต้องส่ง `expectedHash` ของไฟล์เดิมด้วย ค่า hash ไม่ตรงจะไม่เขียนทับ

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
