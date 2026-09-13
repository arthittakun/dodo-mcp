import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bootstrapWorkspace } from '../../src/server/bootstrap.js';
import { startLocalConfig } from '../../src/server/localConfig.js';
import { addStaticClient } from '../../src/auth/clients.js';
import { TOOL_CATALOG } from '../../src/tools/catalog.js';
import { mkTmpDir, rawHttp, type TestContext } from '../helpers/testServer.js';

const cleanup: string[] = [];

async function setup() {
  const configDir = mkTmpDir('dodo-project-admin-cfg-');
  const activeRoot = mkTmpDir('dodo-project-admin-active-');
  cleanup.push(configDir, activeRoot);
  const previous = process.env['DODO_CONFIG_DIR'];
  process.env['DODO_CONFIG_DIR'] = configDir;
  const ws = bootstrapWorkspace({ invokedCwd: activeRoot, log: () => {} });
  if (previous === undefined) delete process.env['DODO_CONFIG_DIR']; else process.env['DODO_CONFIG_DIR'] = previous;
  const admin = await startLocalConfig(ws, 0);
  const url = new URL(admin.url);
  return {
    ws, admin, url, token: url.hash.slice(1),
    headers: { authorization: `Bearer ${url.hash.slice(1)}`, 'x-dodo-workspace': ws.workspaceId, 'x-dodo-epoch': ws.epoch },
    close: async () => { await admin.close(); await ws.shutdownServices(); },
  };
}

afterEach(() => {
  for (const directory of cleanup.splice(0)) fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
});

describe('project registry owner boundary', () => {
  it('requires the private Local Config capability and rejects remote/foreign request shapes', async () => {
    const s = await setup();
    try {
      const port = Number(s.url.port);
      const request = (headers: Record<string, string> = {}) => rawHttp({ port } as TestContext, { method: 'GET', path: '/api/projects', headers });
      expect((await request()).status).toBe(401);
      expect((await request({ ...s.headers, origin: 'https://evil.example' })).status).toBe(403);
      expect((await request({ ...s.headers, 'x-forwarded-for': '127.0.0.1' })).status).toBe(403);
      expect((await request({ ...s.headers, 'x-dodo-epoch': 'stale' })).status).toBe(409);
      expect((await request(s.headers)).status).toBe(200);
      expect(TOOL_CATALOG.some((tool) => /project_(add|list|info|remove)|registry/i.test(tool.name))).toBe(false);
    } finally { await s.close(); }
  });

  it('adds, lists and removes a project without copying or deleting workspace authority', async () => {
    const s = await setup();
    const other = mkTmpDir('dodo-project-admin-other-'); cleanup.push(other);
    fs.writeFileSync(path.join(other, 'safe.txt'), 'safe');
    try {
      const client = addStaticClient(s.ws.store, { name: 'Registry client', redirectUris: ['https://example.test/callback'] });
      s.ws.store.setClientAccess(s.ws.workspaceId, client.clientId, ['dodo:read', 'dodo:write']);
      s.ws.store.setTrustMode(s.ws.workspaceId, 'trusted');
      const post = (route: string, body: unknown, headers: Record<string, string> = s.headers) => fetch(`${s.url.origin}/api/${route}`, {
        method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body),
      });

      expect((await post('projects/add', { path: other }, {})).status).toBe(401);
      expect((await post('projects/add', { path: 'relative' })).status).toBe(400);
      const addedResponse = await post('projects/add', { path: other, displayName: '<img src=x onerror=alert(1)>' });
      expect(addedResponse.status).toBe(200);
      const added = await addedResponse.json() as { project: { projectId: string; workspaceId: string; root: string } };
      expect(added.project.root).toBe(fs.realpathSync.native(other));
      expect(added.project.workspaceId).not.toBe(s.ws.workspaceId);
      expect(s.ws.store.clientAccess(added.project.workspaceId, client.clientId)).toEqual([]);
      expect(s.ws.store.trustMode(added.project.workspaceId)).toBe('inspect');
      expect(s.ws.store.clientAccess(s.ws.workspaceId, client.clientId)).toEqual(['dodo:read', 'dodo:write']);
      expect(s.ws.store.trustMode(s.ws.workspaceId)).toBe('trusted');

      const listed = await (await fetch(`${s.url.origin}/api/projects`, { headers: s.headers })).json() as { projects: Array<Record<string, unknown>> };
      const serialized = JSON.stringify(listed);
      expect(listed.projects).toHaveLength(1);
      expect(serialized).toContain('<img src=x onerror=alert(1)>'); // raw JSON is rendered with textContent by the UI
      expect(serialized).not.toContain(client.clientSecret ?? 'never');
      expect(serialized).not.toContain('dodo:write');

      expect((await post('projects/remove', { projectId: added.project.projectId, confirmProjectId: 'prj_wrong' })).status).toBe(400);
      const removed = await post('projects/remove', { projectId: added.project.projectId, confirmProjectId: added.project.projectId });
      expect(removed.status).toBe(200);
      expect(fs.readFileSync(path.join(other, 'safe.txt'), 'utf8')).toBe('safe');
      expect(s.ws.store.clientAccess(s.ws.workspaceId, client.clientId)).toEqual(['dodo:read', 'dodo:write']);
      expect((await (await fetch(`${s.url.origin}/api/projects`, { headers: s.headers })).json() as { projects: unknown[] }).projects).toEqual([]);
    } finally { await s.close(); }
  });

  it('serves project UI through same-origin packaged assets without inline injection sinks', async () => {
    const s = await setup();
    try {
      const page = await (await fetch(`${s.url.origin}/`)).text();
      const script = await (await fetch(`${s.url.origin}/assets/app.js`)).text();
      expect(page).toContain('Project Registry');
      expect(page).toContain('project-add-form');
      expect(script).toContain("api('projects'");
      expect(script).not.toContain('innerHTML');
      expect(page).not.toMatch(/ on[a-z]+=/);
      expect(page).not.toContain(s.token);
    } finally { await s.close(); }
  });
});
