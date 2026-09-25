/* Private Recovery maintenance UI. Untrusted paths/IDs are rendered as text. */
'use strict';
window.DodoRecoveryMaintenance=async({parent,act,selected,el,section,button,field,check,notice,confirmDanger,refresh})=>{
  const box=section('จัดการพื้นที่ Recovery','ดูพื้นที่ที่เก็บจริง ปรับโควตา และลบเฉพาะสำเนาที่ไม่ถูกใช้งาน');parent.append(box);
  const status=el('div'),list=el('div'),preview=el('div');status.setAttribute('role','status');preview.setAttribute('aria-live','polite');
  box.append(status);const settings=el('details');settings.append(el('summary','โควตา ระยะเก็บ และโฟลเดอร์ที่ไม่สำรอง'));box.append(settings);
  const quota=field(settings,'โควตา Recovery ของโปรเจกต์ (GiB)','maintenanceQuota','','number');quota.min='0.001';quota.max='100';quota.step='0.1';
  const days=field(settings,'ระยะเก็บสำรอง (วัน)','maintenanceDays','','number');days.min='1';days.max='3650';
  const count=field(settings,'จำนวนสำเนาที่เก็บตาม retention','maintenanceCount','','number');count.min='1';count.max='10000';
  const excludes=field(settings,'ไม่สำรองไฟล์หรือโฟลเดอร์ (relative path บรรทัดละรายการ)','maintenanceExcludes','','textarea');excludes.placeholder='models/';
  settings.append(el('p','เช่น models/ — ใช้กับสำเนาใหม่เท่านั้น สำเนาเก่ายังคงอยู่ การแก้ไฟล์ที่ยกเว้นผ่าน DODO จะถูกปฏิเสธเมื่อจำเป็นต้องสำรองก่อนแก้ ไม่รองรับ wildcard','muted'));
  let cursor=0;const chosen=new Set();const size=n=>(n/1048576).toFixed(2)+' MiB';
  const reasons={active_baseline:'จุดปัจจุบัน',latest_backup:'สำเนาล่าสุด',pinned:'Pin ไว้',drift_baseline:'ใช้ตรวจไฟล์เปลี่ยน',named_checkpoint:'มีชื่ออ้างถึง',deployment_provenance:'ใช้กับ deployment',database_compatibility_rule:'ผูกกติกาฐานข้อมูล',reviewed_restore_plan:'มีแผนกู้คืนใช้อยู่',open_session:'session ยังเปิด',unfinished_work:'งานยังไม่จบ',select_complete_session:'ต้องเลือกสำเนาของ session ให้ครบ',other_caller_session:'ประวัติของผู้เรียกอื่น',active_capture:'กำลังสำรอง'};
  const review=async(operation,args)=>{
    preview.replaceChildren(el('p','กำลังตรวจแผน…'));
    try{
      const p=await act(operation,args);preview.replaceChildren(el('h4',p.kind==='cleanup'?'ตรวจรายการก่อนลบ':'ตรวจค่าก่อนบันทึก'));
      const d=p.decision;
      if(p.kind==='cleanup'){
        preview.append(el('p',`ลบ ${d.deleteIds.length} สำเนา และประวัติ ${d.sessions.length} session ที่ปิดแล้ว · เนื้อหารวม ${size(d.logicalBytes)}`));
        preview.append(el('p','พื้นที่ที่จะคืนจริงขึ้นกับไฟล์ที่ใช้ร่วมกันและสำเนา Git ไม่ลบ source ของโปรเจกต์','muted'));
        for(const item of d.items)preview.append(el('p',`${item.eligible?'ลบได้':'เก็บไว้'} · ${item.checkpointId} · ${size(item.logicalBytes)}${item.eligible?'':' · '+(reasons[item.reason]||item.reason)}`));
        if(d.items.some(i=>!i.eligible)){preview.append(el('p','นำรายการที่ถูกป้องกันออกจากการเลือก แล้วตรวจแผนอีกครั้ง','wb-status'));return;}
        if(!d.deleteIds.length&&args.mode!=='pending'){preview.append(el('p','ยังไม่มีสำเนาที่ลบได้ตามเงื่อนไขนี้'));return;}
      }else{
        preview.append(el('p',`โควตา ${size(d.before.projectBytes)} → ${size(d.after.projectBytes)} · เก็บ ${d.after.retentionDays} วัน / ${d.after.retainedPoints} สำเนา`));
        preview.append(el('p','รายการยกเว้น: '+(d.after.excludePaths.join(', ')||'ไม่มี')));
        preview.append(el('p','ไฟล์ที่ยกเว้นจะไม่อยู่ในสำเนาใหม่ การลด retention อาจล้างสำเนาเก่าในการสำรองครั้งถัดไป','wb-status'));
      }
      const key=crypto.randomUUID();let sent=false;
      const apply=button(p.kind==='cleanup'?'ยืนยันลบสำเนาตามแผน':'ยืนยันบันทึกนโยบาย',async()=>{
        if(sent||!await confirmDanger(p.kind==='cleanup'?'ลบสำเนาที่เลือก?':'เปลี่ยนนโยบายสำรอง?',p.kind==='cleanup'?'ลบสำเนาและประวัติ session ตามรายการนี้ถาวร ย้อนกลับการลบไม่ได้':'มีผลต่อความครอบคลุมและระยะเก็บของสำเนา โปรดตรวจรายการยกเว้นก่อนยืนยัน','ยืนยัน'))return;
        sent=true;apply.disabled=true;
        try{
          const result=await act('recovery.recovery_maintenance_apply',{planId:p.planId,planHash:p.planHash,idempotencyKey:key,workspaceId:selected.workspaceId,workspaceEpoch:selected.workspaceEpoch,confirm:true});
          if(result.settingsSaved){notice('บันทึกนโยบายสำรองแล้ว · สำเนาเดิมยังอยู่');await refresh();return;}
          preview.replaceChildren(el('h4','ผลการล้าง'),el('p',`ลบ ${result.deletedCheckpoints.length} สำเนา · คืนพื้นที่ source ${size(result.reclaimedObjectBytes||0)} / Git ${size(result.reclaimedGitBytes||0)}`));
          if(result.physicalCleanup==='pending')preview.append(el('p','ยังมีไฟล์รอเก็บกวาด อาจติดงานสำรอง สิทธิ์ไฟล์ หรือดิสก์ที่ยังไม่พร้อม ใช้ปุ่มเก็บกวาดไฟล์ค้างเพื่อลองใหม่','wb-status'));
          chosen.clear();await load();
        }catch(e){preview.append(el('p','ยังไม่ยืนยันผล: '+e.message+' · ตรวจสถานะก่อนส่งซ้ำ','wb-status'));}
      });preview.append(apply,button('ตรวจผลแผนนี้',async()=>{
        try{const state=await act('recovery.recovery_storage_status',{planId:p.planId});preview.append(el('p',state.applied?`บันทึกผลแล้ว · ${state.result.kind} · เก็บกวาด ${state.result.physicalCleanup}`:'แผนนี้ยังไม่มีผลบันทึก'));
        }catch(e){preview.append(el('p','ตรวจผลไม่สำเร็จ: '+e.message,'wb-status'));}
      }));apply.focus();
    }catch(e){preview.replaceChildren(el('p','ตรวจแผนไม่สำเร็จ: '+e.message,'wb-status'));}
  };
  settings.append(button('ตรวจแผนนโยบายสำรอง',()=>review('recovery.recovery_settings_preview',{changes:{projectBytes:Math.round(Number(quota.value)*1073741824),retentionDays:Number(days.value),retainedPoints:Number(count.value),excludePaths:excludes.value.split('\n').map(p=>p.trim()).filter(Boolean)}})));
  box.append(button('ตรวจแผนลบสำเนาที่เลือก',()=>review('recovery.recovery_cleanup_preview',{mode:'selected',checkpointIds:[...chosen]})),button('ตรวจแผนล้างตาม retention',()=>review('recovery.recovery_cleanup_preview',{mode:'retention'})),button('เก็บกวาดไฟล์ค้าง',()=>review('recovery.recovery_cleanup_preview',{mode:'pending'})),list,preview);
  const load=async()=>{
    status.replaceChildren(el('p','กำลังอ่านพื้นที่สำรอง…'));list.replaceChildren();
    try{
      const d=await act('recovery.recovery_storage_status',{cursor,limit:20});
      status.replaceChildren(el('p',`พื้นที่ source ที่เก็บจริง ${size(d.uniqueSourceBytes)} · Git copies ${size(d.gitCopyBytes)} · รวมโปรเจกต์ ${size(d.projectBytes)} / ${size(d.quota.projectBytes)}`),el('p',`เนื้อหา checkpoint รวม ${size(d.logicalCheckpointBytes)} (อาจอ้างถึงไฟล์เดียวกัน) · ${d.checkpointCount} สำเนา · ไฟล์รอเก็บกวาด ${d.pendingFiles}`,'muted'),el('p',`พื้นที่ทั้ง installation ${size(d.installationBytes)} / ${size(d.quota.installationBytes)} · ต้องเหลือดิสก์อย่างน้อย ${size(d.quota.freeFloorBytes)}`,'muted'));
      quota.value=d.settings.projectBytes/1073741824;days.value=d.settings.retentionDays;count.value=d.settings.retainedPoints;excludes.value=d.settings.excludePaths.join('\n');
      if(!d.items.length)list.append(el('p','ยังไม่มี checkpoint ในหน้านี้'));
      for(const item of d.items){const row=el('div',undefined,'wb-card');const blocked=item.protectedReason;const input=check(row,`${new Date(item.created_at).toLocaleString('th-TH')} · ${size(item.bytes)} · ${blocked?'เก็บไว้: '+(reasons[blocked]||blocked):'เลือกเพื่อลบ'}`,item.id,chosen.has(item.id));input.disabled=Boolean(blocked);input.onchange=()=>input.checked?chosen.add(item.id):chosen.delete(item.id);const detail=el('details');detail.append(el('summary','Checkpoint ID และสถานะ'),el('p',`${item.id} · ${item.state}`));row.append(detail);list.append(row);}
      if(d.nextCursor!==null)list.append(button('สำเนาหน้าถัดไป',async()=>{cursor=d.nextCursor;await load();}));if(cursor)list.append(button('สำเนาหน้าแรก',async()=>{cursor=0;await load();}));
    }catch(e){status.replaceChildren(el('p','โหลดพื้นที่สำรองไม่สำเร็จ: '+e.message,'wb-status'));}
  };
  box.append(button('โหลดพื้นที่สำรองใหม่',load));await load();
};
