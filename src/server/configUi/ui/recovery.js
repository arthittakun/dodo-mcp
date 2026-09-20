/* Owner Recovery dashboard. All untrusted values use textContent; no HTML injection. */
'use strict';
window.DodoRecovery=({el,section,button,check,field,choice,notice,confirmDanger,help,api,refresh,getSelected})=>{
  async function recoveryDrift(parent,act,data,selected){
    const box=section('การเปลี่ยนไฟล์นอก journal','เปรียบเทียบ hash จริง ไม่ระบุว่าใครแก้จากเวลาไฟล์ การยอมรับสถานะไม่ใช่ผลทดสอบและไม่เพิ่มสิทธิ์');parent.append(box);
    const view=el('div');box.append(view);
    function render(d){
      view.replaceChildren(el('p',d.state==='external_changes'?`พบ ${d.changedCount} รายการ · ไม่ทราบผู้แก้${d.critical?' · ต้องตรวจทานก่อนรันคำสั่ง':''}`:d.state==='unchanged'?'ไม่พบการเปลี่ยนจากสถานะที่บันทึก':d.state==='unavailable'?`ตรวจไม่สำเร็จ: ${d.errorCode}`:'ยังไม่ได้สแกน'));
      if(d.changedCount){
        const list=el('ul');for(const c of d.changes)list.append(el('li',`${c.change} · ${c.path} · ${c.beforeHash?.slice(0,12)||'ไม่มี'} → ${c.observedHash?.slice(0,12)||'ไม่มี'}`));view.append(list);
        if(d.truncated){view.append(el('p','ยังมีรายการถัดไป การยืนยันใช้กับการเปลี่ยนแปลงทั้งหมดที่ระบุ'));view.append(button('ดูรายการเปลี่ยนแปลงถัดไป',async()=>render(await act('recovery.drift.scan',{cursor:d.nextCursor}))));}
        view.append(el('p','สำเนาที่ตรวจพบแยกจาก baseline เดิม ไม่รับรองว่ามี bytes ก่อนถูกเขียนทับ หากยังไม่เคยสำรอง'));
        view.append(button('ยอมรับสถานะที่ตรวจนี้',async()=>{
          if(!await confirmDanger('ยอมรับไฟล์ที่เปลี่ยน?',`มี ${d.changedCount} รายการ การยืนยันอนุญาตให้ทำงานต่อจากสถานะนี้ ไม่ได้กู้ไฟล์กลับ`,'ยอมรับสถานะ'))return;
          const result=await act('recovery.drift.acknowledge',{digest:d.digest,workspaceId:selected.workspaceId,workspaceEpoch:selected.workspaceEpoch,confirm:true});render(result);notice('บันทึกสถานะที่เจ้าของตรวจแล้ว');
        }));
      }
    }
    render(data.drift);box.append(button('ตรวจไฟล์และเปรียบเทียบ',async()=>{view.replaceChildren(el('p','กำลังตรวจ hash…'));try{render(await act('recovery.drift.scan'));}catch(e){view.replaceChildren(el('p',String(e.message),'wb-status'));throw e;}}));
    box.append(el('p',`Git recovery: ${data.git.state}${data.git.errorCode?' · '+data.git.errorCode:''} · สำเนา source แยกจาก index/branch ของคุณ`));
  }

  async function recoveryPanel(parent) {
    const card=section('Recovery · สำรอง source','สำรองไฟล์จริงนอกโปรเจกต์ก่อนแก้ไฟล์หรือรันคำสั่ง ไม่รวม secrets, ฐานข้อมูล และ generated files');parent.append(card);
    const status=el('p','กำลังตรวจสอบจุดกู้คืน…','wb-status');status.setAttribute('role','status');card.append(status);
    const selected={...getSelected()};
    const act=(operation,args={})=>api('admin/action',{projectId:selected.projectId,operation,args},true);
    try {
      const data=await act('recovery.status');
      const labels={INITIALIZING:'กำลังเตรียมสำเนา — ยังไม่อนุญาตการเปลี่ยน source จนสำรองสำเร็จ',READY:'SAVED · มีสำเนาที่ตรวจ integrity แล้ว',BLOCKED:'สำรองไม่ได้ — หยุดการเปลี่ยน source',DISABLED_BY_OWNER:'เจ้าของปิดการสำรองอัตโนมัติ'};
      status.textContent=labels[data.state]||data.state;
      if(data.awaitingActivation)status.textContent='เปิดการป้องกันไว้ — รอสร้างจุดกู้คืนแรก';
      if(data.errorCode){status.dataset.kind='error';card.append(el('p',`เหตุผล: ${data.errorCode} · ตรวจพื้นที่ดิสก์ quota, ไฟล์ที่ถูกปฏิเสธ หรือความสมบูรณ์ของ backup แล้วลองสร้างจุดกู้คืนอีกครั้ง`));}
      card.append(el('p',data.lastCheckedAt?`ตรวจล่าสุด ${new Date(data.lastCheckedAt).toLocaleString('th-TH')} · ใช้พื้นที่โปรเจกต์ ${(data.projectBytes/1048576).toFixed(2)} MiB`:'ยังไม่มีสำเนาที่ตรวจสอบแล้ว'));
      card.append(el('p',data.verification.lastVerifiedAt?`เคยตรวจ checks ผ่านล่าสุด ${new Date(data.verification.lastVerifiedAt).toLocaleString('th-TH')} · ตรวจความสดอีกครั้งด้านล่าง`:'ยังไม่มีหลักฐาน checks ผ่านกับ snapshot'));
      card.append(el('p',`รวม ${data.counts.included} รายการ · ยกเว้นตามนโยบาย ${data.counts.excludedByPolicy} รายการ · เหตุการณ์ล่าสุด ${data.lastTrigger||'ยังไม่มี'}`));
      const enabled=check(card,'เปิดการสำรองอัตโนมัติ','recoveryEnabled',data.enabled);enabled.setAttribute('role','switch');
      const advanced=el('details');advanced.append(el('summary','ขอบเขตและพื้นที่สำรอง'));card.append(advanced);
      await cleanupPanel(advanced,act);
      const quota=field(advanced,'พื้นที่สูงสุดต่อโปรเจกต์ (GiB)','recoveryQuota',String(data.policy.projectBytes/1073741824),'number');quota.min='0.001';quota.step='0.1';
      const days=field(advanced,'เก็บกี่วัน (ยกเว้นจุดล่าสุด/ที่ pin)','recoveryDays',String(data.policy.retentionDays),'number');
      const count=field(advanced,'จำนวนจุดที่ไม่ได้ pin','recoveryCount',String(data.policy.retainedPoints),'number');
      const gitRequired=check(advanced,'ต้องมี Git recovery copy ก่อนทำงาน','recoveryGitRequired',data.policy.gitRequired);
      const gitDirectory=field(advanced,'ที่เก็บ Git สำรอง (absolute path; เว้นว่างใช้ private state)','recoveryGitDirectory',data.policy.gitDirectory||'');
      advanced.append(el('p','โฟลเดอร์สำรองต้องมีอยู่แล้ว เป็น private ของเจ้าของ และอยู่นอกโปรเจกต์ หากถอดดิสก์จะหยุด ไม่เปลี่ยนปลายทางเอง','muted'));
      const roots=field(advanced,'โฟลเดอร์ข้อมูล runtime ที่ไม่สำรอง (relative path หนึ่งรายการต่อบรรทัด)','recoveryDataRoots',data.policy.dataRoots.join('\n'),'textarea');
      card.append(button('บันทึกการสำรอง',async()=>{
        if(!enabled.checked&&!await confirmDanger('ปิดการสำรองอัตโนมัติ?', 'การแก้ไฟล์และคำสั่งหลังจากนี้จะไม่มี source checkpoint ใหม่ สำเนาเดิมและ file journal ยังอยู่','ปิดการสำรอง'))return;
        const result=await act('recovery.configure',{confirm:true,policy:{...data.policy,enabled:enabled.checked,gitRequired:gitRequired.checked,gitDirectory:gitDirectory.value.trim()||null,projectBytes:Math.round(Number(quota.value)*1073741824),retentionDays:Number(days.value),retainedPoints:Number(count.value),dataRoots:roots.value.split('\n').map(s=>s.trim()).filter(Boolean)}});
        notice(result.enabled?'บันทึกแล้ว กำลังตรวจความพร้อม':'บันทึกแล้ว เจ้าของปิดการสำรอง');await refresh();
      }));
      card.append(button('สร้างจุดกู้คืนตอนนี้',async()=>{await act('recovery.checkpoint');await refresh();}));
      card.append(button('ตรวจสถานะใหม่',async()=>refresh()));
      card.append(el('p','กู้คืนเฉพาะ source ที่แสดงในแผน ไม่รวมฐานข้อมูล secrets, volumes หรือผลภายนอก และไม่ใช่ OS sandbox','muted'));
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
          preview.replaceChildren(el('h4','ผลกู้คืน'),el('p',`ตรวจสอบสำเร็จ · ${result.changesetId}`));
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


  async function cleanupPanel(parent,act){
    const result=el('div');parent.append(button('ดู preview การล้างตาม retention',async()=>{
      const render=async(cursor=0)=>{
        result.replaceChildren(el('p','กำลังคำนวณรายการ…'));
        try{const d=await act('recovery.cleanup.preview',{cursor,limit:20});result.replaceChildren(el('p',`ล้างได้ ${d.eligiblePoints} สำเนา · ${d.closedSessions} session ที่ปิดแล้ว · ยังไม่ได้ลบข้อมูล`));
          result.append(el('p','พื้นที่ไฟล์อาจใช้ร่วมกัน จึงยังระบุพื้นที่ดิสก์ที่จะคืนจริงไม่ได้','muted'));
          for(const p of d.items)result.append(el('p',`${p.checkpointId} · ${p.eligible?'เข้าเกณฑ์ล้าง':'เก็บไว้'} · ${p.reason}`));
          if(d.nextCursor!==null)result.append(button('ดู retention หน้าถัดไป',()=>render(d.nextCursor)));
        }catch(e){result.replaceChildren(el('p','ตรวจ retention ไม่สำเร็จ: '+e.message,'wb-status'));throw e;}
      };await render();
    }),result);
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
        more.append(el('p','Deployment: NOT_CONFIGURED · Database recovery: NOT_SUPPORTED','muted'));detail.append(more);
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
