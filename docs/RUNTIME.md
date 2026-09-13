# DODO Runtime Intelligence

Runtime Intelligence เก็บหลักฐานจากสิ่งที่เกิดขึ้นจริงใน active workspace โดยคง
security model เดิม ไม่ใช่ agent ที่เฝ้าระบบเองและไม่ใช่ช่องทางรัน command ใหม่

## สิ่งที่รองรับ

- runtime session ที่คงอยู่ข้าม MCP reconnect และ server restart
- process, test และ container-labelled task ผ่าน `JobManager`
- task observation ที่เก็บ status, exit metadata, byte counts และ SHA-256 เท่านั้น
- optional JSON test report ที่ลดเหลือ aggregate counts และ source hash
- browser evidence จาก owned `browser_session` พร้อม bounded MCP image/DOM response
- guarded workspace snapshot และ changeset rollback candidates
- evidence revalidation และ diagnosis ที่แยก fact, observation และ inference
- current runtime evidence เป็น `OBSERVATION` source ใน Context Engine

Full surface มี operations ต่อไปนี้:

```text
runtime_session_open
runtime_session_status
runtime_session_close
runtime_task_start
runtime_task_observe
runtime_task_cancel
runtime_browser_collect
runtime_snapshot
runtime_evidence
runtime_diagnose
```

Compact/Hybrid route ผ่าน `dodo_assist_read`, `dodo_assist_change`, `dodo_exec` และ
`dodo_browser`; ใช้ `dodo_discover(operation="runtime_task_start")` เพื่ออ่าน schema
ล่าสุด

## Lifecycle

```text
runtime_session_open
  → runtime_task_start หรือ runtime_browser_collect/runtime_snapshot
  → runtime_task_observe
  → runtime_evidence (revalidate)
  → runtime_diagnose / context_query
  → runtime_session_close
```

Session default 60 นาทีและตั้งได้สูงสุด 24 ชั่วโมง Evidence เก็บ 24 ชั่วโมง
มีเพดาน 32 open sessions และ 128 retained sessions ต่อ caller/workspace, 32 tasks ต่อ session, 500 evidence
ต่อ session และ 2,000 evidence ต่อ caller/workspace Session หมดอายุไม่ kill job
งานยังอยู่ใน JobManager และดูได้ด้วย job ID ตาม policy เดิม การ close จะปฏิเสธหาก
attached task ยัง running

## Runtime task

`runtime_task_start` รับ explicit `program` และ `args` เท่านั้น ไม่มี shell command
string ก่อน spawn ระบบตรวจ:

1. OAuth `dodo:exec`, installation grant และ active workspace ACL
2. workspace ID/epoch และ principal ownership
3. trusted executable หรือ guarded workspace-relative executable
4. trust-mode execution approval ที่ bind กับ session/kind/program/args/options
5. caller idempotency key; retry key+payload เดิมคืน receipt เดิม
6. owner-configured command sandbox และ network option
7. environment allowlist, argv budget, concurrency และ wall timeout ของ JobManager

`kind=container` เป็น evidence label ไม่ใช่ container daemon หรือ privilege bypass
caller ยังต้องระบุ executable ที่ติดตั้งแล้ว เช่น container CLI และ command นั้นผ่าน
policy เหมือน process อื่น

## Evidence ที่จัดเก็บ

Process/test/container row เก็บเฉพาะ:

- task/job opaque IDs, kind และ bounded duration
- status, exit code, signal, start/end/timeout timestamps
- stdout/stderr total bytes, truncated flag และ SHA-256 ของ bounded sample
- optional test report path/hash และ total/passed/failed/skipped/success

ไม่เก็บ raw stdout/stderr หรือ command output ลง runtime table Raw output ที่มีอยู่ใน
bounded JobManager spool ยังเข้าถึงผ่าน `job_output` ตาม permission เดิมและ retention
ของ jobs

Browser collector เก็บ safe URL ที่ตัด query/fragment, observation ID, title/DOM/image
hash, navigation timing และจำนวน elements/media/console/network/blocked requests
เท่านั้น WebSocket policy ถูกบันทึกว่า blocked ตาม browser isolation ไม่เก็บ DOM
text, console text, request headers, cookies, authorization, input/password values หรือ
page storage ภาพและ bounded observation ถูกส่งเฉพาะ response ปัจจุบันจาก
`BrowserService` ซึ่งยังตรวจ owner, expiry, fresh observation และ web setting

Snapshot เก็บ manifest hash จาก path/size/mtime/ctime metadata ที่ผ่าน `WorkspaceFS`
พร้อม file count/truncated และ caller-owned committed changeset IDs + summary hash
ไม่มี file contents การ snapshot ไม่ apply หรือ rollback สิ่งใด

## Freshness และ Context Engine

Evidence เป็น immutable observation เมื่อ `runtime_evidence(refresh=true)` พบว่า job,
browser observation, test report หรือ workspace manifest เปลี่ยน จะ mark record เดิม
`STALE` โดยไม่เขียนทับ source/content hash การ collect/observe/snapshot ใหม่สร้าง
evidence ใหม่

Context Engine อ่านเฉพาะ `CURRENT`, unexpired evidence ของ caller และ active workspace
แล้วสร้าง `dodo-runtime://runtimeev_...` source โดยผูก content hash และ
caller-specific runtime manifest เป็น cache dependency Runtime text เป็น
`untrusted_runtime_evidence` และไม่สามารถเพิ่ม scope, trust, ACL หรือ approval

## Security boundaries

- session/task/evidence ผูก hash ของ `grantId + clientId`, workspace และ expiry
- ทุก operation re-check live client, grant, scope และ workspace ACL
- opaque ID ไม่ใช่ capability และต่าง principal/workspace ได้ `NOT_FOUND`
- repository config และ saved workflow ไม่ให้ authority แก่ collector
- runtime ไม่เปิด browser, web fetch, desktop, microphone หรือ system audio เอง
- browser collector ใช้เฉพาะ session ที่ caller เปิดและยังเป็นเจ้าของ
- cancel ส่งสัญญาณเฉพาะ live process tree ที่ JobManager เป็นเจ้าของ ไม่ kill stored PID
- Runtime diagnosis เป็น deterministic interpretation ของ bounded metadata ไม่ apply fix

## ข้อจำกัด

- ไม่มี autonomous monitoring หรือ background browser watcher
- มีเฉพาะ task duration และ browser navigation timing ไม่มี raw performance trace
  หรือ WebSocket payload retention; WebSocket ถูก browser isolation ปิดตาม policy เดิม
- container task ไม่มี container-specific API; ใช้ explicit installed CLI ภายใต้ policy
- process exit code 0 ไม่พิสูจน์ user-visible behavior ต้องตรวจ source/UI evidence เพิ่ม
- restart ระหว่าง job running ทำให้ JobManager mark งานเป็น `interrupted_on_restart`
  และไม่ส่ง signal ไป stored PID เพื่อป้องกัน PID reuse
