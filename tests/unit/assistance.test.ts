import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceFS } from '../../src/workspace/fs.js';
import { IgnoreEngine } from '../../src/workspace/ignores.js';
import { runAnalysis, type AnalysisEnvironment } from '../../src/services/assistance/analysis.js';
import { ContextSchema, ImpactSchema, SymbolSchema, RefactorSchema } from '../../src/services/assistance/contracts.js';
import { summarizeTests } from '../../src/services/assistance/verification.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture(files: Record<string, string>): AnalysisEnvironment {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dodo-assist-unit-'))); roots.push(root);
  for (const [name, content] of Object.entries(files)) { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); }
  return { wfs: new WorkspaceFS(root, new IgnoreEngine({ root })), maxFiles: 100, maxFileBytes: 512 * 1024,
    compilerOptions: { allowJs: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext } };
}
const source = {
  'src/oauth.ts': 'export function refreshToken() { return "token"; }\n',
  'src/client.ts': 'import { refreshToken } from "./oauth.js"; export const current = refreshToken();\n',
  'tests/client.test.ts': 'import { current } from "../src/client.js"; console.log(current);\n',
  'docs/oauth.md': '# OAuth refreshToken\nHow identity refresh works.\n',
  'src/unrelated.ts': '// import { refreshToken } from "./oauth.js"\nexport const other = 1;\n',
};

describe('task assistance analysis', () => {
  it('ranks related code/docs/tests, cites hashes, and does not include secret contents', () => {
    const env = fixture({ ...source, '.env': 'refreshToken=NEVER_DISCLOSE' });
    const result = ContextSchema.parse(runAnalysis(env, { op: 'assist_context', goal: 'แก้ OAuth refreshToken', terms: ['refreshToken'], files: ['src/oauth.ts'], maxFiles: 8, maxBytes: 20000 }));
    expect(result.files[0]?.path).toBe('src/oauth.ts');
    expect(result.files.map(f => f.path)).toContain('docs/oauth.md');
    expect(result.relationships).toContainEqual(expect.objectContaining({ from: 'src/client.ts', to: 'src/oauth.ts' }));
    expect(JSON.stringify(result)).not.toContain('NEVER_DISCLOSE');
    expect(result.files.every(f => f.hash.startsWith('sha256:') && f.line > 0)).toBe(true);
  });
  it('finds direct/transitive import edges but not comment lookalikes', () => {
    const env = fixture(source);
    const result = ImpactSchema.parse(runAnalysis(env, { op: 'assist_impact', files: ['src/oauth.ts'], maxResults: 50, maxDepth: 5 }));
    expect(result.impacted).toContainEqual(expect.objectContaining({ path: 'src/client.ts', distance: 1, evidenceLine: 1 }));
    expect(result.impacted).toContainEqual(expect.objectContaining({ path: 'tests/client.test.ts', distance: 2 }));
    expect(result.relatedTests).toContain('tests/client.test.ts');
    expect(result.impacted.map(f => f.path)).not.toContain('src/unrelated.ts');
    expect(result.requiresBroadVerification).toBe(true);
  });
  it('resolves configured path aliases and re-exports inside the guarded snapshot', () => {
    const env = fixture({ ...source, 'src/index.ts': 'export * from "./oauth.js";', 'consumer.ts': 'import { refreshToken } from "@/index.js";' });
    env.compilerOptions.baseUrl = env.wfs.root; env.compilerOptions.paths = { '@/*': ['src/*'] };
    const result = ImpactSchema.parse(runAnalysis(env, { op: 'assist_impact', files: ['src/oauth.ts'], maxResults: 50, maxDepth: 5 }));
    expect(result.impacted.map(f => f.path)).toContain('consumer.ts');
  });
  it('reports dynamic loading, missing targets and bounded/depth-limited analysis honestly', () => {
    const env = fixture({ ...source, 'dynamic.ts': 'const p = "./src/oauth.js"; import(p); require(p);' });
    const result = ImpactSchema.parse(runAnalysis(env, { op: 'assist_impact', files: ['src/oauth.ts', 'deleted.ts'], maxResults: 1, maxDepth: 1 }));
    expect(result.truncated).toBe(true); expect(result.coverage.dynamicImports).toBe(2);
    expect(result.targets).toContainEqual({ path: 'deleted.ts', hash: null, missing: true });
    env.maxFiles = 1;
    const limited = ContextSchema.parse(runAnalysis(env, { op: 'assist_context', goal: 'oauth', terms: [], files: [], maxFiles: 2, maxBytes: 4096 }));
    expect(limited.coverage.truncated).toBe(true);
  });
  it('keeps the requested UTF-8 context output budget and rehashes changed files', () => {
    const env = fixture(source);
    const req = { op: 'assist_context' as const, goal: 'refreshToken', terms: [], files: ['src/oauth.ts'], maxFiles: 6, maxBytes: 4096 };
    const a = ContextSchema.parse(runAnalysis(env, req));
    expect(Buffer.byteLength(JSON.stringify(a))).toBeLessThanOrEqual(4096);
    fs.appendFileSync(path.join(env.wfs.root, 'src/oauth.ts'), '// changed');
    const b = ContextSchema.parse(runAnalysis(env, req));
    expect(a.files[0]?.hash).not.toBe(b.files[0]?.hash);
  });
  it('rejects direct secret/traversal/symlink targets instead of silently searching elsewhere', () => {
    const env = fixture({ ...source, '.env': 'secret' });
    for (const file of ['.env', '../outside.ts']) {
      expect(() => runAnalysis(env, { op: 'assist_context', goal: 'oauth', terms: [], files: [file], maxFiles: 2, maxBytes: 4096 })).toThrow();
    }
    fs.symlinkSync(path.join(env.wfs.root, 'src/oauth.ts'), path.join(env.wfs.root, 'linked.ts'));
    expect(() => runAnalysis(env, { op: 'assist_symbol', file: 'linked.ts', symbol: 'refreshToken', maxBytes: 4096 })).toThrow();
  });
  it('reads qualified symbols and refuses ambiguity and unsupported languages', () => {
    const env = fixture({ 'a.ts': 'class A { run() { return 1; } }\nclass B { run() { return 2; } }', 'a.py': 'def run(): pass' });
    expect(() => runAnalysis(env, { op: 'assist_symbol', file: 'a.ts', symbol: 'run', maxBytes: 4096 })).toThrow(/multiple/);
    const read = SymbolSchema.parse(runAnalysis(env, { op: 'assist_symbol', file: 'a.ts', symbol: 'B.run', maxBytes: 4096 }));
    expect(read.content).toContain('return 2'); expect(read.editableBody).toBe(true);
    expect(() => runAnalysis(env, { op: 'assist_symbol', file: 'a.py', symbol: 'run', maxBytes: 4096 })).toThrow(/TypeScript/);
  });
  it('replaces only the selected body, preserving Unicode, CRLF, comments and surrounding bytes', () => {
    const text = '// สวัสดี 🌏\r\nexport function greet() {\r\n  return "ก่อน";\r\n}\r\nconst outside = "unchanged";\r\n';
    const env = fixture({ 'a.ts': text });
    const read = SymbolSchema.parse(runAnalysis(env, { op: 'assist_symbol', file: 'a.ts', symbol: 'greet', maxBytes: 4096 }));
    const edited = RefactorSchema.parse(runAnalysis(env, { op: 'assist_refactor', file: 'a.ts', symbol: 'greet', expectedHash: read.hash, body: '\n  return "หลัง";\n' }));
    expect(edited.content).toBe(text.replace('"ก่อน"', '"หลัง"'));
    expect(fs.readFileSync(path.join(env.wfs.root, 'a.ts'), 'utf8')).toBe(text);
  });
  it('refuses stale hashes, syntax errors, brace escapes and non-block bodies', () => {
    const env = fixture({ 'a.ts': 'export function greet() { return 1; }\nconst arrow = () => 1;' });
    const read = SymbolSchema.parse(runAnalysis(env, { op: 'assist_symbol', file: 'a.ts', symbol: 'greet', maxBytes: 4096 }));
    for (const body of [' return (; ', '}\nfunction other() {']) {
      expect(() => runAnalysis(env, { op: 'assist_refactor', file: 'a.ts', symbol: 'greet', expectedHash: read.hash, body })).toThrow();
    }
    expect(() => runAnalysis(env, { op: 'assist_refactor', file: 'a.ts', symbol: 'arrow', expectedHash: read.hash, body: 'return 2;' })).toThrow(/block/);
    fs.appendFileSync(path.join(env.wfs.root, 'a.ts'), '\n// edit');
    expect(() => runAnalysis(env, { op: 'assist_refactor', file: 'a.ts', symbol: 'greet', expectedHash: read.hash, body: 'return 2;' })).toThrow(/changed/);
  });
  it('does not execute repository code while computing context', () => {
    const env = fixture({ 'evil.ts': 'throw new Error("executed"); export function evil() {}', 'tsconfig.json': '{"compilerOptions":{"plugins":[{"name":"evil"}]}}' });
    const result = ContextSchema.parse(runAnalysis(env, { op: 'assist_context', goal: 'evil', terms: [], files: [], maxFiles: 3, maxBytes: 4096 }));
    expect(result.files.some(f => f.path === 'evil.ts')).toBe(true);
  });
});

describe('verification result parsing', () => {
  it('parses runner JSON and failure evidence', () => {
    const result = summarizeTests('npm header\n' + JSON.stringify({ numTotalTests: 2, numPassedTests: 1, numFailedTests: 1, numPendingTests: 0,
      testResults: [{ assertionResults: [{ fullName: 'breaks', status: 'failed', failureMessages: ['expected 2'] }] }] }));
    expect(result).toMatchObject({ source: 'json', total: 2, passed: 1, failed: 1 }); expect(result.failures[0]).toContain('expected 2');
  });
  it('never converts missing/zero/malformed test evidence into a test pass', () => {
    expect(summarizeTests('build succeeded').total).toBeNull();
    expect(summarizeTests('No test files found, exiting with code 0').total).toBe(0);
    expect(summarizeTests('{"numTotalTests":2').source).toBe('not_available');
    expect(summarizeTests('{"numTotalTests":1,"numPassedTests":2,"numFailedTests":0}').source).toBe('not_available');
  });
  it('recognizes bounded Vitest summary output without inventing individual test results', () => {
    expect(summarizeTests(' Test Files 2 passed (2)\n Tests 5 passed | 1 skipped (6)\n')).toMatchObject({ source: 'text-summary', total: 6, passed: 5, skipped: 1, failures: [] });
  });
});
