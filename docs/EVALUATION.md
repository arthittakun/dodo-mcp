# DodoBench และ Release Gate

DodoBench เป็นชุดประเมินแบบ deterministic สำหรับ source checkout ของ DODO MCP
ใช้ fixture แยกและเรียก HTTP + OAuth + Compact gateways จริง โดยไม่จำลองชั้น
authorization หรือ policy ผลจึงบอกได้ว่า contract หลักยังทำงานร่วมกัน แต่ไม่ใช่
คะแนนความสามารถของโมเดล AI และไม่ใช่ production latency SLA

## สิ่งที่วัด

Baseline `benchmarks/dodobench-core-v1.json` ครอบคลุม:

- retrieval ข้ามโปรเจกต์ที่ client มี ACL และ context cache hit
- diagnosis/edit ที่แก้เฉพาะไฟล์เป้าหมายด้วย expected hash
- runtime task, test-report evidence และ diagnosis
- binary resource และ MCP image content block
- durable Agent Runtime หลัง server restart
- anonymous OAuth, read-only scope, secret path, stale epoch และ inspect approval
- browser screenshot แบบ optional เมื่อมี Playwright Chromium

รายงานมี success rate, wrong-file edit rate, context precision/recall, cache hit,
จำนวน tool calls, serialized request/response bytes, latency, human intervention และ
security violations ค่า `modelTokens` เป็น `null` เสมอ เพราะ suite นี้ไม่เรียกโมเดล
และไม่เดาจำนวน token

```bash
npm run bench
node scripts/dodo-bench.mjs --output release-evidence/1.0.0/dodobench.json
```

ทุก report ผูกกับ Git revision, dirty state, dataset version/digest, Node/OS/arch,
`package-lock.json` digest และ configuration digest ผลจาก revision หรือ lock คนละชุด
จึงไม่ควรนำมาเทียบเป็น baseline เดียวกันโดยไม่ตรวจ metadata

## Candidate release gate

```bash
npm run release:gate
```

คำสั่งนี้รัน build, typecheck, lint, test suite, DodoBench, production dependency
audit, immutable `npm pack` manifest/checksum และ fresh exact-tarball smoke ซึ่งตรวจ
`dodo --version`, STDIO Full 125 tools, Streamable HTTP + OAuth Compact 19 tools และ
write → read → edit → read-back ผ่าน Compact gateway

หลักฐาน non-secret ถูกเขียนใต้ `release-evidence/<version>/` ซึ่งถูก ignore ทั้ง Git
และ npm package สคริปต์ไม่ publish npm, ไม่แก้ tunnel/DNS และไม่แตะ owner state จริง

## Platform gates

macOS รันจาก owner checkout ส่วน Linux gate เดียวกันรันได้ทั้ง local Docker และ
dedicated self-hosted GitHub Actions runner:

```bash
# macOS บน checkout ปัจจุบัน
npm run release:gate

# Linux จริงใน Docker image แยก พร้อม Playwright Chromium
npm run test:linux:docker
```

Docker build ไม่รับ `.git`, `.npmrc`, `.env`, model, release evidence หรือเอกสารพัฒนา
private เข้า build context ตัว runner ส่งเฉพาะ revision/dirty state ที่อ่านจาก host Git
เข้า release gate และ DodoBench ผ่าน environment attestation ที่รับได้เฉพาะใน Linux
container จากนั้นตรวจ report กลับว่าตรงกับ revision และ lock digest เดิม

`.github/workflows/platform-gates.yml` ใช้ self-hosted labels `linux-ci` และ
`windows-ci 02` ทดสอบ Node 22/24 เฉพาะ push ที่ `main` กับ manual dispatch ไม่มี
`pull_request` trigger เพราะ repository เป็น public และ untrusted PR ต้องไม่ execute
บนเครื่อง runner ของเจ้าของ Actions dependencies ถูก pin ด้วย commit SHA และ token
มีเพียง `contents: read`

`npm run release:gate:strict` ต้องใช้ source ที่ clean และมี macOS/Linux evidence จาก
revision กับ `package-lock.json` เดียวกัน Windows ถูกระบุเป็น
`DEFERRED_MANUAL_NOT_RUN` และไม่ถูกนับเป็น supported release platform ในช่วงนี้
Manual external-AI, owner workspace และ Windows 11 อยู่แยกเป็น `MANUAL_NOT_RUN`
Strict gate รับ Linux evidence เฉพาะ `docker-host-git` จาก clean checkout พร้อม
fresh-install PASS จึงไม่รับ candidate ที่มี uncommitted source หรือ report จาก runner
ชนิดอื่น Report บันทึก origin ว่ามาจาก local หรือ GitHub Actions ตามจริง ไม่มีคำสั่ง
เหล่านี้ publish npm

## Security invariants

Benchmark และ release gate ไม่มีสิทธิ์พิเศษ ไม่มีทาง approve action, เพิ่ม ACL/trust,
ปิด sandbox, เปิด network/desktop หรืออ่าน secret paths ทุก operation ผ่าน target tool
definition และ security pipeline เดิม ผล benchmark ที่ผ่านไม่สามารถลด policy หรือ
แทน manual/platform evidence ได้
