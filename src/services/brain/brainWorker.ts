import path from 'node:path';
import { parentPort } from 'node:worker_threads';
import ts from 'typescript';
import { sha256Bytes } from '../../util/hash.js';
import { truncateUtf8 } from '../../util/bytes.js';
import { ParsedBrainFile, type ParsedBrainFileData } from './contracts.js';
import type { BrainParseRequest, BrainParseResponse } from './protocol.js';

const SYMBOL_MAX = 5000;
const IMPORT_MAX = 5000;
const REFERENCE_MAX = 10000;
const SPECIAL_MAX = 2000;
const DIAGNOSTIC_MAX = 200;

function position(sf: ts.SourceFile, offset: number): { line: number; column: number } {
  const value = sf.getLineAndCharacterOfPosition(offset);
  return { line: value.line + 1, column: value.character + 1 };
}

function exported(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  return (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword || modifier.kind === ts.SyntaxKind.DefaultKeyword);
}

function declaration(node: ts.Node, sf: ts.SourceFile): { name: string; kind: string; nameNode: ts.Node; bodyStart?: number } | undefined {
  if (ts.isFunctionDeclaration(node) && node.name) return { name: node.name.text, kind: 'function', nameNode: node.name, ...(node.body ? { bodyStart: node.body.getStart(sf) } : {}) };
  if (ts.isClassDeclaration(node) && node.name) return { name: node.name.text, kind: 'class', nameNode: node.name };
  if (ts.isInterfaceDeclaration(node)) return { name: node.name.text, kind: 'interface', nameNode: node.name };
  if (ts.isTypeAliasDeclaration(node)) return { name: node.name.text, kind: 'type', nameNode: node.name };
  if (ts.isEnumDeclaration(node)) return { name: node.name.text, kind: 'enum', nameNode: node.name };
  if (ts.isModuleDeclaration(node)) return { name: node.name.getText(sf), kind: 'namespace', nameNode: node.name };
  if ((ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) && node.name) {
    return { name: node.name.getText(sf), kind: ts.isMethodDeclaration(node) ? 'method' : 'accessor', nameNode: node.name, ...(node.body ? { bodyStart: node.body.getStart(sf) } : {}) };
  }
  if (ts.isConstructorDeclaration(node)) return { name: 'constructor', kind: 'constructor', nameNode: node, ...(node.body ? { bodyStart: node.body.getStart(sf) } : {}) };
  if (ts.isPropertyDeclaration(node) && node.name) return { name: node.name.getText(sf), kind: 'property', nameNode: node.name };
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    const functional = node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer));
    return { name: node.name.text, kind: functional ? 'function' : 'variable', nameNode: node.name, ...(functional && ts.isBlock(node.initializer!.body) ? { bodyStart: node.initializer!.body.getStart(sf) } : {}) };
  }
  return undefined;
}

function parseScript(file: string, text: string): ParsedBrainFileData {
  const extension = path.extname(file).toLowerCase();
  const scriptKind = ['.js', '.jsx', '.mjs', '.cjs'].includes(extension)
    ? (extension === '.jsx' ? ts.ScriptKind.JSX : ts.ScriptKind.JS)
    : (extension === '.tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const language = scriptKind === ts.ScriptKind.JS || scriptKind === ts.ScriptKind.JSX ? 'javascript' : 'typescript';
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind);
  const symbols: ParsedBrainFileData['symbols'] = [];
  const imports: ParsedBrainFileData['imports'] = [];
  const references: ParsedBrainFileData['references'] = [];
  const routes: ParsedBrainFileData['routes'] = [];
  const tests: ParsedBrainFileData['tests'] = [];
  const diagnostics: ParsedBrainFileData['diagnostics'] = [];
  const declarationNames = new Set<ts.Node>();
  const ordinal = new Map<string, number>();
  let truncated = false;

  function addImport(specifier: string, kind: 'imports' | 'exports' | 'dynamic_import', node: ts.Node): void {
    if (imports.length >= IMPORT_MAX) { truncated = true; return; }
    imports.push({ specifier: truncateUtf8(specifier, 1024).text, kind, line: position(sf, node.getStart(sf)).line });
  }

  function walk(node: ts.Node, parents: string[]): void {
    const found = declaration(node, sf);
    let childrenParents = parents;
    if (found) {
      declarationNames.add(found.nameNode);
      if (symbols.length < SYMBOL_MAX) {
        const qualifiedName = [...parents, found.name].join('.');
        const key = `${found.kind}:${qualifiedName}`;
        const currentOrdinal = ordinal.get(key) ?? 0;
        ordinal.set(key, currentOrdinal + 1);
        const start = node.getStart(sf), end = node.getEnd();
        const signatureEnd = Math.min(end, found.bodyStart ?? start + 500);
        const signature = sf.text.slice(start, signatureEnd).replace(/\s+/g, ' ').trim();
        const from = position(sf, start), to = position(sf, end);
        symbols.push({
          name: truncateUtf8(found.name, 256).text,
          qualifiedName: truncateUtf8(qualifiedName, 1024).text,
          kind: found.kind,
          ordinal: currentOrdinal,
          line: from.line,
          column: from.column,
          endLine: to.line,
          endColumn: to.column,
          signatureHash: sha256Bytes(signature),
          exported: exported(node) || (node.parent !== undefined && exported(node.parent)),
        });
      } else truncated = true;
      childrenParents = [...parents, found.name];
    }

    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) addImport(node.moduleSpecifier.text, 'imports', node.moduleSpecifier);
    else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) addImport(node.moduleSpecifier.text, 'exports', node.moduleSpecifier);
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression && ts.isStringLiteralLike(node.moduleReference.expression)) addImport(node.moduleReference.expression.text, 'imports', node.moduleReference.expression);

    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      const first = node.arguments[0];
      if ((expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(expression) && expression.text === 'require')) && first && ts.isStringLiteralLike(first)) {
        addImport(first.text, expression.kind === ts.SyntaxKind.ImportKeyword ? 'dynamic_import' : 'imports', first);
      }
      if (ts.isPropertyAccessExpression(expression) && first && ts.isStringLiteralLike(first)) {
        const method = expression.name.text.toLowerCase();
        if (['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'use'].includes(method)) {
          if (routes.length < SPECIAL_MAX) {
            const at = position(sf, node.getStart(sf));
            routes.push({ method: method.toUpperCase(), route: truncateUtf8(first.text, 1024).text, ordinal: routes.length, ...at });
          } else truncated = true;
        }
      }
      if (ts.isIdentifier(expression) && ['describe', 'it', 'test'].includes(expression.text) && first && ts.isStringLiteralLike(first)) {
        if (tests.length < SPECIAL_MAX) {
          const at = position(sf, node.getStart(sf));
          tests.push({ kind: expression.text as 'describe' | 'it' | 'test', name: truncateUtf8(first.text, 1024).text, ordinal: tests.length, ...at });
        } else truncated = true;
      }
    }

    ts.forEachChild(node, (child) => walk(child, childrenParents));
  }
  walk(sf, []);

  function collectReferences(node: ts.Node): void {
    if (references.length >= REFERENCE_MAX) { truncated = true; return; }
    if (ts.isIdentifier(node) && !declarationNames.has(node)) {
      const parent = node.parent;
      const importBinding = ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent) || ts.isImportEqualsDeclaration(parent);
      const propertyName = (ts.isPropertyAccessExpression(parent) && parent.name === node) || (ts.isPropertyAssignment(parent) && parent.name === node);
      if (!importBinding && !propertyName) {
        const at = position(sf, node.getStart(sf));
        references.push({ name: node.text, ...at, call: ts.isCallExpression(parent) && parent.expression === node });
      }
    }
    ts.forEachChild(node, collectReferences);
  }
  collectReferences(sf);

  const parseDiagnostics = (sf as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  for (const diagnostic of parseDiagnostics.slice(0, DIAGNOSTIC_MAX)) {
    const at = position(sf, Math.max(0, diagnostic.start ?? 0));
    diagnostics.push({ category: diagnostic.category === ts.DiagnosticCategory.Warning ? 'warning' : 'error', message: truncateUtf8(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'), 1024).text, ...at });
  }
  if (parseDiagnostics.length > DIAGNOSTIC_MAX) truncated = true;
  return ParsedBrainFile.parse({ provider: 'typescript-ast', language, symbols, imports, references, routes, tests, dependencies: [], diagnostics, truncated });
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function parsePackage(text: string): ParsedBrainFileData {
  let raw: unknown;
  try { raw = JSON.parse(text); }
  catch { return ParsedBrainFile.parse({ provider: 'package-json', language: 'json', symbols: [], imports: [], references: [], routes: [], tests: [], dependencies: [], diagnostics: [{ category: 'error', message: 'package.json is invalid JSON', line: 1, column: 1 }], truncated: false }); }
  const root = object(raw);
  if (!root) return ParsedBrainFile.parse({ provider: 'package-json', language: 'json', symbols: [], imports: [], references: [], routes: [], tests: [], dependencies: [], diagnostics: [{ category: 'error', message: 'package.json root must be an object', line: 1, column: 1 }], truncated: false });
  const dependencies: ParsedBrainFileData['dependencies'] = [];
  const sections = [['dependencies', 'runtime'], ['devDependencies', 'development'], ['peerDependencies', 'peer'], ['optionalDependencies', 'optional']] as const;
  let truncated = false;
  for (const [key, scope] of sections) {
    const section = object(root[key]);
    if (!section) continue;
    for (const name of Object.keys(section).sort()) {
      if (dependencies.length >= 5000) { truncated = true; break; }
      const version = section[name];
      if (typeof version === 'string' && name.length > 0 && name.length <= 256) dependencies.push({ name, scope, version: truncateUtf8(version, 512).text });
    }
  }
  return ParsedBrainFile.parse({ provider: 'package-json', language: 'json', symbols: [], imports: [], references: [], routes: [], tests: [], dependencies, diagnostics: [], truncated });
}

function handle(request: BrainParseRequest): ParsedBrainFileData {
  if (request.path === 'package.json' || request.path.endsWith('/package.json')) return parsePackage(request.text);
  return parseScript(request.path, request.text);
}

if (!parentPort) throw new Error('brain worker requires parentPort');
parentPort.on('message', (request: BrainParseRequest) => {
  let response: BrainParseResponse;
  try { response = { id: request.id, ok: true, data: handle(request) }; }
  catch (error) { response = { id: request.id, ok: false, error: { code: 'INVALID_INPUT', message: truncateUtf8((error as Error).message || 'parser rejected source', 600).text } }; }
  parentPort!.postMessage(response);
});
