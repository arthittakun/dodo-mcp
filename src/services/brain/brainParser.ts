import fs from 'node:fs';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { DodoError } from '../../errors.js';
import type { Limits } from '../../config/limits.js';
import { ParsedBrainFile, type ParsedBrainFileData } from './contracts.js';
import type { BrainParseRequest, BrainParseResponse } from './protocol.js';

interface Pending {
  resolve: (value: ParsedBrainFileData) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** Bounded host for the bundled TypeScript parser. Repository plugins never load. */
export class BrainParser {
  private worker: Worker | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closed = false;

  constructor(private readonly limits: Limits) {}

  available(): boolean { return this.workerPath() !== undefined; }

  async parse(path: string, text: string): Promise<ParsedBrainFileData> {
    if (this.closed) throw new DodoError('STALE_WORKSPACE', 'project brain is closed');
    const worker = this.ensureWorker();
    const id = this.nextId++;
    const request: BrainParseRequest = { id, path, text };
    return await new Promise<ParsedBrainFileData>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new DodoError('TIMEOUT', `project parser timed out after ${this.limits.semanticRequestTimeoutMs} ms`, { retryable: true }));
        this.restart(new DodoError('TIMEOUT', 'project parser restarted after timeout', { retryable: true }));
      }, this.limits.semanticRequestTimeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      worker.postMessage(request);
    });
  }

  cancel(): void { this.restart(new DodoError('CONFLICT', 'project indexing canceled', { retryable: true })); }

  async close(): Promise<void> {
    this.closed = true;
    const worker = this.worker;
    this.worker = undefined;
    this.rejectPending(new DodoError('STALE_WORKSPACE', 'project brain closed'));
    await worker?.terminate();
  }

  private workerPath(): string | undefined {
    for (const url of [new URL('./brainWorker.js', import.meta.url), new URL('../../../dist/services/brain/brainWorker.js', import.meta.url)]) {
      try { const value = fileURLToPath(url); if (fs.existsSync(value)) return value; }
      catch { /* try the built location */ }
    }
    return undefined;
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const workerPath = this.workerPath();
    if (!workerPath) throw new DodoError('NOT_SUPPORTED', 'project brain parser is not built; run npm run build');
    const worker = new Worker(workerPath);
    worker.unref();
    worker.on('message', (response: BrainParseResponse) => {
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      clearTimeout(pending.timer);
      if (!response.ok) pending.reject(new DodoError(response.error.code, response.error.message));
      else {
        const parsed = ParsedBrainFile.safeParse(response.data);
        if (!parsed.success) pending.reject(new DodoError('INTERNAL_ERROR', 'project parser returned an invalid bounded contract'));
        else pending.resolve(parsed.data);
      }
    });
    worker.on('error', () => this.restart(new DodoError('INTERNAL_ERROR', 'project parser worker failed', { retryable: true })));
    worker.on('exit', () => { if (this.worker === worker) this.worker = undefined; });
    this.worker = worker;
    return worker;
  }

  private restart(error: DodoError): void {
    const worker = this.worker;
    this.worker = undefined;
    this.rejectPending(error);
    void worker?.terminate();
  }

  private rejectPending(error: DodoError): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
