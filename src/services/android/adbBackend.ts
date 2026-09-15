import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { DodoError } from '../../errors.js';
import { resolveTrustedExecutable } from '../../platform/execResolve.js';
import { buildChildEnv } from '../../security/env.js';
import type { AdbBackend, AdbResult } from './protocol.js';

const DEFAULT_STDOUT = 8 * 1024 * 1024;
const DEFAULT_STDERR = 64 * 1024;

export class NativeAdbBackend implements AdbBackend {
  constructor(private readonly workspaceRoot: string) {}

  private program(): string {
    return resolveTrustedExecutable('adb', this.workspaceRoot, { allowBatch: false });
  }

  private env(): NodeJS.ProcessEnv {
    return buildChildEnv({ parentEnv: process.env, workspaceRoot: this.workspaceRoot, extraAllowlist: [] });
  }

  available(): boolean {
    try {
      const program = this.program();
      const probe = spawnSync(program, ['version'], { cwd: os.tmpdir(), env: this.env(), shell: false, windowsHide: true, timeout: 3000, maxBuffer: 32 * 1024 });
      return !probe.error && probe.status === 0;
    } catch { return false; }
  }

  async version(): Promise<string> {
    const result = await this.run(['version'], { timeoutMs: 3000, maxStdoutBytes: 32 * 1024 });
    if (result.code !== 0) throw new DodoError('NOT_SUPPORTED', 'ADB version probe failed; install current Android SDK Platform-Tools');
    return result.stdout.toString('utf8').split(/\r?\n/, 1)[0]?.slice(0, 300) || 'Android Debug Bridge';
  }

  async run(args: readonly string[], opts: { timeoutMs?: number; maxStdoutBytes?: number; maxStderrBytes?: number } = {}): Promise<AdbResult> {
    let program: string;
    try { program = this.program(); }
    catch { throw new DodoError('NOT_SUPPORTED', 'ADB is unavailable; install Android SDK Platform-Tools and make adb available on the trusted PATH'); }
    const timeoutMs = opts.timeoutMs ?? 15_000;
    const stdoutCap = opts.maxStdoutBytes ?? DEFAULT_STDOUT;
    const stderrCap = opts.maxStderrBytes ?? DEFAULT_STDERR;
    return await new Promise<AdbResult>((resolve, reject) => {
      const child = spawn(program, [...args], { cwd: os.tmpdir(), env: this.env(), shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const stdout: Buffer[] = [], stderr: Buffer[] = [];
      let stdoutBytes = 0, stderrBytes = 0, settled = false;
      const fail = (error: DodoError) => {
        if (settled) return;
        settled = true;
        child.kill('SIGKILL');
        reject(error);
      };
      const timer = setTimeout(() => fail(new DodoError('TIMEOUT', 'ADB command timed out; an effect may have occurred, inspect the device before retrying')), timeoutMs);
      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > stdoutCap) fail(new DodoError('RESOURCE_LIMIT', 'ADB stdout exceeds the bounded response limit'));
        else stdout.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes > stderrCap) fail(new DodoError('RESOURCE_LIMIT', 'ADB stderr exceeds the bounded diagnostic limit'));
        else stderr.push(chunk);
      });
      child.once('error', () => fail(new DodoError('NOT_SUPPORTED', 'ADB could not be started')));
      child.once('close', (code) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        resolve({ code: code ?? -1, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
      });
    });
  }
}

export function parseAdbDevices(output: string): Array<import('./protocol.js').AndroidDevice> {
  const devices: Array<import('./protocol.js').AndroidDevice> = [];
  for (const line of output.split(/\r?\n/).slice(1)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('*')) continue;
    const fields = trimmed.split(/\s+/);
    const serial = fields.shift();
    const rawState = fields.shift();
    if (!serial || !rawState || !/^(?!-)[!-~]+$/.test(serial) || serial.length > 200) continue;
    const allowedStates = new Set(['device', 'offline', 'unauthorized', 'recovery', 'sideload', 'bootloader']);
    const state = allowedStates.has(rawState) ? rawState as 'device' | 'offline' | 'unauthorized' | 'recovery' | 'sideload' | 'bootloader' : 'unknown';
    const props = new Map<string, string>();
    for (const field of fields) {
      const split = field.indexOf(':');
      if (split > 0) props.set(field.slice(0, split), field.slice(split + 1));
    }
    devices.push({ serial, state, ...(props.get('product') ? { product: props.get('product')! } : {}), ...(props.get('model') ? { model: props.get('model')! } : {}), ...(props.get('device') ? { device: props.get('device')! } : {}), ...(props.get('transport_id') ? { transportId: props.get('transport_id')! } : {}) });
  }
  return devices;
}
