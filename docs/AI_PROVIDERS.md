# AI Providers, Sub-agents และหลายโปรเจกต์

DODO MCP 1.7.0 สามารถเปิด runtime ของหลายโปรเจกต์ใน process เดียว และเรียกโมเดลจาก backend ผ่าน connection/profile ที่เจ้าของเลือกได้ ค่าเริ่มต้นเป็นโหมดส่วนตัว: เพิ่มโปรเจกต์, connection และ profile แล้วใช้งานได้ทันทีโดยไม่ต้องทำ allowlist ซ้ำ

## เริ่มใช้งานผ่านเว็บ

1. เปิด `dodo start` หรือ `dodo --cli` แล้วเข้า Local Config จาก URL ส่วนตัวที่ terminal แสดง ใช้หน้าเว็บ loopback เท่านั้น หน้า "ภาพรวม" แสดงขั้นตอนถัดไป (เพิ่มโปรเจกต์ → เพิ่ม Provider → สร้าง Profile → เริ่มงาน) พร้อมสถานะและรายการที่ต้องตรวจสอบ
2. หน้า "โปรเจกต์": เพิ่ม absolute path ของ A/B แล้วพร้อมใช้ทันที การเลือกดู B ไม่เปลี่ยน default และไม่หยุด A
3. หน้า "Providers & Profiles" (ส่วน AI Providers): เลือก preset หรือ Custom, protocol, Base URL และกรอก key เลือก Env ถาวรในเครื่องที่รัน DODO, เฉพาะรอบนี้ หรือ macOS Keychain ตามที่เซิร์ฟเวอร์รองรับ ฟอร์มใหม่เลือก Env ส่วน Ollama ที่ไม่ใช้คีย์เลือก Session ปุ่มบันทึกตรวจรูปแบบ/endpoint policy และแสดงสถานะบันทึกพร้อมเวลา; ปุ่มรายชื่อโมเดลเป็น credential test แยกจากการทดสอบ inference ผลบอกชื่อ connection, เวลา และเมื่อพลาดจะระบุว่าไม่ retry อัตโนมัติ
4. หน้าเดียวกัน (ส่วน Agent Profiles): เลือกประเภท Coding/Review/Research, connection และ
   Model ID แล้วกด **สร้าง Agent** ได้เลย รายชื่อโมเดลที่โหลดจาก Provider จะปรากฏใน
   Agent form อัตโนมัติ ถ้า endpoint ไม่รองรับ model-list ให้พิมพ์ Model ID เอง ส่วน scopes,
   tool calling, image input, token budgets และราคาอยู่ใน **ตั้งค่าขั้นสูง**
5. หากเป็น installation ที่แชร์หลาย client ให้เปลี่ยน Settings เป็น managed แล้วกำหนด trust, project ACL, profile/client allowlist และ source egress ต่อโปรเจกต์ (การสลับโหมดมีกล่องยืนยันเสมอ) ในโหมดส่วนตัว ฟอร์มสิทธิ์รายโปรเจกต์ถูกซ่อนและแทนด้วยโน้ตสั้นพร้อม tooltip
6. ปุ่มทดสอบ inference/tool calling ส่งข้อมูลสังเคราะห์และอาจมีค่าใช้จ่าย ต้องยืนยันผ่านกล่อง warning ก่อนทุกครั้ง (ค่าใช้จ่ายที่ไม่ทราบแสดงว่า "ไม่ทราบ" ไม่ใช่ศูนย์) ระหว่างทดสอบมี loading modal และปุ่มถูกปิดกันส่งซ้ำ; ผลระบุชื่อ connection, Model ID, ชนิดการทดสอบ และเวลา ผลเก่าไม่รับรองค่าที่เปลี่ยนภายหลัง เมื่อพลาดจะแสดงทั้ง inline และ modal พร้อมข้อความว่าไม่ retry อัตโนมัติ โมเดลที่เปิด tool calling เองแต่ยังไม่ทดสอบยังไม่ถือว่า live coding integration ผ่าน
7. หน้า "Chat & Tasks": เลือกโปรเจกต์/profile ระบุงาน ส่งงานหนึ่งครั้ง (มี idempotency key กันงานซ้ำเมื่อ reconnect) แล้วดู "Runs & Jobs" แสดงสถานะอ่านง่าย ข้อความ, tool receipts และผล jobs อยู่ใน details ที่พับได้ การยกเลิก/ลบประวัติต้องยืนยันก่อน

ประวัติแสดงผลที่มองเห็นได้และหลักฐาน ไม่แสดง raw reasoning/continuation ของ provider หากติด approval ให้อ่านคำขอของ operation เป้าหมายและอนุมัติผ่าน owner controls จากนั้น Resume ด้วยผู้เรียกเดิม การกด Resume ไม่ขยาย scopes หรือ trust

## สร้างภาพและวิดีโอผ่าน Creative Media

ส่วน **Providers & Profiles → Creative Media** ใช้ connection/credential store เดียวกัน แต่เลือกโมเดลงานภาพและวิดีโอแยกจาก Agent Profile ไม่ต้องสร้าง profile เพื่อเรียกเครื่องมือสื่อ ฟอร์ม **เพิ่ม / แก้ไข Provider สำหรับสร้างภาพ** รับชื่อ, รูปแบบ API, Base URL และ key โดยตรง มี preset OpenAI, Google Gemini และ Custom ที่แก้ไขได้ ค่าเริ่มต้น provider ยังเป็น OpenAI (`https://api.openai.com/v1`) ส่วนโมเดลของ config/preset ใหม่เป็น **Auto** บันทึก Custom ได้โดยไม่ต้องกรอก Model ID ก่อน และไม่เปลี่ยนโมเดลที่เคยบันทึกเอง วิดีโอมี `videoEnabled:false` และ `videoModel` ว่างจนเจ้าของตั้งค่าเอง

งานสร้างสื่อผ่าน AI เริ่มปิดไว้ ต้องเปิดและเลือกโปรเจกต์ที่อนุญาตก่อน วิดีโอต้องเปิดเพิ่มสำหรับ connection ที่รองรับ การส่งภาพไปลบพื้นหลังหรือเป็นภาพอ้างอิงวิดีโอต้องเปิด image-upload permission เพิ่ม ส่วนครอป PNG/แบ่ง grid ทำในเครื่องได้โดยไม่มีคีย์ ใน managed mode ใช้ client allowlist ของสิทธิ์ AI รายโปรเจกต์ด้วย การบันทึกตั้งค่าไม่เรียกโมเดลหรือทดสอบ inference คีย์แบบ Env ที่ DODO เก็บจะใช้ข้ามรีสตาร์ตได้ ส่วน Session ต้องใส่ใหม่

Creative Media ใช้ OpenAI-compatible Images API กับ connections แบบ Responses/Chat Completions หรือ Gemini native Interactions ตาม protocol ที่เจ้าของเลือก ชื่อ provider เป็นป้ายชื่อ ไม่จำกัด protocol ของงานภาพ หน้าเว็บโหลดรายการโมเดลอัตโนมัติเมื่อเปิด/เปลี่ยน/บันทึก connection และมีปุ่มโหลดใหม่หรือกรอก ID เองเป็นทางเลือก ข้อผิดพลาดในการโหลดไม่บล็อกฟอร์ม ชื่อ resource ของ Gemini จะตัด `models/` ก่อนใช้เป็น Model ID แต่การมีชื่อในรายการไม่รับรองว่าโมเดลนั้นสร้างภาพได้ เครื่องมือ MCP ไม่รับ URL/key/model/remote task ID และไม่มี fallback เปลี่ยน provider อัตโนมัติ

Auto สำหรับงานภาพขอรายการโมเดลใหม่จาก connection เดิม เลือก image model ที่รู้จักและอยู่ในรายการ แล้วส่งการสร้าง/แก้ภาพหนึ่งครั้ง ผล `creative_job.model` เป็น ID ที่เลือกจริง ไม่ส่ง `auto` ไปยัง provider ไม่เดาใช้ text/video model และไม่ retry งานเสียเงินด้วยโมเดลอื่นเมื่อผิดพลาด ถ้ารายการไม่มีโมเดลที่รู้จักหรือ model-list ใช้ไม่ได้ ต้องเลือก ID เอง การโหลดรายการใน UI ไม่สร้างภาพ

Gemini native ใช้ `quality=auto`, ขอภาพ `1K` และแปลง size ที่เลือกเป็น aspect ratio; metadata แสดงขนาดภาพจริง คำขอ OpenAI-compatible ส่งตัวเลือกตาม Images API แต่ไม่รับรองว่าทุกบริการรองรับทุก quality/background การลบพื้นหลังยังต้องผ่านการตรวจ transparency จริง และ native Gemini ไม่ได้เปิด video compatibility ดู [Creative Media](CREATIVE_MEDIA.md), [OpenAI Images](https://developers.openai.com/api/docs/guides/image-generation) และ [Gemini Images](https://aistudio.google.com/docs/image-generation)

OpenAI ระบุว่า Sora 2 และ Videos API ยุติบริการเมื่อ 24 กันยายน 2026 และไม่มี API ทดแทนตรงตัว ระบบจึงปฏิเสธการเปิดวิดีโอกับ `api.openai.com` และไม่ตั้ง `sora-2` ให้อัตโนมัติ ดู [ประกาศยุติบริการ](https://developers.openai.com/api/docs/deprecations#2026-03-24-sora-2-video-generation-models-and-videos-api)

ผลภาพ/วิดีโอเป็น immutable resource ซึ่งใช้ `download_link_create` เพื่อแชร์ URL แบบ token บน HTTP origin ของ DODO ได้ เลือกอายุ 1, 2, 7, 14 หรือ 30 วัน และยกเลิกด้วย `download_link_revoke` ไม่ส่งไฟล์ให้ AI provider เพิ่มและไม่ใช้ API key ในลิงก์ ผู้ที่มี URL ดาวน์โหลดได้จนหมดอายุ/ถูกถอนสิทธิ์ จึงต้องเก็บ URL เป็นความลับ ส่วน `download_link_list` คืนเฉพาะ metadata ไม่มี token/URL ดู [คู่มือ download links](RESOURCES.md#temporary-token-download-links) ฟีเจอร์นี้แยกจาก connection/model settings และต้องมี HTTP server ที่ให้บริการไฟล์ได้

## Protocols

| Preset | Protocol | Base URL เริ่มต้น |
|---|---|---|
| OpenAI / GPT | Responses | `https://api.openai.com/v1` |
| Gemini | Native Interactions | `https://generativelanguage.googleapis.com/v1beta` |
| Claude | Anthropic Messages | `https://api.anthropic.com/v1` |
| MiniMax | Anthropic-compatible | `https://api.minimax.io/anthropic/v1` |
| GLM / Z.AI | Chat Completions | `https://api.z.ai/api/paas/v4` |
| Kimi | Chat Completions | `https://api.moonshot.ai/v1` |
| Ollama | Native Chat | `http://127.0.0.1:11434/api` |

Custom เลือก protocol ได้ทั้งห้าแบบและสร้างหลาย connection ของค่ายเดียวกันได้ ไม่มี fallback เปลี่ยน endpoint/provider อัตโนมัติ รายชื่อโมเดลขึ้นอยู่กับ endpoint; ถ้าไม่รองรับให้กรอก Model ID เอง ไม่รับประกันว่า model ทุกตัวรองรับ tool calling/ภาพหรือ token limits เท่ากัน

Adapter เก็บ call IDs และ continuation ของ protocol รวมถึง Anthropic thinking signatures, Gemini steps, Responses encrypted reasoning และ Chat/Ollama continuation แบบ private เพื่อส่งผล tools รอบถัดไปอย่างถูกต้อง Responses ใช้ `store:false` และ encrypted reasoning include; Gemini ใช้ `store:false` การตั้งนี้ไม่เปลี่ยนนโยบาย retention ทั้งหมดของผู้ให้บริการ

เอกสาร protocol: [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling), [Gemini Interactions](https://ai.google.dev/gemini-api/docs/interactions-overview), [Anthropic tools](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview), [MiniMax compatibility](https://platform.minimax.io/docs/api-reference/text-anthropic-api), [GLM compatibility](https://docs.z.ai/guides/develop/openai/python), [Kimi API](https://platform.kimi.ai/docs/api/overview), [Ollama Chat](https://docs.ollama.com/api/chat)

Ollama loopback อาจเรียก cloud model ได้ ต้องเลือก inference location และใช้ปุ่มตรวจ metadata ไม่ติดป้ายว่า local จาก hostname เพียงอย่างเดียว การตรวจเป็นหลักฐานที่ endpoint รายงาน ไม่ใช่ OS network sandbox ดู [Ollama Cloud](https://docs.ollama.com/cloud)

## Credential และ endpoint

| วิธีเก็บ | ข้ามรีสตาร์ต | ที่เก็บ |
|---|---|---|
| Env ถาวรในเครื่องที่รัน DODO | ได้ เมื่อเก็บคีย์กับ DODO หรือ provision Env ภายนอกให้ process ทุกครั้ง | ไฟล์ Env ส่วนตัวใต้ `DODO_CONFIG_DIR/credentials/ai` หรือชื่อตัวแปรของเซิร์ฟเวอร์ที่เจ้าของระบุ |
| Session | ไม่ได้ | หน่วยความจำของ DODO process |
| macOS Keychain | ได้ | คลังคีย์ของ macOS บนเครื่องเซิร์ฟเวอร์ |

Env ใช้ได้บน Windows, Linux และ macOS โดยกรอก API Key ในฟอร์มและเลือก Env ระบบจะสร้างชื่อตัวแปรให้เองเมื่อเว้นชื่อว่าง เก็บคีย์แยกต่อ connection และอ่านกลับหลังเปิด DODO ใหม่ ไฟล์เก็บค่าเป็นข้อความ ไม่ใช่ OS vault; DODO จำกัดสิทธิ์ด้วย owner-only directory/file permissions บน POSIX (0700/0600) และ private ACL บน Windows ไฟล์อยู่นอกโปรเจกต์และไม่เขียน shell profile, Windows registry หรือ Env ทั้งเครื่อง ไม่ส่งค่าที่บันทึกไปเป็น environment ของ child jobs

ถ้ามี Env ที่ provision ไว้บนเครื่องเซิร์ฟเวอร์อยู่แล้ว ให้สร้าง connection แบบ Env ระบุ `credentialEnvVar` และเว้น API Key ว่าง DODO จะอ่าน inherited environment ของ process เมื่อยังไม่มีไฟล์ของ connection นั้น ชื่อต้องเป็น A–Z, 0–9 และ `_` จำนวน 3–128 ตัว เริ่มด้วยตัวอักษร และไม่ใช้ตัวแปร OS/loader สำคัญ เช่น `PATH` หรือ `NODE_OPTIONS` ตัวแปรที่ตั้งในเครื่องเบราว์เซอร์จะไม่มีผลต่อเซิร์ฟเวอร์อีกเครื่อง

ไฟล์ที่ DODO เก็บเองมีลำดับก่อนตัวแปรภายนอกเสมอ หากไฟล์มีปัญหา อ่านไม่ได้ หรือชื่อไม่ตรง จะหยุดและให้เจ้าของแก้ไขแทนการสลับไปอ่านแหล่งอื่น การเปลี่ยนค่า Env ภายนอกไม่เปลี่ยนคีย์ที่อนุญาตโดยอัตโนมัติ: กลับมาแก้ connection เดิม ยืนยัน endpoint/reference และบันทึกใหม่ก่อนเรียก API การกรอกคีย์ใหม่ใน UI จะเขียนไฟล์ส่วนตัวและเปลี่ยนไปใช้ค่าที่บันทึกนั้น การลบ connection ลบเฉพาะไฟล์ที่ DODO เป็นเจ้าของ ไม่ unset ตัวแปรภายนอก

ฟอร์มใหม่เลือก Env เมื่อเซิร์ฟเวอร์รองรับ ส่วน connection เดิมไม่เปลี่ยนวิธีเก็บ และ Provider API ยังคง `credentialStorage:'session'` เป็นค่าเริ่มต้นเมื่อไม่ได้ระบุ Keychain เปิดได้เฉพาะเซิร์ฟเวอร์ macOS แม้เปิดหน้าเว็บจากระบบอื่น และอาจมีหน้าต่างระบบให้เจ้าของอนุญาต

- State DB เก็บ credential reference/สถานะและ fingerprint สำหรับผูกคีย์กับ connection ส่วนไฟล์ Env เก็บค่าคีย์ ไม่ส่ง key กลับมาเติม UI ไม่มี key ใน repo, localStorage, URL, logs หรือ process arguments
- เปลี่ยน endpoint/protocol/storage/ชื่อตัวแปร Env ต้องกรอก key ใหม่ ไม่มีการส่ง key เดิมไปปลายทางใหม่ การแก้ connection ที่มี run ใช้อยู่ถูกปฏิเสธจนหยุด/จบงาน
- Public ใช้ HTTPS; loopback/LAN ต้องเลือกอนุญาต private endpoint ชัดเจน DNS ถูกตรวจทุก address แล้ว pin socket; ไม่ตาม redirect, metadata/link-local และ DODO MCP/admin ports ถูกปฏิเสธ
- การอนุญาต AI provider แยกจาก `allowWebFetch` และไม่เปิด Desktop/microphone/system audio หรือเปลี่ยน tunnel token ให้ persistent
- หน้าเว็บใช้ owner authentication เดิม; loopback ไม่ถือเป็น authentication ด้วยตัวเอง Public MCP ไม่มี admin routes

## MCP หลายโปรเจกต์

Full มีเครื่องมือรายตัว ส่วน Compact/Hybrid ใช้ gateways เดิม ตรวจ catalog/schema ของ build ที่รันด้วย `dodo_discover` ก่อนเรียก

```text
project_overview()
  → รายชื่อ projects ที่ caller ได้รับอนุญาต
project_overview(targetProjectId="prj_…")
  → workspaceId, workspaceEpoch และ ai.profiles ของเป้าหมาย

dodo_write(
  targetProjectId="prj_…",
  workspaceId="…", workspaceEpoch="…",
  operation="write_file",
  args={path:"example.txt", content:"alpha"}
)
```

`targetProjectId` เป็น optional สำหรับ Full tools และ Compact gateways ไม่ส่งหมายถึง default เดิม Scope/ACL/context ตรวจหลังเลือก target; OAuth identity ยังต้องมีอายุ, audience และ live grant ถูกต้อง Root-bound grants เดิมใช้ข้าม workspace ไม่ได้ `projectId/projectIds` ของ read federation เดิมยังเป็น read-only และห้ามผสมกับ target routing แบบกำกวม ห้ามใส่ target/context ซ้ำใน gateway args

## Sub-agent contract

Sub-agent ยังพร้อมใช้จากหน้า Local Config → Chat & Tasks เสมอ ส่วน MCP clients จะไม่
เห็น operations กลุ่มนี้โดยค่าเริ่มต้น เจ้าของเปิดได้ที่ **Settings → Sub-agent tools
ใน MCP** แล้ว restart DODO และ rescan/recreate MCP app เมื่อเปิด Full live catalog
จะเพิ่มสี่ tools ด้านล่าง ส่วน Compact/Hybrid ใช้ชื่อ gateways เดิม แต่ operation enum
และ `dodo_discover` จะมีสี่ operations นี้เฉพาะเมื่อเปิดเท่านั้น

```text
dodo_discover(operation="subagent_spawn")
dodo_assist_change(
  targetProjectId="prj_…", workspaceId="…", workspaceEpoch="…",
  operation="subagent_spawn",
  args={profileId:"profile_…",task:"แก้ฟังก์ชันและรัน test",idempotencyKey:"task-unique-0001"}
)
  → run ID

dodo_assist_read(operation="subagent_status", args={runId:"…"}, …context)
dodo_assist_read(operation="subagent_result", args={runId:"…",after:0}, …context)
dodo_assist_change(operation="subagent_control", args={runId:"…",action:"pause|resume|cancel"}, …context)
```

ตรวจชื่อ fields จาก `dodo_discover` ก่อนเรียก ผล result มี receipts แบบแบ่งหน้าและ `nextEventCursor` การ retry spawn ด้วย key/args เดิมได้ run เดิม key เดิมกับงานใหม่ถูกปฏิเสธ

Spawn ต้องมี `dodo:exec` และ profile ลดสิทธิ์จาก caller ได้เท่านั้น โหมดส่วนตัวถือว่าการลงทะเบียน project และการเลือก remote profile เป็น owner consent สำหรับ project access/source egress; โหมด managed ยังบังคับ project ACL และ profile/provider permission แยกกัน Child run ผูกหนึ่ง project ไม่เรียก agent ซ้อนหรือ owner controls และทุก model tool call ยังตรวจ original schema, live grant, epoch, expected hash, secret/path guards, sandbox และ output contract

ค่าเริ่มต้นพร้อมกัน 4 runs ทั้งเครื่อง, 2 ต่อ project, 1 ต่อ Ollama connection, queue 32; profile สูงสุด 20 model calls/50 tool actions/30 นาที ตั้ง input/output budget ตามโมเดล (เริ่ม 64,000/4,096) Input ใช้ UTF-8 byte bound แบบ conservative พร้อม image allowance ไม่ใช่ tokenizer ของทุกค่าย หากไม่มีข้อมูล usage/ราคา ค่าใช้จ่ายแสดง “ไม่ทราบ” ราคาที่กรอกเป็น estimate ไม่ใช่ billing guarantee

## Queue, pause และ recovery

Direct MCP, agent และ schedule ที่อาจแก้ไฟล์ใช้ mutation queue เดียวต่อโปรเจกต์ คำสั่ง shell/exec ถือคิวจน process จบ Read ยังขนานได้ คนละโปรเจกต์มี services/epoch/jobs แยกกันและไม่ใช้ `process.chdir()` คิวไม่ป้องกันโปรแกรมภายนอก จึงยังตรวจ expected hash ตอนถึงคิว และ workspace guard ไม่ใช่ OS sandbox

Pause หยุดขั้นถัดไป; job ที่เริ่มไปแล้วอาจทำต่อจนจบ Cancel พยายามหยุดเฉพาะ job ของ run นั้น ไม่ rollback ผลที่เกิดแล้วโดยอัตโนมัติ ทั้งสองอย่างไม่รับประกันยกเลิก provider billing สำหรับ request ที่ส่งไปแล้ว

History เก็บใน private SQLite แยก project/caller ไม่เป็น approved memory อัตโนมัติ ค้นหา/ลบ terminal runs และตั้ง retention ได้ Run events ส่งด้วย authenticated fetch + cursor; reconnect ไม่สร้างงานใหม่และไม่มี token ใน URL ปิด browser แล้วงานยังทำต่อเมื่อ DODO เปิดอยู่

หลัง DODO restart งานค้างเป็น `interrupted` ต้อง Resume ด้วยสิทธิ์ใหม่จาก caller เดิม หากผล inference/action ไม่แน่นอนจะบล็อก Resume และให้ตรวจ receipts ก่อนสร้างงานใหม่ ไม่ replay side effect เงียบ ๆ OAuth token ไม่ถูกเก็บเพื่อใช้ต่อถาวร delegation lease มีเพดาน 30 นาที; หมดอายุรอ authentication ใหม่ Revoke หยุดขั้นถัดไปโดยไม่ให้ owner Resume เป็นสิทธิ์ที่กว้างกว่า caller เดิม

## ข้อจำกัดและการตรวจรับ

- Runtime พร้อมใช้ได้ไม่เกิน 16 secondary projects ต่อ instance; ปิด runtime ที่ว่างก่อนเปิดเพิ่ม ถ้ามี requests/jobs/agents ใช้อยู่จะปฏิเสธการปิด/ถอด
- Chat รองรับข้อความและ explicit workspace image paths ผ่าน Resource Layer เมื่อ profile รองรับภาพ ไม่มีการอัปโหลดทั้ง repo หรือ binary อื่นไปโมเดลเอง
- Owner controls ที่ไม่ใช่งานประจำบางรายการใช้แบบฟอร์ม advanced operation/JSON ร่วม validation เดิม; เริ่มโปรแกรม/ปลด Keychain/macOS permissions ยังเป็นการกระทำของเจ้าของบนเครื่อง
- ทดสอบ protocol fixtures ทั้งเจ็ด presets ไม่เท่ากับ live provider integration ต้องดู `docs/TEST_REPORT.md` และ manual checklist แยก provider/แพลตฟอร์ม
- งานนี้ไม่เพิ่ม native Windows support, Git worktrees, training หรือ publish release อัตโนมัติ
