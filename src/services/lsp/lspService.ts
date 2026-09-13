import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DodoError } from '../../errors.js';
import type { Limits } from '../../config/limits.js';
import type { WorkspaceFS } from '../../workspace/fs.js';
import { buildChildEnv } from '../../security/env.js';
import type { DiagnosticInfo, Position, ReferenceInfo, RenameResultData, SymbolInfo } from '../intelligence/protocol.js';
import { JsonRpcStdioClient, RpcResponseError } from './jsonrpc.js';
import { resolveTrustedExecutable } from '../../platform/execResolve.js';
import { isWithinPath } from '../../platform/pathPolicy.js';

/**
 * Generic Language Server Protocol adapter: talks to OWNER-INSTALLED language
 * servers (pyright, gopls, rust-analyzer, ...) over stdio so the semantic
 * tools work beyond TypeScript.
 *
 * Trust boundary (mirrors the rest of DODO):
 * - servers come only from the owner's registry; a bare command resolves on
 *   the trusted PATH (never inside the workspace), an absolute command must
 *   live outside the workspace root - a repository can never supply the
 *   executable;
 * - the child env is `buildChildEnv` (whitelist + trusted PATH), cwd = root;
 * - every file the server is told about is read through WorkspaceFS; every
 *   URI the server returns is mapped back through the root and anything
 *   outside (stdlib, site-packages, other checkouts) is counted as
 *   out-of-scope and never disclosed.
 *
 * Lifecycle: one process per language, started lazily, reused, shut down
 * after 10 idle minutes, restarted after a crash; a hung request (TIMEOUT)
 * kills the server exactly like the TypeScript worker policy.
 */

export interface LspServerConfig {
  command: string;
  args: string[];
  /** File extensions handled by this server, e.g. ['.py', '.pyi']. */
  extensions: string[];
}

export interface LspMeta {
  language: string;
  server: string;
  degraded: boolean;
  degradedReason?: string;
}

export interface LspServiceOptions {
  wfs: WorkspaceFS;
  limits: Limits;
  registry: Record<string, LspServerConfig>;
  log?: (line: string) => void;
  /** How long to wait for pushed diagnostics after opening a file (default 3000 ms). */
  diagnosticsWaitMs?: number;
}

// ---------------------------------------------------------------------------
// LSP wire shapes (only what we consume) + defensive guards. Results come
// from a separate process; we never trust their shape blindly.
// ---------------------------------------------------------------------------

interface LspPosition {
  line: number;
  character: number;
}
interface LspRange {
  start: LspPosition;
  end: LspPosition;
}
interface LspLocation {
  uri: string;
  range: LspRange;
}
interface LspTextEdit {
  range: LspRange;
  newText: string;
}
interface LspDiagnostic {
  range: LspRange;
  message: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isUint(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}
function isLspPosition(v: unknown): v is LspPosition {
  return isRecord(v) && isUint(v['line']) && isUint(v['character']);
}
function isLspRange(v: unknown): v is LspRange {
  return isRecord(v) && isLspPosition(v['start']) && isLspPosition(v['end']);
}
function isLspLocation(v: unknown): v is LspLocation {
  return isRecord(v) && typeof v['uri'] === 'string' && isLspRange(v['range']);
}
function isLspTextEdit(v: unknown): v is LspTextEdit {
  return isRecord(v) && isLspRange(v['range']) && typeof v['newText'] === 'string';
}
function isLspDiagnostic(v: unknown): v is LspDiagnostic {
  return isRecord(v) && isLspRange(v['range']) && typeof v['message'] === 'string';
}

const SYMBOL_KIND_NAMES: readonly string[] = [
  'unknown',
  'file',
  'module',
  'namespace',
  'package',
  'class',
  'method',
  'property',
  'field',
  'constructor',
  'enum',
  'interface',
  'function',
  'variable',
  'constant',
  'string',
  'number',
  'boolean',
  'array',
  'object',
  'key',
  'null',
  'enum member',
  'struct',
  'event',
  'operator',
  'type parameter',
];

function symbolKindName(kind: unknown): string {
  return (isUint(kind) ? SYMBOL_KIND_NAMES[kind] : undefined) ?? 'unknown';
}

const ALL_SYMBOL_KINDS = Array.from({ length: 26 }, (_, i) => i + 1);

const CLIENT_CAPABILITIES = {
  textDocument: {
    synchronization: { dynamicRegistration: false, willSave: false, willSaveWaitUntil: false, didSave: false },
    documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true, symbolKind: { valueSet: ALL_SYMBOL_KINDS } },
    references: { dynamicRegistration: false },
    definition: { dynamicRegistration: false, linkSupport: false },
    rename: { dynamicRegistration: false, prepareSupport: true },
    publishDiagnostics: { relatedInformation: false, versionSupport: true, codeDescriptionSupport: false, dataSupport: false },
    diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
  },
  workspace: {
    symbol: { dynamicRegistration: false, symbolKind: { valueSet: ALL_SYMBOL_KINDS } },
    workspaceFolders: true,
    configuration: true,
    applyEdit: false,
    workspaceEdit: { documentChanges: true, resourceOperations: [] as string[], failureHandling: 'abort' },
  },
  general: { positionEncodings: ['utf-16'] },
  // Progress lets us see indexing/analysis work ($/progress begin..end) and
  // wait for it instead of answering from a half-built program.
  window: { workDoneProgress: true },
};

// ---------------------------------------------------------------------------
// Text model: LSP (0-based line, UTF-16 character) <-> char offsets <-> UTF-8 bytes.
// ---------------------------------------------------------------------------

const MAX_LINE_TEXT = 300;

class TextDoc {
  private readonly lineStarts: number[] = [0];
  private readonly lineEnds: number[] = [];

  constructor(readonly text: string) {
    for (let i = 0; i < text.length; i += 1) {
      const c = text.charCodeAt(i);
      if (c === 10) {
        this.lineEnds.push(i);
        this.lineStarts.push(i + 1);
      } else if (c === 13) {
        this.lineEnds.push(i);
        if (text.charCodeAt(i + 1) === 10) i += 1;
        this.lineStarts.push(i + 1);
      }
    }
    this.lineEnds.push(text.length);
  }

  get lineCount(): number {
    return this.lineStarts.length;
  }

  lineLength(line0: number): number {
    return (this.lineEnds[line0] ?? 0) - (this.lineStarts[line0] ?? 0);
  }

  lineText(line0: number): string {
    if (line0 < 0 || line0 >= this.lineCount) return '';
    const t = this.text.slice(this.lineStarts[line0] as number, this.lineEnds[line0] as number);
    return t.length > MAX_LINE_TEXT ? t.slice(0, MAX_LINE_TEXT) : t;
  }

  /** Server-supplied position -> char offset, clamped to the document (LSP semantics). */
  clampOffset(pos: LspPosition): number {
    if (pos.line >= this.lineCount) return this.text.length;
    const start = this.lineStarts[pos.line] as number;
    return Math.min(start + pos.character, this.lineEnds[pos.line] as number);
  }

  /** Char offset -> UTF-16 LSP position. */
  positionAt(offset: number): LspPosition {
    const off = Math.max(0, Math.min(offset, this.text.length));
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((this.lineStarts[mid] as number) <= off) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo, character: off - (this.lineStarts[lo] as number) };
  }

  /** Identifier-ish word containing the offset (used only as a display fallback). */
  wordAt(offset: number): string | undefined {
    const { line } = this.positionAt(offset);
    const lineStart = this.lineStarts[line] as number;
    const text = this.lineText(line);
    const re = /[\p{L}\p{N}_$]+/gu;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const s = lineStart + m.index;
      const e = s + m[0].length;
      if (offset >= s && offset <= e) return m[0];
      if (s > offset) break;
    }
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

interface OpenDoc {
  rel: string;
  uri: string;
  doc: TextDoc;
}

interface OpenState {
  version: number;
}

interface DiagWaiter {
  version: number;
  resolve: () => void;
}

interface ServerEntry {
  language: string;
  command: string;
  client: JsonRpcStdioClient;
  ready: Promise<void>;
  capabilities: Record<string, unknown>;
  serverName: string;
  /** Documents currently open on the server (LRU order), bounded. */
  open: Map<string, OpenState>;
  /** Last pushed diagnostics per URI, bounded. */
  diagnostics: Map<string, unknown[]>;
  diagWaiters: Map<string, DiagWaiter[]>;
  /** `$/progress` tokens that have begun and not ended (indexing, analysis, ...). */
  activeProgress: Set<string | number>;
  /** Serializes requests per server so open/change/close never interleave. */
  queue: Promise<void>;
  idleTimer: NodeJS.Timeout | undefined;
}

const EXCLUDED_DIR_SEGMENTS = new Set(['node_modules', '.venv', 'site-packages', 'target', 'vendor']);
const IDLE_SHUTDOWN_MS = 10 * 60 * 1000;
const DEFAULT_DIAGNOSTICS_WAIT_MS = 3000;
const SHUTDOWN_GRACE_MS = 2000;
/**
 * Startup gate. LSP has no "workspace indexed" signal; servers (pyright
 * included) enumerate workspace files asynchronously AFTER `initialize`
 * completes, so an immediate references/rename would silently miss files in
 * other modules. We wait until the server has no active progress and has
 * been quiet for STARTUP_QUIET_MS, bounded by STARTUP_SETTLE_MAX_MS. The
 * minimum observation window matters because some servers acknowledge
 * `initialize` before they emit their first indexing progress notification.
 */
const STARTUP_QUIET_MS = 400;
const STARTUP_MIN_OBSERVE_MS = 2000;
const STARTUP_SETTLE_MAX_MS = 5000;
/** Per request: bounded wait for reported background work to finish before asking. */
const PRE_REQUEST_IDLE_MAX_MS = 2000;
const MAX_TRACKED_PROGRESS = 64;
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
const MAX_OPEN_DOCS = 32;
const MAX_DIAGNOSTIC_FILES = 50;
const MAX_STORED_DIAGNOSTIC_URIS = 256;
const MAX_EDITS_PER_FILE = 5000;
const MAX_QUERY_LENGTH = 256;
const MAX_SERVER_MESSAGE = 300;
const IDENTIFIER_RE = /^[\p{L}_$][\p{L}\p{N}_$]{0,127}$/u;

export class LspService {
  private readonly wfs: WorkspaceFS;
  private readonly limits: Limits;
  private readonly registry: Record<string, LspServerConfig>;
  private readonly log: (line: string) => void;
  private readonly diagnosticsWaitMs: number;
  private readonly extToLanguage = new Map<string, string>();
  private readonly servers = new Map<string, ServerEntry>();
  private closed = false;

  constructor(opts: LspServiceOptions) {
    this.wfs = opts.wfs;
    this.limits = opts.limits;
    this.registry = {};
    this.log = opts.log ?? (() => {});
    this.diagnosticsWaitMs = opts.diagnosticsWaitMs ?? DEFAULT_DIAGNOSTICS_WAIT_MS;
    for (const [language, config] of Object.entries(opts.registry)) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_+.-]{0,63}$/.test(language)) continue;
      if (!isRecord(config) || typeof config['command'] !== 'string' || !Array.isArray(config['args']) || !Array.isArray(config['extensions'])) continue;
      const extensions: string[] = [];
      for (const ext of config['extensions']) {
        if (typeof ext !== 'string' || ext.length === 0 || ext.includes('/')) continue;
        const norm = (ext.startsWith('.') ? ext : `.${ext}`).toLowerCase();
        extensions.push(norm);
        if (!this.extToLanguage.has(norm)) this.extToLanguage.set(norm, language);
      }
      this.registry[language] = { command: config['command'], args: config['args'].filter((a): a is string => typeof a === 'string'), extensions };
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  languageFor(rel: string): string | undefined {
    if (typeof rel !== 'string') return undefined;
    const ext = path.posix.extname(rel).toLowerCase();
    if (ext === '') return undefined;
    return this.extToLanguage.get(ext);
  }

  available(language: string): { ok: boolean; reason?: string } {
    const config = this.registry[language];
    if (!config) return { ok: false, reason: `no language server registered for "${language}"` };
    const resolved = this.resolveCommand(config);
    return resolved.ok ? { ok: true } : { ok: false, reason: resolved.reason };
  }

  async symbolsInFile(rel: string, maxItems: number): Promise<{ symbols: SymbolInfo[]; meta: LspMeta }> {
    const max = boundedMax(maxItems);
    const language = this.requireLanguage(rel);
    return this.withServer(language, async (entry) => {
      this.requireCapability(entry, 'documentSymbolProvider', 'textDocument/documentSymbol');
      const doc = this.readDoc(rel);
      this.openDoc(entry, doc);
      const result = await this.req(entry, 'textDocument/documentSymbol', { textDocument: { uri: doc.uri } });
      const symbols: SymbolInfo[] = [];
      if (Array.isArray(result)) this.flattenSymbols(result, doc.rel, undefined, symbols, max, 0);
      return { symbols, meta: this.meta(entry) };
    });
  }

  async symbolsQuery(language: string, query: string, maxItems: number): Promise<{ symbols: SymbolInfo[]; meta: LspMeta }> {
    const max = boundedMax(maxItems);
    if (typeof query !== 'string' || query.length > MAX_QUERY_LENGTH) {
      throw new DodoError('INVALID_INPUT', `query must be a string of at most ${MAX_QUERY_LENGTH} characters`);
    }
    if (!this.registry[language]) throw this.unsupported(language);
    return this.withServer(language, async (entry) => {
      this.requireCapability(entry, 'workspaceSymbolProvider', 'workspace/symbol');
      const result = await this.req(entry, 'workspace/symbol', { query });
      const symbols: SymbolInfo[] = [];
      if (Array.isArray(result)) this.flattenSymbols(result, undefined, undefined, symbols, max, 0);
      return { symbols, meta: this.meta(entry) };
    });
  }

  async references(rel: string, position: Position, maxItems: number): Promise<{ references: ReferenceInfo[]; outOfScopeCount: number; meta: LspMeta }> {
    const max = boundedMax(maxItems);
    const language = this.requireLanguage(rel);
    return this.withServer(language, async (entry) => {
      this.requireCapability(entry, 'referencesProvider', 'textDocument/references');
      const doc = this.readDoc(rel);
      const lspPos = toLspPosition(doc.doc, position);
      this.openDoc(entry, doc);
      const result = await this.req(entry, 'textDocument/references', {
        textDocument: { uri: doc.uri },
        position: lspPos,
        context: { includeDeclaration: true },
      });
      const definitionKeys = await this.definitionKeys(entry, doc.uri, lspPos);
      const docs = new Map<string, TextDoc>([[doc.rel, doc.doc]]);
      const references: ReferenceInfo[] = [];
      let outOfScopeCount = 0;
      for (const item of Array.isArray(result) ? result : []) {
        if (!isLspLocation(item)) continue;
        const target = this.uriToRel(item.uri);
        const text = target === undefined ? undefined : this.textOf(target, docs);
        if (target === undefined || text === undefined) {
          outOfScopeCount += 1;
          continue;
        }
        const isDefinition = definitionKeys.has(locationKey(item.uri, item.range.start));
        references.push({
          path: target,
          line: item.range.start.line + 1,
          column: item.range.start.character + 1,
          endLine: item.range.end.line + 1,
          endColumn: item.range.end.character + 1,
          lineText: text.lineText(item.range.start.line),
          isDefinition,
          isWriteAccess: isDefinition, // LSP exposes no read/write classification
        });
        if (references.length >= max) break;
      }
      return { references, outOfScopeCount, meta: this.meta(entry) };
    });
  }

  async rename(rel: string, position: Position, newName: string): Promise<{ result: RenameResultData; meta: LspMeta }> {
    if (typeof newName !== 'string' || !IDENTIFIER_RE.test(newName)) throw new DodoError('INVALID_INPUT', 'newName is not a valid identifier');
    const language = this.requireLanguage(rel);
    return this.withServer(language, async (entry) => {
      const renameCap = entry.capabilities['renameProvider'];
      this.requireCapability(entry, 'renameProvider', 'textDocument/rename');
      const doc = this.readDoc(rel);
      const lspPos = toLspPosition(doc.doc, position);
      this.openDoc(entry, doc);

      let placeholder: string | undefined;
      if (isRecord(renameCap) && renameCap['prepareProvider'] === true) {
        const prep = await this.req(entry, 'textDocument/prepareRename', { textDocument: { uri: doc.uri }, position: lspPos });
        if (prep === null || prep === undefined) throw new DodoError('INVALID_INPUT', 'cannot rename here: not a renameable symbol');
        if (isRecord(prep) && typeof prep['placeholder'] === 'string') placeholder = prep['placeholder'];
        else if (isLspRange(prep)) placeholder = doc.doc.text.slice(doc.doc.clampOffset(prep.start), doc.doc.clampOffset(prep.end));
      }

      const edit = await this.req(entry, 'textDocument/rename', { textDocument: { uri: doc.uri }, position: lspPos, newName });
      if (edit === null || edit === undefined) throw new DodoError('INVALID_INPUT', 'cannot rename here: the language server produced no edits');
      if (!isRecord(edit)) throw new DodoError('INTERNAL_ERROR', 'language server returned a malformed WorkspaceEdit');

      const byUri = collectWorkspaceEdit(edit);
      const docs = new Map<string, TextDoc>([[doc.rel, doc.doc]]);
      const locations: RenameResultData['locations'] = [];
      let outOfScopeCount = countResourceOperations(edit);
      const outOfScopeSample: string[] = [];
      let symbolName = placeholder;
      const cursor = doc.doc.clampOffset(lspPos);

      for (const [uri, edits] of byUri) {
        const target = this.uriToRel(uri);
        const text = target === undefined ? undefined : this.textOf(target, docs);
        if (target === undefined || text === undefined) {
          outOfScopeCount += edits.length;
          if (outOfScopeSample.length < 5) outOfScopeSample.push(target ?? 'outside-workspace');
          continue;
        }
        const converted = toByteEdits(text, edits.slice(0, MAX_EDITS_PER_FILE));
        if (target === doc.rel && symbolName === undefined) {
          const hit = converted.find((e) => e.startChar <= cursor && cursor <= e.endChar);
          if (hit) symbolName = hit.originalText;
        }
        locations.push({ path: target, edits: converted.map(({ start, end, newText, originalText }) => ({ start, end, newText, originalText })) });
      }
      locations.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      const result: RenameResultData = {
        locations,
        outOfScopeCount,
        outOfScopeSample,
        symbolName: symbolName ?? doc.doc.wordAt(cursor) ?? '',
      };
      return { result, meta: this.meta(entry) };
    });
  }

  async diagnostics(rels: string[], maxItems: number): Promise<{ diagnostics: DiagnosticInfo[]; meta: LspMeta }> {
    const max = boundedMax(maxItems);
    if (!Array.isArray(rels) || rels.length === 0) throw new DodoError('INVALID_INPUT', 'at least one file is required');
    const degraded: string[] = [];
    const targets = rels.slice(0, MAX_DIAGNOSTIC_FILES);
    if (rels.length > MAX_DIAGNOSTIC_FILES) degraded.push(`diagnostics limited to the first ${MAX_DIAGNOSTIC_FILES} files`);
    const groups = new Map<string, string[]>();
    for (const rel of targets) {
      const language = this.requireLanguage(rel);
      const list = groups.get(language) ?? [];
      list.push(rel);
      groups.set(language, list);
    }
    const out: DiagnosticInfo[] = [];
    let meta: LspMeta | undefined;
    for (const [language, files] of groups) {
      if (out.length >= max) break;
      const partial = await this.withServer(language, async (entry) => {
        const collected: DiagnosticInfo[] = [];
        const supportsPull = Boolean(entry.capabilities['diagnosticProvider']);
        for (const rel of files) {
          if (collected.length + out.length >= max) break;
          const doc = this.readDoc(rel);
          let items: unknown[];
          if (supportsPull) {
            this.openDoc(entry, doc);
            const report = await this.req(entry, 'textDocument/diagnostic', { textDocument: { uri: doc.uri } });
            if (isRecord(report) && report['kind'] === 'full' && Array.isArray(report['items'])) items = report['items'];
            else if (isRecord(report) && report['kind'] === 'unchanged') items = entry.diagnostics.get(doc.uri) ?? [];
            else {
              items = [];
              degraded.push(`${doc.rel}: language server returned no diagnostic report`);
            }
          } else {
            let arrived: Promise<boolean> = Promise.resolve(false);
            this.openDoc(entry, doc, (version) => {
              arrived = this.waitForDiagnostics(entry, doc.uri, version);
            });
            if (!(await arrived)) degraded.push(`${doc.rel}: no diagnostics published within ${this.diagnosticsWaitMs} ms`);
            items = entry.diagnostics.get(doc.uri) ?? [];
          }
          for (const item of items) {
            if (collected.length + out.length >= max) break;
            if (!isLspDiagnostic(item)) continue;
            collected.push(toDiagnosticInfo(doc.rel, item));
          }
        }
        return { collected, meta: this.meta(entry) };
      });
      out.push(...partial.collected);
      meta ??= partial.meta;
    }
    const finalMeta: LspMeta = meta ?? { language: [...groups.keys()].join(','), server: '', degraded: false };
    if (groups.size > 1) finalMeta.language = [...groups.keys()].join(',');
    if (degraded.length > 0) {
      finalMeta.degraded = true;
      finalMeta.degradedReason = degraded.join('; ').slice(0, 500);
    }
    return { diagnostics: out, meta: finalMeta };
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    const entries = [...this.servers.values()];
    this.servers.clear();
    await Promise.all(
      entries.map(async (entry) => {
        if (entry.idleTimer) clearTimeout(entry.idleTimer);
        await entry.client.shutdown(SHUTDOWN_GRACE_MS);
      }),
    );
  }

  // ---------------------------------------------------------------------------
  // Server lifecycle
  // ---------------------------------------------------------------------------

  private requireLanguage(rel: string): string {
    const normalized = this.wfs.normalizeRel(rel);
    const language = this.languageFor(normalized);
    if (language === undefined) {
      const ext = path.posix.extname(normalized) || '(none)';
      throw new DodoError('UNSUPPORTED_LANGUAGE', `no language server is registered for files with extension ${ext}`, {
        recovery: 'register a language server for this extension in the owner config (lsp section)',
      });
    }
    return language;
  }

  private unsupported(language: string, reason?: string): DodoError {
    return new DodoError('UNSUPPORTED_LANGUAGE', reason ?? `no language server registered for "${language}"`, {
      recovery: 'install the language server and register its command in the owner config (lsp section)',
    });
  }

  private resolveCommand(config: LspServerConfig): { ok: true; abs: string } | { ok: false; reason: string } {
    // Preserve the specific denial used by clients, before the shared resolver
    // performs its additional canonical/symlink/PATHEXT checks.
    if (path.isAbsolute(config.command) && this.insideRoot(config.command)) {
      return { ok: false, reason: 'LSP executable is inside the workspace root; install the server outside the workspace' };
    }
    try {
      const abs = resolveTrustedExecutable(config.command, this.wfs.root, { allowAbsolute: true, allowBatch: false });
      if (process.platform === 'win32' && !/\.exe$/i.test(abs)) throw new Error('Windows LSP requires an .exe, never a .cmd/.bat shim');
      return { ok: true, abs };
    } catch (error) {
      return { ok: false, reason: `${error instanceof Error ? error.message : 'unavailable'}; install the server outside the workspace; for Windows npm shims register node.exe with the server JavaScript entrypoint in args` };
    }
  }

  private insideRoot(abs: string): boolean {
    return isWithinPath(this.wfs.root, abs);
  }

  private async ensureServer(language: string): Promise<ServerEntry> {
    if (this.closed) throw new DodoError('INTERNAL_ERROR', 'LSP service is shut down');
    const existing = this.servers.get(language);
    if (existing) {
      if (existing.client.alive) {
        await existing.ready;
        return existing;
      }
      this.dropServer(existing, existing.client.exit?.reason ?? 'exited');
    }
    const config = this.registry[language];
    if (!config) throw this.unsupported(language);
    const resolved = this.resolveCommand(config);
    if (!resolved.ok) throw this.unsupported(language, `language server for ${language} is unavailable: ${resolved.reason}`);

    let client: JsonRpcStdioClient;
    try {
      client = new JsonRpcStdioClient({
        command: resolved.abs,
        args: config.args,
        cwd: this.wfs.root,
        env: buildChildEnv({ parentEnv: process.env, workspaceRoot: this.wfs.root, extraAllowlist: [] }),
        maxMessageBytes: MAX_MESSAGE_BYTES,
        log: (line) => this.log(`[lsp:${language}] ${line}`),
      });
    } catch (err) {
      throw this.unsupported(language, `cannot start language server "${config.command}": ${(err as Error).message}`);
    }
    const entry: ServerEntry = {
      language,
      command: config.command,
      client,
      ready: Promise.resolve(),
      capabilities: {},
      serverName: path.basename(config.command),
      open: new Map(),
      diagnostics: new Map(),
      diagWaiters: new Map(),
      activeProgress: new Set(),
      queue: Promise.resolve(),
      idleTimer: undefined,
    };
    entry.ready = this.initialize(entry);
    this.servers.set(language, entry);
    client.onExit((info) => {
      if (this.servers.get(language) === entry) {
        this.log(`[lsp:${language}] server ${info.reason}; it will be restarted on the next request`);
        this.dropServer(entry, info.reason);
      }
    });
    try {
      await entry.ready;
    } catch (err) {
      this.dropServer(entry, 'initialize failed');
      throw err;
    }
    this.touch(entry);
    return entry;
  }

  private async initialize(entry: ServerEntry): Promise<void> {
    const { client, language, command } = entry;
    try {
      await client.waitForSpawn();
    } catch (err) {
      throw this.unsupported(language, `cannot start language server "${command}": ${(err as Error).message}`);
    }
    const rootUri = pathToFileURL(this.wfs.root).href;
    const folders = [{ uri: rootUri, name: path.basename(this.wfs.root) || 'workspace' }];

    client.onNotification('textDocument/publishDiagnostics', (params) => this.onPublishDiagnostics(entry, params));
    client.onNotification('window/logMessage', (params) => {
      if (isRecord(params) && typeof params['message'] === 'string') this.log(`[lsp:${language}] ${params['message'].slice(0, 300)}`);
    });
    client.onNotification('$/progress', (params) => {
      if (!isRecord(params) || !isRecord(params['value'])) return;
      const token = params['token'];
      if (typeof token !== 'string' && typeof token !== 'number') return;
      const kind = params['value']['kind'];
      if (kind === 'begin' && entry.activeProgress.size < MAX_TRACKED_PROGRESS) entry.activeProgress.add(token);
      else if (kind === 'end') entry.activeProgress.delete(token);
    });
    client.onRequest('workspace/configuration', (params) => {
      const items = isRecord(params) && Array.isArray(params['items']) ? params['items'] : [];
      return items.map(() => null);
    });
    client.onRequest('workspace/workspaceFolders', () => folders);
    client.onRequest('workspace/applyEdit', () => ({ applied: false, failureReason: 'DODO never applies server-initiated edits' }));
    client.onRequest('window/showDocument', () => ({ success: false }));
    for (const method of [
      'client/registerCapability',
      'client/unregisterCapability',
      'window/workDoneProgress/create',
      'window/showMessageRequest',
      'workspace/diagnostic/refresh',
      'workspace/semanticTokens/refresh',
      'workspace/inlayHint/refresh',
      'workspace/inlineValue/refresh',
      'workspace/codeLens/refresh',
      'workspace/foldingRange/refresh',
    ]) {
      client.onRequest(method, () => null);
    }

    let result: unknown;
    try {
      result = await client.request(
        'initialize',
        {
          processId: process.pid,
          clientInfo: { name: 'dodo' },
          locale: 'en',
          rootUri,
          rootPath: this.wfs.root,
          workspaceFolders: folders,
          capabilities: CLIENT_CAPABILITIES,
          initializationOptions: {},
          trace: 'off',
        },
        this.limits.semanticRequestTimeoutMs,
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'unknown error';
      const stderr = client.stderrSnippet;
      throw this.unsupported(language, `language server "${command}" failed to initialize: ${detail}${stderr ? ` (stderr: ${stderr.slice(-200)})` : ''}`);
    }
    if (isRecord(result) && isRecord(result['capabilities'])) entry.capabilities = result['capabilities'];
    if (isRecord(result) && isRecord(result['serverInfo']) && typeof result['serverInfo']['name'] === 'string') {
      const version = typeof result['serverInfo']['version'] === 'string' ? ` ${result['serverInfo']['version'].slice(0, 32)}` : '';
      entry.serverName = `${result['serverInfo']['name'].slice(0, 64)}${version}`;
    }
    client.notify('initialized', {});
    this.log(`[lsp:${language}] started ${entry.serverName} (pid ${client.pid ?? '?'})`);
    const settleMax = Math.min(STARTUP_SETTLE_MAX_MS, this.limits.semanticRequestTimeoutMs);
    const settled = await this.awaitIdle(entry, settleMax, STARTUP_QUIET_MS, Math.min(STARTUP_MIN_OBSERVE_MS, settleMax));
    if (!settled) this.log(`[lsp:${language}] server still busy ${STARTUP_SETTLE_MAX_MS} ms after start; continuing (results may be incomplete until it settles)`);
  }

  /**
   * Resolve true once the server has no active progress work and (when
   * quietMs > 0) no inbound traffic for quietMs; false when maxMs elapses.
   */
  private awaitIdle(entry: ServerEntry, maxMs: number, quietMs: number, minimumMs = 0): Promise<boolean> {
    const started = Date.now();
    return new Promise((resolve) => {
      const check = (): void => {
        if (!entry.client.alive) {
          resolve(true);
          return;
        }
        const now = Date.now();
        const quietFor = now - entry.client.lastInboundAt;
        if (entry.activeProgress.size === 0 && quietFor >= quietMs && now - started >= minimumMs) {
          resolve(true);
          return;
        }
        if (now - started >= maxMs) {
          resolve(false);
          return;
        }
        const delay = Math.max(25, Math.min(quietMs > 0 ? quietMs - quietFor : 100, maxMs - (now - started)));
        const timer = setTimeout(check, delay);
        timer.unref();
      };
      check();
    });
  }

  private dropServer(entry: ServerEntry, reason: string): void {
    if (this.servers.get(entry.language) === entry) this.servers.delete(entry.language);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
    for (const waiters of entry.diagWaiters.values()) for (const w of waiters) w.resolve();
    entry.diagWaiters.clear();
    if (entry.client.alive) {
      this.log(`[lsp:${entry.language}] stopping server (${reason})`);
      entry.client.kill();
    }
  }

  private touch(entry: ServerEntry): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      if (this.servers.get(entry.language) !== entry) return;
      this.servers.delete(entry.language);
      this.log(`[lsp:${entry.language}] idle for ${IDLE_SHUTDOWN_MS / 60000} minutes; shutting down`);
      void entry.client.shutdown(SHUTDOWN_GRACE_MS);
    }, IDLE_SHUTDOWN_MS);
    entry.idleTimer.unref();
  }

  /** Run one operation against a language's server, serialized per server. */
  private async withServer<T>(language: string, fn: (entry: ServerEntry) => Promise<T>): Promise<T> {
    const entry = await this.ensureServer(language);
    const run = entry.queue.then(async () => {
      // Give reported background work (indexing/analysis) a bounded chance to finish first.
      if (entry.activeProgress.size > 0) await this.awaitIdle(entry, PRE_REQUEST_IDLE_MAX_MS, 0);
      return fn(entry);
    });
    entry.queue = run.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await run;
    } catch (err) {
      if (err instanceof DodoError && err.code === 'TIMEOUT') this.dropServer(entry, 'request timed out');
      throw err;
    } finally {
      if (this.servers.get(language) === entry) this.touch(entry);
    }
  }

  private async req<T = unknown>(entry: ServerEntry, method: string, params: unknown): Promise<T> {
    try {
      return await entry.client.request<T>(method, params, this.limits.semanticRequestTimeoutMs);
    } catch (err) {
      if (err instanceof DodoError) throw err;
      if (err instanceof RpcResponseError) {
        const msg = err.message.slice(0, MAX_SERVER_MESSAGE);
        if (err.rpcCode === -32602) throw new DodoError('INVALID_INPUT', `language server rejected ${method}: ${msg}`);
        if (err.rpcCode === -32801 || err.rpcCode === -32800) {
          throw new DodoError('INTERNAL_ERROR', `language server could not complete ${method}: ${msg}`, { retryable: true });
        }
        throw new DodoError('INTERNAL_ERROR', `language server error on ${method}: ${msg}`);
      }
      throw new DodoError('INTERNAL_ERROR', `language server failure on ${method}`);
    }
  }

  private requireCapability(entry: ServerEntry, capability: string, method: string): void {
    const value = entry.capabilities[capability];
    if (value === undefined || value === null || value === false) {
      throw new DodoError('UNSUPPORTED_LANGUAGE', `language server ${entry.serverName} does not support ${method}`);
    }
  }

  private meta(entry: ServerEntry, degradedReason?: string): LspMeta {
    const reasons: string[] = [];
    if (degradedReason !== undefined) reasons.push(degradedReason);
    if (entry.activeProgress.size > 0) reasons.push('language server still reports background work (indexing/analysis); results may be incomplete');
    const m: LspMeta = { language: entry.language, server: entry.serverName, degraded: reasons.length > 0 };
    if (reasons.length > 0) m.degradedReason = reasons.join('; ');
    return m;
  }

  // ---------------------------------------------------------------------------
  // Documents
  // ---------------------------------------------------------------------------

  private readDoc(rel: string): OpenDoc {
    const { rel: normalized, text } = this.wfs.readTextFile(rel, this.limits.readFileBytes);
    return { rel: normalized, uri: pathToFileURL(this.wfs.absOf(normalized)).href, doc: new TextDoc(text) };
  }

  /**
   * Tell the server about the file's CURRENT content: didOpen the first time,
   * a full-content didChange afterwards (documents stay open, LRU-bounded).
   * `onVersion` runs before the notification is sent so callers can arm a
   * diagnostics waiter for exactly this version.
   */
  private openDoc(entry: ServerEntry, doc: OpenDoc, onVersion?: (version: number) => void): void {
    const existing = entry.open.get(doc.uri);
    if (existing) {
      const version = existing.version + 1;
      entry.open.delete(doc.uri);
      entry.open.set(doc.uri, { version });
      onVersion?.(version);
      entry.client.notify('textDocument/didChange', { textDocument: { uri: doc.uri, version }, contentChanges: [{ text: doc.doc.text }] });
      return;
    }
    while (entry.open.size >= MAX_OPEN_DOCS) {
      const oldest = entry.open.keys().next().value;
      if (oldest === undefined) break;
      entry.open.delete(oldest);
      entry.client.notify('textDocument/didClose', { textDocument: { uri: oldest } });
    }
    const version = 1;
    entry.open.set(doc.uri, { version });
    onVersion?.(version);
    entry.client.notify('textDocument/didOpen', { textDocument: { uri: doc.uri, languageId: entry.language, version, text: doc.doc.text } });
  }

  private onPublishDiagnostics(entry: ServerEntry, params: unknown): void {
    if (!isRecord(params) || typeof params['uri'] !== 'string' || !Array.isArray(params['diagnostics'])) return;
    const uri = params['uri'];
    entry.diagnostics.delete(uri);
    entry.diagnostics.set(uri, params['diagnostics']);
    while (entry.diagnostics.size > MAX_STORED_DIAGNOSTIC_URIS) {
      const oldest = entry.diagnostics.keys().next().value;
      if (oldest === undefined) break;
      entry.diagnostics.delete(oldest);
    }
    const version = typeof params['version'] === 'number' ? params['version'] : undefined;
    const waiters = entry.diagWaiters.get(uri);
    if (!waiters) return;
    const keep: DiagWaiter[] = [];
    for (const w of waiters) {
      if (version === undefined || version >= w.version) w.resolve();
      else keep.push(w);
    }
    if (keep.length > 0) entry.diagWaiters.set(uri, keep);
    else entry.diagWaiters.delete(uri);
  }

  private waitForDiagnostics(entry: ServerEntry, uri: string, version: number): Promise<boolean> {
    return new Promise((resolve) => {
      const waiter: DiagWaiter = { version, resolve: () => resolve(true) };
      const timer = setTimeout(() => {
        const list = entry.diagWaiters.get(uri);
        if (list) {
          const rest = list.filter((w) => w !== waiter);
          if (rest.length > 0) entry.diagWaiters.set(uri, rest);
          else entry.diagWaiters.delete(uri);
        }
        resolve(false);
      }, this.diagnosticsWaitMs);
      timer.unref();
      waiter.resolve = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const list = entry.diagWaiters.get(uri) ?? [];
      list.push(waiter);
      entry.diagWaiters.set(uri, list);
    });
  }

  // ---------------------------------------------------------------------------
  // Scope + mapping
  // ---------------------------------------------------------------------------

  /** Server URI -> workspace-relative POSIX path, or undefined when out of scope (never disclosed). */
  private uriToRel(uri: string): string | undefined {
    if (!uri.startsWith('file:')) return undefined;
    let abs: string;
    try {
      abs = fileURLToPath(uri);
    } catch {
      return undefined;
    }
    const rel = path.relative(this.wfs.root, abs);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
    const posix = rel.split(path.sep).join('/');
    let normalized: string;
    try {
      normalized = this.wfs.normalizeRel(posix);
    } catch {
      return undefined;
    }
    if (normalized === '.') return undefined;
    for (const segment of normalized.split('/')) if (EXCLUDED_DIR_SEGMENTS.has(segment)) return undefined;
    if (this.wfs.ignores.isSecret(normalized) || this.wfs.ignores.isProtected(normalized)) return undefined;
    return normalized;
  }

  /** Current text of an in-scope file (policy-checked read), cached per operation. */
  private textOf(rel: string, cache: Map<string, TextDoc>): TextDoc | undefined {
    const cached = cache.get(rel);
    if (cached) return cached;
    try {
      const doc = new TextDoc(this.wfs.readTextFile(rel, this.limits.readFileBytes).text);
      cache.set(rel, doc);
      return doc;
    } catch {
      return undefined;
    }
  }

  private async definitionKeys(entry: ServerEntry, uri: string, position: LspPosition): Promise<Set<string>> {
    const keys = new Set<string>();
    if (!entry.capabilities['definitionProvider']) return keys;
    try {
      const res = await this.req(entry, 'textDocument/definition', { textDocument: { uri }, position });
      const list: unknown[] = Array.isArray(res) ? res : res === null || res === undefined ? [] : [res];
      for (const item of list) {
        if (isLspLocation(item)) keys.add(locationKey(item.uri, item.range.start));
        else if (isRecord(item) && typeof item['targetUri'] === 'string' && isLspRange(item['targetSelectionRange'])) {
          keys.add(locationKey(item['targetUri'], item['targetSelectionRange'].start));
        }
      }
    } catch (err) {
      if (err instanceof DodoError && err.code === 'TIMEOUT') throw err;
      /* best effort: isDefinition stays false */
    }
    return keys;
  }

  /** Flattens DocumentSymbol[] (hierarchical) or SymbolInformation[]/WorkspaceSymbol[] (flat). */
  private flattenSymbols(items: unknown[], fileRel: string | undefined, container: string | undefined, out: SymbolInfo[], max: number, depth: number): void {
    for (const item of items) {
      if (out.length >= max) return;
      if (!isRecord(item) || typeof item['name'] !== 'string') continue;
      const name = item['name'].slice(0, 256);
      if (isLspRange(item['range'])) {
        // Hierarchical DocumentSymbol (always about the requested file).
        if (fileRel === undefined) continue;
        out.push(makeSymbol(name, item['kind'], fileRel, item['range'], container));
        if (Array.isArray(item['children']) && depth < 32) this.flattenSymbols(item['children'], fileRel, name, out, max, depth + 1);
        continue;
      }
      const location = item['location'];
      if (!isRecord(location) || typeof location['uri'] !== 'string') continue;
      const rel = this.uriToRel(location['uri']);
      if (rel === undefined) continue; // never leak paths outside the root
      const range: LspRange = isLspRange(location['range']) ? location['range'] : { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
      const containerName = typeof item['containerName'] === 'string' ? item['containerName'] : container;
      out.push(makeSymbol(name, item['kind'], rel, range, containerName));
    }
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function boundedMax(maxItems: number): number {
  if (!Number.isInteger(maxItems) || maxItems < 1) throw new DodoError('INVALID_INPUT', 'maxItems must be a positive integer');
  return Math.min(maxItems, 10_000);
}

function toLspPosition(doc: TextDoc, pos: Position): LspPosition {
  if (!isRecord(pos) || !Number.isInteger(pos['line']) || !Number.isInteger(pos['column']) || pos.line < 1 || pos.column < 1) {
    throw new DodoError('INVALID_INPUT', 'position must have 1-based integer line and column');
  }
  const line0 = pos.line - 1;
  if (line0 >= doc.lineCount || pos.column - 1 > doc.lineLength(line0)) throw new DodoError('INVALID_INPUT', 'position out of range');
  return { line: line0, character: pos.column - 1 };
}

function locationKey(uri: string, pos: LspPosition): string {
  return `${uri} ${pos.line}:${pos.character}`;
}

function makeSymbol(name: string, kind: unknown, rel: string, range: LspRange, containerName: string | undefined): SymbolInfo {
  const info: SymbolInfo = {
    name,
    kind: symbolKindName(kind),
    path: rel,
    line: range.start.line + 1,
    column: range.start.character + 1,
    endLine: range.end.line + 1,
    endColumn: range.end.character + 1,
  };
  if (containerName !== undefined && containerName !== '') info.containerName = containerName.slice(0, 256);
  return info;
}

/** WorkspaceEdit -> uri -> TextEdit[] from both `changes` and `documentChanges` (TextDocumentEdit). */
function collectWorkspaceEdit(edit: Record<string, unknown>): Map<string, LspTextEdit[]> {
  const byUri = new Map<string, LspTextEdit[]>();
  const add = (uri: string, edits: unknown): void => {
    if (!Array.isArray(edits)) return;
    const list = byUri.get(uri) ?? [];
    for (const e of edits) if (isLspTextEdit(e)) list.push(e);
    byUri.set(uri, list);
  };
  if (isRecord(edit['changes'])) {
    for (const [uri, edits] of Object.entries(edit['changes'])) add(uri, edits);
  }
  if (Array.isArray(edit['documentChanges'])) {
    for (const change of edit['documentChanges']) {
      if (!isRecord(change)) continue;
      const td = change['textDocument'];
      if (isRecord(td) && typeof td['uri'] === 'string') add(td['uri'], change['edits']);
    }
  }
  return byUri;
}

/** Create/rename/delete-file operations are never applied; they count as out of scope. */
function countResourceOperations(edit: Record<string, unknown>): number {
  if (!Array.isArray(edit['documentChanges'])) return 0;
  let n = 0;
  for (const change of edit['documentChanges']) if (isRecord(change) && typeof change['kind'] === 'string') n += 1;
  return n;
}

interface ByteEdit {
  start: number;
  end: number;
  newText: string;
  originalText: string;
  startChar: number;
  endChar: number;
}

/**
 * LSP ranges (UTF-16 positions) -> UTF-8 BYTE offsets in the file's current
 * bytes, sorted by start - exactly the contract of the TypeScript worker.
 */
function toByteEdits(doc: TextDoc, edits: LspTextEdit[]): ByteEdit[] {
  const chars = edits
    .map((e) => {
      const startChar = doc.clampOffset(e.range.start);
      const endChar = Math.max(startChar, doc.clampOffset(e.range.end));
      return { startChar, endChar, newText: e.newText };
    })
    .sort((a, b) => a.startChar - b.startChar || a.endChar - b.endChar);
  const out: ByteEdit[] = [];
  let prevChar = 0;
  let prevByte = 0;
  for (const e of chars) {
    if (e.startChar < prevChar) {
      // Overlapping edit: recompute from the beginning rather than trust the running total.
      prevChar = 0;
      prevByte = 0;
    }
    const start = prevByte + Buffer.byteLength(doc.text.slice(prevChar, e.startChar), 'utf8');
    const originalText = doc.text.slice(e.startChar, e.endChar);
    const end = start + Buffer.byteLength(originalText, 'utf8');
    out.push({ start, end, newText: e.newText, originalText, startChar: e.startChar, endChar: e.endChar });
    prevChar = e.endChar;
    prevByte = end;
  }
  return out;
}

function toDiagnosticInfo(rel: string, d: LspDiagnostic): DiagnosticInfo {
  const raw = d as LspDiagnostic & { severity?: unknown; code?: unknown };
  const severity = typeof raw.severity === 'number' ? raw.severity : 1;
  const category: DiagnosticInfo['category'] = severity === 1 ? 'error' : severity === 2 ? 'warning' : severity === 4 ? 'suggestion' : 'message';
  let code = 0;
  let message = d.message.slice(0, 500);
  if (typeof raw.code === 'number' && Number.isFinite(raw.code)) code = raw.code;
  else if (typeof raw.code === 'string' && raw.code !== '') message = `${message} (${raw.code.slice(0, 80)})`;
  return { path: rel, line: d.range.start.line + 1, column: d.range.start.character + 1, category, code, message };
}
