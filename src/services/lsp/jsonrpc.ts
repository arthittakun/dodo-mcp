import { spawn, type ChildProcess } from 'node:child_process';
import { DodoError } from '../../errors.js';
import { assertWindowsArgv } from '../../platform/shell.js';
import { signalOwnedProcess } from '../../platform/processTree.js';

/**
 * Minimal LSP-flavoured JSON-RPC 2.0 client over a child process's stdio.
 *
 * - Content-Length framing (LSP base protocol), parsed in O(n) with a hard
 *   cap on message size — an oversized or malformed frame kills the server
 *   rather than growing memory.
 * - Request/response correlation with a per-request timeout (the request is
 *   also cancelled via `$/cancelRequest` so a well-behaved server stops work).
 * - Server→client requests are answered by registered handlers; unknown
 *   methods get a JSON-RPC MethodNotFound error so the server never hangs
 *   waiting on us.
 * - Crash detection: every pending request is rejected and the client is
 *   marked dead; the owner decides whether to restart.
 *
 * The caller supplies the exact environment (DODO passes `buildChildEnv`);
 * this module never touches `process.env` itself.
 */

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

/** A JSON-RPC error response from the server for one of our requests. */
export class RpcResponseError extends Error {
  readonly method: string;
  readonly rpcCode: number;
  readonly data: unknown;

  constructor(method: string, err: JsonRpcErrorObject) {
    super(err.message);
    this.name = 'RpcResponseError';
    this.method = method;
    this.rpcCode = err.code;
    this.data = err.data;
  }
}

export interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  reason: string;
}

export type NotificationHandler = (params: unknown) => void;
/** May return a value or a promise; the resolved value is the JSON-RPC result. */
export type RequestHandler = (params: unknown) => unknown;

export interface StdioClientOptions {
  command: string;
  args: string[];
  cwd: string;
  /** The complete child environment (callers pass `buildChildEnv(...)`). */
  env: NodeJS.ProcessEnv;
  /** Inbound and outbound frame size cap; default 8 MiB. */
  maxMessageBytes?: number;
  log?: (line: string) => void;
}

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

const DEFAULT_MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
const MAX_HEADER_BYTES = 16 * 1024;
const MAX_LOG_LINE = 500;
const MAX_STDERR_TAIL = 2048;
const JSONRPC_METHOD_NOT_FOUND = -32601;
const JSONRPC_INTERNAL_ERROR = -32603;

export class JsonRpcStdioClient {
  private readonly child: ChildProcess;
  private readonly maxMessageBytes: number;
  private readonly log: (line: string) => void;
  private readonly pending = new Map<number, Pending>();
  private readonly notificationHandlers = new Map<string, NotificationHandler[]>();
  private readonly requestHandlers = new Map<string, RequestHandler>();
  private readonly exitListeners: Array<(info: ExitInfo) => void> = [];
  private readonly spawnedPromise: Promise<void>;
  private nextId = 1;
  // Framing state: bytes still being scanned for a header, then body chunks.
  private headBuf: Buffer = Buffer.alloc(0);
  private bodyChunks: Buffer[] = [];
  private bodyLen = 0;
  private bodyNeed = -1;
  private dead = false;
  private exitInfo: ExitInfo | undefined;
  private stderrTail = '';
  private stderrPartial = '';
  private lastInbound = Date.now();

  constructor(opts: StdioClientOptions) {
    this.maxMessageBytes = opts.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
    this.log = opts.log ?? (() => {});
    if (process.platform === 'win32') assertWindowsArgv(opts.command, opts.args);
    const child = spawn(opts.command, opts.args, {
      cwd: opts.cwd,
      env: opts.env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    this.spawnedPromise = new Promise<void>((resolve, reject) => {
      child.once('spawn', () => resolve());
      child.once('error', (err) => reject(err));
    });
    // Nobody may await the spawn promise (e.g. an immediate kill); keep it quiet.
    this.spawnedPromise.catch(() => {});
    child.on('error', (err) => this.markDead(`failed: ${err.message}`, null, null));
    child.on('exit', (code, signal) => this.markDead(`exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`, code, signal));
    child.stdout?.on('data', (chunk: Buffer) => this.onData(chunk));
    child.stderr?.on('data', (chunk: Buffer) => this.onStderr(chunk));
    child.stdin?.on('error', (err) => this.log(`stdin error: ${err.message}`));
  }

  get alive(): boolean {
    return !this.dead;
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  /** Why the process is gone (undefined while alive). */
  get exit(): ExitInfo | undefined {
    return this.exitInfo;
  }

  /** Last ~2 KiB of the server's stderr — useful in error messages. */
  get stderrSnippet(): string {
    return this.stderrTail.trim();
  }

  /** Timestamp (ms) of the last complete inbound frame — lets owners detect a quiet server. */
  get lastInboundAt(): number {
    return this.lastInbound;
  }

  /** Resolves once the OS process exists; rejects on spawn failure (ENOENT, EACCES, ...). */
  waitForSpawn(): Promise<void> {
    return this.spawnedPromise;
  }

  onExit(listener: (info: ExitInfo) => void): void {
    if (this.exitInfo) {
      listener(this.exitInfo);
      return;
    }
    this.exitListeners.push(listener);
  }

  onNotification(method: string, handler: NotificationHandler): void {
    const list = this.notificationHandlers.get(method) ?? [];
    list.push(handler);
    this.notificationHandlers.set(method, list);
  }

  onRequest(method: string, handler: RequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  request<T = unknown>(method: string, params: unknown, timeoutMs: number): Promise<T> {
    if (this.dead) {
      return Promise.reject(new DodoError('INTERNAL_ERROR', `language server is not running (${this.exitInfo?.reason ?? 'never started'})`, { retryable: true }));
    }
    const id = this.nextId;
    this.nextId += 1;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        this.notify('$/cancelRequest', { id });
        reject(new DodoError('TIMEOUT', `language server did not answer ${method} within ${timeoutMs} ms`, { retryable: true }));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject, timer });
      try {
        this.send(params === undefined ? { jsonrpc: '2.0', id, method } : { jsonrpc: '2.0', id, method, params });
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    this.send(params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params });
  }

  /**
   * LSP-conformant shutdown: `shutdown` request, `exit` notification, then a
   * bounded wait before SIGKILL. Safe to call on a dead client.
   */
  async shutdown(graceMs = 2000): Promise<void> {
    if (this.dead) return;
    try {
      await this.request('shutdown', null, Math.min(graceMs, 3000));
    } catch {
      /* proceed to exit/kill regardless */
    }
    if (this.dead) return;
    try {
      this.notify('exit');
      this.child.stdin?.end();
    } catch {
      /* stdin may already be gone */
    }
    await this.waitExit(graceMs);
    if (!this.dead) {
      this.kill();
      await this.waitExit(1000);
    }
  }

  /** Immediate SIGKILL; pending requests are rejected by the exit handler. */
  kill(): void {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    try {
      signalOwnedProcess(this.child, 'SIGKILL');
    } catch {
      this.log('owned LSP process termination failed; owner attention may be required');
    }
  }

  // ---------------------------------------------------------------------------
  // Wire
  // ---------------------------------------------------------------------------

  private send(msg: Record<string, unknown>): void {
    if (this.dead) throw new DodoError('INTERNAL_ERROR', `language server is not running (${this.exitInfo?.reason ?? 'never started'})`, { retryable: true });
    const stdin = this.child.stdin;
    if (!stdin || stdin.destroyed) throw new DodoError('INTERNAL_ERROR', 'language server stdin is closed', { retryable: true });
    const body = Buffer.from(JSON.stringify(msg), 'utf8');
    if (body.length > this.maxMessageBytes) {
      throw new DodoError('FILE_TOO_LARGE', `outbound language server message exceeds ${this.maxMessageBytes} bytes`);
    }
    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii');
    stdin.write(Buffer.concat([header, body]));
  }

  private onData(chunk: Buffer): void {
    let data = chunk;
    for (;;) {
      if (this.dead) return;
      if (this.bodyNeed >= 0) {
        const take = Math.min(data.length, this.bodyNeed - this.bodyLen);
        if (take > 0) {
          this.bodyChunks.push(data.subarray(0, take));
          this.bodyLen += take;
          data = data.subarray(take);
        }
        if (this.bodyLen < this.bodyNeed) return;
        const body = Buffer.concat(this.bodyChunks, this.bodyLen).toString('utf8');
        this.bodyChunks = [];
        this.bodyLen = 0;
        this.bodyNeed = -1;
        this.dispatch(body);
        if (data.length === 0) return;
        continue;
      }
      // Header mode.
      if (data.length > 0) {
        this.headBuf = this.headBuf.length === 0 ? data : Buffer.concat([this.headBuf, data]);
        data = Buffer.alloc(0);
      }
      const headerEnd = this.headBuf.indexOf('\r\n\r\n');
      if (headerEnd === -1) {
        if (this.headBuf.length > MAX_HEADER_BYTES) this.die('protocol error: oversized or missing frame header');
        return;
      }
      const length = parseContentLength(this.headBuf.subarray(0, headerEnd).toString('ascii'));
      if (length === undefined) {
        this.die('protocol error: frame without a valid Content-Length');
        return;
      }
      if (length > this.maxMessageBytes) {
        this.die(`protocol error: inbound message of ${length} bytes exceeds the ${this.maxMessageBytes}-byte cap`);
        return;
      }
      data = this.headBuf.subarray(headerEnd + 4);
      this.headBuf = Buffer.alloc(0);
      this.bodyNeed = length;
      if (length === 0) {
        this.bodyNeed = -1;
        if (data.length === 0) return;
      }
    }
  }

  private dispatch(body: string): void {
    this.lastInbound = Date.now();
    let msg: unknown;
    try {
      msg = JSON.parse(body);
    } catch {
      this.log('dropped unparsable JSON-RPC frame');
      return;
    }
    if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) return;
    const m = msg as { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown };
    if (typeof m.method === 'string') {
      if (typeof m.id === 'number' || typeof m.id === 'string') this.handleServerRequest(m.id, m.method, m.params);
      else this.handleNotification(m.method, m.params);
      return;
    }
    if (typeof m.id !== 'number') return; // response to nobody (or already timed out with a string id we never use)
    const entry = this.pending.get(m.id);
    if (!entry) return; // late answer to a timed-out request
    this.pending.delete(m.id);
    clearTimeout(entry.timer);
    if (m.error !== undefined && m.error !== null) {
      entry.reject(new RpcResponseError(entry.method, normalizeRpcError(m.error)));
      return;
    }
    entry.resolve(m.result);
  }

  private handleNotification(method: string, params: unknown): void {
    const handlers = this.notificationHandlers.get(method);
    if (!handlers) return;
    for (const h of handlers) {
      try {
        h(params);
      } catch (err) {
        this.log(`notification handler ${method} failed: ${(err as Error).message}`);
      }
    }
  }

  private handleServerRequest(id: number | string, method: string, params: unknown): void {
    const handler = this.requestHandlers.get(method);
    if (!handler) {
      this.safeSend({ jsonrpc: '2.0', id, error: { code: JSONRPC_METHOD_NOT_FOUND, message: `client does not support ${method}` } });
      return;
    }
    Promise.resolve()
      .then(() => handler(params))
      .then(
        (result) => this.safeSend({ jsonrpc: '2.0', id, result: result === undefined ? null : result }),
        (err: unknown) =>
          this.safeSend({ jsonrpc: '2.0', id, error: { code: JSONRPC_INTERNAL_ERROR, message: err instanceof Error ? err.message.slice(0, 200) : 'client handler failed' } }),
      );
  }

  private safeSend(msg: Record<string, unknown>): void {
    try {
      this.send(msg);
    } catch (err) {
      this.log(`could not answer server request: ${(err as Error).message}`);
    }
  }

  private onStderr(chunk: Buffer): void {
    const text = this.stderrPartial + chunk.toString('utf8');
    const lines = text.split(/\r?\n/);
    this.stderrPartial = lines.pop() ?? '';
    for (const line of lines) {
      if (line.length === 0) continue;
      this.log(`stderr: ${line.length > MAX_LOG_LINE ? `${line.slice(0, MAX_LOG_LINE)}…` : line}`);
    }
    this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-MAX_STDERR_TAIL);
  }

  private die(reason: string): void {
    this.log(reason);
    this.markDead(reason, null, null);
    this.kill();
  }

  private markDead(reason: string, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.dead) return;
    this.dead = true;
    this.exitInfo = { code, signal, reason };
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new DodoError('INTERNAL_ERROR', `language server ${reason} while handling ${entry.method}`, { retryable: true }));
    }
    this.pending.clear();
    const listeners = this.exitListeners.splice(0);
    for (const listener of listeners) {
      try {
        listener(this.exitInfo);
      } catch {
        /* listener errors never propagate into the exit path */
      }
    }
  }

  private waitExit(ms: number): Promise<void> {
    if (this.dead) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref();
      this.exitListeners.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

function parseContentLength(header: string): number | undefined {
  for (const line of header.split('\r\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    if (line.slice(0, idx).trim().toLowerCase() !== 'content-length') continue;
    const value = line.slice(idx + 1).trim();
    if (!/^\d{1,12}$/.test(value)) return undefined;
    return Number.parseInt(value, 10);
  }
  return undefined;
}

function normalizeRpcError(raw: unknown): JsonRpcErrorObject {
  if (typeof raw === 'object' && raw !== null) {
    const r = raw as { code?: unknown; message?: unknown; data?: unknown };
    const out: JsonRpcErrorObject = {
      code: typeof r.code === 'number' ? r.code : 0,
      message: typeof r.message === 'string' ? r.message.slice(0, 500) : 'unknown error',
    };
    if (r.data !== undefined) out.data = r.data;
    return out;
  }
  return { code: 0, message: 'unknown error' };
}
