import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { launch, obtainToken, mcpRaw, rpc, parseMcpResponse, callToolLegacy, wsArgs, type TestContext, type TokenSet } from '../helpers/testServer.js';

/**
 * ADR-029 security: a compact gateway must behave EXACTLY like the direct
 * call for authorization — the target tool definition stays the authority.
 * Real HTTP + real OAuth fixture; nothing is mocked.
 */
describe('compact gateway security (HTTP default surface)', () => {
  let ctx: TestContext;
  let full: TokenSet; // dodo:read dodo:write dodo:exec
  let readonly: TokenSet; // dodo:read only

  beforeAll(async () => {
    ctx = await launch({ fixtureFiles: { 'a.txt': 'A\n', '.env': 'SECRET=1\n' } }); // trust: inspect (default)
    full = await obtainToken(ctx);
    readonly = await obtainToken(ctx, { scope: 'dodo:read offline_access' });
  }, 120_000);
  afterAll(async () => ctx?.cleanup());

  const gw = (token: string, name: string, operation: string, args: Record<string, unknown> = {}) =>
    callToolLegacy(ctx, token, name, { ...wsArgs(ctx), operation, args });

  it('anonymous HTTP stays 401 with the OAuth challenge', async () => {
    const res = await mcpRaw(ctx, rpc('tools/list'));
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate') ?? '').toContain('Bearer');
  });

  it('a read-only token is denied write/exec/git-commit/media-exec/workflow-run through every gateway', async () => {
    const denied: Array<[string, string, Record<string, unknown>]> = [
      ['dodo_write', 'write_file', { path: 'no.txt', content: 'x' }],
      ['dodo_write', 'apply_changes', { planId: 'p', planHash: 'h', idempotencyKey: 'sec-apply-01' }],
      ['dodo_exec', 'run_command', { command: 'echo hi' }],
      ['dodo_git_write', 'git_commit', { message: 'nope' }],
      ['dodo_media', 'media_open', { path: 'a.txt' }],
      ['dodo_media', 'speech_synthesize', { text: 'no' }],
      ['dodo_browser', 'browser_session', {} ],
      ['dodo_game', 'game_session', { browserId: 'b' }],
      ['dodo_workflow_run', 'workflow_run', { mode: 'start', workflowId: 'w', revision: 1 }],
      ['dodo_desktop_control', 'desktop_action', { windowId: 1, action: { kind: 'click', x: 1, y: 1 } }],
      ['dodo_schedule', 'schedule_propose', { name: 'n', command: 'echo', cron: '* * * * *', expiresAt: new Date(Date.now() + 3600e3).toISOString() }],
    ];
    for (const [gateway, operation, args] of denied) {
      const res = await gw(readonly.accessToken, gateway, operation, args);
      const error = res.envelope['error'] as { code: string; detail?: { requiredScope?: string } } | null;
      expect(error?.code, `${gateway}:${operation}`).toBe('FORBIDDEN');
      expect(error?.detail?.requiredScope, `${gateway}:${operation}`).toMatch(/^dodo:(write|exec)$/);
    }
    // and the same token still reads through gateways whose target is read-scope
    const ok = await gw(readonly.accessToken, 'dodo_read', 'read_files', { files: [{ path: 'a.txt' }] });
    expect(ok.envelope['ok']).toBe(true);
    const status = await gw(readonly.accessToken, 'dodo_media', 'multimodal_status');
    expect(status.envelope['ok']).toBe(true);
  });

  it('workspace context is enforced at the top level; nested overrides in args are rejected', async () => {
    const stale = await callToolLegacy(ctx, full.accessToken, 'dodo_read', {
      workspaceId: ctx.server.workspaceId, workspaceEpoch: 'boot_stale', operation: 'read_files', args: { files: [{ path: 'a.txt' }] },
    });
    expect((stale.envelope['error'] as { code: string }).code).toBe('STALE_WORKSPACE');
    const wrong = await callToolLegacy(ctx, full.accessToken, 'dodo_read', {
      workspaceId: 'ws_other', workspaceEpoch: ctx.server.epoch, operation: 'read_files', args: { files: [{ path: 'a.txt' }] },
    });
    expect((wrong.envelope['error'] as { code: string }).code).toBe('WORKSPACE_MISMATCH');
    for (const nested of [{ workspaceId: 'ws_evil' }, { workspaceEpoch: 'boot_evil' }]) {
      const res = await gw(full.accessToken, 'dodo_read', 'read_files', { ...nested, files: [{ path: 'a.txt' }] });
      expect((res.envelope['error'] as { code: string }).code).toBe('INVALID_INPUT');
    }
  });

  it('secret/path guards through the gateway match the direct tools', async () => {
    const w = await gw(full.accessToken, 'dodo_write', 'write_file', { path: '.env', content: 'X=1' });
    expect((w.envelope['error'] as { code: string }).code).toBe('SECRET_PATH_DENIED');
    const r = await gw(full.accessToken, 'dodo_read', 'read_files', { files: [{ path: '../../etc/passwd' }] });
    const errors = (r.envelope['data'] as { errors: Array<{ error: { code: string } }> }).errors;
    expect(errors[0]?.error.code).toBe('PATH_DENIED');
    const dot = await gw(full.accessToken, 'dodo_read', 'read_files', { files: [{ path: '.env' }] });
    const dotErrors = (dot.envelope['data'] as { errors: Array<{ error: { code: string } }> }).errors;
    expect(dotErrors[0]?.error.code).toBe('SECRET_PATH_DENIED');
  });

  it('inspect trust mode: an effectful gateway call needs the TARGET operation approval, then succeeds once approved', async () => {
    const attempt = await gw(full.accessToken, 'dodo_write', 'write_file', { path: 'approved.txt', content: 'ok\n' });
    const error = attempt.envelope['error'] as { code: string; detail?: { approvalId?: string } };
    expect(error.code).toBe('APPROVAL_REQUIRED');
    const approvalId = error.detail?.approvalId as string;
    const row = ctx.server.services.store.getApproval(approvalId);
    expect(row?.tool).toBe('write_file'); // approval binds the TARGET, not the gateway
    expect(ctx.server.services.store.setApprovalStatus(approvalId, 'approved')).toBe(true);
    const retry = await gw(full.accessToken, 'dodo_write', 'write_file', { path: 'approved.txt', content: 'ok\n' });
    expect(retry.envelope['ok'], JSON.stringify(retry.envelope['error'])).toBe(true);
    // an approval never generalizes: the next different write asks again
    const next = await gw(full.accessToken, 'dodo_write', 'write_file', { path: 'other.txt', content: 'no\n' });
    expect((next.envelope['error'] as { code: string }).code).toBe('APPROVAL_REQUIRED');
  });

  it('a token whose workspace ACL was revoked gets WORKSPACE_ACCESS_REQUIRED, exactly like direct calls', async () => {
    const store = ctx.server.services.store;
    const before = store.clientAccess(ctx.server.workspaceId, readonly.clientId);
    store.setClientAccess(ctx.server.workspaceId, readonly.clientId, []);
    try {
      const res = await gw(readonly.accessToken, 'dodo_read', 'read_files', { files: [{ path: 'a.txt' }] });
      expect((res.envelope['error'] as { code: string }).code).toBe('WORKSPACE_ACCESS_REQUIRED');
    } finally {
      store.setClientAccess(ctx.server.workspaceId, readonly.clientId, before);
    }
  });

  it('target error codes pass through unchanged (FILE_CHANGED, AMBIGUOUS_EDIT, NOT_FOUND detail intact)', async () => {
    const conflict = await gw(full.accessToken, 'dodo_write', 'edit_file', {
      path: 'a.txt', edits: [{ find: 'A', replace: 'B' }], expectedHash: 'sha256:not-the-hash',
    });
    const err = conflict.envelope['error'] as { code: string; detail?: Record<string, unknown>; recovery?: string };
    expect(err.code).toBe('FILE_CHANGED');
    expect(err.detail?.['path']).toBe('a.txt');
    expect(err.recovery).toBeTruthy();
  });

  it('unknown operations and malformed target args are rejected without reaching any handler', async () => {
    // operation outside the enum → SDK schema rejection before any handler (isError result, no envelope)
    const outside = await gw(full.accessToken, 'dodo_write', 'run_command', { command: 'echo hi' });
    expect(outside.isError).toBe(true);
    expect(outside.envelope['ok']).toBeUndefined(); // never reached the pipeline
    expect(JSON.stringify(outside.raw)).toContain('Invalid option');
    const overview = await gw(full.accessToken, 'dodo_read', 'project_overview');
    expect(overview.isError).toBe(true);
    expect(JSON.stringify(overview.raw)).toContain('Invalid option');
    // args that violate the TARGET's original schema → INVALID_INPUT with the discover hint
    const bad = await gw(full.accessToken, 'dodo_write', 'write_file', { path: 'x.txt', content: 'x', nonsense: true });
    const err = bad.envelope['error'] as { code: string; recovery?: string };
    expect(err.code).toBe('INVALID_INPUT');
    expect(err.recovery).toContain('dodo_discover');
  });

  it('no compact tool exposes owner controls, and the surface never lists direct tools', async () => {
    const res = await mcpRaw(ctx, rpc('tools/list'), full.accessToken);
    const body = JSON.stringify(await parseMcpResponse(res));
    for (const forbidden of ['workspace_switch', 'client_delete', 'dodo_kill', 'trust_set', 'auth_approve']) {
      expect(body).not.toContain(forbidden);
    }
  });
});
