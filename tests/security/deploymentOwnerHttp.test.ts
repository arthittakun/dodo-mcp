import { afterEach, describe, expect, it } from 'vitest';
import { launch, obtainToken, wsArgs, type TestContext } from '../helpers/testServer.js';
import { ProjectRegistry } from '../../src/projects/registry.js';

describe('R05 target registration remains private owner administration', () => {
  let ctx: TestContext;
  afterEach(async () => { await ctx?.cleanup(); });
  it('denies anonymous/OAuth/public/stale requests, validates owner target scope, and never creates targets from MCP', async () => {
    ctx = await launch({ toolSurface: 'full', trust: 'trusted', configPort: 0, fixtureFiles: {
      'Dockerfile': 'FROM scratch\n', 'package.json': JSON.stringify({ name: 'owner-target-fixture', scripts: { test: 'node check.cjs' } }),
      'check.cjs': 'process.exit(0);',
    } });
    const p = new ProjectRegistry(ctx.server.services.store).add(ctx.fixtureDir, 'Owner target fixture').project;
    const token = await obtainToken(ctx), url = new URL(ctx.configUrl!);
    const recipe = ctx.server.services.overview.discoverTasks(ctx.server.services.projectConfig).find(t => t.id === 'npm:test')!;
    const definition = { name: 'private-owner-target', adapter: 'docker-compose', composeProject: 'owner-fixture', service: 'web',
      requiredChecks: [{ taskId: recipe.id, recipeDigest: recipe.recipeDigest }], health: [{ id: 'ready', kind: 'http', url: 'https://fixture.example/health' }] };
    const payload = { projectId: p.projectId, operation: 'deployment.configure', args: { ...wsArgs(ctx), confirm: true,
      input: { expectedRevision: 0, enabled: true, definition, confirmDaemonAccess: true } } };
    const send = (auth?: string, epoch = ctx.server.epoch, origin = url.origin, body: unknown = payload) => fetch(`${origin}/api/admin/action`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-dodo-workspace': ctx.server.workspaceId, 'x-dodo-epoch': epoch,
        ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: JSON.stringify(body),
    });
    expect((await send()).status).toBe(401);
    expect((await send(token.accessToken)).status).toBe(401);
    expect((await send(token.accessToken, ctx.server.epoch, ctx.baseUrl)).status).toBe(404);
    expect((await send(url.hash.slice(1), 'stale')).status).toBe(409);
    expect(ctx.server.services.store.db.prepare('SELECT * FROM recovery_deployment_targets').all()).toEqual([]);
    const allowed = await send(url.hash.slice(1)); expect(allowed.status).toBe(200);
    const result = await allowed.json() as { data: { id: string; revision: number } };
    expect(result.data.id).toMatch(/^deploytarget_/); expect(result.data.revision).toBe(1);
    const missingConsent = { ...payload, args: { ...payload.args, input: { ...payload.args.input, confirmDaemonAccess: false } } };
    expect((await send(url.hash.slice(1), ctx.server.epoch, url.origin, missingConsent)).status).toBe(400);
    const adminHealth = { ...payload, args: { ...payload.args, input: { ...payload.args.input, definition: { ...definition,
      health: [{ id: 'bad', kind: 'http', url: url.origin+'/', allowPrivateNetwork: true }] } } } };
    expect((await send(url.hash.slice(1), ctx.server.epoch, url.origin, adminHealth)).status).toBe(403);
    const { TOOL_CATALOG } = await import('../../src/tools/catalog.js');
    expect(TOOL_CATALOG.some(t => ['deployment.configure', 'deployment_target_register', 'deployment.targets'].includes(t.name))).toBe(false);
  });
});
