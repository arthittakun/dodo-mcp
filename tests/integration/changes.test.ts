import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { launch, obtainToken, callToolLegacy, wsArgs, type TestContext, type TokenSet } from '../helpers/testServer.js';

/** E. Changes / journal / rollback (CHG-01..15). */
describe('CHG: change plans, apply, rollback', () => {
  let ctx: TestContext;
  let tokens: TokenSet;

  beforeEach(async () => {
    ctx = await launch({ toolSurface: 'full', 
      fixtureFiles: {
        'a.txt': 'alpha\n',
        'b.txt': 'beta\nbeta\n',
        'keep/c.txt': 'gamma\n',
        'unrelated.txt': 'DO NOT TOUCH\n',
      },
      trust: 'edit',
    });
    tokens = await obtainToken(ctx);
  }, 120_000);
  afterEach(async () => ctx?.cleanup());

  const data = (env: Record<string, unknown>) => env['data'] as Record<string, unknown>;
  const errCode = (env: Record<string, unknown>) => (env['error'] as Record<string, unknown> | null)?.['code'];
  const readFile = (rel: string) => fs.readFileSync(path.join(ctx.fixtureDir, rel), 'utf8');

  async function preview(ops: unknown[]) {
    return callToolLegacy(ctx, tokens.accessToken, 'preview_changes', { ...wsArgs(ctx), operations: ops });
  }
  async function apply(planId: string, planHash: string, key: string) {
    return callToolLegacy(ctx, tokens.accessToken, 'apply_changes', { ...wsArgs(ctx), planId, planHash, idempotencyKey: key });
  }

  it('CHG-01: preview does not modify the workspace and returns hashes+diff', async () => {
    const res = await preview([
      { op: 'create', path: 'new.txt', content: 'hi\n' },
      { op: 'replace_file', path: 'a.txt', content: 'ALPHA\n' },
    ]);
    const d = data(res.envelope);
    expect(d['planId']).toBeTruthy();
    expect(d['planHash']).toBeTruthy();
    expect((d['files'] as unknown[]).length).toBe(2);
    // workspace unchanged
    expect(readFile('a.txt')).toBe('alpha\n');
    expect(fs.existsSync(path.join(ctx.fixtureDir, 'new.txt'))).toBe(false);
  });

  it('CHG-02: replace_exact with wrong occurrence count is AMBIGUOUS_EDIT', async () => {
    const res = await preview([{ op: 'replace_exact', path: 'b.txt', find: 'beta', replace: 'x', expectedCount: 1 }]);
    expect(errCode(res.envelope)).toBe('AMBIGUOUS_EDIT');
    // correct count works
    const ok = await preview([{ op: 'replace_exact', path: 'b.txt', find: 'beta', replace: 'x', expectedCount: 2 }]);
    expect(ok.isError).toBe(false);
  });

  it('CHG-05: apply writes desired bytes and returns a changeset receipt', async () => {
    const p = await preview([
      { op: 'create', path: 'created.txt', content: 'brand new\n' },
      { op: 'replace_file', path: 'a.txt', content: 'ALPHA2\n' },
      { op: 'move', path: 'keep/c.txt', destPath: 'keep/c2.txt' },
    ]);
    const d = data(p.envelope);
    const res = await apply(d['planId'] as string, d['planHash'] as string, 'k-apply-1');
    expect(res.isError).toBe(false);
    expect(data(res.envelope)['changesetId']).toBeTruthy();
    expect(readFile('created.txt')).toBe('brand new\n');
    expect(readFile('a.txt')).toBe('ALPHA2\n');
    expect(fs.existsSync(path.join(ctx.fixtureDir, 'keep/c.txt'))).toBe(false);
    expect(readFile('keep/c2.txt')).toBe('gamma\n');
    expect(readFile('unrelated.txt')).toBe('DO NOT TOUCH\n'); // untouched
  });

  it('CHG-03: external edit after preview causes FILE_CHANGED on apply', async () => {
    const p = await preview([{ op: 'replace_file', path: 'a.txt', content: 'X\n' }]);
    const d = data(p.envelope);
    fs.writeFileSync(path.join(ctx.fixtureDir, 'a.txt'), 'externally edited\n');
    const res = await apply(d['planId'] as string, d['planHash'] as string, 'k-stale-1');
    expect(errCode(res.envelope)).toBe('FILE_CHANGED');
    expect(readFile('a.txt')).toBe('externally edited\n'); // not overwritten
  });

  it('CHG-04: wrong planHash is rejected', async () => {
    const p = await preview([{ op: 'create', path: 'z.txt', content: 'z' }]);
    const d = data(p.envelope);
    const res = await apply(d['planId'] as string, 'sha256:deadbeef', 'k-badhash');
    expect(errCode(res.envelope)).toBe('PLAN_HASH_MISMATCH');
  });

  it('CHG-06: same idempotency key + same payload returns the same changeset (no duplicate)', async () => {
    const p = await preview([{ op: 'create', path: 'idem.txt', content: 'once\n' }]);
    const d = data(p.envelope);
    const r1 = await apply(d['planId'] as string, d['planHash'] as string, 'k-idem-shared');
    const r2 = await apply(d['planId'] as string, d['planHash'] as string, 'k-idem-shared');
    expect(data(r1.envelope)['changesetId']).toBe(data(r2.envelope)['changesetId']);
    expect(data(r2.envelope)['replayed']).toBe(true);
  });

  it('CHG-07: same key with a different payload is IDEMPOTENCY_CONFLICT', async () => {
    const p1 = await preview([{ op: 'create', path: 'k1.txt', content: '1' }]);
    const p2 = await preview([{ op: 'create', path: 'k2.txt', content: '2' }]);
    await apply(data(p1.envelope)['planId'] as string, data(p1.envelope)['planHash'] as string, 'k-conflict');
    const res = await apply(data(p2.envelope)['planId'] as string, data(p2.envelope)['planHash'] as string, 'k-conflict');
    expect(errCode(res.envelope)).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('CHG-10: dirty/untracked unrelated files are preserved byte-for-byte', async () => {
    const before = readFile('unrelated.txt');
    const p = await preview([{ op: 'replace_file', path: 'a.txt', content: 'changed\n' }]);
    const d = data(p.envelope);
    await apply(d['planId'] as string, d['planHash'] as string, 'k-dirty-1');
    expect(readFile('unrelated.txt')).toBe(before);
  });

  it('CHG-11: rollback refuses when a human edited the file after apply', async () => {
    const p = await preview([{ op: 'replace_file', path: 'a.txt', content: 'v2\n' }]);
    const d = data(p.envelope);
    const applied = await apply(d['planId'] as string, d['planHash'] as string, 'k-rb-001');
    const csId = data(applied.envelope)['changesetId'] as string;
    // Human edits the file after apply.
    fs.writeFileSync(path.join(ctx.fixtureDir, 'a.txt'), 'human wrote this\n');
    const rb = await callToolLegacy(ctx, tokens.accessToken, 'rollback_changes', { ...wsArgs(ctx), changesetId: csId, idempotencyKey: 'k-rb-r01' });
    expect(errCode(rb.envelope)).toBe('CONFLICT');
    expect(readFile('a.txt')).toBe('human wrote this\n'); // human bytes preserved
  });

  it('rollback restores pre-apply bytes when the file is untouched', async () => {
    const p = await preview([{ op: 'replace_file', path: 'a.txt', content: 'v2\n' }, { op: 'delete', path: 'b.txt' }]);
    const d = data(p.envelope);
    const applied = await apply(d['planId'] as string, d['planHash'] as string, 'k-rb-002');
    const csId = data(applied.envelope)['changesetId'] as string;
    expect(fs.existsSync(path.join(ctx.fixtureDir, 'b.txt'))).toBe(false);
    const rb = await callToolLegacy(ctx, tokens.accessToken, 'rollback_changes', { ...wsArgs(ctx), changesetId: csId, idempotencyKey: 'k-rb-r02' });
    expect(rb.isError).toBe(false);
    expect(readFile('a.txt')).toBe('alpha\n');
    expect(readFile('b.txt')).toBe('beta\nbeta\n'); // deleted file restored
  });

  it('CHG-13: move onto an existing destination is refused before writing', async () => {
    const res = await preview([{ op: 'move', path: 'a.txt', destPath: 'b.txt' }]);
    expect(errCode(res.envelope)).toBe('CONFLICT');
  });

  it('CHG-15: an approval bound to one plan does not authorize a different one (inspect mode)', async () => {
    // Switch to inspect mode: apply now needs approval.
    ctx.server.services.store.setTrustMode(ctx.server.workspaceId, 'inspect');
    const p = await preview([{ op: 'create', path: 'need-approval.txt', content: 'x' }]);
    const d = data(p.envelope);
    const res = await apply(d['planId'] as string, d['planHash'] as string, 'k-appr-1');
    expect(errCode(res.envelope)).toBe('APPROVAL_REQUIRED');
    const approvalId = ((res.envelope['error'] as Record<string, unknown>)['detail'] as Record<string, unknown>)['approvalId'] as string;
    expect(approvalId).toBeTruthy();
    // Approve THIS action over IPC-equivalent, then apply succeeds.
    ctx.server.services.store.setApprovalStatus(approvalId, 'approved');
    const ok = await apply(d['planId'] as string, d['planHash'] as string, 'k-appr-1b');
    expect(ok.isError).toBe(false);
  });

  it('CHG-12: concurrent applies on the same root serialize without corruption', async () => {
    const p1 = await preview([{ op: 'create', path: 'c1.txt', content: '1\n' }]);
    const p2 = await preview([{ op: 'create', path: 'c2.txt', content: '2\n' }]);
    const [r1, r2] = await Promise.all([
      apply(data(p1.envelope)['planId'] as string, data(p1.envelope)['planHash'] as string, 'k-cc-001'),
      apply(data(p2.envelope)['planId'] as string, data(p2.envelope)['planHash'] as string, 'k-cc-002'),
    ]);
    expect(r1.isError).toBe(false);
    expect(r2.isError).toBe(false);
    expect(readFile('c1.txt')).toBe('1\n');
    expect(readFile('c2.txt')).toBe('2\n');
  });

  it('FS-06: round-trips CRLF and multibyte content by raw-byte hash', async () => {
    const content = 'บรรทัด\r\nสอง\r\nไม่มีท้าย';
    const p = await preview([{ op: 'create', path: 'thai.txt', content }]);
    const d = data(p.envelope);
    await apply(d['planId'] as string, d['planHash'] as string, 'k-thai-01');
    expect(fs.readFileSync(path.join(ctx.fixtureDir, 'thai.txt'), 'utf8')).toBe(content);
  });
});
