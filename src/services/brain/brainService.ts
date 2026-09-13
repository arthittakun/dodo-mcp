import path from 'node:path';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AppServices, ToolCtx } from '../../tools/context.js';
import { DodoError, toDodoError } from '../../errors.js';
import { digestOf, newId } from '../../util/hash.js';
import { liveAccess } from '../multimodal/storage.js';
import { BrainParser } from './brainParser.js';
import {
  BRAIN_FILE_MAX_BYTES,
  BRAIN_QUERY_MAX,
  BRAIN_SCHEMA_VERSION,
  BrainRunMetrics,
  ParsedBrainFile,
  type ParsedBrainFileData,
} from './contracts.js';
import ts from 'typescript';

export const BRAIN_PARSER_VERSION = `typescript-${ts.version}:brain-1`;
const AUTO_INITIAL_DELAY_MS = 750;
const AUTO_REFRESH_MS = 5000;
const RUN_HISTORY_MAX = 20;
const EMPTY_METRICS = {
  scannedFiles: 0, parsedFiles: 0, reusedFiles: 0, movedFiles: 0,
  removedFiles: 0, skippedFiles: 0, affectedFiles: 0, nodes: 0,
  edges: 0, syntaxErrors: 0,
};
const SCRIPT = /\.(?:[cm]?[jt]sx?)$/i;

type RunStatus = 'idle' | 'running' | 'paused' | 'completed' | 'canceled' | 'failed' | 'interrupted';

interface StateRow {
  workspace_id: string;
  namespace: string;
  schema_version: number;
  parser_version: string;
  config_hash: string;
  status: RunStatus;
  paused: number;
  generation: number;
  active_run_id: string | null;
  last_run_id: string | null;
  last_started_at: number | null;
  last_completed_at: number | null;
  last_error: string | null;
  source_hash: string | null;
  metrics: string;
}

interface CacheRow {
  workspace_id: string;
  path: string;
  file_id: string;
  content_hash: string;
  bytes: number;
  mtime_ms: number;
  ctime_ms: number;
  parser_version: string;
  schema_version: number;
  config_hash: string;
  payload: string;
  indexed_at: number;
  generation: number;
}

interface Candidate {
  path: string;
  bytes: number;
  mtimeMs: number;
  ctimeMs: number;
}

interface Snapshot extends Candidate {
  text: string;
  hash: string;
}

interface PreparedFile extends CacheRow {
  parsed: ParsedBrainFileData;
}

interface NodeInsert {
  id: string;
  uri: string;
  type: 'file' | 'symbol' | 'route' | 'test' | 'dependency';
  name: string;
  qualifiedName: string | null;
  path: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  sourceHash: string;
  details: Record<string, unknown>;
}

interface EdgeInsert {
  id: string;
  type: 'contains' | 'imports' | 'exports' | 'dynamic_import' | 'references' | 'depends_on';
  from: string;
  to: string | null;
  targetKey: string | null;
  sourcePath: string;
  targetPath: string | null;
  line: number;
  sourceHash: string;
  details: Record<string, unknown>;
}

interface QueryCursor { v: 1; n: number; e: number; q: string; w: string; a: string; exp: number }

function principalKey(ctx: ToolCtx): string { return digestOf({ grantId: ctx.principal.grantId, clientId: ctx.principal.clientId }); }
function safeMessage(error: unknown): string { return toDodoError(error).message.slice(0, 600); }
function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
function sameStat(left: Candidate, right: Candidate): boolean { return left.bytes === right.bytes && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs; }
function externalPackage(specifier: string): string | undefined {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('#')) return undefined;
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? (parts.length >= 2 ? `${parts[0]}/${parts[1]}` : specifier) : parts[0];
}

/** Durable, bounded, source-verifying project structure index. */
export class ProjectBrainService {
  private readonly parser: BrainParser;
  private readonly configHash: string;
  private readonly cursorKey: Buffer;
  private readonly namespace: string;
  private initialTimer: NodeJS.Timeout | undefined;
  private refreshTimer: NodeJS.Timeout | undefined;
  private currentPromise: Promise<void> | undefined;
  private runToken = 0;
  private closed = false;
  private forceFull = false;

  constructor(readonly services: AppServices, installSecret: string) {
    this.parser = new BrainParser(services.limits);
    this.configHash = digestOf({
      schema: BRAIN_SCHEMA_VERSION,
      parser: BRAIN_PARSER_VERSION,
      fileMax: BRAIN_FILE_MAX_BYTES,
      fileCount: services.limits.semanticFilesMax,
      secretDeny: services.config.secretDeny,
      secretAllow: services.config.secretAllow,
      excludes: services.projectConfig.config.exclude,
    });
    const registered = services.store.db.prepare('SELECT id FROM project_registry WHERE workspace_id=? AND removed_at IS NULL ORDER BY updated_at DESC LIMIT 1').get(services.workspaceId) as { id: string } | undefined;
    this.namespace = registered?.id ?? services.workspaceId;
    this.cursorKey = createHmac('sha256', installSecret).update('dodo-project-brain-cursor-v1').digest();
    this.recoverState();
    this.initialTimer = setTimeout(() => { void this.autoIndex(); }, AUTO_INITIAL_DELAY_MS);
    this.initialTimer.unref();
    this.refreshTimer = setInterval(() => { void this.autoIndex(); }, AUTO_REFRESH_MS);
    this.refreshTimer.unref();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.initialTimer) clearTimeout(this.initialTimer);
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.runToken += 1;
    this.parser.cancel();
    await this.currentPromise?.catch(() => undefined);
    await this.parser.close();
  }

  status(): ReturnType<typeof this.statusFromRow> {
    this.check();
    return this.statusFromRow(this.state());
  }

  async start(mode: 'incremental' | 'full', trigger: 'manual' | 'automatic' = 'manual'): Promise<{ runId: string; changed: boolean }> {
    this.check();
    const state = this.state();
    if (state.paused === 1) throw new DodoError('CONFLICT', 'project indexing is paused; resume it before rebuilding');
    if (this.currentPromise || state.status === 'running') throw new DodoError('CONFLICT', 'project indexing is already running', { retryable: true, detail: { runId: state.active_run_id } });
    if (!this.parser.available()) throw new DodoError('NOT_SUPPORTED', 'project brain parser is not built; run npm run build');
    const runId = newId('brainrun', 12);
    const token = ++this.runToken;
    const effectiveMode = this.forceFull ? 'full' : mode;
    const now = Date.now();
    this.services.store.db.prepare(`UPDATE brain_index_state SET status='running',generation=generation+1,active_run_id=?,last_run_id=?,last_started_at=?,last_error=NULL WHERE workspace_id=?`)
      .run(runId, runId, now, this.services.workspaceId);
    this.services.store.db.prepare('INSERT INTO brain_runs(id,workspace_id,mode,trigger_kind,status,started_at,metrics) VALUES (?,?,?,?,?,?,?)')
      .run(runId, this.services.workspaceId, effectiveMode, trigger, 'running', now, JSON.stringify(EMPTY_METRICS));
    this.currentPromise = this.execute(runId, effectiveMode, token)
      .finally(() => { this.currentPromise = undefined; });
    return { runId, changed: true };
  }

  async wait(runId: string, waitMs: number): Promise<ReturnType<typeof this.status>> {
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      const row = this.services.store.db.prepare('SELECT status FROM brain_runs WHERE id=? AND workspace_id=?').get(runId, this.services.workspaceId) as { status: string } | undefined;
      if (!row || row.status !== 'running') break;
      await sleep(50);
    }
    return this.status();
  }

  async pause(paused: boolean): Promise<{ changed: boolean }> {
    this.check();
    const before = this.state().paused === 1;
    if (before === paused) return { changed: false };
    if (paused && this.currentPromise) {
      this.runToken += 1;
      this.parser.cancel();
      await this.currentPromise.catch(() => undefined);
    }
    this.services.store.db.prepare("UPDATE brain_index_state SET paused=?,status=? WHERE workspace_id=?")
      .run(paused ? 1 : 0, paused ? 'paused' : 'idle', this.services.workspaceId);
    if (!paused) this.initialTimer = setTimeout(() => { void this.autoIndex(); }, 0);
    return { changed: true };
  }

  async cancel(runId?: string): Promise<{ changed: boolean }> {
    this.check();
    const state = this.state();
    if (!this.currentPromise || state.status !== 'running' || (runId !== undefined && runId !== state.active_run_id)) return { changed: false };
    this.runToken += 1;
    this.parser.cancel();
    await this.currentPromise.catch(() => undefined);
    return { changed: true };
  }

  async query(ctx: ToolCtx, input: {
    query?: string; path?: string; nodeTypes?: string[]; edgeTypes?: string[];
    includeStale: boolean; limit: number; cursor?: string;
  }): Promise<{ data: Record<string, unknown>; truncated: boolean; nextCursor: string | null }> {
    this.check(); liveAccess(ctx, 'dodo:read');
    let normalizedPath: string | undefined;
    if (input.path !== undefined) {
      normalizedPath = this.services.wfs.normalizeRel(input.path);
      const resolved = this.services.wfs.resolve(normalizedPath, { allowMissing: true });
      if (resolved.stat && !resolved.stat.isFile()) throw new DodoError('PATH_DENIED', 'brain path filter must identify a file');
    }
    const signature = digestOf({ query: input.query ?? '', path: normalizedPath ?? '', nodeTypes: input.nodeTypes ?? [], edgeTypes: input.edgeTypes ?? [], includeStale: input.includeStale });
    let nodeOffset = 0, edgeOffset = 0;
    if (input.cursor) ({ n: nodeOffset, e: edgeOffset } = this.verifyCursor(ctx, input.cursor, signature));
    const nodes: Array<Record<string, unknown>> = [], edges: Array<Record<string, unknown>> = [];
    const freshness = new Map<string, 'current' | 'stale' | 'missing' | 'inaccessible'>();
    let staleOmitted = 0, inaccessibleOmitted = 0, nodeExhausted = false, edgeExhausted = false;
    const take = Math.min(input.limit, BRAIN_QUERY_MAX);

    while (nodes.length + edges.length < take && (!nodeExhausted || !edgeExhausted)) {
      if (!nodeExhausted) {
        const batch = Math.max(20, take * 2);
        const rows = this.nodeRows(input.query, normalizedPath, input.nodeTypes, nodeOffset, batch);
        let consumed = 0;
        for (const row of rows) {
          consumed += 1;
          nodeOffset += 1;
          const state = this.sourceFreshness(String(row['path']), String(row['source_hash']), freshness);
          if (state === 'inaccessible') { inaccessibleOmitted += 1; continue; }
          if (state !== 'current' && !input.includeStale) { staleOmitted += 1; continue; }
          nodes.push(this.materializeNode(row, state));
          if (nodes.length + edges.length >= take) break;
        }
        nodeExhausted = consumed === rows.length && rows.length < batch;
        if (nodes.length + edges.length >= take) break;
      }
      if (!edgeExhausted) {
        const batch = Math.max(20, take * 2);
        const rows = this.edgeRows(input.query, normalizedPath, input.edgeTypes, edgeOffset, batch);
        let consumed = 0;
        for (const row of rows) {
          consumed += 1;
          edgeOffset += 1;
          const state = this.sourceFreshness(String(row['source_path']), String(row['source_hash']), freshness);
          if (state === 'inaccessible') { inaccessibleOmitted += 1; continue; }
          if (state !== 'current' && !input.includeStale) { staleOmitted += 1; continue; }
          edges.push(this.materializeEdge(row, state));
          if (nodes.length + edges.length >= take) break;
        }
        edgeExhausted = consumed === rows.length && rows.length < batch;
      }
    }
    const truncated = !nodeExhausted || !edgeExhausted;
    const nextCursor = truncated ? this.signCursor(ctx, { v: 1, n: nodeOffset, e: edgeOffset, q: signature, w: this.services.workspaceId, a: principalKey(ctx), exp: Date.now() + 10 * 60 * 1000 }) : null;
    return {
      data: {
        status: this.status(), nodes, edges, staleOmitted, inaccessibleOmitted, truncated, nextCursor,
        evidence: { sourceVerified: true, checkedAt: Date.now(), note: 'Every returned item was re-authorized and compared with the current guarded source hash.' },
      },
      truncated,
      nextCursor,
    };
  }

  async symbol(ctx: ToolCtx, uri: string): Promise<Record<string, unknown>> {
    this.check(); liveAccess(ctx, 'dodo:read');
    if (!uri.startsWith(`symbol://${this.namespace}/`)) throw new DodoError('WORKSPACE_MISMATCH', 'symbol URI belongs to another project namespace');
    const row = this.services.store.db.prepare('SELECT * FROM brain_nodes WHERE workspace_id=? AND uri=? AND node_type=?').get(this.services.workspaceId, uri, 'symbol') as Record<string, unknown> | undefined;
    if (!row) throw new DodoError('NOT_FOUND', 'symbol is not present in the current project brain');
    const state = this.sourceFreshness(row['path'] as string, row['source_hash'] as string, new Map());
    if (state === 'inaccessible') throw new DodoError('PATH_DENIED', 'symbol source is no longer readable under the workspace policy');
    return this.materializeNode(row, state);
  }

  private async autoIndex(): Promise<void> {
    if (this.closed || this.currentPromise) return;
    const state = this.state();
    if (state.paused === 1) return;
    try { await this.start(this.forceFull ? 'full' : 'incremental', 'automatic'); }
    catch { /* status and the next bounded poll expose/retry failures */ }
  }

  private recoverState(): void {
    const existing = this.services.store.db.prepare('SELECT * FROM brain_index_state WHERE workspace_id=?').get(this.services.workspaceId) as StateRow | undefined;
    if (!existing) {
      this.services.store.db.prepare(`INSERT INTO brain_index_state
        (workspace_id,namespace,schema_version,parser_version,config_hash,status,paused,generation,metrics)
        VALUES (?,?,?,?,?,'idle',0,0,?)`)
        .run(this.services.workspaceId, this.namespace, BRAIN_SCHEMA_VERSION, BRAIN_PARSER_VERSION, this.configHash, JSON.stringify(EMPTY_METRICS));
      this.forceFull = true;
      return;
    }
    const mismatch = existing.schema_version !== BRAIN_SCHEMA_VERSION || existing.parser_version !== BRAIN_PARSER_VERSION || existing.config_hash !== this.configHash || existing.namespace !== this.namespace;
    if (existing.status === 'running') {
      this.forceFull = true;
      const now = Date.now();
      this.services.store.db.prepare("UPDATE brain_runs SET status='interrupted',ended_at=?,error=? WHERE id=? AND status='running'").run(now, 'server stopped before index commit', existing.active_run_id);
      this.services.store.db.prepare("UPDATE brain_index_state SET status='interrupted',active_run_id=NULL,last_completed_at=?,last_error=? WHERE workspace_id=?")
        .run(now, 'previous indexing run was interrupted; a recovery scan is queued', this.services.workspaceId);
    }
    if (mismatch) {
      this.forceFull = true;
      this.services.store.db.prepare(`UPDATE brain_index_state SET namespace=?,schema_version=?,parser_version=?,config_hash=?,status='idle',active_run_id=NULL,last_error=? WHERE workspace_id=?`)
        .run(this.namespace, BRAIN_SCHEMA_VERSION, BRAIN_PARSER_VERSION, this.configHash, 'index contract changed; full rebuild queued', this.services.workspaceId);
      this.services.store.db.prepare("UPDATE brain_nodes SET freshness='stale' WHERE workspace_id=?").run(this.services.workspaceId);
      this.services.store.db.prepare("UPDATE brain_edges SET freshness='stale' WHERE workspace_id=?").run(this.services.workspaceId);
    }
  }

  private async execute(runId: string, mode: 'incremental' | 'full', token: number): Promise<void> {
    const metrics = { ...EMPTY_METRICS };
    try {
      const candidates = this.scanCandidates();
      metrics.scannedFiles = candidates.length;
      const existingRows = this.services.store.db.prepare('SELECT * FROM brain_file_cache WHERE workspace_id=? ORDER BY path').all(this.services.workspaceId) as CacheRow[];
      const existing = new Map(existingRows.map((row) => [row.path, row]));
      const candidatePaths = new Set(candidates.map((candidate) => candidate.path));
      const removed = existingRows.filter((row) => !candidatePaths.has(row.path));
      metrics.removedFiles = removed.length;
      const snapshots = new Map<string, Snapshot>();
      const prepared = new Map<string, PreparedFile>();
      const changedPaths = new Set<string>(removed.map((row) => row.path));

      for (const candidate of candidates) {
        this.assertRun(token);
        const cached = existing.get(candidate.path);
        const parsed = cached ? ParsedBrainFile.safeParse(this.parseJson(cached.payload)) : undefined;
        if (mode === 'incremental' && cached && parsed?.success && cached.parser_version === BRAIN_PARSER_VERSION && cached.schema_version === BRAIN_SCHEMA_VERSION && cached.config_hash === this.configHash && sameStat(candidate, { path: cached.path, bytes: cached.bytes, mtimeMs: cached.mtime_ms, ctimeMs: cached.ctime_ms })) {
          metrics.reusedFiles += 1;
          prepared.set(candidate.path, { ...cached, parsed: parsed.data });
          continue;
        }
        try { snapshots.set(candidate.path, this.snapshot(candidate)); }
        catch {
          metrics.skippedFiles += 1;
          changedPaths.add(candidate.path);
          if (cached && parsed?.success) prepared.set(candidate.path, { ...cached, parsed: parsed.data });
          continue;
        }
      }

      // Exact-content moves preserve file_id and parsed cache, making symbol
      // identity independent from the file path.
      const removedByHash = new Map<string, CacheRow[]>();
      for (const row of removed) removedByHash.set(row.content_hash, [...(removedByHash.get(row.content_hash) ?? []), row]);
      const consumedMoves = new Set<string>();
      const reusableByHash = new Map<string, CacheRow>();
      for (const row of existingRows) if (!reusableByHash.has(row.content_hash)) reusableByHash.set(row.content_hash, row);

      for (const candidate of candidates) {
        this.assertRun(token);
        if (prepared.has(candidate.path)) continue;
        const snapshot = snapshots.get(candidate.path);
        if (!snapshot) continue;
        const current = existing.get(candidate.path);
        let fileId = current?.file_id;
        let parsed: ParsedBrainFileData | undefined;
        if (!current) {
          const moveRows = (removedByHash.get(snapshot.hash) ?? []).filter((row) => !consumedMoves.has(row.path));
          if (moveRows.length === 1) {
            const moved = moveRows[0]!;
            const value = ParsedBrainFile.safeParse(this.parseJson(moved.payload));
            if (value.success && moved.parser_version === BRAIN_PARSER_VERSION && moved.schema_version === BRAIN_SCHEMA_VERSION && moved.config_hash === this.configHash) {
              fileId = moved.file_id; parsed = value.data; consumedMoves.add(moved.path); metrics.movedFiles += 1; metrics.reusedFiles += 1;
            }
          }
        }
        if (!parsed && mode === 'incremental') {
          const reusable = reusableByHash.get(snapshot.hash);
          const value = reusable ? ParsedBrainFile.safeParse(this.parseJson(reusable.payload)) : undefined;
          if (reusable && value?.success && reusable.parser_version === BRAIN_PARSER_VERSION && reusable.schema_version === BRAIN_SCHEMA_VERSION && reusable.config_hash === this.configHash) {
            parsed = value.data; metrics.reusedFiles += 1;
          }
        }
        if (!parsed) { parsed = await this.parser.parse(candidate.path, snapshot.text); metrics.parsedFiles += 1; }
        metrics.syntaxErrors += parsed.diagnostics.filter((diagnostic) => diagnostic.category === 'error').length;
        const generation = this.state().generation;
        prepared.set(candidate.path, {
          workspace_id: this.services.workspaceId, path: candidate.path, file_id: fileId ?? newId('brainfile', 12),
          content_hash: snapshot.hash, bytes: snapshot.bytes, mtime_ms: snapshot.mtimeMs, ctime_ms: snapshot.ctimeMs,
          parser_version: BRAIN_PARSER_VERSION, schema_version: BRAIN_SCHEMA_VERSION, config_hash: this.configHash,
          payload: JSON.stringify(parsed), indexed_at: Date.now(), generation, parsed,
        });
        changedPaths.add(candidate.path);
      }

      this.assertRun(token);
      const allFiles = [...prepared.values()].sort((a, b) => a.path.localeCompare(b.path));
      const affected = this.affectedPaths(changedPaths, allFiles);
      if (mode === 'full') for (const file of allFiles) affected.add(file.path);
      metrics.affectedFiles = affected.size;
      const generation = this.state().generation;
      const graph = this.buildGraph(allFiles, affected);
      const now = Date.now();
      const commit = this.services.store.db.transaction(() => {
        this.assertRun(token);
        const deleteFile = this.services.store.db.prepare('DELETE FROM brain_file_cache WHERE workspace_id=? AND path=?');
        for (const row of removed) deleteFile.run(this.services.workspaceId, row.path);
        const upsert = this.services.store.db.prepare(`INSERT INTO brain_file_cache
          (workspace_id,path,file_id,content_hash,bytes,mtime_ms,ctime_ms,parser_version,schema_version,config_hash,payload,indexed_at,generation)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(workspace_id,path) DO UPDATE SET file_id=excluded.file_id,content_hash=excluded.content_hash,bytes=excluded.bytes,mtime_ms=excluded.mtime_ms,ctime_ms=excluded.ctime_ms,parser_version=excluded.parser_version,schema_version=excluded.schema_version,config_hash=excluded.config_hash,payload=excluded.payload,indexed_at=excluded.indexed_at,generation=excluded.generation`);
        for (const file of allFiles) upsert.run(file.workspace_id, file.path, file.file_id, file.content_hash, file.bytes, file.mtime_ms, file.ctime_ms, file.parser_version, file.schema_version, file.config_hash, file.payload, file.indexed_at, generation);
        const deleteNodes = this.services.store.db.prepare('DELETE FROM brain_nodes WHERE workspace_id=? AND path=?');
        const deleteEdges = this.services.store.db.prepare('DELETE FROM brain_edges WHERE workspace_id=? AND source_path=?');
        for (const sourcePath of affected) { deleteEdges.run(this.services.workspaceId, sourcePath); deleteNodes.run(this.services.workspaceId, sourcePath); }
        const insertNode = this.services.store.db.prepare(`INSERT INTO brain_nodes
          (workspace_id,node_id,uri,node_type,name,qualified_name,path,line,column_no,end_line,end_column,source_hash,parser_version,schema_version,freshness,details,updated_at,generation)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'current',?,?,?)`);
        for (const node of graph.nodes) insertNode.run(this.services.workspaceId, node.id, node.uri, node.type, node.name, node.qualifiedName, node.path, node.line, node.column, node.endLine, node.endColumn, node.sourceHash, BRAIN_PARSER_VERSION, BRAIN_SCHEMA_VERSION, JSON.stringify(node.details), now, generation);
        const insertEdge = this.services.store.db.prepare(`INSERT INTO brain_edges
          (workspace_id,edge_id,edge_type,from_node_id,to_node_id,target_key,source_path,target_path,line,source_hash,parser_version,schema_version,freshness,details,updated_at,generation)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'current',?,?,?)`);
        for (const edge of graph.edges) insertEdge.run(this.services.workspaceId, edge.id, edge.type, edge.from, edge.to, edge.targetKey, edge.sourcePath, edge.targetPath, edge.line, edge.sourceHash, BRAIN_PARSER_VERSION, BRAIN_SCHEMA_VERSION, JSON.stringify(edge.details), now, generation);
        const counts = this.counts(); metrics.nodes = counts.nodes; metrics.edges = counts.edges;
        const sourceHash = digestOf(allFiles.map((file) => ({ path: file.path, hash: file.content_hash })));
        this.services.store.db.prepare(`UPDATE brain_index_state SET status='completed',active_run_id=NULL,last_completed_at=?,last_error=NULL,source_hash=?,metrics=? WHERE workspace_id=?`)
          .run(now, sourceHash, JSON.stringify(metrics), this.services.workspaceId);
        this.services.store.db.prepare("UPDATE brain_runs SET status='completed',ended_at=?,metrics=? WHERE id=?").run(now, JSON.stringify(metrics), runId);
        this.services.store.db.prepare(`DELETE FROM brain_runs WHERE workspace_id=? AND id NOT IN (SELECT id FROM brain_runs WHERE workspace_id=? ORDER BY started_at DESC LIMIT ?)`)
          .run(this.services.workspaceId, this.services.workspaceId, RUN_HISTORY_MAX);
      });
      commit.immediate();
      this.forceFull = false;
    } catch (error) {
      const canceled = token !== this.runToken || this.closed;
      const status = canceled ? 'canceled' : 'failed';
      const message = canceled ? 'indexing canceled before commit' : safeMessage(error);
      const now = Date.now();
      try {
        this.services.store.db.prepare('UPDATE brain_index_state SET status=?,active_run_id=NULL,last_completed_at=?,last_error=?,metrics=? WHERE workspace_id=?')
          .run(this.state().paused === 1 ? 'paused' : status, now, message, JSON.stringify(metrics), this.services.workspaceId);
        this.services.store.db.prepare('UPDATE brain_runs SET status=?,ended_at=?,metrics=?,error=? WHERE id=?')
          .run(status, now, JSON.stringify(metrics), message, runId);
      } catch { /* database shutdown/corruption: bootstrap owns final recovery */ }
    }
  }

  private scanCandidates(): Candidate[] {
    const out: Candidate[] = [];
    let visited = 0;
    for (const entry of this.services.wfs.walk({ maxEntries: this.services.limits.semanticFilesMax * 8, maxDepth: 64 })) {
      if (++visited > this.services.limits.semanticFilesMax * 8) break;
      if (!entry.stat.isFile()) continue;
      if (!SCRIPT.test(entry.rel) && entry.rel !== 'package.json' && !entry.rel.endsWith('/package.json')) continue;
      if (entry.stat.size > BRAIN_FILE_MAX_BYTES) continue;
      out.push({ path: entry.rel, bytes: entry.stat.size, mtimeMs: entry.stat.mtimeMs, ctimeMs: entry.stat.ctimeMs });
      if (out.length >= this.services.limits.semanticFilesMax) break;
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  private snapshot(candidate: Candidate): Snapshot {
    const read = this.services.wfs.readTextFile(candidate.path, BRAIN_FILE_MAX_BYTES);
    const afterResolved = this.services.wfs.resolve(candidate.path);
    const after = this.services.wfs.assertRegularFileForDirectAccess(afterResolved);
    const observed = { path: read.rel, bytes: after.size, mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs };
    if (!sameStat(candidate, observed) || read.stat.dev !== after.dev || read.stat.ino !== after.ino) throw new DodoError('FILE_CHANGED', 'source changed while project brain was snapshotting it', { retryable: true });
    return { ...observed, text: read.text, hash: read.hash };
  }

  private affectedPaths(changed: Set<string>, files: PreparedFile[]): Set<string> {
    const affected = new Set(changed);
    if (changed.size === 0) return affected;
    const oldEdges = this.services.store.db.prepare('SELECT source_path,target_path FROM brain_edges WHERE workspace_id=? AND target_path IS NOT NULL').all(this.services.workspaceId) as Array<{ source_path: string; target_path: string }>;
    for (const edge of oldEdges) if (changed.has(edge.target_path)) affected.add(edge.source_path);
    const changedList = [...changed];
    const oldSymbols = this.services.store.db.prepare(`SELECT name FROM brain_nodes WHERE workspace_id=? AND node_type='symbol' AND path IN (${changedList.map(() => '?').join(',')})`)
      .all(this.services.workspaceId, ...changedList) as Array<{ name: string }>;
    const changedNames = new Set(oldSymbols.map((row) => row.name));
    for (const file of files) if (changed.has(file.path)) for (const symbol of file.parsed.symbols) changedNames.add(symbol.name);
    const allPaths = new Set(files.map((file) => file.path));
    for (const file of files) {
      if (file.parsed.references.some((reference) => changedNames.has(reference.name))) affected.add(file.path);
      for (const imported of file.parsed.imports) {
        const target = this.resolveImport(file.path, imported.specifier, allPaths);
        if (target && changed.has(target)) affected.add(file.path);
      }
    }
    return affected;
  }

  private buildGraph(files: PreparedFile[], affected: Set<string>): { nodes: NodeInsert[]; edges: EdgeInsert[] } {
    const allPaths = new Set(files.map((file) => file.path));
    const fileNodes = new Map<string, string>();
    const symbolNodes = new Map<string, Array<{ id: string; path: string }>>();
    const dependencyNodes = new Map<string, string>();
    const dependencyTargets = new Map<string, string>();
    for (const file of files) {
      const fileId = this.nodeId('file', file.file_id);
      fileNodes.set(file.path, fileId);
      for (const symbol of file.parsed.symbols) {
        const id = this.nodeId('symbol', file.file_id, symbol.kind, symbol.qualifiedName, String(symbol.ordinal));
        symbolNodes.set(symbol.name, [...(symbolNodes.get(symbol.name) ?? []), { id, path: file.path }]);
      }
      for (const dependency of file.parsed.dependencies) {
        const id = this.nodeId('dependency', file.file_id, dependency.scope, dependency.name);
        dependencyNodes.set(`${file.path}\0${dependency.scope}\0${dependency.name}`, id);
        if (!dependencyTargets.has(dependency.name)) dependencyTargets.set(dependency.name, id);
      }
    }
    const nodes: NodeInsert[] = [], edges: EdgeInsert[] = [];
    const addEdge = (source: PreparedFile, type: EdgeInsert['type'], from: string, to: string | null, targetKey: string | null, targetPath: string | null, line: number, details: Record<string, unknown>) => {
      const id = this.nodeId('edge', type, from, to ?? targetKey ?? '', source.path, String(line), String(edges.length));
      edges.push({ id, type, from, to, targetKey, sourcePath: source.path, targetPath, line, sourceHash: source.content_hash, details });
    };
    for (const file of files) {
      if (!affected.has(file.path)) continue;
      const fileNode = fileNodes.get(file.path)!;
      nodes.push({ id: fileNode, uri: `file://${this.namespace}/${file.file_id}`, type: 'file', name: path.posix.basename(file.path), qualifiedName: null, path: file.path, line: 1, column: 1, endLine: 1, endColumn: 1, sourceHash: file.content_hash, details: { provider: file.parsed.provider, language: file.parsed.language, diagnostics: file.parsed.diagnostics, truncated: file.parsed.truncated } });
      for (const symbol of file.parsed.symbols) {
        const id = this.nodeId('symbol', file.file_id, symbol.kind, symbol.qualifiedName, String(symbol.ordinal));
        nodes.push({ id, uri: `symbol://${this.namespace}/${id}`, type: 'symbol', name: symbol.name, qualifiedName: symbol.qualifiedName, path: file.path, line: symbol.line, column: symbol.column, endLine: symbol.endLine, endColumn: symbol.endColumn, sourceHash: file.content_hash, details: { kind: symbol.kind, ordinal: symbol.ordinal, signatureHash: symbol.signatureHash, exported: symbol.exported } });
        addEdge(file, 'contains', fileNode, id, null, file.path, symbol.line, { relation: 'declaration' });
      }
      for (const route of file.parsed.routes) {
        const id = this.nodeId('route', file.file_id, route.method, route.route, String(route.ordinal));
        nodes.push({ id, uri: `route://${this.namespace}/${id}`, type: 'route', name: `${route.method} ${route.route}`, qualifiedName: null, path: file.path, line: route.line, column: route.column, endLine: route.line, endColumn: route.column, sourceHash: file.content_hash, details: { method: route.method, route: route.route, evidence: 'syntax_heuristic' } });
        addEdge(file, 'contains', fileNode, id, null, file.path, route.line, { relation: 'route_heuristic' });
      }
      for (const test of file.parsed.tests) {
        const id = this.nodeId('test', file.file_id, test.kind, test.name, String(test.ordinal));
        nodes.push({ id, uri: `test://${this.namespace}/${id}`, type: 'test', name: test.name, qualifiedName: null, path: file.path, line: test.line, column: test.column, endLine: test.line, endColumn: test.column, sourceHash: file.content_hash, details: { kind: test.kind, evidence: 'syntax_heuristic' } });
        addEdge(file, 'contains', fileNode, id, null, file.path, test.line, { relation: 'test_declaration' });
      }
      for (const dependency of file.parsed.dependencies) {
        const id = dependencyNodes.get(`${file.path}\0${dependency.scope}\0${dependency.name}`)!;
        nodes.push({ id, uri: `dependency://${this.namespace}/${id}`, type: 'dependency', name: dependency.name, qualifiedName: null, path: file.path, line: 1, column: 1, endLine: 1, endColumn: 1, sourceHash: file.content_hash, details: { scope: dependency.scope, version: dependency.version } });
        addEdge(file, 'depends_on', fileNode, id, `package:${dependency.name}`, file.path, 1, { scope: dependency.scope, version: dependency.version });
      }
      for (const imported of file.parsed.imports) {
        const targetPath = this.resolveImport(file.path, imported.specifier, allPaths);
        const pkg = externalPackage(imported.specifier);
        const target = targetPath ? fileNodes.get(targetPath) ?? null : pkg ? dependencyTargets.get(pkg) ?? null : null;
        addEdge(file, imported.kind, fileNode, target, targetPath ? null : pkg ? `package:${pkg}` : `module:${imported.specifier}`, targetPath ?? null, imported.line, { specifier: imported.specifier, resolved: target !== null });
      }
      const seenReferences = new Set<string>();
      for (const reference of file.parsed.references) {
        const targets = symbolNodes.get(reference.name) ?? [];
        const target = targets.length === 1 ? targets[0]! : undefined;
        const key = `${reference.name}:${reference.line}:${reference.column}:${target?.id ?? ''}`;
        if (seenReferences.has(key)) continue;
        seenReferences.add(key);
        addEdge(file, 'references', fileNode, target?.id ?? null, target ? null : `symbol-name:${reference.name}`, target?.path ?? null, reference.line, { name: reference.name, column: reference.column, call: reference.call, ambiguous: targets.length > 1 });
      }
    }
    return { nodes, edges };
  }

  private resolveImport(sourcePath: string, specifier: string, allPaths: Set<string>): string | undefined {
    if (!specifier.startsWith('.')) return undefined;
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath), specifier));
    if (base === '..' || base.startsWith('../') || base.startsWith('/')) return undefined;
    const candidates = [base, ...['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'].map((ext) => `${base}${ext}`), ...['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'].map((ext) => `${base}/index${ext}`)];
    return candidates.find((candidate) => allPaths.has(candidate));
  }

  private nodeId(...parts: string[]): string { return `brain_${digestOf([this.namespace, ...parts]).slice('sha256:'.length, 'sha256:'.length + 32)}`; }

  private state(): StateRow {
    const row = this.services.store.db.prepare('SELECT * FROM brain_index_state WHERE workspace_id=?').get(this.services.workspaceId) as StateRow | undefined;
    if (!row) throw new DodoError('RECOVERY_REQUIRED', 'project brain state is missing; restart DODO to recreate it');
    return row;
  }

  private statusFromRow(row: StateRow) {
    const metrics = BrainRunMetrics.safeParse(this.parseJson(row.metrics));
    if (!metrics.success) { this.scheduleCorruptionRecovery(); throw new DodoError('RECOVERY_REQUIRED', 'project brain metrics are corrupt; a full rebuild was queued'); }
    const counts = this.counts();
    return {
      schemaVersion: BRAIN_SCHEMA_VERSION as 1,
      parserVersion: BRAIN_PARSER_VERSION,
      namespace: this.namespace,
      status: row.status,
      paused: row.paused === 1,
      activeRunId: row.active_run_id,
      lastRunId: row.last_run_id,
      lastStartedAt: row.last_started_at,
      lastCompletedAt: row.last_completed_at,
      lastError: row.last_error,
      sourceHash: row.source_hash,
      files: counts.files,
      nodes: counts.nodes,
      edges: counts.edges,
      staleFiles: this.metadataStaleCount(),
      metrics: metrics.data,
      automaticRefresh: true,
      note: 'Index metadata is untrusted evidence, never permission. Query results recheck the guarded source hash.',
    };
  }

  private counts(): { files: number; nodes: number; edges: number } {
    const file = this.services.store.db.prepare('SELECT COUNT(*) AS count FROM brain_file_cache WHERE workspace_id=?').get(this.services.workspaceId) as { count: number };
    const node = this.services.store.db.prepare('SELECT COUNT(*) AS count FROM brain_nodes WHERE workspace_id=?').get(this.services.workspaceId) as { count: number };
    const edge = this.services.store.db.prepare('SELECT COUNT(*) AS count FROM brain_edges WHERE workspace_id=?').get(this.services.workspaceId) as { count: number };
    return { files: file.count, nodes: node.count, edges: edge.count };
  }

  private metadataStaleCount(): number {
    const rows = this.services.store.db.prepare('SELECT path,bytes,mtime_ms,ctime_ms FROM brain_file_cache WHERE workspace_id=?').all(this.services.workspaceId) as Array<{ path: string; bytes: number; mtime_ms: number; ctime_ms: number }>;
    let stale = 0;
    for (const row of rows) {
      try {
        const resolved = this.services.wfs.resolve(row.path);
        const stat = this.services.wfs.assertRegularFileForDirectAccess(resolved);
        if (stat.size !== row.bytes || stat.mtimeMs !== row.mtime_ms || stat.ctimeMs !== row.ctime_ms) stale += 1;
      } catch { stale += 1; }
    }
    return stale;
  }

  private sourceFreshness(sourcePath: string, expectedHash: string, cache: Map<string, 'current' | 'stale' | 'missing' | 'inaccessible'>): 'current' | 'stale' | 'missing' | 'inaccessible' {
    const existing = cache.get(sourcePath); if (existing) return existing;
    try {
      const read = this.services.wfs.readTextFile(sourcePath, BRAIN_FILE_MAX_BYTES);
      const result = read.hash === expectedHash ? 'current' : 'stale'; cache.set(sourcePath, result); return result;
    } catch (error) {
      const code = toDodoError(error).code;
      const result = code === 'NOT_FOUND' ? 'missing' : 'inaccessible'; cache.set(sourcePath, result); return result;
    }
  }

  private nodeRows(query: string | undefined, sourcePath: string | undefined, types: string[] | undefined, offset: number, limit: number): Array<Record<string, unknown>> {
    const clauses = ['workspace_id=?'], params: unknown[] = [this.services.workspaceId];
    if (query) { clauses.push("(name LIKE ? ESCAPE '\\' OR qualified_name LIKE ? ESCAPE '\\')"); const like = `%${this.escapeLike(query)}%`; params.push(like, like); }
    if (sourcePath) { clauses.push('path=?'); params.push(sourcePath); }
    if (types?.length) { clauses.push(`node_type IN (${types.map(() => '?').join(',')})`); params.push(...types); }
    params.push(limit, offset);
    return this.services.store.db.prepare(`SELECT * FROM brain_nodes WHERE ${clauses.join(' AND ')} ORDER BY node_type,name,path,line,node_id LIMIT ? OFFSET ?`).all(...params) as Array<Record<string, unknown>>;
  }

  private edgeRows(query: string | undefined, sourcePath: string | undefined, types: string[] | undefined, offset: number, limit: number): Array<Record<string, unknown>> {
    const clauses = ['workspace_id=?'], params: unknown[] = [this.services.workspaceId];
    if (query) { clauses.push("(target_key LIKE ? ESCAPE '\\' OR details LIKE ? ESCAPE '\\')"); const like = `%${this.escapeLike(query)}%`; params.push(like, like); }
    if (sourcePath) { clauses.push('source_path=?'); params.push(sourcePath); }
    if (types?.length) { clauses.push(`edge_type IN (${types.map(() => '?').join(',')})`); params.push(...types); }
    params.push(limit, offset);
    return this.services.store.db.prepare(`SELECT * FROM brain_edges WHERE ${clauses.join(' AND ')} ORDER BY edge_type,source_path,line,edge_id LIMIT ? OFFSET ?`).all(...params) as Array<Record<string, unknown>>;
  }

  private materializeNode(row: Record<string, unknown>, freshness: 'current' | 'stale' | 'missing'): Record<string, unknown> {
    return {
      id: row['node_id'], uri: row['uri'], type: row['node_type'], name: row['name'], qualifiedName: row['qualified_name'], path: row['path'],
      line: row['line'], column: row['column_no'], endLine: row['end_line'], endColumn: row['end_column'], sourceHash: row['source_hash'],
      parserVersion: row['parser_version'], schemaVersion: row['schema_version'], freshness, details: this.details(row['details']),
    };
  }

  private materializeEdge(row: Record<string, unknown>, freshness: 'current' | 'stale' | 'missing'): Record<string, unknown> {
    return {
      id: row['edge_id'], type: row['edge_type'], from: row['from_node_id'], to: row['to_node_id'], targetKey: row['target_key'],
      sourcePath: row['source_path'], targetPath: row['target_path'], line: row['line'], sourceHash: row['source_hash'],
      parserVersion: row['parser_version'], schemaVersion: row['schema_version'], freshness, details: this.details(row['details']),
    };
  }

  private details(value: unknown): Record<string, unknown> {
    const parsed = this.parseJson(String(value));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { this.scheduleCorruptionRecovery(); throw new DodoError('RECOVERY_REQUIRED', 'project brain row is corrupt; a full rebuild was queued'); }
    return parsed as Record<string, unknown>;
  }

  private parseJson(value: string): unknown { try { return JSON.parse(value); } catch { return undefined; } }
  private escapeLike(value: string): string { return value.replace(/[\\%_]/g, (part) => `\\${part}`); }
  private assertRun(token: number): void { if (this.closed || token !== this.runToken) throw new DodoError('CONFLICT', 'project indexing canceled', { retryable: true }); }
  private check(): void { if (this.closed) throw new DodoError('STALE_WORKSPACE', 'project brain workspace is closed'); }

  private scheduleCorruptionRecovery(): void {
    if (this.closed) return;
    this.forceFull = true;
    try { this.services.store.db.prepare("UPDATE brain_index_state SET status='failed',last_error=? WHERE workspace_id=?").run('corrupt index row detected; full rebuild queued', this.services.workspaceId); } catch { return; }
    this.initialTimer = setTimeout(() => { void this.autoIndex(); }, 0); this.initialTimer.unref();
  }

  private signCursor(ctx: ToolCtx, payload: QueryCursor): string {
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `b1.${encoded}.${createHmac('sha256', this.cursorKey).update(encoded).digest('base64url')}`;
  }

  private verifyCursor(ctx: ToolCtx, token: string, signature: string): QueryCursor {
    const match = /^b1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(token);
    if (!match) throw new DodoError('INVALID_INPUT', 'invalid project brain cursor');
    const body = Buffer.from(match[1]!, 'base64url'), actual = Buffer.from(match[2]!, 'base64url');
    if (body.toString('base64url') !== match[1] || actual.toString('base64url') !== match[2]) throw new DodoError('INVALID_INPUT', 'invalid project brain cursor');
    const expected = createHmac('sha256', this.cursorKey).update(match[1]!).digest();
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new DodoError('INVALID_INPUT', 'invalid project brain cursor');
    let payload: QueryCursor;
    try { payload = JSON.parse(body.toString('utf8')) as QueryCursor; }
    catch { throw new DodoError('INVALID_INPUT', 'invalid project brain cursor'); }
    if (payload.v !== 1 || payload.q !== signature || payload.w !== this.services.workspaceId || payload.a !== principalKey(ctx) || payload.exp <= Date.now() || !Number.isSafeInteger(payload.n) || payload.n < 0 || !Number.isSafeInteger(payload.e) || payload.e < 0) {
      throw new DodoError('STALE_WORKSPACE', 'project brain cursor expired or belongs to another query/client/workspace');
    }
    return payload;
  }
}
