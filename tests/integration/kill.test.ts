import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { launch, freePort, obtainToken, mcpRaw, rpc, parseMcpResponse } from '../helpers/testServer.js';
import type { KillReport } from '../../src/cli/kill.js';

const CLI = path.resolve('dist/cli/main.js');
const exec = promisify(execFile);
const cli = (args: string[], configDir: string, cwd = os.homedir()) => exec(process.execPath, [CLI, ...args], {
  cwd, env: { ...process.env, DODO_CONFIG_DIR: configDir }, timeout: 35000, maxBuffer: 1024 * 1024,
});
async function until(check: () => boolean | Promise<boolean>, ms = 15000) {
  const end = Date.now() + ms;
  while (!await check()) {
    if (Date.now() > end) throw Error('fixture condition timed out');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
function alive(pid: number) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function closeChild(p: ChildProcess) {
  if (p.exitCode !== null || p.signalCode !== null) return;
  p.kill('SIGTERM');
  await until(() => p.exitCode !== null || p.signalCode !== null);
}

describe('dodo kill: CWD-independent shutdown with durable login', () => {
  it('stops HTTP and stdio workspaces plus owned jobs, leaving other programs/configs alive', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dodo-kill-'));
    const cfg = path.join(base, 'config'), otherCfg = path.join(base, 'other-config');
    for (const p of [cfg, otherCfg]) { fs.mkdirSync(p); fs.writeFileSync(path.join(p, 'config.json'), JSON.stringify({ configPort: 0 })); }
    const children: ChildProcess[] = [];
    let client: Client | undefined;
    let secondClient: Client | undefined;
    try {
      const roots = ['A', 'B', 'โปรเจกต์ C', 'other-config-root'].map(n => path.join(base, n));
      for (const root of roots) fs.mkdirSync(root);
      for (const [root, config] of [[roots[0]!, cfg], [roots[1]!, cfg], [roots[3]!, otherCfg]]) {
        const p = spawn(process.execPath, [CLI, 'start', '--port', String(await freePort()), '--quiet'], {
          cwd: root, env: { ...process.env, DODO_CONFIG_DIR: config }, stdio: 'ignore',
        });
        children.push(p);
        await until(async () => { try { await cli(['status'], config!, root); return true; } catch { return false; } });
      }
      const otherProgram = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      children.push(otherProgram);
      const root = roots[2]!;
      await cli(['trust', '--mode', 'trusted', '--yes'], cfg, root);
      fs.writeFileSync(path.join(root, 'worker.cjs'), "require('node:fs').writeFileSync('worker.pid', String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\n");
      const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, 'stdio', '--root', root], env: { ...process.env, DODO_CONFIG_DIR: cfg } as Record<string, string>, stderr: 'pipe' });
      client = new Client({ name: 'kill-test', version: '1.0.0' });
      await client.connect(transport);
      const ov = await client.callTool({ name: 'project_overview', arguments: {} });
      const context = ov.structuredContent as { workspaceId: string; workspaceEpoch: string };
      const job = await client.callTool({ name: 'run_command', arguments: { workspaceId: context.workspaceId, workspaceEpoch: context.workspaceEpoch, command: 'node worker.cjs', background: true } });
      expect((job.structuredContent as { ok: boolean }).ok).toBe(true);
      await until(() => fs.existsSync(path.join(root, 'worker.pid')));
      const jobPid = Number(fs.readFileSync(path.join(root, 'worker.pid'), 'utf8'));
      const status = JSON.parse((await cli(['status', '--json'], cfg, root)).stdout) as { pid: number };

      // A second stdio client of the same root replaces its legacy root alias;
      // the first process must remain discoverable by its instance endpoint.
      secondClient = new Client({ name: 'second-kill-test', version: '1.0.0' });
      await secondClient.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, 'stdio', '--root', root], env: { ...process.env, DODO_CONFIG_DIR: cfg } as Record<string, string>, stderr: 'pipe' }));
      const secondStatus = JSON.parse((await cli(['status', '--json'], cfg, root)).stdout) as { pid: number };
      expect(secondStatus.pid).not.toBe(status.pid);

      const report = JSON.parse((await cli(['kill', '--json'], cfg)).stdout) as KillReport;
      expect(report.failed).toEqual([]);
      expect(report.stopped).toHaveLength(4);
      expect(report.authPreserved).toBe(true);
      await until(() => children[0]!.exitCode === 0 && children[1]!.exitCode === 0 && !alive(status.pid) && !alive(secondStatus.pid) && !alive(jobPid));
      expect(alive(otherProgram.pid!)).toBe(true);
      expect(children[2]!.exitCode).toBeNull();
      expect((await cli(['status'], otherCfg, roots[3])).stdout).toContain('Workspace:');
      expect(JSON.parse((await cli(['kill', '--json'], cfg)).stdout).stopped).toEqual([]);
    } finally {
      await client?.close().catch(() => undefined);
      await secondClient?.close().catch(() => undefined);
      for (const child of children) await closeChild(child);
      fs.rmSync(base, { recursive: true, force: true });
    }
  }, 60000);

  it('keeps existing access/refresh credentials and revocations across kill and restart', async () => {
    const ctx = await launch({ trust: 'trusted', configPort: 0 });
    const valid = await obtainToken(ctx), revoked = await obtainToken(ctx);
    const previousEpoch = ctx.server.epoch;
    ctx.server.services.store.revokeGrant(revoked.grantId);
    ctx.server.services.store.oauthRevokeByGrantId(revoked.grantId);
    const originals = ['config.json', 'keys/jwks.json', 'keys/cookies.json'].map(p => [p, fs.readFileSync(path.join(ctx.configDir, p), 'utf8')] as const);
    try {
      const report = JSON.parse((await cli(['kill', '--json'], ctx.configDir)).stdout) as KillReport;
      expect(report.failed).toEqual([]);
      expect(report.stopped).toHaveLength(1);
      await ctx.server.close();
      const next = await launch({ configDir: ctx.configDir, fixtureDir: ctx.fixtureDir, port: ctx.port });
      ctx.server = next.server;
      // launch rewrites the local-fixture config with the same content.
      for (const [p, before] of originals) expect(fs.readFileSync(path.join(ctx.configDir, p), 'utf8')).toBe(before);
      const request = (token: string) => mcpRaw(ctx, rpc('tools/call', { name: 'project_overview', arguments: {} }), token, { connection: 'close' });
      const ok = await request(valid.accessToken);
      expect(ok.status).toBe(200);
      const result = await parseMcpResponse(ok);
      expect((result['result'] as {structuredContent:{ok:boolean}}).structuredContent.ok).toBe(true);
      expect(ctx.server.epoch).not.toBe(previousEpoch);
      expect((await request(revoked.accessToken)).status).toBe(401);
      expect(valid.refreshToken).toBeTruthy();
      const refresh = await fetch(`${ctx.baseUrl}/token`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', connection: 'close', authorization: `Basic ${Buffer.from(`${valid.clientId}:${valid.clientSecret}`).toString('base64')}` },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: valid.refreshToken!, resource: `${ctx.baseUrl}/mcp` }),
      });
      expect(refresh.status).toBe(200);
      const renewed = await refresh.json() as { access_token: string; refresh_token: string };
      expect((await request(renewed.access_token)).status).toBe(200);
      expect(renewed.refresh_token).toBeTruthy();
      expect(ctx.server.services.store.clientAccess(ctx.server.workspaceId, valid.clientId)).toContain('dodo:exec');
    } finally { await ctx.server.close(); fs.rmSync(ctx.fixtureDir, { recursive: true, force: true }); fs.rmSync(ctx.configDir, { recursive: true, force: true }); }
  }, 60000);

  it('is a no-op before first setup and rejects invalid wait durations', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dodo-kill-empty-'));
    try {
      const config = path.join(base, 'not-created');
      expect(JSON.parse((await cli(['kill', '--json'], config)).stdout).stopped).toEqual([]);
      expect(fs.existsSync(config)).toBe(false);
      await expect(cli(['kill', '--timeout', '0'], config)).rejects.toMatchObject({ code: 1 });
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  });
});
