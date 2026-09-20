import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { mkTmpDir } from '../helpers/testServer.js';
import { bootstrapWorkspace } from '../../src/server/bootstrap.js';

/** Kill ONLY a child fixture after a real rename, before SQLite 'written'. */
describe('R00 real-process crash recovery', () => {
  for (const direction of ['apply', 'rollback'] as const) for (const stopAfter of [1, 2]) {
    it(`${direction}: SIGKILL after rename ${stopAfter} reconciles actual bytes`, async () => {
      const base = fs.realpathSync.native(mkTmpDir('dodo-kill-fixture-')), root = path.join(base, 'root'), config = path.join(base, 'state');
      fs.mkdirSync(root); fs.writeFileSync(path.join(root, 'a.txt'), 'A'); fs.writeFileSync(path.join(root, 'b.txt'), 'B');
      const script = path.join(base, 'crash.mjs');
      const bootstrap = pathToFileURL(path.resolve('dist/server/bootstrap.js')).href;
      const context = pathToFileURL(path.resolve('dist/tools/context.js')).href;
      const catalog = pathToFileURL(path.resolve('dist/tools/catalog.js')).href;
      fs.writeFileSync(script, `import fs from 'node:fs'; import path from 'node:path';
import {bootstrapWorkspace} from ${JSON.stringify(bootstrap)};
import {invokeToolDefinition} from ${JSON.stringify(context)};
import {TOOL_CATALOG} from ${JSON.stringify(catalog)};
const [root, config, direction, count]=process.argv.slice(2);
const ws=bootstrapWorkspace({invokedCwd:root,configDir:{dir:config,source:'env'},log:()=>{}});
ws.store.setTrustMode(ws.workspaceId,'trusted');
const principal={grantId:'fixture',clientId:'fixture',sub:'owner',scopes:['dodo:read','dodo:write','dodo:exec']};
ws.services.localPrincipal=principal;
async function call(name,args){const r=await invokeToolDefinition({def:TOOL_CATALOG.find(t=>t.name===name),services:ws.services,principal,args:{...args,workspaceId:ws.workspaceId,workspaceEpoch:ws.epoch}});if(!r.envelope.ok)throw new Error(r.envelope.error.code);return r.envelope.data;}
const p=await call('preview_changes',{operations:[{op:'replace_file',path:'a.txt',content:'A2'},{op:'replace_file',path:'b.txt',content:'B2'}]});
const apply=()=>call('apply_changes',{planId:p.planId,planHash:p.planHash,idempotencyKey:'fixture-apply'});
let original;if(direction==='rollback'){original=await apply();fs.writeFileSync(path.join(path.dirname(root),'original.json'),JSON.stringify(original));}
const rename=fs.renameSync;let writes=0;
fs.renameSync=function(a,b){const out=rename(a,b);if(path.dirname(String(b))===root&&String(b).endsWith('.txt')&&++writes===Number(count))process.kill(process.pid,'SIGKILL');return out;};
if(direction==='apply')await apply();else await call('rollback_changes',{changesetId:original.changesetId,idempotencyKey:'fixture-rollback'});
throw new Error('fixture did not crash');
`);
      let child: ReturnType<typeof spawn> | undefined;
      let ws: ReturnType<typeof bootstrapWorkspace> | undefined;
      try {
        child = spawn(process.execPath, [script, root, config, direction, String(stopAfter)], { stdio: ['ignore','ignore','pipe'] });
        let stderr = ''; child.stderr!.on('data', chunk => { stderr += String(chunk).slice(0, 2000); });
        const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
          const timer = setTimeout(() => { child!.kill('SIGKILL'); reject(new Error('fixture timed out')); }, 30000);
          child!.once('error', error => { clearTimeout(timer); reject(error); });
          child!.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
        });
        expect(exit.signal ?? exit.code, stderr).toBe(process.platform === 'win32' ? 1 : 'SIGKILL');
        // A newer human edit must remain intact during boot reconciliation.
        if (stopAfter === 1) fs.writeFileSync(path.join(root, 'a.txt'), 'human-after-crash');
        ws = bootstrapWorkspace({ invokedCwd: root, configDir: { dir: config, source: 'env' }, log: () => undefined });
        const rows = ws.store.listChangesets(ws.workspaceId, 10);
        const interrupted = rows.find(cs => cs.kind === direction)!;
        expect(interrupted.status).toBe(stopAfter === 2 ? 'committed' : 'recovery_required');
        if (stopAfter === 1) expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe('human-after-crash');
        else {
          expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe(direction === 'apply' ? 'A2' : 'A');
          expect(fs.readFileSync(path.join(root, 'b.txt'), 'utf8')).toBe(direction === 'apply' ? 'B2' : 'B');
          if (direction === 'rollback') expect(rows.find(cs => cs.kind === 'apply')?.status).toBe('rolled_back');
        }
      } finally { if (child?.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await ws?.shutdownServices(); fs.rmSync(base, { recursive: true, force: true }); }
    }, 45000);
  }
});
