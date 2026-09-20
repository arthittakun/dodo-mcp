# DODO MCP — Test Report

## 1.3.0 Recovery — หลักฐานก่อน final platform gate

Follow-up วันที่ 2026-09-20 ที่ clean revision `8c76c0a`
(`sha256:a9118f3ce6d37a0520ef64720122eb36e9c684154aebb9cb984e8e6459f148bc`):

| Platform | Core (142 files / 938 tests) | Packaging | Fresh install |
|---|---|---|---|
| macOS arm64 / Node 22 | 902 pass / 0 fail / 36 skip | 17/17 | PASS |
| Linux native / Node 22 | 894 pass / 0 fail / 44 skip | 17/17 | PASS |
| Linux native / Node 24 | 894 pass / 0 fail / 44 skip | 17/17 | PASS |

ทั้งสาม gate: build/typecheck/lint/test:all exit0, DodoBench7/7, production audit0
Linux [run35507491429](https://github.com/arthittakun/dodo-mcp/actions/runs/35507491429)
ยืนยัน fresh-install หลังแก้ Node24 fixture connection reset: retry เฉพาะ initialize
ที่ไม่มี effect ไม่ retry tool calls หรือ OAuth exchange

Windows full [run35506660660](https://github.com/arthittakun/dodo-mcp/actions/runs/35506660660)
ที่ `acf805a`: Node24 core889pass/7fail/38skip; duplicate-activation/UI409 ผ่านแล้ว
เหลือ Git-copy6เคส และ timeout ของ scenario restore15ไฟล์ หลังเก็บหลักฐานยกเลิก
Node22 ของ revision เก่าเพื่อทดสอบแพตช์ใหม่ ไม่ถือว่ารอบที่ยกเลิกผ่าน
แพตช์ Git-copy ใช้ writable fd สำหรับ mandatory flush และ fixture ของปลายทาง private
ใช้ Windows ACL จริง ความถูกต้องของแพตช์ต้องอ้าง native run ของ revision นั้น
ผลย้อนหลังข้างต้นไม่ใช้แทน final gate หลังเปลี่ยน source

Windows focused [run35507971440](https://github.com/arthittakun/dodo-mcp/actions/runs/35507971440)
ที่ `144a3ee`: 22pass/3fail/0skip ยืนยัน writable-fd Git backup และ flush-failure
regression, dirty/untracked restore15ไฟล์, worktree/large blobs และ browser drift
success path ผ่าน เหลือสาม assertion ที่รอ asynchronous initialization ด้วย poll
budget เริ่มต้น แยกเพิ่มเวลารอสถานะเป็น30วินาทีโดยไม่เปลี่ยนผล READY/BLOCKED
ที่ต้องได้หรือ assertions การป้องกันไฟล์/การรันคำสั่ง Full gate ต้องรันอีกครั้ง
บน clean revision หลังแพตช์นี้ก่อนเผยแพร่

ผลแต่ละรอบอ้างเฉพาะ source fingerprint/revision ที่ระบุ ไม่ใช่ผล npm รุ่นก่อน
และไม่รวม skipped tests เป็น pass ต้องใช้ final native Windows/Linux และ macOS
ที่ตรง clean candidate ก่อน publish ดู [workflow](https://github.com/arthittakun/dodo-mcp/actions/workflows/platform-gates.yml)
และ [วิธีอ่านหลักฐาน](CI.md)

ชุดรวม macOS วันที่ 2026-09-20 ก่อนแก้ duplicate activation:
`sha256:b75f20c8669d7a7fbd2e16d80104d1ef6dce4b36855a2ab039ae0d2d475d47e2`

- AUTOMATED_PASS: core141files / 933total / 895pass / 0fail / 38skip;
  packaging17/17; build/typecheck/lint/test:all/benchmark/audit/fresh install exit0
- Production dependency audit0; DodoBench7/7
- Fresh exact-tarball: OAuth + Compact20, Full158 with explicit Sub-agent exposure,
  write/edit/readback, A/B routing, agent receipt; Recovery checkpoint, reviewed restore,
  hash readback, idempotent retry, unrelated-file preservation, restart receipt and stale-context denial
- Actual browser desktop/narrow uses isolated state; config plaintext never appears in UI
- Actual macOS Keychain and Windows Credential Manager random-item put/read/delete passed
  (AUTOMATED_PASS); no owner credentials touched

Windows focused [run35505588240](https://github.com/arthittakun/dodo-mcp/actions/runs/35505588240)
passed78/79,0skip and confirmed the native ACL backend (20freshchecks715ms).
Remaining browser scan returned409 while duplicate project activation held the queue.
Follow-up [run35506319903](https://github.com/arthittakun/dodo-mcp/actions/runs/35506319903)
passed23/24,0skip, including all R06 security/browser/native credential tests;
scalar diagnostics isolated the same409. The candidate now marks a checkpointed
runtime active and avoids re-activation, with a regression that keeps external drift
visible and source writes blocked until reviewed. These focused failures remain
recorded; neither is a full Windows PASS. Final full gates must certify the fix.

MANUAL_NOT_RUN: owner production restore, live external ChatGPT, Android hardware,
and Linux Secret Service on a logged-in desktop. SQLite metadata fixtures do not
claim generic database rollback/PITR. Actual disposable Docker product-adapter
acceptance is separate from native CI and preserves database rows/volumes/config.

## Unreleased — native CI workflow (2026-09-20)

Linux platform gate เปลี่ยนเป็น self-hosted native เช่นเดียวกับ Windows โดยไม่ใช้
Docker เพิ่ม prerequisites และ sandboxed Chromium launch probe; media tests ยัง
ถูกบังคับให้รัน เก็บ evidence แยกตาม run ID/attempt เพื่อไม่เขียนทับผลเมื่อ rerun

`AUTOMATED_PASS` บน macOS สำหรับการเปลี่ยน workflow/gate ครั้งนี้:
actionlint 1.7.12, typecheck, lint และ gate-evidence unit tests **23 passed / 0 failed**
รวมการปฏิเสธ Docker report, fingerprint/revision/lock ที่ไม่ตรง, dirty source,
false pass และ fresh-install ที่ไม่ครบ ผลนี้ไม่ใช่ native Linux/Windows PASS

Follow-up: diagnostics เพิ่มเฉพาะ test path/index/source line โดยไม่ส่ง raw error,
titles หรือ expected/actual values และย้าย CI evidence ออกนอก checkout เพื่อไม่ถูก
cleanup ลบ Typecheck/lint/actionlint และ gate-evidence tests **25 passed / 0 failed**
ผ่านบน macOS หลังแก้ ส่วน native application test results ต้องดูแยกตาม CI run

Native CI [run 35495748297](https://github.com/arthittakun/dodo-mcp/actions/runs/35495748297)
ทดสอบ clean commit `e0e5f9a9b14d0d2e7f4c776aeaf0e19b621eb8f9`
และ fingerprint `sha256:83791f00f244466f064ea413494e7555406835b276f562dca809e3c8901ae665`
โดยตรงบน Linux X64 ไม่มี Docker:

| Gate | Node 22.23.2 | Node 24.21.0 |
|---|---|---|
| build/typecheck/lint/full suite | exit 0 | exit 0 |
| Core / 874 tests | 833 pass / 41 skip / 0 fail | 833 pass / 41 skip / 0 fail |
| Packaging | 17 pass | 17 pass |
| DodoBench | 7/7 pass | 7/7 pass |
| Production audit | 0 vulnerabilities | 0 vulnerabilities |
| Fresh exact-tarball install | PASS | PASS |

ก่อนหน้านี้ run 35495249409 ที่ commit `723733e` มี Linux Node 24 core failure
หนึ่งเคส (830 pass / 41 skip) ส่วน Node 22 ผ่านครบ ยังไม่ยืนยันสาเหตุของ failure
รอบแรก และไม่อ้างว่า diagnostics change แก้ runtime bug ผลรอบล่าสุดข้างบนผ่านจริง
แต่ไม่ลบหรือแทนที่ประวัติผลล้มเหลว

Windows Node 22/24 ในรอบแรกล้มก่อน step แรกที่ runner `InitializeSecretMasker` /
`PowerShellPreAmpersandEscape` ไม่มี application tests ได้รัน ดู [CI](CI.md)
สำหรับการเปิด runner ใหม่ สถานะรอบแรกเป็น `RUNNER_BLOCKED` ไม่ใช่ application PASS
และไม่ได้ rerun ใน Linux-only รอบดังกล่าว

หลังเจ้าของเปิด runner ใหม่ [Windows run 35496561994](https://github.com/arthittakun/dodo-mcp/actions/runs/35496561994)
ที่ clean commit `1739646f0678a6e1c29bc92c8eba6cd1a017f0df` ผ่าน startup แล้ว
Node 24.21.0 ผ่าน build/typecheck/lint แต่ `test:all` หมดเวลา 30 นาที
(1,800,010 ms) จึงเป็น `AUTOMATED_FAIL` ไม่มี complete core JSON report และยังไม่ถึง
packaging/benchmark/audit/fresh install Node 22 ถูกยกเลิกก่อนทดสอบเพื่อวินิจฉัย
ไม่ถือเป็น PASS หรือ application failure ของ Node 22

[การอ่านหลักฐานเดิม](https://github.com/arthittakun/dodo-mcp/actions/runs/35498195971)
พบ reporter output ของ 49 ไฟล์ / 490 tests / 47 failures / 29 skipped ก่อน timeout
เป็น **ผลบางส่วนเท่านั้น** ไม่ใช่ยอดรวม full suite มี failures ใน Recovery และ
integration อื่น จึงห้ามสรุปว่าเพิ่ม timeout อย่างเดียวจะผ่าน หรือยกเลิก backup/ACL
เพื่อให้ผลเขียว งานตรวจเฉพาะกลุ่มมี scope `focused_diagnostics_only` ไม่ใช่ release gate
Manual Windows acceptance ยัง `MANUAL_NOT_RUN`

Focused reproduction [run 35498746408](https://github.com/arthittakun/dodo-mcp/actions/runs/35498746408)
จบจริง: **17 pass / 8 fail / 0 skip** ใน 2 ไฟล์ (236,088 ms)
พบ private ACL verifier คืน metadata ก่อน Windows ปรับ Administrators owner
ขณะที่ journal ตรวจ ctime จาก file descriptor หลังปรับ จึงเกิด `CONFLICT` ทั้งที่
backup ถูกต้อง แพตช์คืน metadata หลังตรวจ ACL พร้อมปฏิเสธ identity/type/content
ที่เปลี่ยนระหว่างตรวจ ไม่ลบ hash/ACL/owner/reparse guards

หลังแก้ที่ `89b762b` [Windows focused run 35499178559](https://github.com/arthittakun/dodo-mcp/actions/runs/35499178559)
**34 pass / 0 fail / 0 skip** ใน 3 ไฟล์ (302,245 ms): recoveryBackups, directTools
และ windowsAclOwner รวม native owner/DACL/junction checks และการอ่าน metadata
หลัง owner repair ผลนี้เป็น `AUTOMATED_PASS` เฉพาะชุดย่อย ไม่ใช่ full Windows gate

Local macOS สำหรับแพตช์: typecheck/lint ผ่าน, 31 focused tests pass / 9 native
Windows tests skipped ไม่อ้าง skips เป็น Windows evidence Windows full gate
รอบต่อไปใช้ aggregate `test:all` budget 60 นาที โดยคง timeout ราย test/hook และ
assertions เดิม ผล full gate หลังแพตช์ยังรอยืนยัน

ผล Recovery/Docker ด้านล่างเป็นหลักฐานของ candidate รอบก่อนตาม fingerprint เดิม
ไม่ใช้แทน native CI ข้างบน ไม่มี merge main หรือ npm publish จากผลนี้

## Unreleased — Source Recovery R00–R02 candidate

ตรวจ 2026-09-20 บน source fingerprint
`sha256:89c3ad25f99781f41824c3b13c39400ef231d173ea818e7eb9cd1717d4782c69`
ผลนี้เป็น development candidate ไม่ใช่การรับรองว่า npm รุ่นที่เผยแพร่มีฟีเจอร์นี้แล้ว

| Gate | macOS arm64 / Node 22 | Linux Docker arm64 / Node 22 |
|---|---|---|
| build, typecheck, lint, test:all | exit 0 | exit 0 |
| Core: 121 files / 832 tests | 797 pass / 35 skip / 0 fail | 791 pass / 41 skip / 0 fail |
| Packaging / fresh installed restore | 17 pass / 0 fail | 17 pass / 0 fail |
| Production npm audit | 0 vulnerabilities | 0 vulnerabilities |
| DodoBench | not rerun in this gate | 7/7 pass |

`AUTOMATED_PASS`: real HTTP OAuth/target A/B/caller isolation, read-only refusal,
inspect approval, external hash/mode conflicts, dirty Git index preservation,
binary/directory/partial restore, injected write failure compensation, six abrupt
restore crash boundaries, private owner API and built CLI. Real Chromium verifies
desktop/390px preview → confirmation → restore → journal status. PACK-17 repeats
backup/preview/restore/read-back/idempotent retry against an installed tarball.

Linux fresh exact-tarball smoke additionally verifies Full STDIO 148 and Compact
HTTP 20, OAuth, write/edit, target routing and sub-agent protocol fixtures. Sub-agent
operations are explicitly enabled in that smoke; the normal hidden Full count is 144.

One preliminary full run failed a Brain per-run metric assertion when automatic
indexing ran before the fixture's manual rebuild. The fixture isolates that timer;
the real parser/index/security and original assertions remain. The final full runs
above passed; preliminary failed logs were retained. Skips cover platform/backend
conditions and are not counted as passes.

`MANUAL_NOT_RUN`: native Windows/Android, live owner data restore, live provider
credentials and publication. Automated browser use is not `MANUAL_PASS`.
See [Recovery scope and limitations](RECOVERY.md) and
[ADR-052](adr/052-reviewed-source-restore.md).

## 1.2.1 Agent Profile creation and Compact/Hybrid visibility controls

วันที่ตรวจ: 2026-09-16

- Root cause reproduction: Agent form ส่ง `model: ""` หรือค่าตัวเลขที่ไม่ผ่าน schema
  แล้ว owner API ตอบเพียง `invalid request fields`
- Chromium real UI: ตรวจ Model ID ว่างก่อนส่ง, backend ระบุ field `model`, โหลด model
  fixture แล้วเลือกให้อัตโนมัติ, สร้าง Coding Agent, ทดสอบ tool calling, สร้างไฟล์จริง
  และอ่านผลกลับ — `AUTOMATED_PASS`
- Responsive: desktop 1440px และ mobile 390px ไม่มี horizontal overflow —
  `AUTOMATED_PASS`
- Per-operation visibility: ปิด `write_file` แล้วหายจาก discover, gateway enum และ
  Hybrid direct duplicate; ปิด `git_commit` แล้ว gateway ที่ว่างหาย; Full ยังครบ —
  `AUTOMATED_PASS`
- Owner-only API ปฏิเสธ unauthenticated/stale/unknown operation และบันทึกรายการแบบ
  canonical; public MCP ไม่มี admin route — `AUTOMATED_PASS`
- Chromium real UI: สวิตช์ราย operation, search, เปิด/ปิดทั้งหมวด, restart notice,
  desktop 1280px และ 320px ไม่มี horizontal overflow — `AUTOMATED_PASS`
- Focused catalog/HTTP/security/UI suites: 40/40 — `AUTOMATED_PASS`
- `npm run test:all`: 107 files passed, 3 skipped; 731 tests passed, 35 skipped;
  packaging 16/16 — `AUTOMATED_PASS`
- `npm audit --omit=dev`: 0 vulnerabilities — `AUTOMATED_PASS`
- Fresh immutable tarball smoke: CLI 1.2.1, generated config schema และ Local Config
  UI assets ครบ — `AUTOMATED_PASS`
- Live owner provider credentials: `MANUAL_NOT_RUN`
- npm publish: `MANUAL_NOT_RUN`

## Release 1.2.0 — Cloudflare Local และ Simple Project Access

ผล candidate บน macOS arm64 วันที่ 2026-09-16:

- build: **AUTOMATED_PASS** — Complete Full 138, live Full default 134, Compact 20,
  Hybrid 49 และ config schemas 2 ชุด
- typecheck/lint: **AUTOMATED_PASS**
- core/integration/security/compatibility: **AUTOMATED_PASS** — 726 passed /
  35 skipped / 0 failed ใน 107 ไฟล์ที่ผ่านและ 3 ไฟล์ที่ skip
- packaging: **AUTOMATED_PASS** — 16/16 รวม release document, ADR, generated UI
  assets และ fresh tarball checks ตาม manifest
- focused connection/project/OAuth/security/Chromium: **AUTOMATED_PASS** — 92 passed,
  1 skipped, 0 failed; ทดสอบสาม connection modes, write-only credential boundary,
  Remote Config ผ่าน owner-managed public mode, per-project `read/edit/full`,
  project-name routing และ real browser UI
- production dependency audit: **AUTOMATED_PASS** — 0 vulnerabilities
- Cloudflare Local ผ่าน public hostname/process จริงของเจ้าของ: **MANUAL_NOT_RUN**
- DODO Tunnel credential store/readiness ผ่าน public hostname จริงของ 1.2.0:
  **MANUAL_NOT_RUN**

Regression รอบแรกพบ security fixture คาด marker `Project Registry` ที่หายจากหัวข้อไทย
จึงคืน marker ใน UI แล้วรัน focused และ full suite ใหม่จนผ่าน ไม่ได้ลด assertion
หรือ security requirement

## Release 1.1.0 — Android ADB tool family

ผล candidate บน macOS วันที่ 2026-09-16:

- build: **AUTOMATED_PASS** — Complete Full 138, live Full default 134, Compact 20,
  Hybrid 49 และ config schemas 2 ชุด
- typecheck/lint: **AUTOMATED_PASS**
- core/integration/security/compatibility: **AUTOMATED_PASS** — 698 passed /
  35 skipped / 0 failed ใน 103 ไฟล์ที่ผ่านและ 3 ไฟล์ที่ skip
- packaging: **AUTOMATED_PASS** — 16/16
- Android focused: **AUTOMATED_PASS** — parser/PNG/UI redaction, exact serial,
  OAuth scope, compact image passthrough, approval binding, idempotency, secret/path
  guards, expected-hash conflict, private staging cleanup, Local Config owner auth,
  real HTTP+OAuth dispatch ของทั้ง 13 operation families และ Chromium UI
- production dependency audit: **AUTOMATED_PASS** — 0 vulnerabilities
- physical Android hardware/emulator: **MANUAL_NOT_RUN**
- Android/Termux host acceptance: **MANUAL_NOT_RUN**

Automated ADB ใช้ backend fixture ที่บันทึก argv/ผลลัพธ์จริงของ invocation pipeline
โดยไม่แตะอุปกรณ์เจ้าของ จึงพิสูจน์ routing/security/content-block contract แต่ไม่แทน
USB/Wireless debugging, RSA prompt, OEM Android behavior หรือ real device permission

## Release 1.0.6 — Android-safe Sharp loading

ผล macOS วันที่ 2026-09-16:

- build/typecheck/lint: **AUTOMATED_PASS**
- core/integration/security/compatibility: **AUTOMATED_PASS** — 682 passed / 35 skipped /
  0 failed ใน 100 ไฟล์ที่ผ่านและ 3 ไฟล์ที่ skip ตาม platform/capability
- packaging: **AUTOMATED_PASS** — 16/16
- optional-backend regression: **AUTOMATED_PASS** — mock ให้ `sharp` load ไม่ได้แล้ว
  import image/resource modules ยังผ่าน; เมื่อเรียก image operation จึงตอบ typed
  `NOT_SUPPORTED`
- no-Sharp compiled smoke: **AUTOMATED_PASS** — ย้าย `node_modules/sharp` ออกจาก
  fixture ชั่วคราวแล้ว `node dist/cli/main.js --version` แสดง 1.0.6; image operation
  ปฏิเสธแบบ bounded ตาม contract
- WebAssembly fallback smoke: **AUTOMATED_PASS** — ปิด native Darwin Sharp packages
  ชั่วคราว, บังคับไม่ใช้ global libvips แล้ว `@img/sharp-wasm32` 0.35.4 สร้าง PNG
  2×2 สำเร็จ 95 bytes
- production dependency audit: **AUTOMATED_PASS** — 0 vulnerabilities
- Android/Termux device install และ MCP workflow: **MANUAL_NOT_RUN**
- Android setup, credential store, sandbox, desktop และ browser: **MANUAL_NOT_RUN**

ผล macOS/Wasm พิสูจน์ startup/fallback contract แต่ไม่แทน Android device acceptance
จึงยังระบุ Android เป็น experimental

## Release 1.0.4 — Windows setup guidance

ผล candidate gate บน macOS วันที่ 2026-09-16:

- build: **AUTOMATED_PASS** — Full 125, Compact 19, Hybrid 49 และ config schemas 2 ชุด
- typecheck และ lint: **AUTOMATED_PASS**
- core/integration/security/compatibility: **AUTOMATED_PASS** — 680 passed / 34 skipped / 0 failed ใน 99 ไฟล์ที่ผ่านและ 3 ไฟล์ที่ skip ตาม platform/capability
- packaging: **AUTOMATED_PASS** — 16/16 รวม assertion ว่า tarball มี `docs/WINDOWS_SETUP.md`
- production dependency audit: **AUTOMATED_PASS** — 0 vulnerabilities
- npm pack dry-run: **AUTOMATED_PASS** — package 1.0.4, 456 files, มีคู่มือและ release document ใหม่
- native Windows interactive ACL recovery และ Cloudflare executable ของผู้ใช้:
  **MANUAL_NOT_RUN** — automated tests ไม่เปลี่ยนสถานะนี้

CLI เพิ่มการแสดง typed recovery ใน command/JSON/interactive menu และยังคงปฏิเสธ
foreign owner, reparse point หรือ permissive state DACL แบบ fail closed คู่มือแนะนำ
fresh local NTFS state โดยเก็บ directory เดิมไว้; ไม่มี test หรือเอกสารส่วนใดลด ACL
เป็น `Everyone` หรือ takeover state ของ account อื่น

## Release 1.0.3 — Persistent connection mode

- `tests/integration/connectionMode.test.ts`: Local ใช้ loopback เป็น OAuth issuer/MCP
  resource และเรียก `project_overview` ผ่าน OAuth จริง; Tunnel advertise public URL
  แต่คง upstream ที่ loopback
- `tests/security/tunnelCredentials.test.ts`: migration จาก config เดิมและ credential
  locator ที่ไม่มี token
- `tests/security/localConfig.test.ts`: owner authentication, write-only OS credential
  boundary, exclusive mode และไม่มี endpoint เริ่ม tunnel ด้วย token ชั่วคราว
- `tests/integration/tunnelSupervisor.test.ts`: configured credential, argv/log/state
  non-disclosure, readiness, bounded restart และ owned stop
- `tests/security/remoteConfig.test.ts` กับ `tests/integration/remoteConfigUi.test.ts`:
  Remote Config เปิดได้เฉพาะ Tunnel ที่ทำงานและไม่รับ credential ทาง IPC
- `tests/integration/configUiComponents.test.ts`: Chromium จริงแสดง Active MCP URL
  ตาม runtime, บังคับ Local/Tunnel เป็นตัวเลือกเดียว และไม่บันทึก Tunnel เมื่อ HTTPS
  origin หรือ credential ยังไม่พร้อม

Targeted gate ล่าสุด: **AUTOMATED_PASS** — 9 files, 61 tests passed, 1 skipped ตาม
dependency/platform; Chromium UI 5/5 ผ่าน; typecheck และ lint ผ่าน

Full gate ล่าสุด: **AUTOMATED_PASS** — `npm run build` สร้าง Full 125 / Compact 19 /
Hybrid 49 tools; `npm run test:all` ผ่าน core/security/compatibility 99 files,
679 tests passed, 34 skipped, 0 failed และ packaging 16/16

- `npm audit --omit=dev`: **AUTOMATED_PASS** — production vulnerabilities 0
- `npm pack --dry-run`: **AUTOMATED_PASS** — มี CLI, Local Config assets และ schema
  ทั้งสาม surfaces; ไม่พบ `.env`, state DB, model/media, release evidence หรือ
  `docs/development` ใน manifest

Live Cloudflare hostname และ OS credential store ด้วย credential ของเจ้าของสำหรับ source
นี้: **MANUAL_NOT_RUN** — ไม่ถือว่า fixture cloudflared เป็นหลักฐานของ public network จริง

## Pre-release project access, project names and tunnel readiness — 2026-09-16

หลักฐานชุดนี้สร้างก่อนรวมเข้า 1.2.0 งานรอบนี้: Simple Project Access Policy (read/edit/full),
เรียกโปรเจกต์ด้วยชื่อ (`targetProject`), แก้ข้อความที่บังคับ ACL ในโหมดส่วนตัว และแก้
Cloudflare readiness ที่สถานะกระพริบ

**รันจริงบน macOS arm64, Node v22.23.2:**

- `npm run typecheck` / `npm run lint` / `npm run build` — **AUTOMATED_PASS** (exit 0)
- `npm run test:all` — **AUTOMATED_PASS**: 705 passed / 34 skipped / 0 failed (106 ไฟล์)
  + packaging 16/16
- `npx vitest run tests/security/projectAccessLevel.test.ts` (ใหม่, 11 ข้อ) —
  **AUTOMATED_PASS**: mapping ระดับ→scope, `full` token ถูกบีบตามระดับ, token `read`
  เขียน/exec ไม่ได้แม้โปรเจกต์ `full`, managed mode ยังต้องมี ACL แล้วระดับบีบซ้ำ,
  workspace ที่ไม่ได้ลงทะเบียนไม่ถูกบีบ, ค่าที่อ่านไม่ออก → `read` (fail closed),
  row เก่า migrate เป็น `full` (ไม่ถอนสิทธิ์), ระดับผิด → ไม่มีโปรเจกต์ค้าง,
  ชื่อซ้ำถูกปฏิเสธแบบไม่สนตัวพิมพ์, resolve ชื่อ/ชื่อกำกวม/ชื่อไม่รู้จัก
- `npx vitest run tests/integration/projectByName.test.ts` (ใหม่) — **AUTOMATED_PASS**
  ผ่าน HTTP + OAuth จริง: route ด้วยชื่อ, เขียนลงโปรเจกต์ถูกตัว, ตัวพิมพ์/ช่องว่างไม่สำคัญ,
  ระดับ `edit` บล็อก exec แล้วยกเป็น `full` ทำได้, ชื่อไม่รู้จัก → NOT_FOUND,
  id+ชื่อขัดกัน → INVALID_INPUT, ชื่อกำกวม → CONFLICT พร้อม candidate,
  `targetProject` ใน nested args ถูกปฏิเสธและไม่มีไฟล์ถูกเขียน
- `npx vitest run tests/unit/tunnelReadiness.test.ts` (ใหม่, 8 ข้อ) — **AUTOMATED_PASS**:
  probe 200/503/ปิด/ค้าง, ไม่ใช้ socket ซ้ำ (นับ connection = 2), schema รองรับทุก phase,
  state.json รุ่นเก่า parse ได้, ปฏิเสธ field แปลกปลอม
- `npx vitest run tests/integration/tunnelSupervisor.test.ts` (เพิ่ม 3 ข้อ) —
  **AUTOMATED_PASS** ด้วย fake cloudflared จริง: readiness ตกชั่วคราว → `degraded`
  และ `connected` ยังเป็น true, ไม่มีบรรทัด "is not connected"; ล้มติดกันครบเกณฑ์ →
  `disconnected` แล้ว recover กลับ `connected`; ไม่เคยรายงาน connected โดยไม่มีหลักฐาน
- `npx vitest run tests/integration/projectAccessUi.test.ts` (ใหม่, 2 ข้อ) —
  **AUTOMATED_PASS** ใน Chromium จริง: เพิ่มโปรเจกต์ครบในหน้าเดียว (path/ชื่อ/ระดับ),
  การ์ดแสดงระดับที่ backend เก็บจริง, เปลี่ยนระดับแล้วยืนยันหลัง backend ตอบ,
  reload ยังเห็นค่าเดิม, ชื่อซ้ำขึ้น error (ไม่ขึ้น success), personal ซ่อนฟอร์ม ACL /
  managed แสดงครบ, 390px ไม่มี horizontal scroll, `pageerror` = 0
- `npm run test:linux:docker` — **AUTOMATED_PASS** (node v22.23.2, arm64, Chromium)
- `npm pack` + fresh install จาก tarball — **AUTOMATED_PASS**: 461 ไฟล์, ไม่มี
  state.db/.env/jwks/.sock, `dist/projects/ownerAdmin.js` และ
  `dist/security/projectAccess.js` อยู่ในแพ็กเกจ, และรัน
  `dodo project add --access read` → `dodo project access "auto-upload" --mode full`
  → `dodo project list` ได้จริงจาก tarball ที่ติดตั้งสด
- `npm run test:windows` บน macOS — 56 passed / 30 skipped: **ไม่ใช่หลักฐาน Windows**
  (ข้อที่เป็น Windows-only ถูก skip)

**MANUAL_NOT_RUN** (ยังไม่มีหลักฐาน):
- Windows native (windows-ci-02) — ยังไม่ได้รัน รอบนี้แก้สาเหตุที่เป็น Windows-specific
  ไว้แล้ว (event-loop starvation จากการเขียน log, keep-alive socket) แต่ยังไม่มีหลักฐานจริง
- การยืนยันบน tunnel จริง `https://mcp.baanseriesnow.com/mcp` กับ cloudflared จริง
  (เทสต์ใช้ fake cloudflared ที่ควบคุม `/ready` ได้)
- การอัปเกรดจาก state ของ 1.0.2/1.0.3 จริง (migration ตรวจด้วย fixture เท่านั้น)

## Scope

รายงานนี้ใช้กับ DODO MCP 1.0.3 source และแยกผล automated กับ manual อย่างชัดเจน

## Release 1.0.2 — Temporary Remote Config

เพิ่ม owner-paired `/config` bridge บน listener 21730 ที่ปิดเป็น 404 ตามค่าเริ่มต้น
และเปิดได้ครั้งละไม่เกินหนึ่งชั่วโมงด้วย `dodo --web` โดย Local Config 21731 ยังคง
bind loopback เท่านั้น `dodo --web` ต่ออายุผ่าน authenticated installation IPC โดย
ไม่ restart MCP และเริ่ม process-owned Tunnel ด้วย token ชั่วคราวเมื่อ process เดิม
เริ่มแบบ local-only

- typecheck และ targeted lint: **AUTOMATED_PASS**
- `tests/security/remoteConfig.test.ts`: **AUTOMATED_PASS** — absent-by-default,
  one-time pairing, strict cookie/CSP, unauthorized asset/API, cross-site denial,
  workspace/epoch binding, expiry/close, IPC renewal, token/pairing non-persistence
  และ run-scoped Tunnel handoff
- `tests/integration/remoteConfigUi.test.ts`: **AUTOMATED_PASS** ใน Chromium จริง —
  pairing และ dashboard จริงที่ 1440×900/390×844, no console errors, no horizontal
  overflow, close → 404; screenshots อยู่ใน ignored local release evidence
- `tests/integration/cli.test.ts`: bounded `--web`, `web --status`, `web --close`
  contract ผ่าน
- `npm run test:all`: **AUTOMATED_PASS** — 98 files ผ่าน, 3 files ข้ามตาม platform;
  677 tests ผ่าน, 34 skipped, 0 failed และ packaging 16/16
- `npm audit --omit=dev`: **AUTOMATED_PASS** — 0 vulnerabilities
- npm pack manifest: **AUTOMATED_PASS** — รวม `dist/server/remoteConfig.js`, Local
  Config UI, ADR-047 และ release note; release evidence/state/credentials ไม่อยู่ใน manifest
- public Cloudflare hostname → Remote Config บนอุปกรณ์ภายนอก: **MANUAL_NOT_RUN**

## Release 1.0.1 platform gate — 2026-09-15

- macOS local, Node 22: **AUTOMATED_PASS** — core 669 passed / 0 failed / 34 skipped,
  packaging 16/16, production audit 0 vulnerabilities, DodoBench 7/7 และ fresh
  exact-tarball install ผ่าน
- Windows native self-hosted, Node 22: **AUTOMATED_PASS** — core 671 passed / 0 failed /
  32 skipped, packaging 16/16, production audit 0 vulnerabilities, DodoBench 7/7
  และ fresh install ผ่าน
- Windows native self-hosted, Node 24: **AUTOMATED_PASS** — core 671 passed / 0 failed /
  32 skipped, packaging 16/16, production audit 0 vulnerabilities, DodoBench 7/7
  และ fresh install ผ่าน
- Linux Docker: ใช้หลักฐาน gate ที่ผ่านก่อนหน้าและไม่มี runtime source เปลี่ยนหลังจากนั้น;
  release นี้ไม่ได้รัน Linux ซ้ำตามขอบเขต platform follow-up ที่เจ้าของกำหนด
- Windows manual acceptance บน desktop/permission จริงและ live AI providers:
  **MANUAL_NOT_RUN**

Windows CI แก้ persistent-checkout line-ending drift โดยบังคับ canonical Git bytes และ
ตรวจ clean index ก่อนสร้าง source fingerprint ไม่มีการลด security assertion หรือข้าม
release gate ส่วน GitHub artifact upload อาจไม่เกิดเมื่อ storage quota เต็ม แต่ sanitized
summary ยังคงอยู่ใน job log และผล gate ไม่อาศัย artifact upload

## Optional Sub-agent MCP exposure — 2026-09-14

เพิ่ม owner-only switch ที่ Local Config → Settings ค่าเริ่มต้นปิด โดยหน้าเว็บ Chat &
Tasks ยังใช้ agent ได้ Full live catalog เปลี่ยนจาก complete 125 เป็น 121 ขณะที่
Compact/Hybrid คง 19/49 tool names แต่กรอง operation enum, discover, overview note และ
server instructions ให้ตรงกับ runtime ผลเปิดสวิตช์ต้อง restart/rescan และไม่ได้เพิ่ม
OAuth scope, ACL, trust, profile authority, approval หรือข้าม guards ใด ๆ

- `npm run build`, typecheck, lint — **AUTOMATED_PASS**
- catalog/default/config/auth tests — **AUTOMATED_PASS**: default false, Full 121,
  opt-in Full 125, Compact/Hybrid 19/49, hidden operation `NOT_FOUND`, stale/unauthorized
  Local Config writes ถูกปฏิเสธ
- Chromium UI-04 — **AUTOMATED_PASS**: switch, SweetAlert confirmation, persisted config,
  restart notice และ Chat & Tasks ยังเข้าถึงได้; console/CSP errors = 0
- `npm run test:all` — **AUTOMATED_PASS**: 649 passed / 31 skipped / 0 failed ใน
  94 files ผ่าน, 2 files ข้ามตาม platform และ packaging 16/16
- exact tarball smoke — **AUTOMATED_PASS**: fixture เปิด option โดยชัดแจ้ง, STDIO 125,
  HTTP Compact 19, OAuth, write/edit/read-back, target routing และ Sub-agent receipt ผ่าน
- `npm audit --omit=dev` — **AUTOMATED_PASS**: 0 vulnerabilities
- owner server restart + external ChatGPT rescan — **MANUAL_NOT_RUN**

## Local Config UI redesign — 2026-09-14 (macOS, Node 22.23.2)

ปรับ Information Architecture เป็น dashboard 8 หน้า, เพิ่มระบบ tooltip ที่เข้าถึงได้, vendor SweetAlert2 11.26.25 (same-origin, CSP `'self'` เดิม ไม่มี `unsafe-inline`/`unsafe-eval`), provider action lifecycle, personal-mode UX และ hardened `/assets` route (normalize + extension allowlist + traversal fail-closed) ผลรันจริง:

- `npm run build` / `npm run typecheck` / `npm run lint` — **AUTOMATED_PASS** (exit 0)
- `npx vitest run tests/security/localConfig.test.ts` — **AUTOMATED_PASS** 9/9 (รวม CSP ไม่มี CDN, asset traversal/encoded/NUL/deep-path → 404, ไฟล์ first-party ไม่มี `innerHTML`, vendored assets เสิร์ฟจาก same origin)
- `npx vitest run tests/integration/aiWorkbench.test.ts` — **AUTOMATED_PASS** 1/1 ใน Chromium จริง (nav ใหม่, SweetAlert confirm ก่อน probe, ผลทดสอบมี connection/model/เวลา, XSS ใน model output ไม่ทำงาน, ไม่มี secret ใน storage, 390px ไม่มี horizontal scroll, dark/light, keyboard focus, `pageerror` = 0)
- `npx vitest run tests/integration/configUiComponents.test.ts` (UI-01..04) — **AUTOMATED_PASS** 4/4 ใน Chromium จริง: tooltip, SweetAlert, double-submit, text-only hostile names, personal/managed controls, theme/reduced motion, 320px และ Sub-agent MCP switch พร้อม restart notice/Chat & Tasks continuity; console error/CSP violation = 0
- `npm run test:pack` — **AUTOMATED_PASS** 16/16 (PACK-07 ตรวจ ui/ + vendor/ อยู่ใน tarball, ไม่มี URL ภายนอกใน index.html, vendored SweetAlert2 ตรง byte กับ devDependency ที่ pin)
- `npm run test:all` — **AUTOMATED_PASS**: 649 passed / 31 skipped (Windows-only บน macOS) / 0 failed ใน 94 ไฟล์ + packaging 16/16
- Screenshot จาก Chromium fixture: `release-evidence/ai-workbench/{providers-desktop,task-desktop,task-mobile,history-mobile-light,overview-320}.png`
- **MANUAL_NOT_RUN**: การแตะ tooltip บนอุปกรณ์ touch จริง (ทดสอบผ่าน Chromium click-as-tap แล้วเท่านั้น), screen reader จริง (VoiceOver/NVDA), และการใช้งานบนเบราว์เซอร์อื่นนอกจาก Chromium

### Visual pass (theme tokens)

ใช้พื้น charcoal/slate แบบเรียบใน dark mode และ warm neutral ใน light mode แยกชั้นด้วย surface, border และ spacing พร้อม accent ม่วงเฉพาะ control/สถานะสำคัญ ไม่มี gradient, ambient glow หรือ asset ตกแต่งจากภายนอก ส่วน sticky navigation ใช้ `backdrop-filter` เฉพาะเมื่อ browser รองรับ ตรวจด้วย Chromium fixture ว่า dark/light สลับค่าจริง และ `PACK-07` ล็อกข้อกำหนดว่า first-party CSS ต้องไม่มี `linear-gradient`, `radial-gradient` หรือ `conic-gradient` เทสต์ทั้งหมดข้างต้นรันซ้ำผ่านหลังปรับสี (AUTOMATED_PASS ทั้งชุด)

### Layout tidy pass (spacing/grid system)

จัดระเบียบตามหลัก 2026 (8px spacing scale, law of proximity, one shared shell width): เพิ่ม token ระยะ `--s1..--s8` + `--shell`/`--card-pad`, ลบการซ้อน card-in-card (`#workbench` เป็น layout container ไม่ใช่ card แล้ว, `.wb-section` ใช้ chrome เดียวกับ `.card` ทุกหน้า), รวมทุกหน้าให้กว้างเท่ากันและจัดกึ่งกลาง, form field กริด 2 คอลัมน์ระยะสม่ำเสมอ, ปุ่ม action เป็นแถวระยะเท่ากันแทน margin เฉพาะจุด, ยุบ `#wb-notice` ที่ว่างและทำเป็นกล่องเมื่อมีข้อความ ผลรัน gate เต็มล่าสุดหลังจัด layout และเพิ่ม Sub-agent exposure switch: **649 passed / 31 skipped / 0 failed + packaging 16/16** (รวม assertion viewport 320/390 ไม่มี horizontal scroll, personal-mode visibility, dark/light) — AUTOMATED_PASS

## AI Providers / Multi-project — current source verification

วันที่ 2026-09-14 บน macOS, Node 22.23.2; source baseline ก่อน release 1.0.1

| Gate | ผล |
|---|---|
| Build, typecheck, lint | AUTOMATED_PASS |
| Unit/integration/security/compatibility | AUTOMATED_PASS — 94 files, 649 tests; skipped 2 files / 31 tests ตาม platform/prerequisite |
| Packaging suite | AUTOMATED_PASS — 16 tests |
| Production npm audit | AUTOMATED_PASS — 0 vulnerabilities |
| Chromium owner UI | AUTOMATED_PASS — 1440px/390px, dark/light, keyboard, safe model text, explicit resource image attachment, create file in B and history reconnect without replay |
| macOS Keychain | AUTOMATED_PASS — synthetic set/get/delete round-trip; fixture item deleted |
| Exact tarball fresh install | AUTOMATED_PASS — explicit Sub-agent opt-in: Full 125, Compact HTTP 19 + OAuth, write/edit/read-back, target B, provider fixture agent write + receipt; cleanup passed |
| Linux Docker | NOT_RUN — runner command stops at docker info; local Engine socket unavailable |
| Live OpenAI, Gemini, Claude, MiniMax, GLM, Kimi, Ollama | MANUAL_NOT_RUN — no live credentials/model inference used |
| Native Windows for this feature | MANUAL_NOT_RUN — outside this task |

Protocol fixtures exercise all seven presets / five adapters, fragmented streams, tool
call IDs and continuation/signatures, 429, abort/interruption, credential-echo rejection,
DNS/private/metadata policy and redirect refusal. These results do not establish live
model compatibility or provider billing behavior.

Personal-mode regressions prove an owner-approved OAuth token can list/read/write an
owner-registered Project B with no duplicate workspace ACL, while read-only scope still
cannot write. Enabled remote profiles are discoverable without a ProjectAI allowlist;
managed mode remains explicit and retains existing ACL/trust/egress tests. Persistent
Desktop consent is reused across workspace epochs/projects, temporary consent remains
workspace-bound, snapshots remain stale across epochs, and installation disable revokes it.

Real HTTP + OAuth fixtures prove parallel A/B jobs and writes, no-default-ACL project
selection, target scope/context rejection, secret/hash guards and isolated changesets.
Agent fixtures verify write/read/edit/exec/read, actual stdout receipts, inspect approvals,
queued revocation/conflict, owned-job cancellation, no recursive spawn, idempotency,
explicit process-crash recovery and uncertain-outcome refusal. Runtime teardown tests
prove new requests cannot acquire a closing target while the default remains usable.

Private non-secret evidence is retained under release-evidence/ai-workbench (ignored and
not packaged): gate log, audit, artifact manifest/checksum, fresh-install report and five
actual UI screenshots. The npm manifest includes all 11 UI assets, AI runtime modules,
Full/Compact/Hybrid schemas and the AI provider guide; development docs, conversations,
state databases, media/model files and credentials are absent.

No live provider or external ChatGPT acceptance is reported as MANUAL_PASS. No publish,
global reinstall, existing-server restart or tunnel/DNS change is part of this work.

## Baseline gates before AI Providers / Multi-project


```bash
npm run build
npm run typecheck
npm run lint
npm run test:all
npm audit --omit=dev
npm pack
```

ผล local gate วันที่ 2026-09-14 (macOS, source checkout):

- build: PASS — full 121, compact 19, hybrid 49 และ config schemas ถูกสร้างสำเร็จ
- typecheck: PASS
- lint: PASS
- core/integration/security/compatibility: 84 files PASS, 2 files platform-skipped; 605 tests PASS, 31 tests platform/prerequisite-skipped
- packaging: 16 tests PASS
- `npm audit --omit=dev`: 0 vulnerabilities (0 low/moderate/high/critical)
- `npm pack`: PASS — required runtime/schemas/docs present and forbidden private state/development artifacts absent; exact final artifact metadata is reported separately so the packaged report does not contain a self-referential checksum
- fresh exact-tarball install: PASS — `dodo --version` = `1.0.0`, Full = 121,
  Compact = 19 และ installed Compact `dodo_assist_read → memory_status`,
  `dodo_assist_change → runtime_session_open` และ `agent_run_open` คืน schemaVersion 1
  จาก fresh state สำเร็จ โดย agent run มี `authority=coordination_only`

macOS owner-flow verification เพิ่มเติมหลังเปลี่ยน Tunnel lifecycle:

- headless Chromium แสดง Local Config จริงที่ 1440px และ 390px; temporary token
  เป็น masked input, ไม่มี external asset และ state มาจาก runtime
- pseudo-terminal fixture เรียก CLI จริงและพิสูจน์ hidden prompt → child environment,
  token ไม่อยู่ใน terminal output/argv/config และ `SIGINT` ปิด owned child พร้อม DODO
- exact tarball fresh install และ global reinstall รายงาน `dodo 1.0.0`; package 408 files
  ไม่มี development docs, state DB, `.env`, model หรือ release evidence
- `dodo setup --check --components all` บน macOS arm64: Git, ripgrep,
  cloudflared, ffmpeg, Whisper/model, Chromium, LSP, speech และ sandbox พร้อม;
  Desktop permission และ outbound web consent ยังไม่เปิดตาม security default

ชุดทดสอบครอบคลุม transport, OAuth, Local Config, workspace switching, ACL, stale context, path/secret guards, changes, jobs, Git, semantic tools, assistance, multimodal, browser, workflow, surface catalog และ packaging

Native candidate regression เพิ่ม lossless NTFS file IDs ผ่าน JSON/SQLite และ
replaced-root checks, LSP drive/URI normalization, portable mid-write rollback,
Windows private-fixture ACL และ writable CAS flush handle ผล local ข้างต้นไม่ใช้
แทนผล native Windows CI; ต้องตรวจ Node 22/24 บน runner `windows-ci 02` แยกกัน

IPC shutdown regression จำลอง endpoint ที่หายไประหว่างตรวจ identity และยืนยันว่า
descriptor ปลอมหรือ ACL ที่เปิดกว้างซึ่งยังอยู่ยังถูกปฏิเสธ Packaging ล้างเฉพาะ
temporary directory ของ suite หลังจบ รวมถึงกรณี test fail เพื่อไม่สะสม native
dependencies และ private fixture state บนเครื่องที่รันทดสอบซ้ำ

Fresh-install smoke รัน installed package ใน process ลูก และให้ parent ลบ fixture
หลังลูก exit เพื่อให้ Windows ปลด native DLL ก่อน cleanup รายงาน `PASS` ถูกเขียน
หลัง verification และ cleanup สำเร็จทั้งคู่เท่านั้น

Setup foundation tests เพิ่มหลักฐานว่า setup plan/check ไม่เขียน state, installer ไม่เริ่มหากไม่มี `--yes`, setup receipt มี schema/kind ที่กำหนด, state import ใช้ allowlist, ตรวจ source hash ซ้ำ, ไม่ merge target เดิม และไม่คัดลอก DB/keys/OAuth/ACL/trust/permission state รวมถึง fail closed ต่อ malformed/unknown config, links และ live IPC markers

Tunnel tests ใช้ fake `cloudflared` และ loopback readiness fixture พิสูจน์ว่า run-scoped token จาก runtime ไม่อยู่ใน config/argv/log/status, child รับผ่าน dedicated environment, job environment ไม่ inherit tunnel variables, owner IPC เป็น singleton ที่ authenticated, readiness มาจาก `/ready`, restart มีเพดาน และ runtime close หยุดเฉพาะ live owned child ไม่มีการใช้ Cloudflare credential, API, DNS หรือ public network จริง

Global launcher และ interactive CLI tests พิสูจน์ว่า `dodo --cli` แสดง/เลือก/เพิ่ม
โปรเจกต์ได้, setup menu ระบุ cloudflared, launcher ไม่ใช้ invocation CWD หรือเผย
private inert root, anonymous MCP ยังได้ 401, OAuth installation login และ authenticated
catalog ใช้ได้ก่อนเลือก target แต่ tool invocation ไม่มี ACL, invalid target ไม่เปิดสิทธิ์
และ successful switch ใช้ real canonical root พร้อมบันทึก registry
preference Local Config Tunnel fixture พิสูจน์ซ้ำว่า unauthenticated request ถูกปฏิเสธ,
config endpoint ปฏิเสธ raw token, session endpoint ตอบ `tokenStored:false`, raw token
ไม่อยู่ใน response/config/audit และ owner เริ่ม/หยุด process-owned runtime ได้

Project Registry tests ครอบคลุม schema migration, Unicode/spaced canonical paths,
duplicate และ concurrent add, stable project ID, directory relocation, missing/
symlink/replaced readiness, corrupt metadata recovery, transactional audit, reviewed
soft removal, Local Config authentication/XSS boundary, ACL/trust isolation, runtime
workspace switch, Linux inode reuse, fail-closed v1 birth-time migration และ fresh
tarball CLI

Multi-project federation tests ใช้ HTTP + OAuth fixture จริงกับ Project A/B และ
พิสูจน์ concurrent overview/read/search โดย active root/epoch ไม่เปลี่ยน, target
identity/source hash, target-scoped audit, bounded partial failure, installation
identity + per-project ACL, live ACL revocation, stale active epoch, legacy grant
refusal, secret/traversal/replaced-root guards และ strict rejection เมื่อพยายามส่ง
`projectId` เข้า write operation Universal Resource, Project Brain และ Context Engine
operations และ Advanced Agent Runtime ทำให้ complete catalog เป็น 125; live default
เป็น Full 121 / Compact 19 / Hybrid 49 เพราะซ่อน Sub-agent operations จนกว่า owner จะเปิด

Universal Resource tests ใช้ HTTP + OAuth และ Compact gateway จริง ครอบคลุม text,
binary range/resume, image/audio MCP blocks, raster transform, PDF/ZIP metadata,
content hash dedup, concurrent ingest, restart persistence, expired-reference GC,
old crash-object recovery, disk/reference quotas, expected hash/MIME, corrupt
decoder input/CAS bytes, anonymous/read-only/revoked ACL, principal ownership,
stale epoch, private config state, secret/traversal/symlink/hardlink และ target-specific
inspect approval รวมถึง SQLite aggregate-quota trigger และ orphan grace ที่กัน GC
ชนกับการสร้าง reference

Project Brain tests ใช้ HTTP + OAuth, Full และ Compact gateway จริง ครอบคลุม bundled
TypeScript AST parser, symbols/references/imports/routes/tests/dependencies, incremental
one-file parse, affected relations, exact-content move ที่รักษา `symbol://` identity,
syntax error, deleted/generated/secret/private files, pagination, cancel/concurrent run,
restart/corruption recovery, source-hash freshness, anonymous/read-only/revoked ACL,
workspace epoch, traversal/symlink/hardlink, principal-bound cursor และ target-specific
inspect approval โดยไม่ execute source หรือ repository plugin

Context Engine tests ใช้ HTTP + OAuth, direct Full และ Compact gateway จริง ครอบคลุม
goal/Thai+identifier terms, deterministic ranking/evidence IDs, byte budget, cursor,
L0–L6 cache hit/metrics, source-hash freshness transition, evidence recheck, active และ
federated A/B retrieval by ID/name, unavailable target partial result, anonymous/live
ACL/revocation, principal/workspace/cursor binding, secret/private-state/symlink guards,
repository instruction เป็น untrusted content, canonical signed cursor, cache corruption
recovery, Memory dependency freshness และ Runtime dependency freshness Fixture
baseline มี precision=1 และ recall=1 สำหรับ source/test/docs ที่กำหนด พร้อม term
coverage=1 และ latency ต่ำกว่า 5 วินาทีใน isolated local fixture (ไม่ใช่ production SLA)

Memory tests ใช้ HTTP + OAuth, Full/Compact assistance gateways และ authenticated
private owner IPC จริง ครอบคลุม evidence-bound proposal, exact digest approval,
CURRENT/STALE retrieval, Context `MEMORY` evidence, source change ก่อน/หลัง approval,
cross-client evidence isolation, live per-project ACL, explicit cross-project visibility,
duplicate/conflict review, credential-shaped text, repository prompt injection,
principal/workspace-bound canonical cursor, retention/prune ที่ไม่ลบ current record หรือ
project file, learning proposal จาก current reviewed memory, non-executable owner review
และ scrubbed owner audit

Runtime Intelligence tests ใช้ HTTP + OAuth และ Compact gateways จริง ครอบคลุม
durable session, nonblocking task start, completed-task reconnect หลัง server restart,
idempotent retry ที่ไม่สร้าง job ซ้ำ, cancel, wall timeout, close refusal ขณะ running,
process/test aggregate evidence, raw-output non-retention, guarded test-report counts,
snapshot staleness, Context `OBSERVATION`, deterministic diagnosis, anonymous/read-only/
revoked ACL, principal isolation, stale epoch, secret/traversal report path และ quota
Headless Chromium fixture พิสูจน์ existing-session-only collection, MCP image passthrough
persisted hashes/counts/bounded navigation timing, WebSocket-blocked policy และการ mark
หลักฐานเดิมเป็น stale หลังหน้าเปลี่ยน โดยไม่มี DOM/console/password/header text

Advanced Agent Runtime tests ใช้ HTTP + OAuth และ Compact gateways จริง ครอบคลุม
immutable plan revision, bounded hypotheses, overlapping intent refusal, managed
write/exec/read, metadata snapshot compare + original-journal rollback, current Runtime
evidence judgement, exact completion criteria, durable restart recovery และ private
owner skill review Security fixtures ครอบคลุม anonymous/read-only, principal isolation,
live ACL revoke, stale epoch, path capability + intent, secret/traversal/nested context,
program allowlist, target-bound inspect approval, hostile skill rejection และยืนยันว่า
cancel coordinator ไม่ kill owned job

Resource และ Project Brain cursor tests ตรวจ canonical Base64URL + HMAC ซ้ำ โดย token
ที่เปลี่ยนอักขระท้ายต้องได้ `INVALID_INPUT` แม้ decoder จะถอด non-canonical text เป็น
byte sequence เดียวกันได้

Headless Chromium fixture เปิด Local Config จริงที่ ephemeral loopback ports เพิ่ม
Project B ผ่าน UI, แสดงผลที่ desktop และ 390px, กดเปิดรายการ และตรวจว่า active
workspace เปลี่ยนเป็น canonical root B สำเร็จ ภาพอยู่ใน local ignored artifacts และ
ไม่ถูก pack การตรวจบน owner browser/config จริงยังคง `MANUAL_NOT_RUN`

## Surface evidence

- Complete Full capability schema: 125 tools
- Full live default: 121 tools; owner opt-in Sub-agent exposure: 125
- Compact surface: 19 tools
- Hybrid surface: 49 tools
- generated schema metric: Full 443,030; Compact 52,317; Hybrid 124,657 bytes
- Compact schema เป็น catalog แยกและลด schema load ตอนเชื่อมต่อ
- Full schema อยู่ใน `schemas/tools.json`
- Compact schema อยู่ใน `schemas/tools.compact.json`
- Hybrid schema อยู่ใน `schemas/tools.hybrid.json`

## DodoBench / release gate

DodoBench core v1 ใช้ isolated real HTTP + OAuth fixtures ประเมิน 7 เคสบนเครื่องที่มี
Chromium: retrieval A/B, safe edit, runtime diagnosis, image resource, restart recovery,
security boundaries และ browser image block ผลแต่ละรอบบันทึก revision/lock/config/OS,
tool calls, serialized bytes, p50/p95, precision/recall, wrong-file rate, cache hit และ
security violations โดย `modelTokens=null` เพราะไม่มี model call

Fresh release smoke ติดตั้ง exact tarball ใน temporary prefix เปิด Sub-agent exposure
แบบ explicit แล้วตรวจ CLI 1.0.0, STDIO Full 125, HTTP Streamable + OAuth Compact 19,
write/edit read-back และ Sub-agent receipt จริง ค่า default-off ถูกตรวจแยกใน STDIO/HTTP/
packaging regressions
นโยบายปัจจุบันใช้ macOS local และ Linux native GitHub Actions โดย report ต้องมี
clean revision/source fingerprint/lock digest ตรงกันก่อน strict gate จะผ่าน
Dedicated self-hosted GitHub Actions รัน Linux X64 และ Windows X64 โดยตรงบน
Node 22/24 โดยไม่รับ untrusted pull requests Windows manual acceptance
ยังคง `MANUAL_NOT_RUN` ดู [CI](CI.md) สำหรับ prerequisites

## Required security scenarios

- anonymous HTTP request ได้ 401
- read-only scope เรียก write/exec ไม่ได้
- managed mode: token ที่ไม่มี workspace ACL ถูกปฏิเสธ; personal mode ยังต้องมี owner-registered target และ live scope
- workspace mismatch และ stale epoch ถูกปฏิเสธ
- secret, traversal, symlink และ hardlink guard fail closed
- inspect mode ยังคง target approval
- expected hash conflict ไม่ overwrite ไฟล์
- running jobs block workspace switch
- switch failure ทำให้ workspace เดิมใช้งานต่อได้
- gateway ไม่เรียก gateway อื่นหรือ owner controls
- federated target ที่ไม่มี ACL/installation identity ถูกปฏิเสธโดยไม่เผย path
- federated secret/traversal/replaced root fail closed และ write/exec federation ยังปิด
- memory proposal ใช้ evidence ID ข้าม client ไม่ได้และ source-changed proposal fail closed
- AI ไม่มี MCP operation สำหรับ memory approval/prune/learning review; owner action ใช้ private authenticated IPC + digest
- current memory ไม่ถูก prune และ learning approval ไม่ติดตั้ง/execute หรือ grant authority
- runtime handle ข้าม principal/workspace ไม่ได้, revoke มีผลทันที และ inspect exec ยังต้อง target-bound approval
- runtime evidence ไม่เก็บ raw process/browser secret และ changed source ถูก mark stale
- agent run ไม่เพิ่ม authority, managed target ตรวจ live ACL/epoch/scope/policy ซ้ำ และ path write ต้องมี capability + intent
- agent skill ที่ยังไม่ผ่าน exact private owner review ถูกซ่อนและไม่ executable
- agent coordinator cancel/pause ไม่ kill job และ restart ไม่ replay action

## Packaging

ตรวจว่า tarball มี `dist`, `schemas`, `docs`, `README.md`, setup scripts และ native sources ตาม package policy และไม่มี state DB, OAuth credentials, tokens, models หรือ release temp files

## Manual gates

การทดสอบผ่าน ChatGPT, Claude หรือเครื่อง Windows จริงต้องทำใน environment ของผู้ใช้และรายงานแยกเป็น `MANUAL_PASS` หรือ `MANUAL_NOT_RUN` ห้ามสรุปจาก catalog, macOS หรือ Linux Docker เพียงอย่างเดียว

สถานะ manual setup/import บน owner state จริง: `MANUAL_NOT_RUN` การตรวจรับใช้ isolated fixtures และ temporary package เท่านั้น ไม่มีการเปลี่ยน owner config, OAuth state, tunnel, DNS หรือ global installation

สถานะ live Cloudflare connection/clean-stop smoke บน macOS/Windows/Linux:
`MANUAL_PASS` (2026-09-15, run 34908481066); public DNS → MCP/OAuth/Remote Config
end-to-end บนอุปกรณ์ภายนอก: `MANUAL_NOT_RUN`

สถานะ multi-project federation ผ่าน external AI และ owner project จริง: `MANUAL_NOT_RUN`

สถานะ owner-reviewed Memory ผ่าน external AI และ owner repository จริง: `MANUAL_NOT_RUN`

สถานะ Runtime Intelligence ผ่าน external AI และ owner repository จริง: `MANUAL_NOT_RUN`

สถานะ Advanced Agent Runtime ผ่าน external AI และ owner repository จริง: `MANUAL_NOT_RUN`

## Unreleased R03 candidate — 2026-09-20 (AUTOMATED_PASS)

Final source/test/gate fingerprint: `sha256:e8e638e493bbdacf27f39221178ba29005c9c094348c4cca2cbec19f7ad15f5b`.

| Gate | macOS arm64 / Node 22.23.2 | Linux Docker arm64 / Node 22.23.2 |
|---|---:|---:|
| Build, typecheck, lint | exit 0 | exit 0 |
| Core (124 files / 851 tests) | 816 pass / 35 skip / 0 fail | 810 pass / 41 skip / 0 fail |
| Packaging | 17 pass / 0 fail | 17 pass / 0 fail |
| Production npm audit | 0 vulnerabilities | 0 vulnerabilities |
| Headless desktop/narrow owner UI | pass | pass |
| Exact tarball install and HTTP OAuth / STDIO | packaging smoke pass | release smoke pass |

R03 exercises persistent same-size/mtime drift, 54 overwrites + 2 deletions, original/emergency snapshot separation, unknown-author job observation, unchanged/non-target writes, nested ignore rules, deadline/raced hash failures, exact owner acknowledgement and revoked/stale authority. Independent Git tests cover staged secrets, hooks/filters, preserved index/HEAD/config, unborn/detached/parent/linked-worktree repositories, large blobs, unavailable backup volumes, quotas, and uncertain final journal persistence. Existing restore crash, OAuth, ACL, sandbox and path guard suites remain enabled.

A separate disposable disaster fixture deleted the original root, working `.git` and CAS objects. On both platforms two approved files were recovered byte-for-byte from independent bare Git objects into a NEW directory; excluded credentials/database data were not restored. This demonstrates an owner-directed recovery procedure, not permission to override the original runtime's root identity.

Environment-specific 200-file × 8 KiB scan measurements: unchanged source 63 ms macOS / 151 ms Docker; 54 overwrites + 2 deletions including emergency copy 2316 ms / 1382 ms. The default scan budget is 15000 ms; these small fixtures do not establish performance for all repositories. Linux DodoBench also passed its seven existing cases.

Earlier failed rounds are retained privately: a legacy-schema fixture omitted new tables; a new test used the wrong fixture accessor; expected transport/error assertions were corrected to their actual typed contract. Final gates above reran the complete suite. Detailed logs, manifests, screenshots and checksums stay in private development evidence and are excluded from npm.

MANUAL_NOT_RUN: live owner projects, native Windows/Android, physical removable-drive removal, live ChatGPT and external provider credentials. Automated browser tests are not manual acceptance. No npm publish or owner-server restart was performed.

## Unreleased R04 candidate — 2026-09-20 (AUTOMATED_PASS)

Source fingerprint (both gates):
`sha256:fb79ab8f05a095b47545299af30e0dabb48633a2a547e3025990101688c375bc`.
This is a dirty development candidate, not the published package with the same
version metadata. No release readiness claim is made.

| Platform | Core | Packaging | Skipped | Failures |
|---|---:|---:|---:|---:|
| macOS arm64, Node 22.23.2 | 833 passed / 868 | 17 passed | 35 | 0 |
| Linux Docker arm64, Node 22.23.2 | 827 passed / 868 | 17 passed | 41 | 0 |

`npm run build`, `npm run test:all` (including typecheck/lint), packaging and
installed-package checks exited 0. Linux additionally passed the 7-case DodoBench
and exact-tarball fresh-install smoke (Full STDIO 148; HTTP/OAuth Compact 20,
write/edit/read-back and target routing). Production dependency audits reported
0 vulnerabilities on both platforms. Platform/optional skips remain explicit in
private machine reports; skipped tests are not passes.

17 new R04 cases cover actual passing/failing/skipped/truncated/unknown/inconsistent
recipe output, manifest/recipe/runtime drift, caller isolation, owner expiry,
revision races/tombstones, immutable snapshots, protected pin/name retention,
OAuth read-only/revoked ACL, rejected model-supplied status, private/public admin
separation and hostile Origin/proxy headers. Browser fixtures on desktop/390px
register a project with Recovery on, edit through MCP, verify, pin/name, detect
stale source, restore/read back, and show a real quota reservation failure. Existing
restore/crash/hash/secret/sandbox tests remain enabled. UI assets are included in
the tarball and do not use external CDNs.

MANUAL_NOT_RUN: owner's live projects/storage, native Windows, Android and live
ChatGPT. Production/database recovery is not implemented in R04. Browser fixture
screenshots are automated evidence, not manual owner acceptance. The first local
Docker build failed because its daemon was off; the completed container gate above
was run after starting Docker. Early test-fixture mistakes were corrected without
relaxing security/schema assertions and remain in private logs.

## Unreleased deployment/data recovery candidates — 2026-09-20

R05 source fingerprint `sha256:548622178672a0baf317c33db634d17e33a1d28595781c48d9e18c4a4020b5c5`:
macOS core135files910total874passed36skipped0failed; packaging17/17. Native Linux
Node22+24 in run35503836757 each868passed42skipped0failed; packaging17/17,
benchmark7/7, production audit0 and fresh tarball installPASS. All gate commands
exit0. Disposable actual Docker acceptance separately passed (26.12s), including
source/image tampering, unhealthy deployment, exact image rollback, source restore,
unchanged SQLite/private volume data and reviewed probe/image cleanup.

Initial R06 source fingerprint `sha256:77595e3557db592479fcb32c41324d2fdd7f441d10560622343c9f13a040a4c5`:
macOS Node22 core141files929total892passed37skipped0failed; packaging17/17,
benchmark7/7,audit0,fresh tarball installPASS; all gate commands exit0. Browser
fixture exercises SQLite registration, encrypted config backup/redacted review/
restore, real file read-back, CLI and desktop/narrow layouts. Crypto fixtures use
an explicitly injected key store; a separate actual macOS Keychain random-item
put/read/delete test also passed. Helper protocol fixtures cover secret stdin,
fixed references and failure behavior for macOS/Windows/Linux.

These snapshots predate final combined changes and are not release authorization.
Native Windows R04 focus35503022077 used native .NET ACL checks (20checks718ms),
75/78passed;3failures remained in drift tests. The earlier full Windows run failed.
Those failures remain recorded and are not replaced with skipped assertions.
Subsequent fixes require new exact-source native gates. Live owner production,
manual ChatGPT, Linux Secret Service and Windows Credential Manager acceptance
are MANUAL_NOT_RUN unless a later result explicitly records them. Database row
rollback/PITR is NOT_SUPPORTED; no such result is implied by source recovery.
