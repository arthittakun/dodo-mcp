import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { callToolLegacy, launch, mkTmpDir, obtainToken } from '../helpers/testServer.js';
import { ProjectRegistry } from '../../src/projects/registry.js';
import { GlobalConfigSchema } from '../../src/config/globalConfig.js';
import type { Principal } from '../../src/tools/context.js';

describe('single-owner personal mode', () => {
  it('is the product default while managed mode remains explicit', () => {
    const defaults = GlobalConfigSchema.parse({});
    expect(defaults.accessMode).toBe('personal');
    expect(defaults.exposeSubagentsToMcp).toBe(false);
    expect(GlobalConfigSchema.parse({ accessMode: 'managed' }).accessMode).toBe('managed');
    expect(GlobalConfigSchema.parse({ exposeSubagentsToMcp: true }).exposeSubagentsToMcp).toBe(true);
  });

  it('uses an owner-approved OAuth token across registered projects without duplicate ACL or trust prompts', async () => {
    const targetRoot = mkTmpDir('dodo-personal-target-');
    const ctx = await launch({ configPatch: { accessMode: 'personal' } });
    try {
      const target = new ProjectRegistry(ctx.server.services.store).add(targetRoot, 'Personal target').project;
      const token = await obtainToken(ctx, { grantWorkspaceAccess: false });
      expect(ctx.server.services.store.clientAccess(ctx.server.workspaceId, token.clientId)).toEqual([]);
      expect(ctx.server.services.store.clientAccess(target.workspaceId, token.clientId)).toEqual([]);
      expect(ctx.server.services.trustMode()).toBe('trusted');

      const activeOverview = await callToolLegacy(ctx, token.accessToken, 'project_overview', {});
      expect(activeOverview.envelope.ok).toBe(true);
      expect((activeOverview.envelope.data as { federation: { projects: Array<{ projectId: string }> } }).federation.projects)
        .toContainEqual(expect.objectContaining({ projectId: target.projectId }));
      const federated = await callToolLegacy(ctx, token.accessToken, 'project_overview', { projectId: target.projectId });
      expect(federated.envelope.ok).toBe(true);

      const ai = ctx.server.services.installation!.ai;
      const connection = await ai.settings.saveConnection({
        name: 'personal fixture', provider: 'custom', protocol: 'responses',
        baseUrl: 'http://127.0.0.1:9/v1', allowPrivateNetwork: true,
      }, 'personal-fixture-key');
      const profile = ai.settings.saveProfile({
        name: 'Personal coding', connectionId: connection.id, model: 'fixture-model',
        scopes: ['dodo:read', 'dodo:write', 'dodo:exec'], toolCalling: true,
      });
      const principal: Principal = {
        grantId: token.grantId, clientId: token.clientId, sub: 'owner',
        scopes: ['dodo:read', 'dodo:write', 'dodo:exec'],
      };
      expect(ai.availableProfiles(target.workspaceId, principal))
        .toContainEqual(expect.objectContaining({ id: profile.id }));

      const overview = await callToolLegacy(ctx, token.accessToken, 'project_overview', { targetProjectId: target.projectId });
      expect(overview.envelope.ok).toBe(true);
      const workspaceId = overview.envelope.workspaceId as string;
      const workspaceEpoch = overview.envelope.workspaceEpoch as string;
      const write = await callToolLegacy(ctx, token.accessToken, 'dodo_write', {
        targetProjectId: target.projectId,
        workspaceId,
        workspaceEpoch,
        operation: 'write_file',
        args: { path: 'ready.txt', content: 'ready\n' },
      });
      expect(write.envelope.ok).toBe(true);
      expect(fs.readFileSync(path.join(targetRoot, 'ready.txt'), 'utf8')).toBe('ready\n');

      const reader = await obtainToken(ctx, { scope: 'dodo:read', grantWorkspaceAccess: false });
      const denied = await callToolLegacy(ctx, reader.accessToken, 'dodo_write', {
        targetProjectId: target.projectId,
        workspaceId,
        workspaceEpoch,
        operation: 'write_file',
        args: { path: 'denied.txt', content: 'no\n' },
      });
      expect(denied.envelope.error).toMatchObject({ code: 'FORBIDDEN' });
      expect(fs.existsSync(path.join(targetRoot, 'denied.txt'))).toBe(false);
    } finally {
      await ctx.cleanup();
      fs.rmSync(targetRoot, { recursive: true, force: true });
    }
  });

  it('switches modes immediately only through authenticated Local Config', async () => {
    const ctx = await launch({ configPort: 0, configPatch: { accessMode: 'managed' } });
    try {
      const privateUrl = new URL(ctx.configUrl!);
      const authorization = `Bearer ${privateUrl.hash.slice(1)}`;
      const headers = {
        authorization,
        'content-type': 'application/json',
        'x-dodo-workspace': ctx.server.workspaceId,
        'x-dodo-epoch': ctx.server.epoch,
      };
      const endpoint = `${privateUrl.origin}/api/ai/access-mode`;
      expect((await fetch(endpoint, { method: 'POST', headers: { ...headers, authorization: '' }, body: JSON.stringify({ mode: 'personal' }) })).status).toBe(401);
      const changed = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ mode: 'personal' }) });
      expect(changed.status).toBe(200);
      expect(await changed.json()).toMatchObject({ ok: true, data: { mode: 'personal', effectiveImmediately: true } });
      expect(ctx.server.services.trustMode()).toBe('trusted');
      expect(JSON.parse(fs.readFileSync(path.join(ctx.configDir, 'config.json'), 'utf8')).accessMode).toBe('personal');
    } finally {
      await ctx.cleanup();
    }
  });

  it('changes sub-agent MCP exposure only through authenticated Local Config and requires restart', async () => {
    const ctx = await launch({ configPort: 0, configPatch: { exposeSubagentsToMcp: false } });
    try {
      const privateUrl = new URL(ctx.configUrl!);
      const authorization = `Bearer ${privateUrl.hash.slice(1)}`;
      const headers = {
        authorization,
        'content-type': 'application/json',
        'x-dodo-workspace': ctx.server.workspaceId,
        'x-dodo-epoch': ctx.server.epoch,
      };
      const endpoint = `${privateUrl.origin}/api/admin/config`;
      const denied = await fetch(endpoint, {
        method: 'POST', headers: { ...headers, authorization: '' },
        body: JSON.stringify({ exposeSubagentsToMcp: true }),
      });
      expect(denied.status).toBe(401);

      const stale = await fetch(endpoint, {
        method: 'POST', headers: { ...headers, 'x-dodo-epoch': 'boot_stale' },
        body: JSON.stringify({ exposeSubagentsToMcp: true }),
      });
      expect(stale.status).toBe(409);

      const changed = await fetch(endpoint, {
        method: 'POST', headers,
        body: JSON.stringify({ exposeSubagentsToMcp: true }),
      });
      expect(changed.status).toBe(200);
      expect(await changed.json()).toMatchObject({ ok: true, data: { saved: true, restartRequired: true } });
      expect(JSON.parse(fs.readFileSync(path.join(ctx.configDir, 'config.json'), 'utf8')).exposeSubagentsToMcp).toBe(true);
    } finally {
      await ctx.cleanup();
    }
  });
});
