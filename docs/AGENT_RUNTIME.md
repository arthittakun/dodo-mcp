# DODO Advanced Agent Runtime

Advanced Agent Runtime เป็นชั้นประสานงานสำหรับงานพัฒนาที่ต้องวางแผน ทดลองหลาย
สมมติฐาน เก็บหลักฐาน และกู้สถานะหลัง reconnect/restart โดยไม่สร้างสิทธิ์ใหม่ให้ AI

## วงจรการทำงาน

```text
Goal → Context → Plan → Act → Observe → Verify → Diagnose → Repair → Verify
```

ตัวอย่างผ่าน Compact/Hybrid surface:

```text
dodo_assist_change(operation="agent_run_open", args={
  goal: "แก้ callback ที่คืนสถานะผิด",
  completionCriteria: ["targeted tests pass", "no unrelated file changes"],
  capabilities: {
    allowedProjectIds: [],
    writablePaths: ["src/auth", "tests/auth"],
    allowedPrograms: ["npm"],
    allowNetwork: false,
    allowBrowser: false,
    allowDesktop: false,
    allowMedia: false,
    allowWorkflow: false,
    secretAccess: false,
    maxHypotheses: 3,
    maxActions: 50,
    maxRunningJobs: 1,
    maxWallMinutes: 60
  }
})

dodo_assist_change(operation="agent_plan_set", args={...})
dodo_assist_change(operation="agent_hypothesis_open", args={...})
dodo_assist_change(operation="agent_intent_acquire", args={...})
dodo_write(operation="agent_write", args={
  runId: "arun_...",
  hypothesisId: "ahyp_...",
  operation: "edit_file",
  args: {path: "src/auth/callback.ts", edits: [...], expectedHash: "sha256:..."}
})
```

Full surface เปิด operations รายตัว 17 รายการ:

```text
agent_run_open
agent_run_status
agent_plan_set
agent_hypothesis_open
agent_intent_acquire
agent_intent_release
agent_read
agent_write
agent_exec
agent_snapshot_create
agent_snapshot_compare
agent_snapshot_rollback
agent_hypothesis_judge
agent_skill_search
agent_skill_inspect
agent_skill_propose
agent_run_control
```

Compact/Hybrid ใช้ `dodo_assist_read`, `dodo_assist_change`, `dodo_write` และ
`dodo_exec` โดยอ่าน schema ล่าสุดจาก `dodo_discover`

## Authority และ capabilities

Run ผูกกับ principal, active workspace และ workspace epoch และมี
`authority: coordination_only` Capabilities ของ run ลดขอบเขตจากสิทธิ์ที่ caller มี
อยู่แล้วเท่านั้น:

- `allowedProjectIds` ต้องเป็น project ที่ caller อ่านได้ในขณะเปิด run
- `writablePaths` จำกัด path เพิ่มจาก WorkspaceFS/path/secret policy เดิม
- `allowedPrograms` จำกัด executable เพิ่มจาก trusted resolver เดิม
- network/browser/desktop/media/workflow ปิดเป็นค่าเริ่มต้นและต้องเปิดต่อ run
- `secretAccess` เป็น `false` เท่านั้น
- hypothesis, action, running-job และ wall-time quota มีเพดานต่อ run

ทุก managed action เรียก target definition ผ่าน invocation pipeline ปกติ จึงตรวจ
OAuth scope, installation identity, live workspace ACL, workspace ID/epoch, trust,
target-bound approval, strict input schema, expected hash, path/secret/link guards,
command sandbox, caller idempotency และ audit อีกครั้ง Run ID, plan, hypothesis,
intent, snapshot, evidence หรือ skill ไม่ใช่ capability

## Plan, hypothesis และ intent

`agent_plan_set` เพิ่ม immutable revision โดยใช้ `expectedRevision` และปฏิเสธ dependency
ที่หาย, self-reference หรือ cycle แต่ plan ไม่ execute operation

แต่ละ hypothesis ระบุ probable cause และ expected evidence การเขียนต้องถือ active
path intent ที่ครอบทุก path และ path ต้องอยู่ใน `writablePaths` ของ run ด้วย Intent
ที่ overlap กันระหว่าง active hypotheses ถูกปฏิเสธ จึงไม่ให้ candidate สองตัวเขียนทับ
พื้นที่เดียวกันพร้อมกัน Symbol/resource intent ใช้ประสานงานเท่านั้นและไม่แทน filesystem
หรือ resource permission

## Managed read, write และ exec

- `agent_read` เรียก read-scope target ใน Full core catalog
- `agent_write` เรียก write-scope target ยกเว้น raw rollback; rollback หลัง snapshot
  ใช้ `agent_snapshot_rollback`
- `agent_exec` รับเฉพาะ target ที่ใช้ explicit program/argv หรือ owned runtime handle
  และไม่เปิด `run_command`, `run_commands`, `schedule_propose`, `job_input` หรือ
  `job_cancel`

Command ยังรันด้วยสิทธิ์ OS ของผู้ใช้ตาม trust/sandbox ที่เจ้าของตั้งไว้ Coordinator
ไม่มี owner control และ pause/cancel run จะไม่ kill job หากต้องหยุด process ต้องเรียก
operation ของ JobManager/Runtime ที่เป็นเจ้าของ handle โดยตรง

## Snapshot, evidence และ recovery

Snapshot เก็บเฉพาะ guarded file metadata, manifest hash และ changeset baseline ไม่เก็บ
file contents การ compare แสดง path metadata ที่เปลี่ยนและ caller-owned committed
changesets ที่สร้างหลัง snapshot การ rollback ต้องระบุ snapshot + changeset ที่ตรงกัน,
ถือ path intent และผ่าน `rollback_changes` journal/conflict/approval/idempotency เดิม

Hypothesis judgement และ completion ต้องอ้าง caller-owned `CURRENT` Runtime evidence
ที่ revalidate ได้ Completion ต้องมีผล passed สำหรับ completion criteria ทุกข้อความแบบ
exact match จึงเปลี่ยนสถานะเป็น `COMPLETED`

หลัง server restart action ที่ค้าง `RUNNING` จะเป็น `INTERRUPTED` พร้อม
`SERVER_RESTARTED` และ run epoch เก่าจะเป็น `RECOVERY_REQUIRED` เจ้าของงานต้องอ่าน
status แล้วเรียก `agent_run_control(action="recover")` อย่างชัดเจน ระบบไม่ replay
effectful action และไม่ signal stored PID

## Reusable skills

AI เสนอ guidance ได้ด้วย `agent_skill_propose` แต่ proposal ถูกซ่อนจาก search จนกว่า
เจ้าของจะตรวจ exact digest ผ่าน private authenticated IPC:

```bash
dodo agent skill pending
dodo agent skill show askillprop_xxxxxxxxxxxx
dodo agent skill approve askillprop_xxxxxxxxxxxx --digest sha256:...
# หรือ
dodo agent skill reject askillprop_xxxxxxxxxxxx --digest sha256:...
```

Approved skill มี version แบบ immutable และ `authority: untrusted_guidance` เสมอ
`agent_skill_search` คืนเฉพาะ metadata; `agent_skill_inspect` จึงเปิด steps ของ version
ที่ผ่าน review Skill ไม่ถูกติดตั้งเป็น code, ไม่ execute เอง และไม่ grant scope, ACL,
trust, approval, sandbox exception, network หรือ owner permission

## ข้อจำกัด

- มี active workspace เดียวต่อ DODO process; federation ใน run ยังคง read-only
- Coordinator ไม่ใช่ autonomous daemon และไม่เฝ้าหรือแก้ project เองนอก MCP call
- ไม่มี unrestricted shell, hidden owner control หรือ automatic approval
- snapshot เป็น metadata comparison ไม่ใช่ VM/filesystem snapshot
- cancel/pause run ไม่หยุด process และไม่ลบ workspace files
