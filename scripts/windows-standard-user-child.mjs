// Real per-user installation and setup; no mocks and no permission relaxation.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = path.dirname(fileURLToPath(import.meta.url));
const plan = JSON.parse(fs.readFileSync(path.join(root, 'plan.json'), 'utf8'));
const identity = JSON.parse(fs.readFileSync(path.join(root, 'identity.json'), 'utf8'));
const logs = path.join(root, 'logs'); fs.mkdirSync(logs);
const project = path.join(root, 'project'); fs.mkdirSync(project);
const prefix = path.join(root, 'installed'); fs.mkdirSync(prefix);
const config = path.join(process.env.LOCALAPPDATA, 'dodo');
const npmCli = path.join(root, 'node/node_modules/npm/bin/npm-cli.js');
const cli = path.join(prefix, 'node_modules/dodo-mcp/dist/cli/main.js');
const observer = path.join(root, 'nativeAclDiagnostics.mjs');
const result = { scope: 'windows-standard-user', identity, checks: [], complete: false, coverage: {
  nativeUacProvisioning: 'NOT_RUN', liveDesktopConsent: 'NOT_RUN', httpOAuth: 'NOT_RUN',
} };
const env = { ...process.env, npm_config_cache: path.join(root, 'npm-cache'), npm_config_userconfig: path.join(root, 'empty-npmrc'),
  npm_config_globalconfig: path.join(root, 'empty-global-npmrc'), DODO_TEST_REPORT_DIR: logs };
fs.writeFileSync(env.npm_config_userconfig, ''); fs.writeFileSync(env.npm_config_globalconfig, '');
// Deliberately no DODO_CONFIG_DIR for normal tests: exercise the user's default.
delete env.DODO_CONFIG_DIR;
function category(text) {
  if (/managed-tool ACL verification failed/.test(text)) return 'managed_tool_acl';
  if (/private Windows state ACL could not be established/.test(text)) return 'private_state_acl';
  if (/sandbox.*cancel|provisioning|UAC/i.test(text)) return 'sandbox_provisioning';
  if (/download|fetch failed|integrity|Content-Length/i.test(text)) return 'download';
  if (/EACCES|EPERM|Access.*denied|UnauthorizedAccess/i.test(text)) return 'os_access_denied';
  return 'other';
}
function run(id, args, override = {}, timeout = 600000) {
  const start = Date.now();
  const out = spawnSync(plan.node, args, { cwd: project, env: { ...env, ...override }, timeout, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8', windowsHide: true, shell: false });
  fs.writeFileSync(path.join(logs, `${id}.log`), `${out.stdout ?? ''}\n${out.stderr ?? ''}\n${out.error?.message ?? ''}`);
  const text = `${out.stdout ?? ''}\n${out.stderr ?? ''}`;
  return { out, text, exitCode: out.status, elapsedMs: Date.now() - start };
}
const cliArgs = args => ['--import', observer, cli, ...args];
function record(id, call, extra = {}) {
  const check = { id, passed: call.exitCode === 0, exitCode: call.exitCode, elapsedMs: call.elapsedMs,
    ...(call.exitCode !== 0 ? { category: category(call.text) } : {}), ...extra };
  result.checks.push(check); save(); return check;
}
function save() { fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(result, null, 2)); }

async function stdio(id) {
  const child = spawn(plan.node, cliArgs(['stdio', '--root', project]), { cwd: project, env, windowsHide: true, shell: false, stdio: ['pipe','pipe','pipe'] });
  const log = fs.createWriteStream(path.join(logs, `${id}.log`));
  child.stderr.pipe(log);
  const pending = new Map(); let serial = 0, buffer = '';
  const rejectPending = error => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); } pending.clear(); };
  child.on('error', rejectPending);
  child.on('exit', () => rejectPending(new Error('stdio exited before response')));
  child.stdout.on('data', chunk => {
    buffer += chunk;
    while (buffer.includes('\n')) {
      const i = buffer.indexOf('\n'), line = buffer.slice(0,i); buffer = buffer.slice(i+1);
      try {
        const value = JSON.parse(line), p = pending.get(value.id);
        if (p) {
          pending.delete(value.id); clearTimeout(p.timer);
          if (value.error) p.reject(new Error('MCP protocol error'));
          else p.resolve(value.result);
        }
      } catch { rejectPending(new Error('invalid MCP framing')); }
    }
  });
  const request = (method, params) => new Promise((resolve,reject) => {
    const n = ++serial;
    const timer = setTimeout(() => { pending.delete(n); reject(new Error('MCP response timeout')); }, 120000);
    pending.set(n,{resolve,reject,timer});
    child.stdin.write(JSON.stringify({ jsonrpc:'2.0',id:n,method,params })+'\n');
  });
  const tool = async (name,args) => {
    const response = await request('tools/call',{name,arguments:args});
    assert.equal(response.isError === true, false, `${name}: ${response.structuredContent?.error?.code ?? 'MCP_ERROR'}`);
    assert.equal(response.structuredContent?.ok, true, `${name}: missing success envelope`);
    return response.structuredContent.data;
  };
  try {
    await request('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'standard-user-fixture',version:'1.0.0'}});
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
    const list = await request('tools/list',{});
    assert(list.tools.some(t=>t.name==='write_file'));
    const overview = await tool('project_overview',{});
    assert.equal(fs.realpathSync.native(overview.root), fs.realpathSync.native(project));
    const context = {workspaceId:overview.workspaceId,workspaceEpoch:overview.workspaceEpoch};
    const name = `${id}.txt`;
    await tool('write_file',{...context,path:name,content:'alpha\n'});
    assert.equal(fs.readFileSync(path.join(project,name),'utf8'),'alpha\n');
    const expectedHash = 'sha256:' + createHash('sha256').update('alpha\n').digest('hex');
    await tool('edit_file',{...context,path:name,expectedHash,edits:[{find:'alpha',replace:'beta'}]});
    assert.equal(fs.readFileSync(path.join(project,name),'utf8'),'beta\n');
    await tool('read_files',{...context,files:[{path:name}]});
    return {toolCount:list.tools.length,writeEditReadBack:true};
  } finally {
    child.stdin.end();
    await new Promise(resolve => {
      if (child.exitCode !== null) return resolve();
      const timer = setTimeout(()=>{child.kill();resolve();},8000);
      child.once('exit',()=>{clearTimeout(timer);resolve();});
    });
    log.end();
  }
}
try {
  assert.equal(process.platform,'win32'); assert.equal(identity.administrator,false); assert.equal(identity.expectedUser,true);
  record('fresh-tarball-install',run('fresh-tarball-install',[npmCli,'install','--prefix',prefix,path.join(root,'package.tgz'),'--registry=https://registry.npmjs.org/','--no-audit','--no-fund'],{},600000));
  if (!fs.existsSync(cli)) throw new Error('installed CLI absent');
  record('version',run('version',[cli,'--version']));
  // Each component is independent so one failure does not hide later evidence.
  for (const component of ['git','ripgrep','ffmpeg','whisper','model','chromium','lsp','speech','desktop']) {
    const id = `setup-${component}`;
    const call = run(id,cliArgs(['setup','--yes','--components',component,'--json']),{},900000);
    let report; try { report=JSON.parse(call.out.stdout); } catch { /* retain private raw output */ }
    const item = report?.components?.find(c=>c.component===component);
    record(id,call,{component,state:['ready','missing','needs-permission','needs-backend','failed'].includes(item?.state)?item.state:null});
  }
  record('repeat-setup',run('repeat-setup',cliArgs(['setup','--yes','--components','git,ripgrep,lsp,speech','--json'])));
  record('check-setup',run('check-setup',cliArgs(['setup','--check','--components','git,ripgrep,lsp,speech','--json'])));
  record('trust-fixture',run('trust-fixture',cliArgs(['trust','--mode','edit','--yes'])));
  for (const id of ['stdio-first','stdio-restart']) {
    const start=Date.now();
    try { result.checks.push({id,passed:true,...await stdio(id),elapsedMs:Date.now()-start}); }
    catch(error) { fs.writeFileSync(path.join(logs,`${id}-failure.log`),String(error.stack)); result.checks.push({id,passed:false,category:'runtime',elapsedMs:Date.now()-start}); }
    save();
  }
  // These are reproduction cases, separate from clean-install success checks.
  const mixed=run('admin-state-setup',cliArgs(['setup','--yes','--components','ripgrep','--json']),{DODO_CONFIG_DIR:plan.mixedState});
  const mixedStart=run('admin-state-runtime',cliArgs(['trust','--mode','edit','--yes']),{DODO_CONFIG_DIR:plan.mixedState});
  result.adminCreatedState={setup:{exitCode:mixed.exitCode,category:category(mixed.text)},runtime:{exitCode:mixedStart.exitCode,category:category(mixedStart.text)},
    readableByUser:fs.existsSync(path.join(plan.mixedState,'managed-tools.json')),note:'reproduction_only_not_successful_migration'};
  result.defaultStateUsed=fs.existsSync(config);
  const aclFile=path.join(logs,'native-acl-observer.jsonl');
  result.aclDiagnostics=fs.existsSync(aclFile)?fs.readFileSync(aclFile,'utf8').trim().split('\n').filter(Boolean).slice(0,40).map(line=>JSON.parse(line)):[];
  result.complete=result.checks.every(check=>check.passed)&&result.defaultStateUsed;
} catch(error) {
  fs.writeFileSync(path.join(logs,'fixture-failure.log'),String(error.stack));
  result.fixtureFailed=true;
} finally { save(); }
process.exitCode=result.complete?0:1;
