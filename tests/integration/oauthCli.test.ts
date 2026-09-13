import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { addStaticClient } from '../../src/auth/clients.js';
import { CookieJar, launch, pkcePair, type TestContext } from '../helpers/testServer.js';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../../dist/cli/main.js', import.meta.url));

describe('OAuth approval command copying', () => {
  let ctx: TestContext;
  beforeAll(async () => { ctx = await launch(); });
  afterAll(async () => { await ctx?.cleanup(); });

  function owner(args: string[]) {
    return exec(process.execPath, [cli, ...args], {
      cwd: ctx.fixtureDir,
      env: { ...process.env, DODO_CONFIG_DIR: ctx.configDir },
      timeout: 10_000,
    });
  }

  it.each(['-' + 'A'.repeat(42), '--' + 'B'.repeat(41), 'C'.repeat(43)])(
    'the printed command approves the exact seeded request %s over IPC', async (id) => {
      const store = ctx.server.services.store;
      const seed = (requestId: string) => store.createApproval({
        id: requestId, kind: 'oauth', workspaceId: ctx.server.workspaceId,
        epoch: ctx.server.epoch, ttlMs: 60_000,
        summary: JSON.stringify({ clientId: 'fixture-client', redirectUri: ctx.redirectUri, scopes: ['dodo:read'] }),
      });
      seed(id);
      const pending = await owner(['auth', 'pending']);
      const line = pending.stdout.split('\n').find(value => value.startsWith('approve:') && value.endsWith(id));
      expect(line).toBeDefined();
      const command = line!.replace(/^approve:\s+dodo /, '').split(' ');
      const approved = await owner(command);
      expect(approved.stdout).toContain(`approved: ${id}`);
      expect(store.getApproval(id)?.status).toBe('approved');

      // Copyable syntax does not weaken single-use approval or the deny path.
      expect(store.setApprovalStatus(id, 'consumed')).toBe(true);
      await expect(owner(command)).rejects.toMatchObject({ code: 2, stderr: expect.stringContaining('consumed') });
      const deniedId = id + '_deny';
      seed(deniedId);
      await owner(['auth', 'deny', '--', deniedId]);
      expect(store.getApproval(deniedId)?.status).toBe('denied');
    },
  );

  it('the real OAuth browser page prints the same copyable approval command', async () => {
    const client = addStaticClient(ctx.server.services.store, { redirectUris: [ctx.redirectUri], public: true });
    const { challenge } = pkcePair();
    const jar = new CookieJar();
    const auth = new URL('/auth', ctx.baseUrl);
    auth.search = new URLSearchParams({
      client_id: client.clientId, redirect_uri: ctx.redirectUri, response_type: 'code',
      scope: 'dodo:read', state: 'approval-command-fixture',
      code_challenge: challenge, code_challenge_method: 'S256', resource: `${ctx.baseUrl}/mcp`,
    }).toString();
    const start = await fetch(auth, { redirect: 'manual' });
    expect([302, 303]).toContain(start.status);
    jar.absorb(start);
    const location = new URL(start.headers.get('location')!, ctx.baseUrl);
    const uid = location.pathname.split('/interaction/')[1]!;
    const page = await fetch(location, { headers: { cookie: jar.header() }, redirect: 'manual' });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain(`dodo auth approve -- ${uid}</pre>`);
    expect(ctx.server.services.store.getApproval(uid)?.status).toBe('pending');
    await owner(['auth', 'deny', '--', uid]);
  });
});
