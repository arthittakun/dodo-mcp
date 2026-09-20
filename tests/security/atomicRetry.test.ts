import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { platformFixture } from '../helpers/platform.js';
import * as retry from '../../src/platform/fsRetry.js';
import { sha256Bytes } from '../../src/util/hash.js';
import { DodoError, toDodoError } from '../../src/errors.js';

describe('Windows sharing retries preserve concurrent external edits',()=>{
 let f:ReturnType<typeof platformFixture>;
 afterEach(async()=>{vi.restoreAllMocks();await f?.close();});
 it.each(['edit','delete','move'] as const)('%s rechecks the target after a sharing lock before another syscall',async operation=>{
  f=platformFixture();const target=path.join(f.root,'source.txt');fs.writeFileSync(target,'before');
  const originalRetry=retry.retryWindowsFs;
  vi.spyOn(retry,'retryWindowsFs').mockImplementation(fn=>originalRetry(fn,'win32'));
  vi.spyOn(retry,'renameWithRetry').mockImplementation((from,to)=>originalRetry(()=>fs.renameSync(from,to),'win32'));
  // The real syscall boundary is denied once, while an unrelated writer edits
  // the file. Retrying the same effect without a fresh guard would destroy it.
  let injected=false;
  const rename=fs.renameSync,unlink=fs.unlinkSync;
  const block=()=>{injected=true;fs.writeFileSync(target,'external');throw Object.assign(new Error('fixture sharing lock'),{code:'EPERM'});};
  vi.spyOn(fs,'renameSync').mockImplementation((from,to)=>{
   if(!injected&&((operation==='edit'&&String(to)===target)||(operation==='move'&&String(from)===target)))block();
   return rename(from,to);
  });
  vi.spyOn(fs,'unlinkSync').mockImplementation(file=>{if(!injected&&operation==='delete'&&String(file)===target)block();return unlink(file);});
  const call=operation==='edit'?f.call('edit_file',{path:'source.txt',expectedHash:sha256Bytes(Buffer.from('before')),edits:[{find:'before',replace:'after'}]}):operation==='delete'?f.call('delete_path',{path:'source.txt'}):f.call('move_path',{path:'source.txt',destPath:'moved.txt'});
  await expect(call).rejects.toThrow(/FILE_CHANGED|PARTIAL_RECOVERY_REQUIRED/);
  expect(injected).toBe(true);expect(fs.readFileSync(target,'utf8')).toBe('external');expect(fs.existsSync(path.join(f.root,'moved.txt'))).toBe(false);
 });
 it.each(['create','modify','move'] as const)('%s compensation rechecks after a sharing lock and preserves new owner bytes',async operation=>{
  f=platformFixture();const first=path.join(f.root,'first.txt'),second=path.join(f.root,'second.txt'),moved=path.join(f.root,'moved.txt');
  if(operation!=='create')fs.writeFileSync(first,'before');fs.writeFileSync(second,'second-before');
  const originalRetry=retry.retryWindowsFs,rename=fs.renameSync,unlink=fs.unlinkSync;
  vi.spyOn(retry,'retryWindowsFs').mockImplementation(fn=>originalRetry(fn,'win32'));
  vi.spyOn(retry,'renameWithRetry').mockImplementation((from,to)=>originalRetry(()=>fs.renameSync(from,to),'win32'));
  let applyingFailed=false,injected=false;
  const block=(target:string)=>{injected=true;fs.writeFileSync(target,'external');throw Object.assign(new Error('fixture sharing lock'),{code:'EPERM'});};
  vi.spyOn(fs,'renameSync').mockImplementation((from,to)=>{
   if(String(to)===second){applyingFailed=true;throw Object.assign(new Error('fixture disk failure'),{code:'EIO'});}
   if(applyingFailed&&!injected&&operation==='modify'&&String(to)===first)block(first);
   if(applyingFailed&&!injected&&operation==='move'&&String(from)===moved)block(moved);
   return rename(from,to);
  });
  vi.spyOn(fs,'unlinkSync').mockImplementation(file=>{if(applyingFailed&&!injected&&operation==='create'&&String(file)===first)block(first);return unlink(file);});
  const firstOp=operation==='create'?{op:'create',path:'first.txt',content:'after'}:operation==='modify'?{op:'replace_file',path:'first.txt',content:'after'}:{op:'move',path:'first.txt',destPath:'moved.txt'};
  const plan=await f.call('preview_changes',{operations:[firstOp,{op:'replace_file',path:'second.txt',content:'second-after'}]});
  await expect(f.call('apply_changes',{planId:plan.planId,planHash:plan.planHash,idempotencyKey:f.key()})).rejects.toThrow('PARTIAL_RECOVERY_REQUIRED');
  expect(injected).toBe(true);expect(fs.readFileSync(operation==='move'?moved:first,'utf8')).toBe('external');expect(fs.readFileSync(second,'utf8')).toBe('second-before');
 });
 it('keeps an OS failure cause private while preserving the public error contract',()=>{
  const cause=Object.assign(new Error('PRIVATE_SECRET_PATH_AND_TOKEN'),{code:'EPERM'});
  const error=new DodoError('INTERNAL_ERROR','apply failed',{cause});
  expect(error.cause).toBe(cause);
  const info=toDodoError(error).toInfo();
  expect(info).toEqual({code:'INTERNAL_ERROR',message:'apply failed',retryable:false});
  expect(JSON.stringify(info)).not.toContain('PRIVATE_SECRET_PATH_AND_TOKEN');
 });
});
