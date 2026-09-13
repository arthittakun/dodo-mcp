import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bootstrapWorkspace } from '../../src/server/bootstrap.js';
import { invokeToolDefinition, type Principal } from '../../src/tools/context.js';
import { TOOL_CATALOG } from '../../src/tools/catalog.js';
import { removeWithRetry } from '../../src/platform/fsRetry.js';

/** Real services in isolated temporary state; never the running owner's state. */
export function platformFixture() {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dodo-platform-')));
  const root = path.join(base, 'โปรเจ็ค space'), configDir = path.join(base, 'state');
  fs.mkdirSync(root);
  const ws = bootstrapWorkspace({ invokedCwd: root, configDir: { dir: configDir, source: 'env' }, log: () => undefined });
  ws.store.setTrustMode(ws.workspaceId, 'trusted');
  const principal: Principal = { grantId: 'local-stdio', clientId: 'stdio', sub: 'owner', scopes: ['dodo:read', 'dodo:write', 'dodo:exec'] };
  ws.services.localPrincipal = principal;
  const context = { workspaceId: ws.workspaceId, epoch: ws.epoch, principal: principal.grantId };
  let serial = 0;
  return {
    base, root, configDir, ws, context,
    async call(name: string, args: Record<string, unknown>) {
      const def = TOOL_CATALOG.find(tool => tool.name === name);
      if (!def) throw new Error(`unknown test tool ${name}`);
      const result = await invokeToolDefinition({ def, services: ws.services, principal, args: { ...args, workspaceId: ws.workspaceId, workspaceEpoch: ws.epoch } });
      if (!result.envelope.ok) throw new Error(`${result.envelope.error?.code}: ${result.envelope.error?.message}`);
      return result.envelope.data as Record<string, unknown>;
    },
    key() { return `platform-fixture-${++serial}`; },
    async run(program: string, args: string[] = [], shell = false) {
      const job = ws.services.jobs.start({ ...context, kind: 'exec', program, args, cwdRel: '.', shell, timeoutMs: 30000 });
      if (!await ws.services.jobs.waitForExit(job.jobId, 35000)) throw new Error('test job did not finish');
      return { ...job, row: ws.store.getJob(job.jobId)!, stdout: ws.services.jobs.inlineOutput(job.jobId, ws.workspaceId, 'stdout', 65536).content, stderr: ws.services.jobs.inlineOutput(job.jobId, ws.workspaceId, 'stderr', 65536).content };
    },
    async close() { await ws.shutdownServices(); removeWithRetry(base, true); },
  };
}
