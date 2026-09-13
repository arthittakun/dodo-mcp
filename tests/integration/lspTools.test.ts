import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, obtainToken, callToolLegacy, wsArgs, type TestContext, type TokenSet } from '../helpers/testServer.js';

/**
 * LSP adapter through the real tools: symbols / references / preview_rename /
 * diagnostics for Python via pyright (devDependency), registered the way an
 * owner would (`lsp` in the global config).
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PYRIGHT = path.join(ROOT, 'node_modules', 'pyright', 'langserver.index.js');

describe('LSP via tools (real pyright through native Node)', () => {
  let ctx: TestContext;
  let tokens: TokenSet;

  beforeAll(async () => {
    expect(fs.existsSync(PYRIGHT), 'required pyright devDependency is installed').toBe(true);
    ctx = await launch({ toolSurface: 'full', 
      trust: 'edit',
      configPatch: { lsp: { python: { command: process.execPath, args: [PYRIGHT, '--stdio'], extensions: ['.py'] } } },
      fixtureFiles: {
        'pkg/__init__.py': '',
        'pkg/util.py': 'def greet(name: str) -> str:\n    return "hi " + name\n\nLIMIT = 3\n',
        'pkg/main.py': 'from pkg.util import greet\n\n# greet is mentioned here in a comment\nmsg = greet("a")\nother = greet("b")\nlabel = "greet"\n',
        'bad.py': 'x: int = "not an int"\n',
        'notes.rb': 'puts 1\n',
      },
    });
    tokens = await obtainToken(ctx);
  }, 120_000);
  afterAll(async () => ctx?.cleanup());

  const data = (env: Record<string, unknown>) => env['data'] as Record<string, unknown>;
  const errCode = (env: Record<string, unknown>) => (env['error'] as Record<string, unknown> | null)?.['code'];
  const call = (name: string, args: Record<string, unknown>) => callToolLegacy(ctx, tokens.accessToken, name, { ...wsArgs(ctx), ...args });

  it('symbols lists Python declarations through the LSP provider', async () => {
    const res = await call('symbols', { file: 'pkg/util.py' });
    expect(res.isError, JSON.stringify(res.envelope['error'])).toBe(false);
    const d = data(res.envelope);
    expect((d['symbols'] as Array<{ name: string }>).map((s) => s.name)).toEqual(expect.arrayContaining(['greet', 'LIMIT']));
    expect(d['language']).toBe('python');
  }, 90_000);

  it('references are semantic (call sites, not the comment or the string)', async () => {
    const res = await call('references', { file: 'pkg/util.py', line: 1, column: 5 });
    expect(res.isError, JSON.stringify(res.envelope['error'])).toBe(false);
    const refs = data(res.envelope)['references'] as Array<{ path: string; line: number }>;
    const mainLines = refs.filter((r) => r.path === 'pkg/main.py').map((r) => r.line).sort();
    expect(mainLines).toEqual(expect.arrayContaining([1, 4, 5]));
    expect(mainLines).not.toContain(3); // comment
    expect(mainLines).not.toContain(6); // string literal
  }, 90_000);

  it('preview_rename builds a plan that applies through the journal', async () => {
    const res = await call('preview_rename', { file: 'pkg/util.py', line: 1, column: 5, newName: 'salute' });
    expect(res.isError, JSON.stringify(res.envelope['error'])).toBe(false);
    const d = data(res.envelope);
    const files = (d['files'] as Array<{ path: string }>).map((f) => f.path).sort();
    expect(files).toEqual(['pkg/main.py', 'pkg/util.py']);
    const ap = await call('apply_changes', { planId: d['planId'], planHash: d['planHash'], idempotencyKey: 'k-lsp-rename-01' });
    expect(ap.isError).toBe(false);
    const main = fs.readFileSync(path.join(ctx.fixtureDir, 'pkg/main.py'), 'utf8');
    expect(main).toContain('salute("a")');
    expect(main).toContain('# greet is mentioned'); // comment untouched
    expect(main).toContain('label = "greet"'); // string untouched
  }, 90_000);

  it('diagnostics source=lsp reports the type error', async () => {
    const res = await call('diagnostics', { source: 'lsp', files: ['bad.py'] });
    expect(res.isError, JSON.stringify(res.envelope['error'])).toBe(false);
    const diags = data(res.envelope)['diagnostics'] as Array<{ path: string; category: string }>;
    expect(diags.some((x) => x.path === 'bad.py' && x.category === 'error')).toBe(true);
  }, 90_000);

  it('an unregistered language is still UNSUPPORTED_LANGUAGE with the lsp add hint', async () => {
    const res = await call('symbols', { file: 'notes.rb' });
    expect(errCode(res.envelope)).toBe('UNSUPPORTED_LANGUAGE');
    expect(((res.envelope['error'] as Record<string, unknown>)['recovery'] as string)).toContain('dodo lsp add');
  });
});
