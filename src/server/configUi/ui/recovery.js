/* Owner Recovery dashboard. All untrusted values use textContent; no HTML injection. */
'use strict';
window.DodoRecovery=({el,section,button,check,field,choice,notice,confirmDanger,help,api,refresh,getSelected})=>{
  function groupCard(step,title,desc){
    const box=el('div',undefined,'rec-group');
    const head=el('div',undefined,'rec-group-head');
    const h=el('h3',undefined,'rec-group-title');
    h.append(el('span',String(step),'rec-group-step'),document.createTextNode(title));
    head.append(h);
    if(desc)head.append(el('p',desc,'rec-group-desc'));
    box.append(head);
    return box;
  }

  function statCard(label,val,sub){
    const box=el('div',undefined,'rec-stat');
    box.append(el('div',label,'rec-stat-label'),el('div',String(val),'rec-stat-val'));
    if(sub)box.append(el('div',sub,'rec-stat-sub'));
    return box;
  }

  async function gitRecoverySection(parent,act,data,selected){
    const box=section('การกู้คืนจาก Git · Git Recovery','เมื่อโปรเจกต์เชื่อม Git ระบบสามารถสร้างจุดกู้คืน ดู Diff และย้อนไฟล์จาก Git Checkpoint หรือ Git Commit ได้โดยตรง โดยไม่กระทบ branch หรือ .git/index ของคุณ');
    parent.append(box);
    const body=el('div');box.append(body);
    const previewBox=el('div');box.append(previewBox);

    const loadGit=async()=>{
      body.replaceChildren(el('p','กำลังตรวจสอบสถานะ Git ของโปรเจกต์…','wb-status'));
      previewBox.replaceChildren();
      try{
        const g=await act('recovery.git.status',{limit:20});
        body.replaceChildren();
        if(!g.isRepo){
          const empty=el('div',undefined,'rec-alert');
          empty.dataset.tone='info';
          empty.append(
            el('p','โปรเจกต์นี้ยังไม่ได้เชื่อมต่อ Git (.git)','rec-alert-title'),
            el('p','ระบบจึงใช้โหมด DODO Snapshot อัตโนมัติ หากคุณเริ่มต้นใช้งาน Git (git init) ในโฟลเดอร์โปรเจกต์ ระบบจะเปิดใช้งาน Git Recovery ให้ทันที','muted')
          );
          body.append(empty);
          return;
        }
        const stats=el('div',undefined,'rec-stats');
        stats.append(
          statCard('Branch ปัจจุบัน',g.branch||'Detached HEAD',g.head?`HEAD: ${g.head.slice(0,12)}`:'ยังไม่มี commit แรก'),
          statCard('ไฟล์ที่แก้ไขค้าง (Modified)',`${g.dirtyCount} ไฟล์`,g.untrackedCount?`ไฟล์ใหม่ยังไม่อ้างอิง (Untracked): ${g.untrackedCount} ไฟล์`:'ไม่มีไฟล์ Untracked'),
          statCard('DODO Git Checkpoints',`${g.checkpoints.length} จุดกู้คืน`,'เก็บใน refs/dodo/checkpoints/* แยกจาก branch'),
          statCard('Git Commits ล่าสุด',`${g.commits.length} รายการ`,'สามารถเลือกดู Diff หรือกู้คืนไฟล์จาก commit ใดก็ได้')
        );
        body.append(stats);

        if(g.entries&&g.entries.length){
          const dirtyDetails=el('details',undefined,'details');
          dirtyDetails.append(el('summary',`ดูรายการไฟล์ที่กำลังเปลี่ยนแปลงใน Working Tree (${g.entries.length} รายการ)`));
          const pillList=el('ul',undefined,'rec-path-list');
          for(const item of g.entries){
            pillList.append(el('li',`${item.status} · ${item.path}`,'rec-path-pill'));
          }
          dirtyDetails.append(pillList);
          body.append(dirtyDetails);
        }

        const pathFilter=field(body,'ระบุไฟล์หรือโฟลเดอร์ที่ต้องการกู้คืนจาก Git (เว้นว่างเพื่อกู้คืนทุกไฟล์ที่ต่างกัน)','gitRestorePath','');
        pathFilter.placeholder='เช่น src/lib/env.ts หรือเว้นว่างเพื่อเลือกทั้งหมด';

        const actions=el('div',undefined,'rec-action-bar');
        actions.append(
          button('สร้าง Git Checkpoint ตอนนี้',async()=>{
            const cp=await act('recovery.git.checkpoint');
            notice(`สร้าง Git Checkpoint สำเร็จ (${cp.id})`);
            await loadGit();
          },'btn primary'),
          button('รีเฟรชข้อมูล Git',loadGit)
        );
        body.append(actions);

        const showGitPreview=async(ref,label)=>{
          previewBox.replaceChildren(el('p',`กำลังเปรียบเทียบไฟล์ปัจจุบันกับ ${label} (${ref})…`,'wb-status'));
          try{
            const rawPaths=pathFilter.value.split('\n').flatMap(s=>s.split(',')).map(s=>s.trim()).filter(Boolean);
            const p=await act('recovery.git.preview',{ref,...(rawPaths.length?{paths:rawPaths}:{})});
            const boxView=el('div',undefined,'rec-diff-box');
            boxView.append(
              el('h4',`ตรวจสอบ Diff ก่อนกู้คืนจาก Git: ${label}`),
              el('p',`Commit SHA: ${p.resolvedSha} · พบไฟล์ที่ต่างจากสถานะปัจจุบัน ${p.changedFiles.length} ไฟล์`,'muted')
            );
            if(!p.changedFiles.length){
              boxView.append(el('p','ไฟล์ในโปรเจกต์ปัจจุบันตรงกับจุดกู้คืน Git นี้อยู่แล้ว ไม่มีการเปลี่ยนแปลงที่ต้องกู้คืน','wb-status'));
              previewBox.replaceChildren(boxView);
              return;
            }
            const filePills=el('ul',undefined,'rec-path-list');
            for(const f of p.changedFiles){
              filePills.append(el('li',`${f.status} · ${f.path}`,'rec-path-pill'));
            }
            boxView.append(filePills);
            if(p.diff){
              boxView.append(el('pre',p.diff));
            }
            const restoreBtn=button('ยืนยันกู้คืนไฟล์จาก Git จุดนี้',async()=>{
              if(!await confirmDanger('กู้คืนไฟล์จาก Git?',`ระบบจะสร้าง Git Checkpoint สำรองสถานะปัจจุบันให้อัตโนมัติก่อน แล้วจึงย้อนไฟล์ ${p.changedFiles.length} รายการกลับไปยัง ${label} (${p.resolvedSha.slice(0,10)})`,'กู้คืนจาก Git'))return;
              const res=await act('recovery.git.restore',{
                ref:p.resolvedSha,
                ...(rawPaths.length?{paths:rawPaths}:{}),
                workspaceId:selected.workspaceId,
                workspaceEpoch:selected.workspaceEpoch,
                confirm:true,
              });
              notice(`กู้คืนไฟล์จาก Git สำเร็จ (${res.restoredFiles.length} ไฟล์) · สำรองก่อนกู้ไว้ที่ ${res.backupCheckpointId}`);
              await loadGit();
            },'btn primary');
            boxView.append(restoreBtn);
            previewBox.replaceChildren(boxView);
            restoreBtn.focus();
          }catch(e){
            previewBox.replaceChildren(el('p','ตรวจสอบ Diff จาก Git ไม่สำเร็จ: '+e.message,'wb-status'));
          }
        };

        const cols=el('div',undefined,'rec-git-columns');
        const cpCol=el('div',undefined,'rec-group');
        cpCol.append(el('h4','DODO Git Checkpoints (จุดกู้คืนอัตโนมัติ/กดสร้างเอง)'));
        const cpList=el('div',undefined,'rec-git-list');
        if(!g.checkpoints.length){
          cpList.append(el('p','ยังไม่มี Git Checkpoint — กดปุ่ม “สร้าง Git Checkpoint ตอนนี้” เพื่อสร้างจุดกู้คืนแรกได้เลย','muted'));
        }
        for(const cp of g.checkpoints){
          const item=el('div',undefined,'rec-item-card');
          const head=el('div',undefined,'rec-item-head');
          head.append(el('b',cp.id),el('code',cp.sha.slice(0,10)));
          item.append(
            head,
            el('p',`${cp.subject||'DODO Git checkpoint'} · ${cp.date?new Date(cp.date).toLocaleString('th-TH'):''}`,'muted'),
            el('div',undefined,'rec-item-actions')
          );
          item.lastChild.append(button('ดู Diff & กู้คืน',()=>showGitPreview(cp.ref,cp.id),'btn small'));
          cpList.append(item);
        }
        cpCol.append(cpList);

        const commitCol=el('div',undefined,'rec-group');
        commitCol.append(el('h4','Git Commits ล่าสุดของโปรเจกต์ (git log)'));
        const commitList=el('div',undefined,'rec-git-list');
        if(!g.commits.length){
          commitList.append(el('p','ยังไม่มีประวัติ git commit ใน branch ปัจจุบัน','muted'));
        }
        for(const c of g.commits){
          const item=el('div',undefined,'rec-item-card');
          const head=el('div',undefined,'rec-item-head');
          head.append(el('b',c.subject||'(ไม่มีข้อความ commit)'),el('code',c.sha.slice(0,10)));
          item.append(
            head,
            el('p',`${c.author} · ${c.date?new Date(c.date).toLocaleString('th-TH'):''}`,'muted'),
            el('div',undefined,'rec-item-actions')
          );
          item.lastChild.append(button('ดู Diff & กู้คืน',()=>showGitPreview(c.sha,`Commit ${c.sha.slice(0,8)}`),'btn small'));
          commitList.append(item);
        }
        commitCol.append(commitList);
        cols.append(cpCol,commitCol);
        body.append(cols);
      }catch(e){
        body.replaceChildren(el('p','โหลดข้อมูล Git Recovery ไม่สำเร็จ: '+e.message,'wb-status'));
      }
    };
    await loadGit();
  }

  async function recoveryDrift(parent,act,data,selected){
    const box=section('การเปลี่ยนไฟล์นอก journal','เปรียบเทียบ hash จริง ไม่ระบุว่าใครแก้จากเวลาไฟล์ การยอมรับสถานะไม่ใช่ผลทดสอบและไม่เพิ่มสิทธิ์');parent.append(box);
    const view=el('div');box.append(view);
    function render(d){
      view.replaceChildren(el('p',d.state==='external_changes'?`พบ ${d.changedCount} รายการ · ไม่ทราบผู้แก้${d.critical?' · แนะนำให้ตรวจทานก่อนรันคำสั่ง':''}`:d.state==='unchanged'?'ไม่พบการเปลี่ยนจากสถานะที่บันทึก':d.state==='unavailable'?`ตรวจไม่สำเร็จ: ${d.errorCode} · ไม่บล็อกงานปกติ`:'ยังไม่ได้สแกน'));
      if(d.changedCount){
        const list=el('ul');for(const c of d.changes)list.append(el('li',`${c.change} · ${c.path} · ${c.beforeHash?.slice(0,12)||'ไม่มี'} → ${c.observedHash?.slice(0,12)||'ไม่มี'}`));view.append(list);
        if(d.truncated){view.append(el('p','ยังมีรายการถัดไป การยืนยันใช้กับการเปลี่ยนแปลงทั้งหมดที่ระบุ'));view.append(button('ดูรายการเปลี่ยนแปลงถัดไป',async()=>render(await act('recovery.drift.scan',{cursor:d.nextCursor}))));}
        view.append(el('p','สำเนาที่ตรวจพบแยกจาก baseline เดิม ไม่รับรองว่ามี bytes ก่อนถูกเขียนทับ หากยังไม่เคยสำรอง'));
        view.append(button('ยอมรับสถานะที่ตรวจนี้',async()=>{
          if(!await confirmDanger('ยอมรับไฟล์ที่เปลี่ยน?',`มี ${d.changedCount} รายการ การยืนยันบันทึกสถานะที่ตรวจแล้วเป็น baseline ใหม่ ไม่ได้กู้ไฟล์กลับ`,'ยอมรับสถานะ'))return;
          const result=await act('recovery.drift.acknowledge',{digest:d.digest,workspaceId:selected.workspaceId,workspaceEpoch:selected.workspaceEpoch,confirm:true});render(result);notice('บันทึกสถานะที่เจ้าของตรวจแล้ว');
        }));
      }
    }
    render(data.drift);box.append(button('ตรวจไฟล์และเปรียบเทียบ',async()=>{view.replaceChildren(el('p','กำลังตรวจ hash…'));try{render(await act('recovery.drift.scan'));}catch(e){view.replaceChildren(el('p',String(e.message),'wb-status'));throw e;}}));
    box.append(el('p',`Git recovery: ${data.git.state}${data.git.errorCode?' · '+data.git.errorCode:''} · สำเนา source แยกจาก index/branch ของคุณ`));
  }

  async function recoveryPanel(parent) {
    const card=section('Recovery · ระบบสำรองและกู้คืนโปรเจกต์','ตั้งค่าโหมดกู้คืน การใช้ Git อัตโนมัติ การไม่บล็อกงานเมื่อพบไฟล์ติดปัญหา และกำหนดขอบเขตการสำรองทั้งหมดผ่าน UI');parent.append(card);
    const status=el('p','กำลังตรวจสอบจุดกู้คืน…','wb-status');status.setAttribute('role','status');card.append(status);
    const selected={...getSelected()};
    const act=(operation,args={})=>api('admin/action',{projectId:selected.projectId,operation,args},true);
    const retryBackup=async()=>{
      const result=await act('recovery.reset');
      notice(result.state==='BLOCKED'?`ตรวจสำเนาใหม่แล้ว ยังสำรองไม่ได้ (${result.errorCode||'UNKNOWN'}) · งานปกติยังทำต่อได้`:'ตรวจสถานะสำเนาใหม่แล้ว');
      await refresh();
    };
    try {
      const data=await act('recovery.status');
      const effectiveMode=data.effectiveMode||(data.hasGitRepo?'git':'snapshot');
      const labels={
        INITIALIZING:'กำลังเตรียมสำเนา — พร้อมใช้งานโดยไม่บล็อกการทำงาน',
        READY:effectiveMode==='git'?'SAVED · พร้อมใช้งาน (โหมด Git Recovery)':'SAVED · มีสำเนาที่ตรวจ integrity แล้ว (โหมด Snapshot)',
        BLOCKED:'สำรองไม่พร้อม — ยังแก้ไฟล์และรันคำสั่งได้ตามสิทธิ์เดิม',
        DISABLED_BY_OWNER:'เจ้าของปิดการสำรองอัตโนมัติ',
      };
      status.textContent=labels[data.state]||data.state;
      if(data.awaitingActivation&&data.enabled&&data.state==='INITIALIZING')status.textContent='เปิดการสำรองไว้ — รอสร้างจุดกู้คืนแรก';

      const headerBar=el('div',undefined,'rec-header');
      const headerCopy=el('div',undefined,'rec-header-copy');
      headerCopy.append(
        el('strong',data.hasGitRepo?'ตรวจพบ Git Repository ในโปรเจกต์นี้ (.git)':'โปรเจกต์ทั่วไป (ยังไม่ได้เชื่อม Git)'),
        el('span','สำรองอัตโนมัติแบบ best effort: ปัญหาการสำรองไม่บล็อกการแก้ไฟล์หรือรันคำสั่ง','muted')
      );
      const badge=el('span',
        data.state==='BLOCKED'?`สำรองไม่พร้อม · ${data.errorCode||'BLOCKED'}`:
        data.state==='DISABLED_BY_OWNER'?'ปิดการใช้งาน':
        effectiveMode==='git'?'พร้อมใช้งาน · Git Recovery':'พร้อมใช้งาน · DODO Snapshot',
        'rec-badge'
      );
      badge.dataset.tone=data.state==='BLOCKED'?'danger':data.state==='DISABLED_BY_OWNER'?'muted':'ok';
      headerBar.append(headerCopy,badge);
      card.append(headerBar);

      const metricGrid=el('div',undefined,'rec-stats');
      metricGrid.append(
        statCard(
          'โหมดที่ใช้งานจริง',
          effectiveMode==='git'?'Git Recovery':effectiveMode==='off'?'ปิดการใช้งาน':'DODO Snapshot',
          `ตั้งค่า: ${(data.policy.mode||'auto').toUpperCase()} · ปัญหาการสำรองไม่บล็อกงานปกติ`
        ),
        statCard(
          'การตรวจสอบล่าสุด',
          data.lastCheckedAt?new Date(data.lastCheckedAt).toLocaleTimeString('th-TH'):'ยังไม่มี',
          data.lastCheckedAt?new Date(data.lastCheckedAt).toLocaleDateString('th-TH'):`เหตุการณ์: ${data.lastTrigger||'ยังไม่มี'}`
        ),
        statCard(
          'ไฟล์ที่คุ้มครอง / ยกเว้น',
          `${data.counts.included} ไฟล์`,
          `ยกเว้นตามนโยบาย ${data.counts.excludedByPolicy} รายการ · ข้าม Secret ${(data.skippedSecretFiles||[]).length} ไฟล์`
        ),
        statCard(
          'พื้นที่จัดเก็บโปรเจกต์',
          `${(data.projectBytes/1048576).toFixed(2)} MiB`,
          `โควตา ${(data.policy.projectBytes/1073741824).toFixed(1)} GiB · สแกนแล้ว ${data.progress.scanned} รายการ`
        )
      );
      card.append(metricGrid);

      // Diagnostic & Quick-Fix Callout for blockedPath, errorCode, skippedSecretFiles, or lastWarning
      const problemPaths=[
        ...(data.blockedPath?[data.blockedPath]:[]),
        ...(Array.isArray(data.skippedSecretFiles)?data.skippedSecretFiles:[]),
      ].filter((v,i,a)=>Boolean(v)&&a.indexOf(v)===i);

      if(data.state==='BLOCKED'||data.errorCode||data.lastWarning||problemPaths.length){
        const alertBox=el('div',undefined,'rec-alert');
        alertBox.dataset.tone=data.state==='BLOCKED'?'danger':'warn';
        alertBox.append(
          el('p',
            data.state==='BLOCKED'
              ?`Recovery ยังสำรองไม่สำเร็จ (${data.errorCode||'UNKNOWN'}) · ไม่บล็อกการแก้ไฟล์หรือรันคำสั่ง`
              :`คำเตือนจากระบบ Recovery (ไม่บล็อกการแก้ไฟล์หรือรันคำสั่ง)`,
            'rec-alert-title'
          )
        );
        if(data.errorDetail)alertBox.append(el('p',data.errorDetail,'muted'));
        if(data.lastWarning&&data.lastWarning!==data.errorDetail)alertBox.append(el('p',data.lastWarning,'muted'));
        if(problemPaths.length){
          alertBox.append(el('p','พาธภายในโปรเจกต์ที่สำรองไม่ได้หรือถูกข้าม (relative path; เช่น เนื้อหาคล้ายคีย์หรือไฟล์เกินขีดจำกัด):'));
          const ul=el('ul',undefined,'rec-path-list');
          for(const p of problemPaths)ul.append(el('li',p,'rec-path-pill'));
          alertBox.append(ul);
        }else if(data.errorCode==='SECRET_PATH_DENIED'){
          alertBox.append(el('p','ตรวจไฟล์ตัวอย่างที่อาจมีข้อความคล้ายคีย์ เช่น env.example, scripts/setup-env.sh หรือ src/lib/env.ts แล้วลองสำรองใหม่หรือเลือกข้ามไฟล์นั้น การแก้ไฟล์และรันคำสั่งยังใช้สิทธิ์เดิม','muted'));
        }
        const quickActions=el('div',undefined,'rec-action-bar');
        if(problemPaths.length){
          quickActions.append(button('เพิ่มไฟล์ต้นเหตุเข้า Exclude ทันที',async()=>{
            const merged=[...new Set([...(data.policy.excludePaths||[]),...problemPaths])];
            await act('recovery.configure',{confirm:true,policy:{...data.policy,strictEnforcement:false,excludePaths:merged}});
            await act('recovery.reset');
            notice(`เพิ่ม ${problemPaths.join(', ')} เข้า Exclude แล้ว · ตรวจสถานะสำเนาใหม่ด้านบน`);
            await refresh();
          },'btn primary'));
        }
        if(data.errorCode==='SECRET_PATH_DENIED'||(Array.isArray(data.skippedSecretFiles)&&data.skippedSecretFiles.length)){
          quickActions.append(button('ข้ามไฟล์ที่มีเนื้อหาคล้าย Secret ในการสำรอง',async()=>{
            await act('recovery.configure',{confirm:true,policy:{...data.policy,strictEnforcement:false,skipSecretContentFiles:true}});
            await retryBackup();
          },'btn'));
        }
        if(data.hasGitRepo&&data.policy.mode!=='git'){
          quickActions.append(button('สลับใช้ Git Recovery ล้วน (ไม่สแกนไฟล์ CAS)',async()=>{
            await act('recovery.configure',{confirm:true,policy:{...data.policy,enabled:true,mode:'git',strictEnforcement:false}});
            await act('recovery.reset');
            notice('สลับเป็นโหมด Git Recovery เรียบร้อยแล้ว');
            await refresh();
          },'btn'));
        }
        quickActions.append(button('ลองสำรองใหม่ทันที',retryBackup,'btn'));
        alertBox.append(quickActions);
        card.append(alertBox);
      }

      // ---- Git Recovery Section ----
      await gitRecoverySection(card,act,data,selected);

      // ---- Categorized 4-Group Settings Dashboard ----
      const settingsHeader=el('h3','ตั้งค่าระบบ Recovery ทั้งหมด (แยกตามหมวดหมู่)');
      card.append(settingsHeader);
      const settingsGrid=el('div',undefined,'rec-settings-grid');
      card.append(settingsGrid);

      // Group 1: Backup mode and automatic best-effort behavior.
      const g1=groupCard(1,'โหมดการสำรอง','เลือก Git หรือ Snapshot โดยปัญหาการสำรองอัตโนมัติไม่บล็อกงานปกติ');
      const modeSelect=choice(g1,'โหมดการสำรองและกู้คืน (Recovery Mode)','recoveryMode',[
        ['auto','Auto (แนะนำ — ใช้ Git อัตโนมัติถ้าโปรเจกต์มี .git)'],
        ['git','Git เท่านั้น (ใช้ Git ล้วน ไม่สแกนไฟล์ CAS ของ DODO)'],
        ['snapshot','DODO Snapshot (สำรองไฟล์เข้าคลัง CAS ของ DODO)'],
        ['off','ปิดการใช้งาน Recovery'],
      ],data.policy.mode||'auto');
      const enabled=check(g1,'เปิดการสำรองอัตโนมัติ','recoveryEnabled',data.enabled);enabled.setAttribute('role','switch');
      g1.append(el('p','สำรองอัตโนมัติแบบ best effort: หากไฟล์ถูกข้าม คลังสำรองไม่พร้อม หรือสแกนไม่สำเร็จ จะแสดงคำเตือนและให้งานปกติทำต่อได้ การสร้างจุดกู้คืนที่ร้องขอและการกู้คืนตามแผนยังต้องตรวจสำเนาสำเร็จ','muted'));
      settingsGrid.append(g1);

      // Group 2: Secret Content Screening & Drift Policy
      const g2=groupCard(2,'การตรวจไฟล์ความลับและไฟล์เปลี่ยนภายนอก','จัดการการตรวจจับคีย์ตัวอย่างในโค้ด (เช่น env.example) และการแก้ไฟล์จากภายนอก');
      const scanContentSecrets=check(g2,'สแกนหาคีย์ความลับในเนื้อหาไฟล์ระหว่างสำรอง Snapshot','recoveryScanSecrets',data.policy.scanContentSecrets!==false);
      scanContentSecrets.setAttribute('role','switch');
      const skipSecretContentFiles=check(g2,'ข้ามไฟล์ที่พบเนื้อหาคล้าย Secret อัตโนมัติ และแสดงพาธที่ข้าม','recoverySkipSecrets',data.policy.skipSecretContentFiles!==false);
      skipSecretContentFiles.setAttribute('role','switch');
      const checkDrift=check(g2,'ตรวจจับการแก้ไฟล์จากภายนอก DODO (Drift Detection)','recoveryCheckDrift',data.policy.checkDrift!==false);
      checkDrift.setAttribute('role','switch');
      const driftCols=el('div',undefined,'rec-three-col');
      const massFilesInput=field(driftCols,'จำนวนไฟล์เปลี่ยนเตือน (ไฟล์)','recoveryMassFiles',data.policy.massFiles??20,'number');massFilesInput.min='1';massFilesInput.max='100000';
      const massPercentInput=field(driftCols,'สัดส่วนไฟล์เปลี่ยน (%)','recoveryMassPercent',data.policy.massPercent??20,'number');massPercentInput.min='0';massPercentInput.max='100';
      const deletedFilesInput=field(driftCols,'จำนวนไฟล์ถูกลบเตือน','recoveryDeletedFiles',data.policy.deletedFiles??10,'number');deletedFilesInput.min='1';deletedFilesInput.max='100000';
      g2.append(driftCols);
      settingsGrid.append(g2);

      // Group 3: Exclusions & Data Roots
      const g3=groupCard(3,'ไฟล์และโฟลเดอร์ที่ยกเว้น (Exclusions)','ระบุไฟล์หรือโฟลเดอร์ที่ไม่ต้องการให้ DODO สแกนสำรอง (เช่น node_modules, .next, env.example)');
      const excludePathsField=field(g3,'รายการไฟล์/โฟลเดอร์ที่ยกเว้น (บรรทัดละ 1 รายการ)','recoveryExcludePaths',(data.policy.excludePaths||[]).join('\n'),'textarea');
      excludePathsField.placeholder='node_modules\n.next\nenv.example\nscripts/setup-env.sh';
      const chipBar=el('div',undefined,'rec-chip-bar');
      chipBar.append(el('span','เพิ่มด่วน:','muted'));
      for(const preset of ['node_modules','.next','dist','build','models','env.example','scripts/setup-env.sh','src/lib/env.ts','.env.docker']){
        const chip=el('button',`+ ${preset}`,'rec-chip-btn');
        chip.type='button';
        chip.onclick=()=>{
          const lines=excludePathsField.value.split('\n').map(s=>s.trim()).filter(Boolean);
          if(!lines.includes(preset)){
            lines.push(preset);
            excludePathsField.value=lines.join('\n');
          }
        };
        chipBar.append(chip);
      }
      g3.append(chipBar);
      const roots=field(g3,'โฟลเดอร์ข้อมูล runtime ที่ไม่สำรอง (relative path หนึ่งรายการต่อบรรทัด)','recoveryDataRoots',(data.policy.dataRoots||[]).join('\n'),'textarea');
      roots.placeholder='data\nuploads';
      settingsGrid.append(g3);

      // Group 4: Quotas, Scan Limits & Retention
      const g4=groupCard(4,'โควตาพื้นที่ ขีดจำกัดการสแกน และระยะเวลาเก็บ','ปรับแต่งขนาดพื้นที่สำรอง ขีดจำกัดขนาดไฟล์ เวลาสแกน และจำนวนจุดกู้คืน');
      const quotaCols=el('div',undefined,'rec-two-col');
      const projectGiBInput=field(quotaCols,'โควตาโปรเจกต์ (GiB)','recoveryProjectGiB',Number((data.policy.projectBytes/1073741824).toFixed(2)),'number');projectGiBInput.min='0.01';projectGiBInput.max='100';projectGiBInput.step='0.1';
      const fileMiBInput=field(quotaCols,'ขนาดไฟล์สูงสุด (MiB)','recoveryFileMiB',Number((data.policy.fileBytes/1048576).toFixed(2)),'number');fileMiBInput.min='1';fileMiBInput.max='1024';fileMiBInput.step='1';
      const maxEntriesInput=field(quotaCols,'จำนวนไฟล์สูงสุดที่สแกน','recoveryMaxEntries',data.policy.maxEntries??100000,'number');maxEntriesInput.min='100';maxEntriesInput.max='1000000';
      const scanMsInput=field(quotaCols,'เวลาสแกนสูงสุด (ms)','recoveryScanMs',data.policy.scanMs??15000,'number');scanMsInput.min='500';scanMsInput.max='60000';
      const retentionDaysInput=field(quotaCols,'ระยะเวลาเก็บสำเนา (วัน)','recoveryRetentionDays',data.policy.retentionDays??30,'number');retentionDaysInput.min='1';retentionDaysInput.max='3650';
      const retainedPointsInput=field(quotaCols,'จำนวนจุดกู้คืนสูงสุด','recoveryRetainedPoints',data.policy.retainedPoints??200,'number');retainedPointsInput.min='1';retainedPointsInput.max='10000';
      g4.append(quotaCols);

      const advanced=el('details',undefined,'details');advanced.append(el('summary','ขอบเขตและพื้นที่สำรอง (Git Copy แยกโฟลเดอร์ขั้นสูง)'));
      const gitRequired=check(advanced,'กำหนดให้จุดกู้คืนที่ร้องขอมี Git recovery copy','recoveryGitRequired',data.policy.gitRequired);
      const gitDirectory=field(advanced,'ที่เก็บ Git สำรอง (absolute path; เว้นว่างใช้ private state)','recoveryGitDirectory',data.policy.gitDirectory||'');
      advanced.append(el('p','โฟลเดอร์สำรองต้องมีอยู่แล้ว เป็น private ของเจ้าของ และอยู่นอกโปรเจกต์','muted'));
      advanced.append(el('p','เมื่อ Git copy หรือโฟลเดอร์สำรองไม่พร้อม งานแก้ไฟล์และคำสั่งปกติยังทำต่อได้ พร้อมคำเตือนเรื่องสำเนาที่ขาดไป','muted'));
      g4.append(advanced);
      settingsGrid.append(g4);

      modeSelect.onchange=()=>{
        if(modeSelect.value==='off')enabled.checked=false;
        else enabled.checked=true;
      };
      enabled.onchange=()=>{
        if(!enabled.checked&&modeSelect.value!=='off')modeSelect.value='off';
        else if(enabled.checked&&modeSelect.value==='off')modeSelect.value='auto';
      };

      const mainActions=el('div',undefined,'rec-action-bar');
      mainActions.append(
        button('บันทึกการสำรอง',async()=>{
          const isEnabled=enabled.checked&&modeSelect.value!=='off';
          if(!isEnabled&&!await confirmDanger('ปิดการสำรองอัตโนมัติ?','การแก้ไฟล์และคำสั่งหลังจากนี้จะไม่มี source checkpoint ใหม่ สำเนาเดิมและ file journal ยังอยู่','ปิดการสำรอง'))return;
          const nextPolicy={
            ...data.policy,
            enabled:isEnabled,
            mode:isEnabled?(modeSelect.value==='off'?'auto':modeSelect.value):'off',
            strictEnforcement:false,
            scanContentSecrets:scanContentSecrets.checked,
            skipSecretContentFiles:skipSecretContentFiles.checked,
            checkDrift:checkDrift.checked,
            massFiles:Math.max(1,Math.round(Number(massFilesInput.value)||20)),
            massPercent:Math.min(100,Math.max(0,Number(massPercentInput.value)||20)),
            deletedFiles:Math.max(1,Math.round(Number(deletedFilesInput.value)||10)),
            projectBytes:Math.max(1048576,Math.round((Number(projectGiBInput.value)||5)*1073741824)),
            fileBytes:Math.max(1024,Math.round((Number(fileMiBInput.value)||64)*1048576)),
            maxEntries:Math.max(1,Math.round(Number(maxEntriesInput.value)||100000)),
            scanMs:Math.min(60000,Math.max(100,Math.round(Number(scanMsInput.value)||15000))),
            retentionDays:Math.max(1,Math.round(Number(retentionDaysInput.value)||30)),
            retainedPoints:Math.max(1,Math.round(Number(retainedPointsInput.value)||200)),
            gitRequired:gitRequired.checked,
            gitDirectory:gitDirectory.value.trim()||null,
            excludePaths:excludePathsField.value.split('\n').map(s=>s.trim()).filter(Boolean),
            dataRoots:roots.value.split('\n').map(s=>s.trim()).filter(Boolean),
          };
          const result=await act('recovery.configure',{confirm:true,policy:nextPolicy});
          notice(result.enabled?'บันทึกการตั้งค่า Recovery ทั้งหมดเรียบร้อยแล้ว':'บันทึกแล้ว เจ้าของปิดการสำรองอัตโนมัติ');
          await refresh();
        },'btn primary'),
        button('สร้างจุดกู้คืนตอนนี้',async()=>{await act('recovery.checkpoint');notice('สร้างจุดกู้คืนเรียบร้อยแล้ว');await refresh();}),
        button('ลองสำรองใหม่',retryBackup),
        button('ตรวจสถานะใหม่',async()=>refresh())
      );
      card.append(mainActions);
      card.append(el('p','กู้คืนเฉพาะ source ที่แสดงในแผน ไม่รวมฐานข้อมูล secrets, volumes หรือผลภายนอก และไม่ใช่ OS sandbox','muted'));

      await window.DodoRecoveryMaintenance({parent:card,act,selected,el,section,button,field,check,notice,confirmDanger,refresh});
      await verificationPanel(card,act,selected);
      await recoveryDrift(card,act,data,selected);
      await recoveryHistory(card,act,selected);
    } catch(error){status.dataset.kind='error';status.textContent='ตรวจสอบ Recovery ไม่สำเร็จ: '+error.message;}
  }

  async function recoveryHistory(card,act,selected) {
    const history=el('section');history.append(el('h3','ประวัติและการกู้คืน'));card.append(history);
    const kind=choice(history,'ประเภทประวัติ','recoveryHistoryKind',[['checkpoints','จุดกู้คืน'],['sessions','Session งาน']],'checkpoints');
    const selection=field(history,'เลือกไฟล์หรือโฟลเดอร์ (เว้นว่างเพื่อเลือกทั้งหมดที่สำรอง)','restorePath','');
    const mirror=check(history,'Exact mirror: รวมการลบไฟล์ source ที่เพิ่มหลัง checkpoint','restoreMirror',false);
    const list=el('div'),preview=el('section');history.append(list,preview);let cursor=0;
    const showStatus=async(planId)=>{
      const result=await act('recovery.restore_status',planId?{planId}:{});preview.replaceChildren(el('h4','สถานะจาก journal'));
      if(!result.plans.length)preview.append(el('p','ยังไม่มีแผนกู้คืน'));
      for(const p of result.plans)preview.append(el('p',`${p.planId} · ${p.status}${p.changesetId?' · '+p.changesetId:''}`));
    };
    const review=async(item)=>{
      preview.replaceChildren(el('p','กำลังตรวจไฟล์และ backup…'));mirror.disabled=kind.value==='sessions';
      let p;
      try{p=await act('recovery.restore_preview',{...(kind.value==='sessions'?{sessionId:item.id}:{checkpointId:item.id}),...(selection.value.trim()?{paths:[selection.value.trim()]}:{}),exactMirror:kind.value==='checkpoints'&&mirror.checked});}
      catch(error){const status=el('p','ตรวจแผนไม่สำเร็จ: '+error.message,'wb-status');status.setAttribute('role','alert');preview.replaceChildren(status);return;}
      preview.replaceChildren(el('h4','ตรวจแผนก่อนกู้คืน'));preview.append(el('p',p.applicable?'ยังไม่มีการแก้ไฟล์ — ตรวจ diff แล้วจึงยืนยัน':'ยังไม่มีการแก้ไฟล์ — '+(p.unchanged?'ไฟล์ตรงกับจุดที่เลือกแล้ว':'พบ conflict ต้องตรวจไฟล์ก่อน')));
      if(p.database)preview.append(el('p',`Database compatibility: ${p.database.state} · ${p.database.configured?'ใช้กติกาที่เจ้าของกำหนด':'ยังไม่ตั้ง adapter'} · ไม่มีการย้อนข้อมูล DB`,'wb-status'));
      for(const c of p.conflicts||[])preview.append(el('p',`${c.path}: ${c.reason}`,'wb-status'));
      for(const f of p.files||[]){const d=el('details');d.append(el('summary',`${f.action} · ${f.path} (${f.bytesBefore} → ${f.bytesAfter} bytes)`));d.append(el('pre',f.diff||'(ตรวจตามชนิดและ hash)'));d.append(el('p',`${f.beforeHash||'ไม่มีไฟล์'} → ${f.afterHash||'ลบไฟล์'}`,'muted'));preview.append(d);}
      if(!p.applicable)return;
      preview.append(el('p','สำรองสถานะปัจจุบันก่อนกู้คืน ถ้าไฟล์เปลี่ยนหลัง preview ระบบจะปฏิเสธ ไม่รวม DB/secrets/volumes','muted'));
      const key=crypto.randomUUID();let sent=false;
      const apply=button('กู้คืนตามแผนนี้',async()=>{
        if(sent)return;
        if(!await confirmDanger('กู้คืน source ตามแผนนี้?',`จะใช้แผน ${p.planId} เท่านั้น รวมรายการลบที่แสดงใน preview`,'กู้คืน'))return;
        sent=true;apply.hidden=true;
        try{
          const result=await act('recovery.restore_apply',{planId:p.planId,planHash:p.planHash,idempotencyKey:key,workspaceId:p.workspaceId,workspaceEpoch:p.workspaceEpoch,confirm:true});
          preview.replaceChildren(el('h4','ผลกู้คืน'),el('p',`ตรวจสอบ source สำเร็จ · ${result.changesetId}`));
          if(result.databaseChangedDuringRestore)preview.append(el('p','ตรวจพบ schema เปลี่ยนระหว่างกู้ source ต้องให้เจ้าของตรวจความเข้ากันได้ก่อนใช้งาน · DODO ไม่ได้ย้อนข้อมูล DB','wb-status'));
        }catch(e){preview.append(el('p','ยังไม่ยืนยันว่ากู้คืนสำเร็จ: '+e.message+' · ตรวจสถานะก่อนสั่งใหม่','wb-status'));}
      });
      preview.append(apply,button('ตรวจสถานะแผนนี้',()=>showStatus(p.planId)));
      apply.focus();
    };
    const load=async()=>{
      list.replaceChildren(el('p','กำลังโหลดประวัติ…'));
      try{
        const data=await act(kind.value==='sessions'?'recovery.recovery_session_list':'recovery.checkpoint_list',{cursor,limit:10});list.replaceChildren();
        if(!data.items.length)list.append(el('p','ยังไม่มีประวัติประเภทนี้'));
        for(const item of data.items){const row=el('div',undefined,'wb-card');row.append(el('p',`${item.title||item.id} · ${new Date(item.created_at).toLocaleString('th-TH')} · ${item.state}`));const view=button('ดู preview',()=>review(item));if(kind.value==='checkpoints'&&item.state!=='READY')view.disabled=true;row.append(view);
          if(kind.value==='checkpoints'&&item.state==='READY'){
            row.append(button(item.pinned?'เลิก pin':'Pin สำเนานี้',async()=>{const result=await act('recovery.pin',{checkpointId:item.id,pinned:!item.pinned,expectedPinned:Boolean(item.pinned),workspaceId:selected.workspaceId,workspaceEpoch:selected.workspaceEpoch,confirm:true});notice(result.pinned?'Pin แล้ว สำเนาจะไม่หมดอายุ':'เลิก pin แล้ว จุดที่ยังมีชื่ออ้างถึงจะยังเก็บไว้');await load();}));
            row.append(button('ตั้งชื่อสำเนา',async()=>{const data=await act('recovery.evidence.list');const form=el('section');form.append(el('h4','ชื่อที่เจ้าของเลือก · ไม่รับรองผลทดสอบ'));const name=field(form,'ชื่อสำเนา','checkpointName','stable');
              form.append(button('บันทึกชื่อสำเนา',async()=>{const old=data.pointers.find(p=>p.name===name.value.trim());
                if(!await confirmDanger('ตั้งชื่อสำเนานี้?',`${name.value.trim()}: ${old?.snapshotId||'ยังไม่มี'} → ${item.id} ชื่อนี้ไม่เพิ่มสิทธิ์และไม่เปลี่ยนผลทดสอบ`,'บันทึกชื่อ'))return;
                const result=await act('recovery.mark',{name:name.value.trim(),snapshotId:item.id,expectedRevision:old?.revision||0,workspaceId:selected.workspaceId,workspaceEpoch:selected.workspaceEpoch,confirm:true});notice(`บันทึก ${result.name} แล้ว · OWNER_MARKED_STABLE`);await refresh();}));preview.replaceChildren(form);name.focus();}));
          }else if(kind.value==='sessions')row.append(button('ดู timeline',async()=>{
            const render=async(cursor=0)=>{const d=await act('recovery.recovery_session_inspect',{sessionId:item.id,cursor,limit:20});preview.replaceChildren(el('h4',d.title),el('p',`สถานะ ${d.state}`));for(const e of d.events)preview.append(el('p',`${new Date(e.created_at).toLocaleString('th-TH')} · ${e.kind} · ${e.ref||e.snapshot_id||''}`));if(d.nextCursor!==null)preview.append(button('เหตุการณ์ถัดไป',()=>render(d.nextCursor)));};await render();
          }));list.append(row);}
        if(data.nextCursor!==null)list.append(button('หน้าถัดไป',async()=>{cursor=data.nextCursor;await load();}));
        if(cursor)list.append(button('กลับหน้าแรก',async()=>{cursor=0;await load();}));
      }catch(e){list.replaceChildren(el('p','โหลดประวัติไม่สำเร็จ: '+e.message,'wb-status'));}
    };
    kind.onchange=()=>{cursor=0;preview.replaceChildren();mirror.disabled=kind.value==='sessions';void load();};
    history.append(button('ตรวจแผนล่าสุด / หลังเชื่อมต่อใหม่',()=>showStatus()));
    await load();
  }

  async function verificationPanel(parent,act,selected){
    const box=section('หลักฐานและชื่อสำเนา','SAVED คือมีสำเนา · VERIFIED คือ checks ที่เลือกผ่าน · stable เป็นชื่อที่เจ้าของตั้ง');parent.append(box);
    box.append(help('ผลทดสอบอ้างเฉพาะ source และ recipes ที่ตรวจในเวลานั้น ไม่ครอบคลุม environment ภายนอก การแก้แล้วเปลี่ยนกลับระหว่าง checks หรือความถูกต้องทุกกรณี','ขอบเขตหลักฐาน'));
    const status=el('div'),detail=el('div');status.setAttribute('aria-live','polite');box.append(status,detail);let cursor=0;
    const inspect=async(id)=>{
      detail.replaceChildren(el('p','กำลังเทียบ snapshot กับ source, recipes และ jobs จริง…'));
      try{const d=await act('recovery.evidence.inspect',{verificationId:id});const labels={VERIFIED:'ผ่าน checks ที่เลือกกับ snapshot นี้',FAILED:'มี check ไม่ผ่าน',STALE:'หลักฐานเก่า — source, recipe หรือ runtime เปลี่ยน',INCONCLUSIVE:'ยังรับรองไม่ได้ — ตรวจ job และขอบเขตหลักฐาน'};
        detail.replaceChildren(el('h4',`${d.state} · ${labels[d.state]}`),el('p',`ตรวจเมื่อ ${new Date(d.checkedAt).toLocaleString('th-TH')}`));
        const more=el('details');more.append(el('summary','Snapshot และผลทดสอบที่ใช้ตัดสิน'),el('p',d.checkpointId),el('p',`Manifest ${d.manifestHash}`),el('p',`เหตุผล: ${d.reason}`));
        for(const c of d.evidence?.checks||[])more.append(el('p',`${c.taskId} · ${c.status} · exit ${c.exitCode??'ยังไม่มี'} · ผ่าน ${c.counts.passed??'ไม่ทราบ'} / ${c.counts.total??'ไม่ทราบ'} · ข้าม ${c.counts.skipped??'ไม่ทราบ'}${c.outputTruncated?' · output ถูกตัด':''}`));
        if(d.evidence?.notRun.length)more.append(el('p','ยังไม่ได้รัน: '+d.evidence.notRun.join(', ')));
        more.append(el('p',`Deployment: ${d.production} · Database recovery: ${d.database}`,'muted'));detail.append(more);
      }catch(e){detail.replaceChildren(el('p','ตรวจหลักฐานไม่สำเร็จ: '+e.message,'wb-status'));throw e;}
    };
    const load=async()=>{
      status.replaceChildren(el('p','กำลังโหลดหลักฐาน…'));
      try{const d=await act('recovery.evidence.list',{cursor,limit:5});status.replaceChildren();
        if(!d.items.length)status.append(el('p','ยังไม่มีผล verify_changes ที่ผูก snapshot · สำเนาที่มีเป็น SAVED'));
        for(const e of d.items){const row=el('div',undefined,'wb-card');row.append(el('p',`${new Date(e.createdAt).toLocaleString('th-TH')} · ${e.lastObservation?.state||'ยังไม่ได้ตรวจผล'} (ข้อมูลครั้งก่อน)`),button('ตรวจหลักฐานปัจจุบัน',()=>inspect(e.verificationId)));status.append(row);}
        if(d.nextCursor!==null)status.append(button('หลักฐานหน้าถัดไป',async()=>{cursor=d.nextCursor;await load();}));
        if(cursor)status.append(button('หลักฐานหน้าแรก',async()=>{cursor=0;await load();}));
        const active=d.pointers.filter(p=>p.snapshotId);if(!active.length)status.append(el('p','ยังไม่ได้ตั้งชื่อ stable หรือชื่อสำเนาอื่น'));
        for(const p of active){const row=el('div',undefined,'wb-card');row.append(el('p',`${p.name} · OWNER_MARKED_STABLE`),button('ถอนชื่อ '+p.name,async()=>{
          if(!await confirmDanger('ถอนชื่อสำเนา?',`${p.name} จะไม่ป้องกัน retention อีกต่อไป สำเนาที่ pin ไว้ยังคงอยู่`,'ถอนชื่อ'))return;
          await act('recovery.mark',{name:p.name,snapshotId:null,expectedRevision:p.revision,workspaceId:selected.workspaceId,workspaceEpoch:selected.workspaceEpoch,confirm:true});notice('ถอนชื่อแล้ว');await load();
        }));const ref=el('details');ref.append(el('summary','สำเนาที่อ้างถึง'),el('p',p.snapshotId));row.append(ref);status.append(row);}
        const history=el('details');history.append(el('summary','ประวัติการตั้งชื่อ (owner)'));for(const e of d.pointerEvents.items)history.append(el('p',`${new Date(e.createdAt).toLocaleString('th-TH')} · ${e.name} · ${e.previousId||'ยังไม่มี'} → ${e.snapshotId||'ถอนชื่อ'} · revision ${e.revision}`));status.append(history);
        if(cursor===0&&d.items.length)await inspect(d.items[0].verificationId);
      }catch(e){status.replaceChildren(el('p','โหลดหลักฐานไม่สำเร็จ: '+e.message,'wb-status'));}
    };
    box.append(button('โหลดหลักฐานอีกครั้ง',load));await load();
  }
  return recoveryPanel;
};
