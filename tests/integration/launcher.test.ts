import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startServer, type RunningServer } from '../../src/server/appServer.js';
import { loadGlobalConfig } from '../../src/config/globalConfig.js';
import { statePaths } from '../../src/config/paths.js';

const created: string[] = [];
const running: RunningServer[] = [];
function temp(prefix: string): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(value);
  return value;
}

afterEach(async () => {
  for (const server of running.splice(0)) await server.close();
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('global launcher mode', () => {
  it('does not expose the invocation CWD and activates the first owner-selected project atomically', async () => {
    const configDir = temp('dodo-launcher-cfg-');
    const unrelatedCwd = temp('dodo-launcher-cwd-');
    const project = temp('dodo-launcher-project-');
    fs.writeFileSync(path.join(project, 'project.txt'), 'selected');
    const previous = process.env['DODO_CONFIG_DIR'];
    process.env['DODO_CONFIG_DIR'] = configDir;
    let server: RunningServer;
    try {
      server = await startServer({ invokedCwd: unrelatedCwd, deferWorkspace: true, portOverride: 0, configPort: 0, quiet: true });
    } finally {
      if (previous === undefined) delete process.env['DODO_CONFIG_DIR']; else process.env['DODO_CONFIG_DIR'] = previous;
    }
    running.push(server);
    expect(server.workspaceSelected).toBe(false);
    expect(server.root).not.toBe(fs.realpathSync(unrelatedCwd));

    const health = await (await fetch(`http://127.0.0.1:${server.port}/healthz`)).json() as { workspaceSelected: boolean };
    expect(health.workspaceSelected).toBe(false);
    const blocked = await fetch(`http://127.0.0.1:${server.port}/mcp`, { method: 'POST' });
    expect(blocked.status).toBe(503);
    expect(await blocked.json()).toMatchObject({ error: 'workspace_required' });

    const configUrl = new URL(server.configUrl as string);
    const authorization = `Bearer ${configUrl.hash.slice(1)}`;
    const stateResponse = await fetch(`${configUrl.origin}/api/state`, { headers: { authorization } });
    const initial = await stateResponse.json() as { workspace: null; controlContext: { workspaceId: string; epoch: string }; workspaceSwitchSupported: boolean };
    expect(initial.workspace).toBeNull();
    expect(initial.workspaceSwitchSupported).toBe(true);
    expect(JSON.stringify(initial)).not.toContain(unrelatedCwd);
    const headers = {
      authorization,
      'content-type': 'application/json',
      'x-dodo-workspace': initial.controlContext.workspaceId,
      'x-dodo-epoch': initial.controlContext.epoch,
    };

    const unauthorized = await fetch(`${configUrl.origin}/api/workspace/switch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: project }) });
    expect(unauthorized.status).toBe(401);
    const invalid = await fetch(`${configUrl.origin}/api/workspace/switch`, { method: 'POST', headers, body: JSON.stringify({ path: 'relative/path' }) });
    expect(invalid.status).toBe(400);
    expect(server.workspaceSelected).toBe(false);

    const selected = await fetch(`${configUrl.origin}/api/workspace/switch`, { method: 'POST', headers, body: JSON.stringify({ path: project }) });
    expect(selected.status).toBe(200);
    expect(await selected.json()).toMatchObject({ ok: true, changed: true, needsProjectOverview: true, startupRemembered: true });
    expect(server.workspaceSelected).toBe(true);
    expect(server.host.current().rootInfo.root).toBe(fs.realpathSync(project));

    const nextState = await (await fetch(`${configUrl.origin}/api/state`, { headers: { authorization } })).json() as { workspace: { root: string; workspaceId: string } };
    expect(nextState.workspace.root).toBe(fs.realpathSync(project));
    const config = loadGlobalConfig(statePaths(configDir).configFile);
    expect(config.startupProjectId).toMatch(/^prj_/);
    const after = await fetch(`http://127.0.0.1:${server.port}/mcp`, { method: 'POST' });
    expect(after.status).not.toBe(503);
  });
});
