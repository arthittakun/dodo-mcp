// Explicit opt-in test: opens only a disposable, owned macOS fixture window.
// No OS permission prompts; no interaction with unrelated applications.
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import { execFileSync,spawn } from 'node:child_process';
import { setupNativeDesktop,NativeDesktopBackend } from '../dist/services/desktop/nativeBackend.js';
if(process.platform!=='darwin')throw Error('native desktop verification requires macOS');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dodo-native-fixture-'));
const app=path.join(dir,'Fixture.app'),contents=path.join(app,'Contents'),bin=path.join(contents,'MacOS','fixture');
fs.mkdirSync(path.dirname(bin),{recursive:true});
fs.writeFileSync(path.join(contents,'Info.plist'),'<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.dodo.fixture</string><key>CFBundleExecutable</key><string>fixture</string><key>CFBundleName</key><string>DODO Test Fixture</string><key>NSHighResolutionCapable</key><true/></dict></plist>');
execFileSync('/usr/bin/xcrun',['swiftc','tests/fixtures/desktop-window.swift','-o',bin],{stdio:'pipe',timeout:120000});
const setup=await setupNativeDesktop(dir);
const backend=new NativeDesktopBackend(dir);
const report={date:new Date().toISOString(),node:process.version,platform:process.platform,arch:process.arch,permissions:setup.permissions,helperCompiled:true,capture:'MANUAL_NOT_RUN',ocr:'MANUAL_NOT_RUN',accessibility:'MANUAL_NOT_RUN',control:'MANUAL_NOT_RUN'};
let child;
try{
 if(!setup.permissions.screenRecording)throw Error('Screen Recording is not granted; no permission prompt requested');
 child=spawn(bin,[],{stdio:'ignore'});
 let selected;
 for(let i=0;i<30&&!selected;i++){await new Promise(r=>setTimeout(r,150));const w=await backend.run({op:'windows',allowedApps:['dev.dodo.fixture']});selected=w.windows.find(w=>w.pid===child.pid);}
 if(!selected)throw Error('fixture window did not appear');
 const image=await backend.run({op:'capture',windowId:selected.windowId,maxEdge:1200,ocr:true,allowedApps:['dev.dodo.fixture']});
 if(!image.image||!image.ocr.some(r=>r.text.includes('FIXTURE')))throw Error('capture/OCR did not recognize the fixture');
 report.capture='PASS';report.ocr='PASS';report.imageWidth=image.imageWidth;report.imageHeight=image.imageHeight;
 const target={...image};delete target.image;delete target.ocr;delete target.ocrTruncated;
 if(setup.permissions.accessibility){
   const ax=await backend.run({op:'accessibility',target,allowedApps:['dev.dodo.fixture'],deadline:Date.now()+30000});
   if(!ax.elements.length)throw Error('accessibility tree is empty');report.accessibility='PASS';
   if(process.argv.includes('--control')){
     await backend.run({op:'action',target,action:{kind:'click',x:120,y:image.imageHeight-165,button:'left',count:1},allowedApps:['dev.dodo.fixture'],deadline:Date.now()+30000});
     const next=await backend.run({op:'capture',windowId:selected.windowId,maxEdge:1200,ocr:true,allowedApps:['dev.dodo.fixture']});
     if(!next.ocr.some(r=>r.text.includes('Clicks: 1')))throw Error('native click was not observed in fixture');report.control='PASS (fixture click observed)';
   }
 }else{
   try{await backend.run({op:'action',target,action:{kind:'focus'},allowedApps:['dev.dodo.fixture'],deadline:Date.now()+30000});throw Error('control should be denied');}catch(e){if(e.code!=='FORBIDDEN')throw e;report.control='DENIAL_PASS; positive control MANUAL_NOT_RUN (Accessibility not granted)';}
 }
}finally{
 if(child&&child.exitCode===null){child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));}
 fs.mkdirSync('artifacts',{recursive:true});fs.writeFileSync('artifacts/desktop-native-report.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
 fs.rmSync(dir,{recursive:true,force:true});
}
