import { runAnalysis } from '../assistance/analysis.js';
import { DodoError } from '../../errors.js';
import { parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { WorkspaceFS } from '../../workspace/fs.js';
import { IgnoreEngine } from '../../workspace/ignores.js';
import { sha256Bytes } from '../../util/hash.js';
import type {
  WorkerInit,
  WorkerRequest,
  WorkerResponse,
  SymbolInfo,
  ReferenceInfo,
  RenameResultData,
  DiagnosticInfo,
  WorkerMeta,
  Position,
} from './protocol.js';

/**
 * Guarded TypeScript Language Service worker (spec §11):
 * - runs the BUNDLED TypeScript (a pinned dependency of DODO) — never a
 *   compiler or plugin loaded from the repository;
 * - every file access goes through the same WorkspaceFS policy as the rest
 *   of DODO, plus a single extra allowlist: TypeScript's own lib directory;
 * - tsconfig is parsed as data (`ts.readConfigFile`), plugins stripped;
 * - unresolved imports degrade honestly instead of reaching outside the root.
 */
const init = workerData as WorkerInit;
const TS_LIB_DIR = path.dirname(ts.getDefaultLibFilePath({}));

const ignores = new IgnoreEngine({ root: init.root, extraSecretPatterns: init.extraSecretPatterns, projectExcludes: init.projectExcludes });
const wfs = new WorkspaceFS(init.root, ignores);

const SCRIPT_EXTS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

interface SnapshotEntry {
  version: string;
  snapshot: ts.IScriptSnapshot;
  text: string;
}

const snapshots = new Map<string, SnapshotEntry>();
let fileListCache: { at: number; files: string[] } | undefined;
let degraded = false;
let degradedReason: string | undefined;

function isInTsLib(abs: string): boolean {
  const rel = path.relative(TS_LIB_DIR, abs);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** abs path → workspace rel, or undefined when outside root. */
function relOf(abs: string): string | undefined {
  const rel = path.relative(init.root, abs);
  if (rel === '' ) return '.';
  if (rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
  return rel.split(path.sep).join('/');
}

function guardedReadFile(abs: string): string | undefined {
  if (isInTsLib(abs)) {
    try {
      return fs.readFileSync(abs, 'utf8');
    } catch {
      return undefined;
    }
  }
  const rel = relOf(abs);
  if (rel === undefined || rel === '.') return undefined;
  try {
    const { bytes } = wfs.readFileBytes(rel, init.maxSnapshotBytes);
    return bytes.toString('utf8');
  } catch {
    return undefined;
  }
}

function guardedFileExists(abs: string): boolean {
  if (isInTsLib(abs)) return fs.existsSync(abs);
  const rel = relOf(abs);
  if (rel === undefined || rel === '.') return false;
  try {
    const resolved = wfs.resolve(rel);
    return resolved.stat?.isFile() ?? false;
  } catch {
    return false;
  }
}

function guardedDirExists(abs: string): boolean {
  if (isInTsLib(abs)) return true;
  const rel = relOf(abs);
  if (rel === undefined) return false;
  if (rel === '.') return true;
  try {
    const resolved = wfs.resolve(rel);
    return resolved.stat?.isDirectory() ?? false;
  } catch {
    return false;
  }
}

function projectFiles(): string[] {
  const now = Date.now();
  if (fileListCache && now - fileListCache.at < 3000) return fileListCache.files;
  const files: string[] = [];
  for (const f of wfs.walk({ includeIgnored: false, maxEntries: init.semanticFilesMax * 4 })) {
    if (!SCRIPT_EXTS.has(path.posix.extname(f.rel))) continue;
    if (f.stat.size > init.maxSnapshotBytes) continue;
    files.push(path.join(init.root, f.rel));
    if (files.length >= init.semanticFilesMax) {
      degraded = true;
      degradedReason = `project exceeds ${init.semanticFilesMax} script files; analysis covers the first ${init.semanticFilesMax}`;
      break;
    }
  }
  fileListCache = { at: now, files };
  return files;
}

function compilerOptions(): ts.CompilerOptions {
  const defaults: ts.CompilerOptions = {
    allowJs: true,
    checkJs: false,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    jsx: ts.JsxEmit.Preserve,
    esModuleInterop: true,
    skipLibCheck: true,
    noEmit: true,
  };
  const configPath = path.join(init.root, 'tsconfig.json');
  if (!guardedFileExists(configPath)) return defaults;
  const read = ts.readConfigFile(configPath, (f) => guardedReadFile(f));
  if (read.error || !read.config) return defaults;
  const parseHost: ts.ParseConfigHost = {
    useCaseSensitiveFileNames: false,
    fileExists: guardedFileExists,
    readFile: guardedReadFile,
    readDirectory: () => [], // file list comes from our own bounded walk
  };
  try {
    const parsed = ts.parseJsonConfigFileContent(read.config, parseHost, init.root);
    const options = { ...defaults, ...parsed.options };
    // Strip anything that can execute or emit.
    delete options.plugins;
    options.noEmit = true;
    delete options.outDir;
    delete options.declarationDir;
    options.incremental = false;
    delete options.tsBuildInfoFile;
    return options;
  } catch {
    return defaults;
  }
}

const host: ts.LanguageServiceHost = {
  getScriptFileNames: () => projectFiles(),
  getScriptVersion: (fileName) => {
    try {
      const st = fs.lstatSync(fileName);
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return 'missing';
    }
  },
  getScriptSnapshot: (fileName) => {
    const version = host.getScriptVersion(fileName);
    const cached = snapshots.get(fileName);
    if (cached && cached.version === version) return cached.snapshot;
    const text = guardedReadFile(fileName);
    if (text === undefined) return undefined;
    const snapshot = ts.ScriptSnapshot.fromString(text);
    snapshots.set(fileName, { version, snapshot, text });
    if (snapshots.size > init.semanticFilesMax * 2) snapshots.clear();
    return snapshot;
  },
  getCurrentDirectory: () => init.root,
  getCompilationSettings: compilerOptions,
  getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
  fileExists: guardedFileExists,
  readFile: guardedReadFile,
  directoryExists: guardedDirExists,
  getDirectories: () => [],
  readDirectory: () => [],
  realpath: (p) => p, // never follow symlinks
  useCaseSensitiveFileNames: () => false,
};

const service = ts.createLanguageService(host, ts.createDocumentRegistry());

function absOfRel(relInput: string): string {
  const resolved = wfs.resolve(relInput);
  if (!resolved.stat?.isFile()) throw new WorkerError('NOT_FOUND', `file not found: ${resolved.rel}`);
  if (!SCRIPT_EXTS.has(path.posix.extname(resolved.rel))) {
    throw new WorkerError('UNSUPPORTED_LANGUAGE', 'semantic tools support TypeScript/JavaScript files only in v1');
  }
  return path.join(init.root, resolved.rel);
}

class WorkerError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function sourceFileOf(abs: string): ts.SourceFile {
  const program = service.getProgram();
  const sf = program?.getSourceFile(abs);
  if (!sf) throw new WorkerError('NOT_FOUND', 'file is not part of the analyzed project (limit reached or excluded)');
  return sf;
}

function toOffset(sf: ts.SourceFile, pos: Position): number {
  try {
    return sf.getPositionOfLineAndCharacter(pos.line - 1, pos.column - 1);
  } catch {
    throw new WorkerError('INVALID_INPUT', 'position out of range');
  }
}

function spanToPos(sf: ts.SourceFile, start: number, length: number): { line: number; column: number; endLine: number; endColumn: number } {
  const s = sf.getLineAndCharacterOfPosition(start);
  const e = sf.getLineAndCharacterOfPosition(start + length);
  return { line: s.line + 1, column: s.character + 1, endLine: e.line + 1, endColumn: e.character + 1 };
}

function lineTextAt(sf: ts.SourceFile, offset: number): string {
  const { line } = sf.getLineAndCharacterOfPosition(offset);
  const starts = sf.getLineStarts();
  const from = starts[line] as number;
  const to = line + 1 < starts.length ? (starts[line + 1] as number) - 1 : sf.text.length;
  const text = sf.text.slice(from, to).replace(/\r$/, '');
  return text.length > 300 ? text.slice(0, 300) : text;
}

function relFromAbs(abs: string): string {
  return relOf(abs) ?? abs;
}

function meta(): WorkerMeta {
  const m: WorkerMeta = {
    projectFiles: projectFiles().length,
    degraded,
    programVersion: sha256Bytes(projectFiles().join('\n')).slice(0, 23),
  };
  if (degradedReason !== undefined) m.degradedReason = degradedReason;
  return m;
}

function flattenNavTree(tree: ts.NavigationTree, sf: ts.SourceFile, out: SymbolInfo[], container: string | undefined, maxItems: number): void {
  if (out.length >= maxItems) return;
  const span = tree.spans[0];
  if (span && tree.text !== '<global>') {
    const pos = spanToPos(sf, span.start, span.length);
    const info: SymbolInfo = { name: tree.text, kind: tree.kind, path: relFromAbs(sf.fileName), ...pos };
    if (container !== undefined) info.containerName = container;
    out.push(info);
  }
  for (const child of tree.childItems ?? []) {
    flattenNavTree(child, sf, out, tree.text === '<global>' ? undefined : tree.text, maxItems);
    if (out.length >= maxItems) return;
  }
}

function handle(req: WorkerRequest): { data: unknown } {
  switch (req.op) {
    case 'assist_context':
    case 'assist_impact':
    case 'assist_symbol':
    case 'assist_refactor':
      return { data: runAnalysis({ wfs, maxFiles: init.semanticFilesMax, maxFileBytes: init.maxSnapshotBytes, compilerOptions: compilerOptions() }, req) };
    case 'symbols_file': {
      const abs = absOfRel(req.file);
      const sf = sourceFileOf(abs);
      const tree = service.getNavigationTree(abs);
      const out: SymbolInfo[] = [];
      flattenNavTree(tree, sf, out, undefined, req.maxItems);
      return { data: { symbols: out } };
    }
    case 'symbols_query': {
      const items = service.getNavigateToItems(req.query, req.maxItems * 2);
      const out: SymbolInfo[] = [];
      for (const item of items) {
        const rel = relOf(item.fileName);
        if (rel === undefined) continue; // never leak lib/dependency paths outside root
        const sf = sourceFileOf(item.fileName);
        const pos = spanToPos(sf, item.textSpan.start, item.textSpan.length);
        const info: SymbolInfo = { name: item.name, kind: item.kind, path: rel, ...pos };
        if (item.containerName) info.containerName = item.containerName;
        out.push(info);
        if (out.length >= req.maxItems) break;
      }
      return { data: { symbols: out } };
    }
    case 'references': {
      const abs = absOfRel(req.file);
      const sf = sourceFileOf(abs);
      const offset = toOffset(sf, req.position);
      const symbols = service.findReferences(abs, offset) ?? [];
      const refs = symbols.flatMap((s) => s.references);
      const out: ReferenceInfo[] = [];
      let outOfScope = 0;
      for (const ref of refs) {
        const rel = relOf(ref.fileName);
        if (rel === undefined) {
          outOfScope += 1;
          continue;
        }
        const rsf = sourceFileOf(ref.fileName);
        const pos = spanToPos(rsf, ref.textSpan.start, ref.textSpan.length);
        out.push({
          path: rel,
          ...pos,
          lineText: lineTextAt(rsf, ref.textSpan.start),
          isDefinition: ref.isDefinition ?? false,
          isWriteAccess: ref.isWriteAccess ?? false,
        });
        if (out.length >= req.maxItems) break;
      }
      return { data: { references: out, outOfScopeCount: outOfScope } };
    }
    case 'rename': {
      const abs = absOfRel(req.file);
      const sf = sourceFileOf(abs);
      const offset = toOffset(sf, req.position);
      const rename = service.getRenameInfo(abs, offset, { allowRenameOfImportPath: false });
      if (!rename.canRename) {
        throw new WorkerError('INVALID_INPUT', `cannot rename here: ${rename.localizedErrorMessage ?? 'not a renameable symbol'}`);
      }
      const locations = service.findRenameLocations(abs, offset, false, false, { providePrefixAndSuffixTextForRename: false }) ?? [];
      const byFile = new Map<string, RenameResultData['locations'][number]>();
      let outOfScopeCount = 0;
      const outOfScopeSample: string[] = [];
      for (const loc of locations) {
        const rel = relOf(loc.fileName);
        if (rel === undefined || rel.startsWith('node_modules/') || rel.includes('/node_modules/')) {
          outOfScopeCount += 1;
          if (outOfScopeSample.length < 5) outOfScopeSample.push(rel ?? 'outside-workspace');
          continue;
        }
        const lsf = sourceFileOf(loc.fileName);
        const entry = byFile.get(rel) ?? { path: rel, edits: [] };
        // UTF-16 char offsets → byte offsets in the file's UTF-8 bytes.
        const startByte = Buffer.byteLength(lsf.text.slice(0, loc.textSpan.start), 'utf8');
        const endByte = startByte + Buffer.byteLength(lsf.text.slice(loc.textSpan.start, loc.textSpan.start + loc.textSpan.length), 'utf8');
        entry.edits.push({
          start: startByte,
          end: endByte,
          newText: (loc.prefixText ?? '') + req.newName + (loc.suffixText ?? ''),
          originalText: lsf.text.slice(loc.textSpan.start, loc.textSpan.start + loc.textSpan.length),
        });
        byFile.set(rel, entry);
      }
      const data: RenameResultData = {
        locations: [...byFile.values()].map((f) => ({ ...f, edits: f.edits.sort((a, b) => a.start - b.start) })),
        outOfScopeCount,
        outOfScopeSample,
        symbolName: rename.displayName,
      };
      return { data };
    }
    case 'diagnostics': {
      const targets = req.files === null ? projectFiles().slice(0, 50) : req.files.map((f) => absOfRel(f));
      const out: DiagnosticInfo[] = [];
      for (const abs of targets) {
        let sf: ts.SourceFile;
        try {
          sf = sourceFileOf(abs);
        } catch {
          continue;
        }
        const diags = [...service.getSyntacticDiagnostics(abs), ...service.getSemanticDiagnostics(abs)];
        for (const d of diags) {
          if (out.length >= req.maxItems) break;
          const start = d.start ?? 0;
          const pos = spanToPos(sf, start, 0);
          out.push({
            path: relFromAbs(abs),
            line: pos.line,
            column: pos.column,
            category:
              d.category === ts.DiagnosticCategory.Error
                ? 'error'
                : d.category === ts.DiagnosticCategory.Warning
                  ? 'warning'
                  : d.category === ts.DiagnosticCategory.Suggestion
                    ? 'suggestion'
                    : 'message',
            code: d.code,
            message: ts.flattenDiagnosticMessageText(d.messageText, ' ').slice(0, 500),
          });
        }
        if (out.length >= req.maxItems) break;
      }
      return { data: { diagnostics: out } };
    }
  }
}

parentPort?.on('message', (req: WorkerRequest) => {
  let res: WorkerResponse;
  try {
    const { data } = handle(req);
    res = { id: req.id, ok: true, data, meta: meta() };
  } catch (err) {
    if (err instanceof WorkerError || err instanceof DodoError) {
      res = { id: req.id, ok: false, error: { code: err.code, message: err.message } };
    } else {
      res = { id: req.id, ok: false, error: { code: 'INTERNAL_ERROR', message: 'language service failed' } };
    }
  }
  parentPort?.postMessage(res);
});
