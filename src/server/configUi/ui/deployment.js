/* Private owner deployment controls. No credentials, raw job output or model HTML. */
'use strict';
window.DodoDeployment=({el,section,button,check,field,choice,notice,confirmDanger})=>async(parent,act,selected)=>{
  const box=section('Deployment · Docker','ตั้งปลายทางโดยเจ้าของก่อน Build และ Deploy คำสั่งอาจมีผลนอก workspace ตามสิทธิ์ Docker ของบัญชีนี้ ยังใช้ sandbox และ approval เดิม');parent.append(box);
  const status=el('p','กำลังอ่านปลายทาง…','wb-status');status.setAttribute('role','status');box.append(status);
  const reviewed=input=>({workspaceId:selected.workspaceId,workspaceEpoch:selected.workspaceEpoch,confirm:true,input});
  try{
    const targets=await act('deployment.targets');status.textContent=targets.items.length?`${targets.items.length} ปลายทางที่เจ้าของลงทะเบียน · ผล health เป็นหลักฐาน ณ เวลาที่ตรวจ`:'ยังไม่มีปลายทาง · การสำรอง source ยังทำงานตามปกติ';
    const setup=el('details');setup.append(el('summary','เพิ่มหรือแก้ปลายทาง'));box.append(setup);
    const form=el('form',undefined,'wb-form');form.onsubmit=e=>e.preventDefault();setup.append(form);
    const targetPicker=choice(form,'ปลายทางที่แก้ไข','deploymentTarget',[['','เพิ่มปลายทางใหม่'],...targets.items.map(t=>[t.id,t.definition.name])],'');
    const name=field(form,'ชื่อปลายทาง (a-z, 0-9, -)','deploymentName','web');
    const context=field(form,'Docker context','dockerContext','default'),project=field(form,'Compose project','composeProject',''),service=field(form,'Compose service','composeService','web');
    const root=field(form,'โฟลเดอร์ build ภายในโปรเจกต์','buildRoot','.'),dockerfile=field(form,'Dockerfile ภายในโฟลเดอร์ build','dockerfile','Dockerfile');
    const source=field(form,'โฟลเดอร์ source ใน image (เว้นว่างหากไม่รองรับกู้ source)','containerSource','');
    const health=field(form,'Health URL','healthUrl',''),privateNet=check(form,'อนุญาต Health URL นี้เข้าปลายทาง localhost/LAN','deploymentPrivate',false);
    const published=field(form,'พอร์ตเครื่องสำหรับ service (เว้นว่างหากไม่ publish)','publishedPort','','number'),containerPort=field(form,'พอร์ตใน container','containerPort','3000','number');
    const task=choice(form,'Required check ก่อน build','deploymentCheck',targets.recipes.map(t=>[t.taskId,t.taskId]));
    if(!targets.recipes.length)form.append(el('p','ยังไม่มี task recipe ตั้ง test script ของโปรเจกต์ก่อนลงทะเบียน target'));
    const enabled=check(form,'เปิดปลายทางนี้','deploymentEnabled',true);
    const advanced=el('details');advanced.append(el('summary','ตัวเลือกขั้นสูง: definition JSON'));form.append(advanced);
    const json=field(advanced,'Definition JSON (เว้นว่างเพื่อใช้ช่องด้านบน)','deploymentDefinition','','textarea');
    advanced.append(el('p','ใช้สำหรับ health หลายรายการ, OpenAPI contract, volume ที่มีอยู่แล้ว และงบ image ห้ามใส่ credentials หรือ Docker socket path'));
    let editing;
    targetPicker.onchange=()=>{editing=targets.items.find(t=>t.id===targetPicker.value);json.value=editing?JSON.stringify(editing.definition,null,2):'';enabled.checked=editing?.enabled??true;};
    form.append(button('บันทึกปลายทาง',async()=>{
      const recipe=targets.recipes.find(t=>t.taskId===task.value);
      let definition;
      if(json.value.trim()){try{definition=JSON.parse(json.value);}catch{throw new Error('Definition JSON ไม่ถูกต้อง');}}
      else {if(!recipe)throw new Error('ต้องเลือก required check');definition={name:name.value,adapter:'docker-compose',dockerContext:context.value,composeProject:project.value,service:service.value,contextRoot:root.value,dockerfile:dockerfile.value,requiredChecks:[recipe],health:[{id:'ready',kind:'http',url:health.value,allowPrivateNetwork:privateNet.checked}],...(source.value?{sourceMapping:{workspaceRoot:root.value,containerRoot:source.value}}:{}),ports:published.value?[{host:'127.0.0.1',published:Number(published.value),target:Number(containerPort.value)}]:[]};}
      if(!await confirmDanger('บันทึกปลายทาง Docker?',`ปลายทาง ${definition.name} จะใช้ Docker daemon ตาม context ที่ระบุ การบันทึกยังไม่ Build หรือ Deploy`,'บันทึกปลายทาง'))return;
      const result=await act('deployment.configure',reviewed({...(editing?{targetId:editing.id}:{}),expectedRevision:editing?.revision??0,enabled:enabled.checked,definition,confirmDaemonAccess:true}));
      status.textContent=`บันทึก ${result.definition.name} revision ${result.revision} แล้ว · กดรีเฟรชเพื่อใช้รายการล่าสุด`;notice('บันทึกปลายทางที่เจ้าของตรวจแล้ว');
    }));
    async function maintenancePreview(input,label,parent){
      const review=await act('deployment.maintenance',reviewed(input)),details=el('details');details.open=true;
      details.append(el('summary',label+' — ยังไม่ดำเนินการ'),el('pre',JSON.stringify(review,null,2),'wb-output'));parent.append(details);
      details.append(button('ยืนยันตามแผนนี้',async()=>{
        if(!await confirmDanger(label+'?',review.reviewId+' · ตรวจสถานะจริงซ้ำก่อนใช้แผนนี้ ไม่สั่งซ้ำหากผลไม่แน่นอน','ยืนยัน'))return;
        const outcome=await act('deployment.maintenance',reviewed({action:'apply',reviewId:review.reviewId,reviewHash:review.reviewHash}));
        details.append(el('p',outcome.state==='COMPLETED'?'ดำเนินการตามแผนแล้ว · ไม่ใช่การรับรองว่า production healthy':'ผลยังไม่แน่นอน ต้องตรวจสถานะจริงก่อนดำเนินการต่อ'));
      }));
    }
    const retention=el('details');retention.append(el('summary','การเก็บ image และล้างเฉพาะรายการที่ไม่มีการอ้างอิง'));box.append(retention);
    retention.append(el('p','เก็บตามงบของ target พร้อมป้องกัน image ที่ปักหมุด, ใช้งานใน container, known-good ล่าสุด/ก่อนหน้า หรือแผนที่ยังใช้ได้ ไม่มีการ prune หรือแตะ volume'));
    for(const t of targets.items)retention.append(button('ดูแผนล้าง image: '+t.definition.name,()=>maintenancePreview({action:'cleanup_preview',targetId:t.id},'ล้าง image ตามแผน',retention)));
    const plans=section('แผน Build / Deploy','เลือก verification ที่ตรงกับ source ปัจจุบัน ทุกแผนมี hash และหมดอายุ ผลไม่แน่นอนต้องตรวจสถานะก่อนสั่งใหม่');box.append(plans);
    const target=choice(plans,'ปลายทางสำหรับแผน','deploymentPlanTarget',targets.items.filter(t=>t.enabled).map(t=>[t.id,`${t.definition.name} · revision ${t.revision}`]));
    const verification=field(plans,'Verification ID ที่ checks ผ่าน','deploymentVerification','');
    let prepareKey;
    plans.append(button('สร้างแผน Deployment',async()=>{
      const t=targets.items.find(t=>t.id===target.value);if(!t)throw new Error('เลือกปลายทางที่เปิดอยู่');
      prepareKey??=crypto.randomUUID();
      const p=await act('deployment.prepare',reviewed({targetId:t.id,expectedTargetRevision:t.revision,verificationId:verification.value,idempotencyKey:prepareKey}));
      prepareKey=undefined;await load(p.plan.deploymentId);
    }));
    const records=el('div');plans.append(records);
    async function load(focus){
      records.replaceChildren(el('p','กำลังอ่านผลที่บันทึก…'));
      const result=await act('deployment.list');records.replaceChildren();
      if(!result.items.length)records.append(el('p','ยังไม่มีแผน Deployment'));
      for(const r of result.items){
        const card=section(r.plan.deploymentId,`${r.state} · image ${r.imageDigest||'ยังไม่สร้าง'}`);records.append(card);
        const details=el('details');details.open=r.plan.deploymentId===focus;details.append(el('summary','แผนและหลักฐาน'),el('pre',JSON.stringify(r,null,2),'wb-output'));card.append(details);
        card.append(button('เปรียบเทียบ source',async()=>{const result=await act('deployment.compare',{deploymentId:r.plan.deploymentId});details.open=true;details.replaceChildren(el('summary','ผลเปรียบเทียบ'),el('pre',JSON.stringify(result,null,2),'wb-output'));}));
        if(!r.retention?.imageRetired)card.append(button(r.retention?.pinned?'เลิกปักหมุด image':'ปักหมุด image',async()=>{
          await act('deployment.maintenance',reviewed({action:'pin',deploymentId:r.plan.deploymentId,pinned:!r.retention?.pinned,expectedPinned:!!r.retention?.pinned}));await load(r.plan.deploymentId);
        }));
        if(r.state==='UNKNOWN'&&!r.retention?.uncertaintyAcknowledged)card.append(button('ตรวจและรับทราบผลที่ไม่แน่นอน',()=>maintenancePreview({action:'resolve_preview',deploymentId:r.plan.deploymentId},'รับทราบ UNKNOWN โดยไม่สั่งซ้ำและไม่รับรอง health',card)));
        if(r.retention?.cleanupOutcome?.state==='UNKNOWN')card.append(button('ตรวจผลล้าง image ที่ยังไม่แน่นอน',()=>maintenancePreview({action:'image_preview',deploymentId:r.plan.deploymentId},'รับทราบสถานะ image โดยไม่สั่งลบซ้ำ',card)));
        if(r.retention?.unfinishedProbe)card.append(button('ตรวจ container probe ที่ค้าง',()=>maintenancePreview({action:'probe_preview',deploymentId:r.plan.deploymentId},'ล้างเฉพาะ probe ที่หยุดอยู่และมี identity ตรง',card)));
        if(r.imageDigest){
          card.append(button('ตรวจ container จริง',async()=>{const result=await act('deployment.observe',reviewed({deploymentId:r.plan.deploymentId}));details.open=true;details.replaceChildren(el('summary','ผลตรวจ container ณ เวลานี้'),el('pre',JSON.stringify(result,null,2),'wb-output'));}));
          card.append(button('ดูแผนกู้ source จาก container',async()=>{
            const result=await act('deployment.source_preview',reviewed({deploymentId:r.plan.deploymentId})),p=result.restore;
            details.open=true;details.replaceChildren(el('summary','แผนกู้ source — ยังไม่เปลี่ยนไฟล์'));
            for(const file of p.files||[])details.append(el('h4',file.path),el('pre',file.diff||'(ตรวจด้วย hash)','wb-output'));
            for(const conflict of p.conflicts||[])details.append(el('p',conflict.path+': '+conflict.reason));
            if(!p.applicable){details.append(el('p',p.unchanged?'Source ตรงกับภาพที่ตรวจแล้ว':'แผนยังใช้ไม่ได้ โปรดตรวจ conflict'));return;}
            const key=crypto.randomUUID();let sent=false;
            details.append(button('กู้ source ตามแผนจาก container',async()=>{
              if(sent||!await confirmDanger('กู้ source ที่ตรวจแล้ว?',`${p.planId} · สำรองไฟล์ปัจจุบันก่อนแก้ ไม่แตะ DB, volume หรือ restart container`,'กู้ source'))return;
              sent=true;
              try{const outcome=await act('recovery.restore_apply',{planId:p.planId,planHash:p.planHash,idempotencyKey:key,workspaceId:p.workspaceId,workspaceEpoch:p.workspaceEpoch,confirm:true});details.append(el('p',outcome.verified?'กู้และตรวจ source สำเร็จ':'ยังไม่มีผลยืนยันการตรวจ source'));}
              catch(e){details.append(el('p','ยังยืนยันผลไม่ได้: '+e.message+' · ตรวจ restore_status ก่อนสั่งใหม่'));throw e;}
            }));
          }));
        }
        if(r.state==='KNOWN_GOOD'&&!r.retention?.imageRetired){
          let rollbackKey;
          card.append(button('เตรียม rollback image นี้',async()=>{
            if(!await confirmDanger('เตรียมแผน rollback?',`${r.imageDigest} · ตรวจ container ปัจจุบันก่อน ยังไม่ Deploy และไม่ย้อน DB`,'เตรียมแผน'))return;
            rollbackKey??=crypto.randomUUID();const result=await act('deployment.rollback_prepare',reviewed({deploymentId:r.plan.deploymentId,idempotencyKey:rollbackKey}));await load(result.plan.deploymentId);
          }));
        }
        if(r.state==='PREPARED'||r.state==='BUILT'){
          const op=r.state==='PREPARED'?'build':'apply',label=op==='build'?'Build ตามแผนนี้':'Deploy image นี้';
          card.append(button(label,async()=>{
            if(!await confirmDanger(label+'?',`${r.plan.deploymentId} · ${r.imageDigest||r.planHash} · ไม่เปลี่ยน DB หรือสั่งลบ volume` ,label))return;
            const payload={deploymentId:r.plan.deploymentId,planHash:r.planHash,...(op==='apply'?{imageDigest:r.imageDigest}:{})};
            try{const result=await act('deployment.'+op,reviewed(payload));status.textContent=`${result.state} · ${result.plan.deploymentId}`;await load(r.plan.deploymentId);}
            catch(e){status.textContent='ยังยืนยันผลไม่ได้: '+e.message+' · กดอ่านผลล่าสุดก่อนสั่งใหม่';throw e;}
          }));
        }
      }
      if(result.nextCursor!==null)records.append(el('p','มีประวัติเก่ามากกว่าหน้านี้ ใช้ deployment_list พร้อม cursor เพื่ออ่านต่อ'));
    }
    plans.append(button('อ่านผลล่าสุด',()=>load()));await load();
    box.append(el('p','การป้องกันนี้ครอบคลุม DODO deployment adapter คำสั่ง shell หรือ CI ภายนอกยังเปลี่ยน production ได้เอง Source backup ไม่รวม DB, secrets และ volume data','muted'));
  }catch(e){status.textContent='อ่าน Deployment ไม่สำเร็จ: '+e.message;status.dataset.kind='error';}
};
