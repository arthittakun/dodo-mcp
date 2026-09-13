import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { DodoError } from '../../src/errors.js';
import { downloadVerified, validateDownloadUrl, WINDOWS_PINS } from '../../src/setup/download.js';
import { inspectSetup, runSetup, parseComponents, COMPONENTS } from '../../src/setup/setup.js';
import { ensurePrivateDirectory } from '../../src/platform/privateFs.js';
import { registerManagedPath, readManagedPaths } from '../../src/setup/managedTools.js';

const owned: string[] = [];
function fixture() {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dodo-setup-unit-'))); owned.push(base);
  const root = path.join(base,'project'), configDir = path.join(base,'owner-state'); fs.mkdirSync(root);
  return {base,root,configDir};
}
afterEach(() => { for (const dir of owned.splice(0)) fs.rmSync(dir,{recursive:true,force:true,maxRetries:3}); });
const payload=Buffer.from('reviewed fixture content');
const pin={url:'https://github.com/fixture/release.zip',sha256:createHash('sha256').update(payload).digest('hex'),bytes:payload.length};
const source=(body:Buffer=payload)=> (async()=>new Response(new Uint8Array(body),{status:200})) as typeof fetch;

describe('explicit dependency setup safety and fidelity',()=>{
  it('selects only known components and deduplicates requests',()=>{
    expect(parseComponents('all')).toEqual([...COMPONENTS]);
    expect(parseComponents('git, speech,git')).toEqual(['git','speech']);
    for(const bad of ['', 'git;whoami','desktop,*','node'])expect(()=>parseComponents(bad)).toThrow();
  });
  it('check and plan do not create state, download or enable network policy',async()=>{
    const f=fixture();
    for(const mode of [{check:true},{plan:true}]){
      const report=await runSetup({cwd:f.root,configDir:f.configDir,components:['web','model'],...mode});
      expect(report.complete).toBe(false);expect(report.exitCode).toBe(2);
      expect(report.components.find(c=>c.component==='web')?.state).toBe('needs-permission');
      expect(fs.existsSync(f.configDir)).toBe(false);expect(fs.readdirSync(f.root)).toEqual([]);
    }
  });
  it('refuses permission mutation in check and plan modes',async()=>{
    const f=fixture();
    await expect(runSetup({cwd:f.root,configDir:f.configDir,check:true,enableWeb:true,components:['web']})).rejects.toThrow();
    await expect(runSetup({cwd:f.root,configDir:f.configDir,plan:true,enableWeb:true,components:['web']})).rejects.toThrow();
    expect(fs.existsSync(f.configDir)).toBe(false);
  });
  it('does not run missing-component installers without explicit --yes acknowledgement',async()=>{
    const f=fixture();
    try {
      await runSetup({cwd:f.root,configDir:f.configDir,components:['model']},()=>undefined);
      throw new Error('expected setup approval refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(DodoError);
      expect((error as DodoError).code).toBe('APPROVAL_REQUIRED');
      expect((error as DodoError).detail).toEqual({components:['model']});
    }
    expect(fs.existsSync(f.configDir)).toBe(false);
    expect(fs.readdirSync(f.root)).toEqual([]);
  });
  it('web opt-in changes only that permission while preserving owner configuration',async()=>{
    const f=fixture();ensurePrivateDirectory(f.configDir);
    fs.writeFileSync(path.join(f.configDir,'config.json'),JSON.stringify({version:1,allowWebFetch:false,commandSandbox:'require',allowedHosts:['owner.example'],lsp:{fixture:{command:'fixture-server',args:[],extensions:['.fixture']}}}),{mode:0o600});
    const report=await runSetup({cwd:f.root,configDir:f.configDir,components:['web'],enableWeb:true},()=>undefined);
    expect(report.complete).toBe(true);
    const saved=JSON.parse(fs.readFileSync(path.join(f.configDir,'config.json'),'utf8'));
    expect(saved.allowWebFetch).toBe(true);expect(saved.commandSandbox).toBe('require');expect(saved.allowedHosts).toEqual(['owner.example']);expect(saved.lsp.fixture.command).toBe('fixture-server');
    expect(fs.existsSync(path.join(f.configDir,'setup.lock'))).toBe(false);
    expect(fs.existsSync(report.receipt!)).toBe(true);
    expect(JSON.parse(fs.readFileSync(report.receipt!,'utf8'))).toMatchObject({schemaVersion:1,kind:'dodo-setup-receipt',webConsentRequested:true});
    expect(fs.readdirSync(f.root)).toEqual([]);
  });
  it('does not steal an existing setup lock',async()=>{
    const f=fixture();ensurePrivateDirectory(f.configDir);fs.writeFileSync(path.join(f.configDir,'setup.lock'),'another-owner-operation',{mode:0o600});
    await expect(runSetup({cwd:f.root,configDir:f.configDir,components:['web']},()=>undefined)).rejects.toThrow(/setup.lock/);
    expect(fs.readFileSync(path.join(f.configDir,'setup.lock'),'utf8')).toBe('another-owner-operation');
  });
  it('refuses managed tools/state inside a project',async()=>{
    const f=fixture();await expect(inspectSetup({cwd:f.root,configDir:path.join(f.root,'state'),check:true,components:['web']})).rejects.toThrow(/outside/);
    expect(fs.readdirSync(f.root)).toEqual([]);
  });
  it('registers private external tool paths without editing global PATH or owner config',()=>{
    const f=fixture();const dir=path.join(f.configDir,'tools','fixture','bin');ensurePrivateDirectory(dir);
    const before=process.env['PATH'];registerManagedPath(f.configDir,dir);
    expect(readManagedPaths(f.configDir,f.root)).toEqual([fs.realpathSync.native(dir)]);
    expect(process.env['PATH']).toBe(before);expect(fs.existsSync(path.join(f.configDir,'config.json'))).toBe(false);
  });
  it('rejects traversal and linked managed tool directories',()=>{
    const f=fixture();ensurePrivateDirectory(f.configDir);ensurePrivateDirectory(path.join(f.configDir,'tools'));
    const manifest=path.join(f.configDir,'managed-tools.json');
    fs.writeFileSync(manifest,JSON.stringify({version:1,paths:['tools/../outside']}),{mode:0o600});
    expect(()=>readManagedPaths(f.configDir,f.root)).toThrow();
    const outside=path.join(f.base,'external');fs.mkdirSync(outside);
    fs.symlinkSync(outside,path.join(f.configDir,'tools','linked'),process.platform==='win32'?'junction':'dir');
    fs.writeFileSync(manifest,JSON.stringify({version:1,paths:['tools/linked']}));
    expect(()=>readManagedPaths(f.configDir,f.root)).toThrow();
  });
  it('downloads exact bytes with SHA verification and reuses only a matching file',async()=>{
    const f=fixture(),target=path.join(f.base,'fixture.zip');await downloadVerified(pin,target,source());expect(fs.readFileSync(target)).toEqual(payload);
    await downloadVerified(pin,target,async()=>{throw Error('must not download twice');});
    fs.writeFileSync(target,'human change');await expect(downloadVerified(pin,target,source())).rejects.toThrow(/not overwritten/);expect(fs.readFileSync(target,'utf8')).toBe('human change');
  });
  it('rejects corrupt, truncated and oversized bytes without leaving final or partial files',async()=>{
    for(const body of [Buffer.from('x'.repeat(payload.length)),payload.subarray(0,-1),Buffer.concat([payload,Buffer.from('extra')])]){
      const f=fixture(),target=path.join(f.base,'bad.zip');await expect(downloadVerified(pin,target,source(body))).rejects.toThrow();expect(fs.existsSync(target)).toBe(false);expect(fs.readdirSync(f.base)).toEqual(['project']);
    }
  });
  it('refuses redirect destinations outside the fixed HTTPS publisher hosts',async()=>{
    const f=fixture();const fake=(async()=>new Response(null,{status:302,headers:{location:'http://127.0.0.1/internal'}})) as typeof fetch;
    await expect(downloadVerified(pin,path.join(f.base,'bad.zip'),fake)).rejects.toThrow();
    for(const url of ['http://github.com/x','https://github.com.evil.test/x','https://user:password@github.com/x','https://github.com:444/x','https://evil.aws.cdn.hf.co/x'])expect(()=>validateDownloadUrl(url)).toThrow();
    expect(()=>validateDownloadUrl('https://us.aws.cdn.hf.co/xet-bridge-us/model')).not.toThrow();
    expect(fs.readdirSync(f.base)).toEqual(['project']);
  });
  it('every portable Windows recipe is versioned and integrity-pinned',()=>{
    for(const spec of Object.values(WINDOWS_PINS)){
      expect(spec.url).toContain('/releases/download/');expect(spec.url).not.toContain('/latest/');expect(spec.sha256).toMatch(/^[a-f0-9]{64}$/);expect(spec.bytes).toBeGreaterThan(1000);expect(()=>validateDownloadUrl(spec.url)).not.toThrow();
    }
  });
});
