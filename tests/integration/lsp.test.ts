import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkspaceFS } from '../../src/workspace/fs.js';
import { IgnoreEngine } from '../../src/workspace/ignores.js';
import { DEFAULT_LIMITS, type Limits } from '../../src/config/limits.js';
import { DodoError } from '../../src/errors.js';
import { LspService } from '../../src/services/lsp/lspService.js';

/**
 * Service-level test of the generic LSP adapter against a REAL language
 * server: pyright (devDependency), spawned over stdio with the whitelisted
 * child env. No HTTP server, no network. The command is an absolute path
 * OUTSIDE the temp workspace root, which is exactly what `available()`
 * permits (in-repo executables are refused).
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// Run the actual JavaScript server through Node, never a Windows npm .cmd shim.
const PYRIGHT = path.resolve(ROOT, 'node_modules/pyright/langserver.index.js');
const LIMITS: Limits = { ...DEFAULT_LIMITS, semanticRequestTimeoutMs: 45_000 };
const T = 60_000;

const UTIL_PY = ['def greet(name: str) -> str:', '    return GREETING + ", " + name', '', '', 'GREETING = "Hello"', ''].join('\n');

// A non-ASCII comment BEFORE the call sites makes UTF-8 byte offsets differ
// from UTF-16 char offsets, so the rename edits are only correct if the
// adapter really converts to bytes.
const MAIN_PY = [
  'from pkg.util import GREETING, greet',
  '',
  '# สวัสดี: this comment mentions greet but is not a reference',
  'banner = "please do not greet here"',
  '',
  '',
  'def run() -> None:',
  '    print(greet("Ada"))',
  '    print(greet("Grace"))',
  '    print(GREETING)',
  '',
].join('\n');

const BAD_PY = 'x: int = "s"\n';

function writeFixture(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
}

function applyByteEdits(bytes: Buffer, edits: Array<{ start: number; end: number; newText: string }>): string {
  let out = bytes;
  for (const e of [...edits].sort((a, b) => b.start - a.start)) {
    out = Buffer.concat([out.subarray(0, e.start), Buffer.from(e.newText, 'utf8'), out.subarray(e.end)]);
  }
  return out.toString('utf8');
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('LspService (generic LSP adapter, real pyright over stdio)', () => {
  let root: string;
  let svc: LspService;
  const logs: string[] = [];

  beforeAll(() => {
    expect(fs.existsSync(PYRIGHT), `pyright-langserver missing at ${PYRIGHT}`).toBe(true);
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dodo-lsp-')));
    writeFixture(root, {
      'pkg/__init__.py': '',
      'pkg/util.py': UTIL_PY,
      'pkg/main.py': MAIN_PY,
      'bad.py': BAD_PY,
      'x.rb': 'puts "hi"\n',
      'script.lua': 'print("hi")\n',
    });
    // An "executable" inside the workspace must never be accepted as a server.
    fs.mkdirSync(path.join(root, 'bin'));
    fs.writeFileSync(path.join(root, 'bin', 'evil-ls'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    const wfs = new WorkspaceFS(root, new IgnoreEngine({ root }));
    svc = new LspService({
      wfs,
      limits: LIMITS,
      registry: {
        python: { command: process.execPath, args: [PYRIGHT, '--stdio'], extensions: ['.py'] },
        lua: { command: 'dodo-no-such-language-server-xyz', args: [], extensions: ['.lua'] },
        evil: { command: path.join(root, 'bin', 'evil-ls'), args: [], extensions: ['.evil'] },
      },
      log: (line) => logs.push(line),
    });
  }, T);

  afterAll(async () => {
    await svc.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }, T);

  it('languageFor maps registered extensions only; available() enforces the trusted-command rule', () => {
    expect(svc.languageFor('pkg/util.py')).toBe('python');
    expect(svc.languageFor('x.rb')).toBeUndefined();
    expect(svc.languageFor('README')).toBeUndefined();

    expect(svc.available('python')).toEqual({ ok: true });
    expect(svc.available('ruby').ok).toBe(false);

    const missing = svc.available('lua');
    expect(missing.ok).toBe(false);
    expect(missing.reason).toContain('dodo-no-such-language-server-xyz');

    const inRepo = svc.available('evil');
    expect(inRepo.ok).toBe(false);
    expect(inRepo.reason).toMatch(/inside the workspace root/);
  });

  it(
    'symbolsInFile lists greet (hierarchical documentSymbol flattened)',
    async () => {
      const { symbols, meta } = await svc.symbolsInFile('pkg/util.py', 50);
      const greet = symbols.find((s) => s.name === 'greet');
      expect(greet).toBeDefined();
      expect(greet?.path).toBe('pkg/util.py');
      expect(greet?.kind).toBe('function');
      expect(greet?.line).toBe(1);
      expect(symbols.some((s) => s.name === 'GREETING')).toBe(true);
      expect(meta.language).toBe('python');
      expect(meta.server).toBe(path.basename(process.execPath));
      expect(meta.degraded).toBe(false);
    },
    T,
  );

  it(
    'references at the def position include the pkg/main.py call sites but not the comment/string lines',
    async () => {
      const column = UTIL_PY.indexOf('greet') + 1; // 1-based column of the identifier on line 1
      const { references, outOfScopeCount, meta } = await svc.references('pkg/util.py', { line: 1, column }, 100);
      expect(meta.language).toBe('python');
      expect(outOfScopeCount).toBe(0);

      const decl = references.find((r) => r.path === 'pkg/util.py' && r.line === 1);
      expect(decl).toBeDefined();
      expect(decl?.isDefinition).toBe(true);
      expect(decl?.lineText).toBe('def greet(name: str) -> str:');

      const inMain = references.filter((r) => r.path === 'pkg/main.py');
      const mainLines = inMain.map((r) => r.line).sort((a, b) => a - b);
      expect(mainLines).toContain(8);
      expect(mainLines).toContain(9);
      expect(mainLines).not.toContain(3); // comment
      expect(mainLines).not.toContain(4); // string literal
      for (const r of inMain) {
        expect(r.isDefinition).toBe(false);
        expect(r.lineText.slice(r.column - 1, r.endColumn - 1)).toBe('greet');
      }
    },
    T,
  );

  it(
    'rename greet -> salute returns UTF-8 byte-offset edits for util.py AND main.py that apply cleanly',
    async () => {
      const column = UTIL_PY.indexOf('greet') + 1;
      const { result, meta } = await svc.rename('pkg/util.py', { line: 1, column }, 'salute');
      expect(meta.language).toBe('python');
      expect(result.symbolName).toBe('greet');
      expect(result.outOfScopeCount).toBe(0);

      const paths = result.locations.map((l) => l.path).sort();
      expect(paths).toEqual(['pkg/main.py', 'pkg/util.py']);

      for (const loc of result.locations) {
        const bytes = fs.readFileSync(path.join(root, loc.path));
        expect(loc.edits.length).toBeGreaterThan(0);
        // Sorted, byte-exact, original text is exactly the identifier.
        for (let i = 0; i < loc.edits.length; i += 1) {
          const e = loc.edits[i] as (typeof loc.edits)[number];
          expect(e.originalText).toBe('greet');
          expect(e.newText).toBe('salute');
          expect(bytes.subarray(e.start, e.end).toString('utf8')).toBe('greet');
          if (i > 0) expect(e.start).toBeGreaterThan((loc.edits[i - 1] as (typeof loc.edits)[number]).end);
        }
        const applied = applyByteEdits(bytes, loc.edits);
        if (loc.path === 'pkg/util.py') {
          expect(loc.edits).toHaveLength(1);
          expect(applied.startsWith('def salute(name: str) -> str:')).toBe(true);
          expect(count(applied, 'greet')).toBe(0);
        } else {
          expect(loc.edits).toHaveLength(3); // import + two calls
          expect(applied).toContain('from pkg.util import GREETING, salute');
          expect(applied).toContain('print(salute("Ada"))');
          expect(applied).toContain('print(salute("Grace"))');
          expect(count(applied, 'greet')).toBe(2); // comment + string survive untouched
          // The Thai comment precedes the calls: byte offsets must differ from char offsets.
          const callChar = MAIN_PY.indexOf('greet("Ada")');
          const callEdit = loc.edits.find((e) => e.start === Buffer.byteLength(MAIN_PY.slice(0, callChar), 'utf8'));
          expect(callEdit).toBeDefined();
          expect(callEdit?.start).not.toBe(callChar);
        }
      }
    },
    T,
  );

  it(
    'diagnostics for bad.py contain an error',
    async () => {
      const { diagnostics, meta } = await svc.diagnostics(['bad.py'], 50);
      expect(meta.language).toBe('python');
      const errors = diagnostics.filter((d) => d.category === 'error');
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]?.path).toBe('bad.py');
      expect(errors[0]?.line).toBe(1);
      expect(errors[0]?.message.toLowerCase()).toMatch(/int|str/);
      // A clean file produces none (and does not pick up stale results from bad.py).
      const clean = await svc.diagnostics(['pkg/util.py'], 50);
      expect(clean.diagnostics.filter((d) => d.category === 'error')).toEqual([]);
    },
    T,
  );

  it(
    'symbolsQuery finds greet across the workspace with workspace-relative paths only',
    async () => {
      const { symbols } = await svc.symbolsQuery('python', 'greet', 50);
      const hit = symbols.find((s) => s.name === 'greet');
      expect(hit).toBeDefined();
      expect(hit?.path).toBe('pkg/util.py');
      for (const s of symbols) expect(path.isAbsolute(s.path)).toBe(false);
    },
    T,
  );

  it('unregistered extension -> UNSUPPORTED_LANGUAGE (no server involved)', async () => {
    await expect(svc.symbolsInFile('x.rb', 10)).rejects.toMatchObject({ code: 'UNSUPPORTED_LANGUAGE' });
    await expect(svc.references('x.rb', { line: 1, column: 1 }, 10)).rejects.toBeInstanceOf(DodoError);
    await expect(svc.symbolsQuery('ruby', 'x', 10)).rejects.toMatchObject({ code: 'UNSUPPORTED_LANGUAGE' });
  });

  it('missing command -> UNSUPPORTED_LANGUAGE naming the command; in-repo command refused', async () => {
    const err = await svc.symbolsInFile('script.lua', 10).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DodoError);
    expect((err as DodoError).code).toBe('UNSUPPORTED_LANGUAGE');
    expect((err as DodoError).message).toContain('dodo-no-such-language-server-xyz');
    await expect(svc.symbolsQuery('evil', 'x', 10)).rejects.toMatchObject({ code: 'UNSUPPORTED_LANGUAGE' });
  });

  it('rejects invalid positions and identifiers without hitting the server', async () => {
    await expect(svc.rename('pkg/util.py', { line: 1, column: 5 }, 'not valid')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(svc.references('pkg/util.py', { line: 999, column: 1 }, 10)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
