# DODO MCP — Test Report

## Scope

รายงานนี้ใช้กับ DODO MCP 1.0.0 baseline และแยกผล automated กับ manual อย่างชัดเจน

## Automated gates

```bash
npm run build
npm run typecheck
npm run lint
npm run test:all
npm audit --omit=dev
npm pack
```

ชุดทดสอบครอบคลุม transport, OAuth, Local Config, workspace switching, ACL, stale context, path/secret guards, changes, jobs, Git, semantic tools, assistance, multimodal, browser, workflow, surface catalog และ packaging

## Surface evidence

- Full surface: 74 tools
- Compact surface: 19 tools
- Hybrid surface: 49 tools
- Compact schema เป็น catalog แยกและลด schema load ตอนเชื่อมต่อ
- Full schema อยู่ใน `schemas/tools.json`
- Compact schema อยู่ใน `schemas/tools.compact.json`
- Hybrid schema อยู่ใน `schemas/tools.hybrid.json`

## Required security scenarios

- anonymous HTTP request ได้ 401
- read-only scope เรียก write/exec ไม่ได้
- token ที่ไม่มี workspace ACL ถูกปฏิเสธ
- workspace mismatch และ stale epoch ถูกปฏิเสธ
- secret, traversal, symlink และ hardlink guard fail closed
- inspect mode ยังคง target approval
- expected hash conflict ไม่ overwrite ไฟล์
- running jobs block workspace switch
- switch failure ทำให้ workspace เดิมใช้งานต่อได้
- gateway ไม่เรียก gateway อื่นหรือ owner controls

## Packaging

ตรวจว่า tarball มี `dist`, `schemas`, `docs`, `README.md`, setup scripts และ native sources ตาม package policy และไม่มี state DB, OAuth credentials, tokens, models หรือ release temp files

## Manual gates

การทดสอบผ่าน ChatGPT, Claude หรือเครื่อง Windows จริงต้องทำใน environment ของผู้ใช้และรายงานแยกเป็น `MANUAL_PASS` หรือ `MANUAL_NOT_RUN` ห้ามสรุปจาก catalog เพียงอย่างเดียว
