import type { AssistanceRequest } from '../assistance/contracts.js';
import { Worker } from 'node:worker_threads';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DodoError, type ErrorCode, ERROR_CODES } from '../../errors.js';
import type { Limits } from '../../config/limits.js';
import type {
  WorkerInit,
  WorkerRequest,
  WorkerResponse,
  WorkerMeta,
  Position,
  SymbolInfo,
  ReferenceInfo,
  RenameResultData,
  DiagnosticInfo,
} from './protocol.js';

/**
 * Host side of the guarded TypeScript worker (spec §11): bounded request
 * timeouts; a hung worker is terminated and restarted, surfacing TIMEOUT
 * instead of stalling the server.
 */
type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export class IntelService {
  private worker: Worker | undefined;
  private nextId = 1;
  private pending = new Map<number, { resolve: (r: WorkerResponse) => void; timer: NodeJS.Timeout }>();
  lastMeta: WorkerMeta | undefined;

  constructor(
    private readonly init: WorkerInit,
    private readonly limits: Limits,
  ) {}

  /**
   * Locate the compiled worker. In the published package it sits next to this
   * module; when running from TypeScript sources (vitest) it lives under
   * dist/ after a build.
   */
  private workerPath(): string | undefined {
    const candidates = [
      new URL('./tsWorker.js', import.meta.url),
      new URL('../../../dist/services/intelligence/tsWorker.js', import.meta.url),
    ];
    for (const url of candidates) {
      try {
        const p = fileURLToPath(url);
        if (fs.existsSync(p)) return p;
      } catch {
        /* try next */
      }
    }
    return undefined;
  }

  available(): { ok: boolean; reason?: string } {
    if (this.workerPath() === undefined) {
      return { ok: false, reason: 'semantic worker not built (run npm run build)' };
    }
    return { ok: true };
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const workerPath = this.workerPath();
    if (workerPath === undefined) {
      throw new DodoError('UNSUPPORTED_LANGUAGE', 'semantic tools unavailable: semantic worker not built (run npm run build)');
    }
    const worker = new Worker(workerPath, { workerData: this.init });
    worker.unref();
    worker.on('message', (res: WorkerResponse) => {
      const entry = this.pending.get(res.id);
      if (!entry) return;
      this.pending.delete(res.id);
      clearTimeout(entry.timer);
      entry.resolve(res);
    });
    worker.on('error', () => this.restart());
    worker.on('exit', () => {
      if (this.worker === worker) this.worker = undefined;
    });
    this.worker = worker;
    return worker;
  }

  private restart(): void {
    const w = this.worker;
    this.worker = undefined;
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.resolve({ id, ok: false, error: { code: 'TIMEOUT', message: 'language service restarted' } });
    }
    this.pending.clear();
    void w?.terminate();
  }

  private async request(req: DistOmit<WorkerRequest, 'id'>): Promise<{ data: unknown; meta: WorkerMeta | undefined }> {
    const worker = this.ensureWorker();
    const id = this.nextId;
    this.nextId += 1;
    const full = { ...req, id } as WorkerRequest;
    const res = await new Promise<WorkerResponse>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ id, ok: false, error: { code: 'TIMEOUT', message: `language service timed out after ${this.limits.semanticRequestTimeoutMs} ms` } });
        this.restart();
      }, this.limits.semanticRequestTimeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, timer });
      worker.postMessage(full);
    });
    if (!res.ok) {
      const code: ErrorCode = (ERROR_CODES as readonly string[]).includes(res.error.code) ? (res.error.code as ErrorCode) : 'INTERNAL_ERROR';
      throw new DodoError(code, res.error.message, { retryable: code === 'TIMEOUT' });
    }
    this.lastMeta = res.meta;
    return { data: res.data, meta: res.meta };
  }

  async symbolsInFile(file: string, maxItems: number): Promise<{ symbols: SymbolInfo[]; meta: WorkerMeta | undefined }> {
    const { data, meta } = await this.request({ op: 'symbols_file', file, maxItems });
    return { symbols: (data as { symbols: SymbolInfo[] }).symbols, meta };
  }

  async symbolsQuery(query: string, maxItems: number): Promise<{ symbols: SymbolInfo[]; meta: WorkerMeta | undefined }> {
    const { data, meta } = await this.request({ op: 'symbols_query', query, maxItems });
    return { symbols: (data as { symbols: SymbolInfo[] }).symbols, meta };
  }

  async references(file: string, position: Position, maxItems: number): Promise<{ references: ReferenceInfo[]; outOfScopeCount: number; meta: WorkerMeta | undefined }> {
    const { data, meta } = await this.request({ op: 'references', file, position, maxItems });
    const d = data as { references: ReferenceInfo[]; outOfScopeCount: number };
    return { ...d, meta };
  }

  async rename(file: string, position: Position, newName: string): Promise<{ result: RenameResultData; meta: WorkerMeta | undefined }> {
    if (!/^[\p{L}_$][\p{L}\p{N}_$]{0,127}$/u.test(newName)) {
      throw new DodoError('INVALID_INPUT', 'newName is not a valid identifier');
    }
    const { data, meta } = await this.request({ op: 'rename', file, position, newName });
    return { result: data as RenameResultData, meta };
  }

  async diagnostics(files: string[] | null, maxItems: number): Promise<{ diagnostics: DiagnosticInfo[]; meta: WorkerMeta | undefined }> {
    const { data, meta } = await this.request({ op: 'diagnostics', files, maxItems });
    return { diagnostics: (data as { diagnostics: DiagnosticInfo[] }).diagnostics, meta };
  }

  /** Additive, bounded AST/context operations; validated by the tool's output schema. */
  async assist(req: AssistanceRequest): Promise<unknown> {
    const { data } = await this.request(req);
    return data;
  }

  async shutdown(): Promise<void> {
    const w = this.worker;
    this.worker = undefined;
    await w?.terminate();
  }
}
