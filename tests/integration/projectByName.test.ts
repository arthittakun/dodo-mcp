import fs from 'node:fs';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { describe, it, expect } from 'vitest';
import { launch, obtainToken, mkTmpDir } from '../helpers/testServer.js';
import { ProjectAdmin } from '../../src/projects/ownerAdmin.js';
import type { Envelope } from '../../src/tools/envelope.js';

/**
 * Addressing a project by NAME over real HTTP + OAuth.
 *
 * The owner says "use DODO to fix the auto-upload project"; the client must be
 * able to route on that name without the owner ever seeing a `prj_…` id, while
 * every existing gate still runs.
 */
describe('project targeting by name', () => {
  it('routes by name, enforces the project access level, and refuses ambiguous or conflicting targets', async () => {
    const autoUpload = mkTmpDir('dodo-name-auto-upload-');
    const other = mkTmpDir('dodo-name-other-');
    // Personal mode must come from config: acquiring a target project runs
    // bootstrapWorkspace, which re-applies config.accessMode to the store.
    const ctx = await launch({ trust: 'trusted', configPatch: { accessMode: 'personal' } });
    const clients: Client[] = [];
    try {
      const services = ctx.server.services;
      const admin = new ProjectAdmin(services.store);
      const project = admin.add({ path: autoUpload, name: 'auto-upload', access: 'edit' }).project;

      const token = await obtainToken(ctx);
      const client = new Client({ name: 'name-routing-fixture', version: '1.0.0' });
      clients.push(client);
      await client.connect(new StreamableHTTPClientTransport(new URL(`${ctx.baseUrl}/mcp`), { authProvider: { token: async () => token.accessToken } }));
      const call = async (name: string, args: Record<string, unknown>) =>
        (await client.callTool({ name, arguments: args })).structuredContent as unknown as Envelope;

      // 1. project_overview resolves the NAME and returns that project's real context.
      const overview = await call('project_overview', { targetProject: 'auto-upload' });
      expect(overview.ok).toBe(true);
      expect(overview.workspaceId).toBe(project.workspaceId);
      expect(overview.workspaceEpoch).toBeTruthy();
      const context = { workspaceId: overview.workspaceId, workspaceEpoch: overview.workspaceEpoch, targetProject: 'auto-upload' };

      // 2. A write lands in that project, using only the name.
      const written = await call('dodo_write', { ...context, operation: 'write_file', args: { path: 'named.txt', content: 'routed by name' } });
      expect(written.ok).toBe(true);
      expect(fs.readFileSync(path.join(autoUpload, 'named.txt'), 'utf8')).toBe('routed by name');
      expect(fs.existsSync(path.join(ctx.fixtureDir, 'named.txt'))).toBe(false);

      // 3. Case and surrounding whitespace do not matter to the owner.
      expect((await call('project_overview', { targetProject: '  AUTO-UPLOAD  ' })).workspaceId).toBe(project.workspaceId);

      // 4. The project access level is enforced on the name-routed path:
      //    'edit' must not be able to run commands.
      const execDenied = await call('dodo_exec', { ...context, operation: 'exec_command', args: { program: 'node', args: ['-e', 'console.log(1)'], idempotencyKey: 'named-exec-1' } });
      expect(execDenied.ok).toBe(false);
      expect(execDenied.error).toMatchObject({ code: 'FORBIDDEN' });

      // 5. Raising the level makes exec work — without touching OAuth or trust.
      admin.setAccess(project.projectId, 'full');
      const execOk = await call('dodo_exec', { ...context, operation: 'exec_command', args: { program: 'node', args: ['-e', 'console.log("named ok")'], idempotencyKey: 'named-exec-2' } });
      expect(execOk.ok).toBe(true);

      // 6. An unknown name fails closed and never invents a target.
      const unknown = await call('project_overview', { targetProject: 'does-not-exist' });
      expect(unknown.ok).toBe(false);
      expect(unknown.error).toMatchObject({ code: 'NOT_FOUND' });

      // 7. An id and a name that disagree are rejected rather than silently
      //    preferring one of them.
      const conflicting = await call('project_overview', { targetProject: 'auto-upload', targetProjectId: 'prj_zzzzzzzzzzzz' });
      expect(conflicting.ok).toBe(false);
      expect(conflicting.error).toMatchObject({ code: 'INVALID_INPUT' });

      // 8. A duplicate name (only possible for rows written before uniqueness
      //    was enforced) is ambiguous, and the error lists only projects this
      //    caller may already see.
      admin.add({ path: other, name: 'other-project', access: 'read' });
      services.store.db.prepare("UPDATE project_registry SET display_name='auto-upload' WHERE canonical_root=?").run(fs.realpathSync.native(other));
      const ambiguous = await call('project_overview', { targetProject: 'auto-upload' });
      expect(ambiguous.ok).toBe(false);
      expect(ambiguous.error).toMatchObject({ code: 'CONFLICT' });
      expect(JSON.stringify(ambiguous.error)).toContain('matches 2 registered projects');

      // 9. Routing fields are top-level only. Using the DEFAULT workspace's own
      //    context (so the gateway's workspace check passes), a nested
      //    targetProject must be refused rather than re-routing the write.
      const home = await call('project_overview', {});
      const nested = await call('dodo_write', {
        workspaceId: home.workspaceId, workspaceEpoch: home.workspaceEpoch,
        operation: 'write_file', args: { path: 'nested.txt', content: 'x', targetProject: 'auto-upload' },
      });
      expect(nested.ok).toBe(false);
      expect(nested.error).toMatchObject({ code: 'INVALID_INPUT' });
      expect(fs.existsSync(path.join(autoUpload, 'nested.txt'))).toBe(false);
    } finally {
      for (const c of clients) await c.close();
      await ctx.cleanup();
      fs.rmSync(autoUpload, { recursive: true, force: true });
      fs.rmSync(other, { recursive: true, force: true });
    }
  }, 60000);
});
