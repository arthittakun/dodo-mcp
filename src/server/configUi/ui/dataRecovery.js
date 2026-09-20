/* Private owner data controls. Separate opt-in; no database writes or credentials in the browser. */
'use strict';
window.DodoDataRecovery=({el,section,button,check,field,choice,confirmDanger})=>async(parent,act,selected)=>{
  const card=section('Database · ตรวจความเข้ากันได้','อ่านเฉพาะ migration metadata ที่เจ้าของเลือก ไม่ย้อนข้อมูล ไม่รัน SQL หรือ migration อัตโนมัติ');parent.append(card);
  const state=el('p','กำลังอ่านการตั้งค่า…');state.setAttribute('role','status');card.append(state);
  const reviewed=input=>({workspaceId:selected.workspaceId,workspaceEpoch:selected.workspaceEpoch,confirm:true,input});
  try{
    const result=await act('recovery.database.list');
    state.textContent=result.configured?`${result.targetCount} ปลายทาง · ยังไม่รับรองความเข้ากันได้จนตรวจ checkpoint`:'ยังไม่เปิดอ่านฐานข้อมูล · Source backup ไม่รวมข้อมูล DB';
    const advanced=el('details');advanced.append(el('summary','เพิ่มปลายทาง SQLite แบบอ่านอย่างเดียว'));card.append(advanced);
    const name=field(advanced,'ชื่อฐานข้อมูลสำหรับการตรวจ','recoveryDbName',''),file=field(advanced,'ไฟล์ .sqlite/.db ภายในโปรเจกต์','recoveryDbFile','');
    const table=field(advanced,'ตาราง migration IDs','recoveryDbTable','migrations'),column=field(advanced,'คอลัมน์ migration ID','recoveryDbColumn','id');
    const policy=choice(advanced,'เมื่อ schema ไม่ตรงหรือยังตรวจไม่ได้','recoveryDbPolicy',[['block','หยุด source restore จนตรวจได้'],['warn','แจ้งเตือน แต่เจ้าของยอมให้ restore source']],'block');
    advanced.append(button('อนุญาตให้อ่าน migration metadata',async()=>{
      if(!await confirmDanger('เปิดการตรวจฐานข้อมูลนี้?',`${file.value} · อ่านอย่างเดียว ไม่มีการสำรองหรือแก้แถวข้อมูล`,'อนุญาตให้อ่าน'))return;
      const saved=await act('recovery.database.configure',reviewed({expectedRevision:0,enabled:true,confirmReadOnlyAccess:true,definition:{name:name.value,adapter:'sqlite-migration-table',databaseFile:file.value,table:table.value,column:column.value,onMismatch:policy.value}}));
      state.textContent=`บันทึก ${saved.id} revision ${saved.revision} · รีเฟรชหน้าโปรเจกต์เพื่อผูก checkpoint`;
    }));
    for(const target of result.items){
      const d=section(target.definition.name,`${target.enabled?'เปิด':'ปิด'} · ${target.definition.databaseFile} · revision ${target.revision}`);card.append(d);
      d.append(button('อ่าน migration IDs ปัจจุบัน',async()=>{const out=await act('recovery.database.inspect',reviewed({targetId:target.id}));const view=el('details');view.open=true;view.append(el('summary','Metadata ที่อ่านจริง'),el('pre',JSON.stringify(out,null,2)));d.append(view);}));
      d.append(button(target.enabled?'ปิดการตรวจปลายทางนี้':'เปิดการตรวจปลายทางนี้',async()=>{
        if(!await confirmDanger('เปลี่ยนการตรวจ schema?',target.enabled?'เมื่อปิด ผล compatibility จะเป็น UNKNOWN และไม่ใช้ปลายทางนี้บล็อก source restore':'จะตรวจ readiness แบบอ่านอย่างเดียวก่อนเปิด','บันทึก'))return;
        const out=await act('recovery.database.configure',reviewed({targetId:target.id,expectedRevision:target.revision,enabled:!target.enabled,confirmReadOnlyAccess:true,definition:target.definition}));state.textContent=`บันทึก revision ${out.revision} แล้ว · รีเฟรชก่อนแก้ครั้งถัดไป`;
      }));
      const bind=el('details');bind.append(el('summary','กำหนด compatibility ของ checkpoint โดยเจ้าของ'));d.append(bind);
      const checkpoint=field(bind,'Checkpoint ID','dbCheckpoint-'+target.id,''),ids=field(bind,'Migration IDs ที่ source นี้ต้องใช้ (คั่นด้วย comma)','dbIds-'+target.id,'');
      const extra=check(bind,'ยอมรับ migration เพิ่มเติมนอกจากที่ระบุ','dbExtra-'+target.id,false);
      bind.append(button('บันทึกกติกา checkpoint',async()=>{
        if(!await confirmDanger('รับรองกติกาความเข้ากันได้?',checkpoint.value+' · เป็นกติกาที่เจ้าของระบุ ไม่ใช่ผลเดาจาก SQL หรือ AI','บันทึกกติกา'))return;
        const out=await act('recovery.database.bind',reviewed({targetId:target.id,expectedRevision:target.revision,checkpointId:checkpoint.value,requiredMigrationIds:ids.value.split(',').map(s=>s.trim()).filter(Boolean),allowExtra:extra.checked,confirmCompatibilityRule:true}));
        state.textContent=`ผูก ${out.checkpointId} กับ ${out.requiredCount} migration IDs แล้ว · preview source restore ใหม่เพื่อดูผล`;
      }));
      bind.append(button('ถอนกติกาของ checkpoint นี้',async()=>{
        if(!await confirmDanger('ถอนกติกาความเข้ากันได้?',checkpoint.value+' · กลับเป็น UNKNOWN และจุดกู้คืนนี้อาจหมดอายุตาม retention ถ้าไม่มีรายการอื่นอ้างถึง','ถอนกติกา'))return;
        const out=await act('recovery.database.unbind',reviewed({targetId:target.id,expectedRevision:target.revision,checkpointId:checkpoint.value,confirmCompatibilityRemoval:true}));state.textContent=out.removed?'ถอนกติกาแล้ว · ไม่ได้เปลี่ยน DB':'ไม่มีกติกาที่ตรงกับ checkpoint นี้';
      }));
    }
  }catch(e){state.textContent='อ่านการตั้งค่าฐานข้อมูลไม่สำเร็จ: '+e.message;state.setAttribute('role','alert');}
  const vault=section('Private config · สำรองแบบเข้ารหัส','ปิดเป็นค่าเริ่มต้นสำหรับข้อมูลลับ · เปิดแยกเป็นรายไฟล์โดยเจ้าของ เก็บ key ใน Keychain / Credential Manager / Secret Service ไม่มี plaintext export ให้ AI');parent.append(vault);
  const vaultState=el('p','กำลังอ่านรายการสำรอง…');vaultState.setAttribute('role','status');const vaultBody=el('div');vault.append(vaultState,vaultBody);
  async function loadVault(){
    try{
      const data=await act('recovery.config.list');vaultBody.replaceChildren();
      vaultState.textContent=data.targets.length?`${data.targets.length} ไฟล์ที่ลงทะเบียน · แสดงสำเนาล่าสุด ${data.backups.length} รายการ`:'ยังไม่ลงทะเบียนไฟล์ลับ · Source backup ยังคงไม่รวม secrets';
      const form=el('details');form.append(el('summary','ลงทะเบียนไฟล์ลับสำหรับสำรอง'));vaultBody.append(form);
      const name=field(form,'ชื่อรายการ config','configVaultName',''),file=field(form,'Path ภายในโปรเจกต์ เช่น .env','configVaultPath','');
      const retention=field(form,'จำนวนสำเนาที่เก็บ (2–100; สำเนาที่มีแผนกู้คืนอ้างถึงจะยังเก็บ)','configVaultRetention','10','number');retention.min='2';retention.max='100';
      form.append(el('p','เลือกได้เฉพาะไฟล์ private ที่ source tools อ่านไม่ได้ ขนาดไม่เกิน 1 MiB · หาก OS key store ใช้ไม่ได้จะไม่เปิดการสำรอง'));
      form.append(button('เปิดสำรองไฟล์ลับนี้',async()=>{
        if(!await confirmDanger('เปิดสำรองแบบเข้ารหัส?',file.value+' · Key เก็บใน OS key store ของผู้ใช้นี้ หาก key หายจะถอดสำเนาไม่ได้','เปิดเฉพาะไฟล์นี้'))return;
        const out=await act('recovery.config.configure',reviewed({expectedRevision:0,enabled:true,confirmEncryptedPrivateBackup:true,definition:{name:name.value,path:file.value,retention:Number(retention.value)}}));
        await loadVault();vaultState.textContent=`ลงทะเบียน ${out.id} revision ${out.revision} แล้ว · ยังไม่สร้างสำเนาจนกดสำรอง`;
      }));
      for(const target of data.targets){
        const box=section(target.definition.name,`${target.enabled?'เปิด':'ปิด'} · ${target.definition.path} · revision ${target.revision}`);vaultBody.append(box);
        if(target.enabled)box.append(button('สำรอง config ตอนนี้',async()=>{const out=await act('recovery.config.backup',reviewed({targetId:target.id}));await loadVault();vaultState.textContent=`สร้างสำเนาเข้ารหัส ${out.id} · ${out.bytes} bytes`; }));
        box.append(button(target.enabled?'ปิดการสำรอง config':'เปิดการสำรอง config',async()=>{
          if(!await confirmDanger('เปลี่ยนการสำรองไฟล์ลับ?',target.definition.path+' · สำเนาเดิมยังเก็บไว้ การปิดจะระงับการกู้คืนจนเปิดใหม่','บันทึก'))return;
          const out=await act('recovery.config.configure',reviewed({targetId:target.id,expectedRevision:target.revision,enabled:!target.enabled,definition:target.definition,confirmEncryptedPrivateBackup:true}));await loadVault();vaultState.textContent=`บันทึก revision ${out.revision} · ${out.enabled?'เปิด':'ปิด'}`;
        }));
        box.append(button('หมุนเวียน key',async()=>{
          if(!await confirmDanger('สร้าง key ใหม่?', 'สำเนาเก่ายังต้องใช้ key เดิม ห้ามลบ key เดิมออกจาก OS store จนเลิกใช้สำเนาที่อ้างถึง','สร้าง key ใหม่'))return;
          const out=await act('recovery.config.rotate',reviewed({targetId:target.id,expectedRevision:target.revision}));await loadVault();vaultState.textContent=`สร้าง key ใหม่แล้ว revision ${out.revision} · ไม่เข้ารหัสสำเนาเก่าซ้ำ`;
        }));
        const keep=field(box,'จำนวนสำเนาที่เก็บสำหรับ '+target.definition.name,'configKeep-'+target.id,String(target.definition.retention),'number');keep.min='2';keep.max='100';
        box.append(button('บันทึก retention ของ config',async()=>{
          if(!await confirmDanger('เปลี่ยนจำนวนสำเนาที่เก็บ?', 'สำเนาเก่าที่เกินจำนวนนี้และไม่มีแผนกู้คืนอ้างถึงจะถูกลบจาก state โดยไม่ลบ key เก่าออกจาก OS store','บันทึก retention'))return;
          const out=await act('recovery.config.configure',reviewed({targetId:target.id,expectedRevision:target.revision,enabled:target.enabled,definition:{...target.definition,retention:Number(keep.value)},confirmEncryptedPrivateBackup:true}));await loadVault();vaultState.textContent=`บันทึก retention แล้ว revision ${out.revision} · สำเนาที่แผนกู้คืนอ้างถึงยังเก็บไว้`;
        }));
        const backups=data.backups.filter(b=>b.target_id===target.id);if(!backups.length)box.append(el('p','ยังไม่มีสำเนาเข้ารหัส'));
        for(const backup of backups){
          const row=el('div');row.append(el('p',`${backup.id} · ${new Date(backup.created_at).toLocaleString('th-TH')} · ${backup.bytes} bytes`));box.append(row);
          if(target.enabled)row.append(button('ตรวจแผนคืน config',async()=>{
            const plan=await act('recovery.config.preview',reviewed({backupId:backup.id}));const result=el('section');
            result.append(el('h4','แผนคืนค่า · ไม่แสดงเนื้อหาลับ'),el('p',`${plan.changed?'เนื้อหาต่างจากปัจจุบัน':'เนื้อหาตรงกับปัจจุบัน'} · ${plan.bytesBefore} → ${plan.bytesAfter} bytes · หมดอายุ ${new Date(plan.expiresAt).toLocaleTimeString('th-TH')}`));
            result.append(el('p','หยุดโปรแกรมที่อ่าน/เขียน config นี้ก่อนยืนยัน ระบบสำรองค่าปัจจุบันแบบเข้ารหัสก่อนเขียนทับไฟล์เดิม หากเครื่องดับอาจเหลือบางส่วนและจะรายงาน UNKNOWN ไม่เขียนซ้ำอัตโนมัติ ไม่ restart โปรแกรมให้'));
            result.append(button('ยืนยันคืนค่า config',async()=>{
              if(!await confirmDanger('คืนค่าไฟล์ลับตามแผนนี้?',target.definition.path+' · ยืนยันว่าหยุดโปรแกรมที่ใช้ไฟล์นี้แล้ว สำเนาก่อนคืนค่าจะเข้ารหัสด้วย','คืนค่า config'))return;
              const out=await act('recovery.config.apply',reviewed({planId:plan.planId,planHash:plan.planHash}));await loadVault();
              vaultState.textContent=out.state==='APPLIED'?`อ่านกลับตรงกับสำเนา · ${plan.planId} · ยังไม่ได้ restart โปรแกรม`:`สถานะ ${out.state} · ตรวจไฟล์ในเครื่องและสำเนาก่อนคืนค่า ห้ามส่งแผนเดิมซ้ำเพื่อหวังให้เขียนใหม่`;
            }));row.append(result);
          }));
        }
      }
      if(data.restores.length){const details=el('details');details.append(el('summary','ประวัติแผนและสถานะการกู้คืน'));for(const r of data.restores)details.append(el('p',`${r.id} · ${r.state} · สำเนาก่อนเขียน: ${r.before_id||'ยังไม่มี'}`));vaultBody.append(details);}
    }catch(e){vaultState.textContent='อ่านรายการ config ไม่สำเร็จ: '+e.message;vaultState.setAttribute('role','alert');}
  }
  await loadVault();
};
