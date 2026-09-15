import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DodoError } from '../../errors.js';
import type { Store } from '../../store/store.js';
import type { WorkspaceFS } from '../../workspace/fs.js';
import { decodeUtf8Strict } from '../../util/bytes.js';
import { digestOf, sha256Bytes } from '../../util/hash.js';
import { readAndroidPolicy, saveAndroidPolicy } from './androidPolicy.js';
import { AndroidActionSchema, AndroidAppActionSchema, AndroidSerialSchema, type AdbBackend, type AndroidAction, type AndroidAppAction, type AndroidDevice, type AndroidPolicy } from './protocol.js';
import { parseAdbDevices } from './adbBackend.js';
import { ensurePrivateDirectory } from '../../platform/privateFs.js';
import { removeWithRetry } from '../../platform/fsRetry.js';

type Identity = { grantId: string; clientId: string };
type Snapshot = { serial: string; principal: string; width: number; height: number; expiresAt: number; policyDigest: string };

const DEVICE_PATH_MAX = 512;
const SNAPSHOT_TTL = 30_000;
// One DODO process can host several project runtimes. Device effects/reads must
// still serialize across those runtimes so two agents cannot interleave ADB
// commands merely by targeting different projects.
const PROCESS_DEVICE_BUSY = new Set<string>();

function devicePath(value: string): string {
  if (typeof value !== 'string' || value.length < 2 || value.length > DEVICE_PATH_MAX || !value.startsWith('/') || /[\0\r\n]/.test(value)) {
    throw new DodoError('INVALID_INPUT', 'device path must be an absolute Android path without control characters');
  }
  if (value.split('/').some((part) => part === '..')) throw new DodoError('PATH_DENIED', 'device path traversal is rejected');
  return value;
}

function pngDimensions(bytes: Buffer): { width: number; height: number } {
  if (bytes.length < 24 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || bytes.subarray(12, 16).toString('ascii') !== 'IHDR') {
    throw new DodoError('INTERNAL_ERROR', 'ADB screenshot did not return a valid PNG');
  }
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (width < 1 || height < 1 || width > 20_000 || height > 20_000) throw new DodoError('RESOURCE_LIMIT', 'Android screenshot dimensions are outside the supported range');
  return { width, height };
}

function decodeXml(value: string): string {
  return value.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

export function parseUiHierarchy(xml: string, maxNodes = 300): { nodes: Array<Record<string, unknown>>; truncated: boolean } {
  const nodes: Array<Record<string, unknown>> = [];
  const matches = xml.matchAll(/<node\s+([^>]*?)(?:\/?>)/g);
  let total = 0;
  for (const match of matches) {
    total += 1;
    if (nodes.length >= maxNodes) continue;
    const attrs = new Map<string, string>();
    for (const attr of match[1]!.matchAll(/([A-Za-z][A-Za-z0-9_-]*)="([^"]*)"/g)) attrs.set(attr[1]!, decodeXml(attr[2]!));
    const boundsMatch = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/.exec(attrs.get('bounds') ?? '');
    const password = attrs.get('password') === 'true';
    nodes.push({
      index: total - 1,
      className: (attrs.get('class') ?? '').slice(0, 200),
      resourceId: (attrs.get('resource-id') ?? '').slice(0, 300),
      packageName: (attrs.get('package') ?? '').slice(0, 220),
      ...(password ? { redacted: true } : {
        ...(attrs.get('text') ? { text: attrs.get('text')!.slice(0, 500) } : {}),
        ...(attrs.get('content-desc') ? { description: attrs.get('content-desc')!.slice(0, 500) } : {}),
      }),
      clickable: attrs.get('clickable') === 'true',
      enabled: attrs.get('enabled') !== 'false',
      focusable: attrs.get('focusable') === 'true',
      ...(boundsMatch ? { bounds: { x: Number(boundsMatch[1]), y: Number(boundsMatch[2]), width: Number(boundsMatch[3]) - Number(boundsMatch[1]), height: Number(boundsMatch[4]) - Number(boundsMatch[2]) } } : {}),
    });
  }
  return { nodes, truncated: total > nodes.length };
}

export class AndroidService {
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly busy = new Set<string>();
  private closed = false;

  constructor(
    private readonly store: Store,
    private readonly wfs: WorkspaceFS,
    private readonly workspaceId: string,
    private readonly epoch: string,
    private readonly backend: AdbBackend,
    private readonly configDir: string,
    private readonly clock: () => number = Date.now,
  ) {}

  policy(): AndroidPolicy { return readAndroidPolicy(this.store, this.workspaceId, this.epoch, this.clock()); }

  setPolicy(input: unknown): AndroidPolicy {
    const policy = saveAndroidPolicy(this.store, this.workspaceId, this.epoch, input, this.clock());
    this.snapshots.clear();
    return policy;
  }

  async status() {
    const policy = this.policy();
    return {
      // The MCP status tool is readable with dodo:read. Exact device serials
      // remain behind dodo:exec/android_devices and the local owner plane.
      policy: { mode: policy.mode, persistent: policy.persistent, expiresAt: policy.expiresAt, allowedDeviceCount: policy.allowedDevices.length },
      adbAvailable: this.backend.available(),
      version: this.backend.available() ? await this.backend.version() : null,
      setup: 'Install Android SDK Platform-Tools, enable USB/Wireless debugging, authorize the host on the phone, then run dodo android devices.',
      permissionCommand: 'dodo android allow --device <serial> --mode view|control --persist --yes',
      scope: 'dodo:exec',
      snapshotTtlMs: SNAPSHOT_TTL,
      note: 'ADB controls the selected device with that device user\'s privileges. DODO does not pair, connect, root, or bypass the Android authorization dialog.',
    };
  }

  async allDevices(): Promise<AndroidDevice[]> {
    this.checkOpen();
    const result = await this.backend.run(['devices', '-l'], { maxStdoutBytes: 128 * 1024 });
    this.expectOk(result.code, 'list Android devices');
    return parseAdbDevices(result.stdout.toString('utf8'));
  }

  async devices(): Promise<{ devices: AndroidDevice[]; hiddenCount: number }> {
    const policy = this.authorize(undefined, false);
    const all = await this.allDevices();
    const devices = all.filter((d) => policy.allowedDevices.includes(d.serial));
    return { devices, hiddenCount: all.length - devices.length };
  }

  async info(serialInput: string) {
    const serial = this.serial(serialInput); const policy = this.authorize(serial, false);
    return this.exclusive(serial, async () => {
      await this.assertOnline(serial);
      const props = await this.adbText(serial, ['shell', 'getprop'], 512 * 1024);
      const get = (name: string) => new RegExp(`^\\[${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]: \\[(.*)\\]$`, 'm').exec(props)?.[1]?.slice(0, 300) ?? '';
      const display = await this.adbText(serial, ['shell', 'wm', 'size'], 4096);
      const battery = await this.adbText(serial, ['shell', 'dumpsys', 'battery'], 32 * 1024);
      this.checkPolicy(policy, serial);
      return {
        serial,
        manufacturer: get('ro.product.manufacturer'), model: get('ro.product.model'), device: get('ro.product.device'),
        androidVersion: get('ro.build.version.release'), sdk: get('ro.build.version.sdk'), abi: get('ro.product.cpu.abi'),
        display: display.trim().slice(0, 500),
        battery: {
          level: Number(/^\s*level:\s*(\d+)/m.exec(battery)?.[1] ?? -1),
          status: Number(/^\s*status:\s*(\d+)/m.exec(battery)?.[1] ?? -1),
          powered: /AC powered:\s*true|USB powered:\s*true|Wireless powered:\s*true/.test(battery),
        },
      };
    });
  }

  async capture(serialInput: string, identity: Identity) {
    const serial = this.serial(serialInput); const policy = this.authorize(serial, false);
    return this.exclusive(serial, async () => {
      await this.assertOnline(serial);
      const result = await this.backend.run(['-s', serial, 'exec-out', 'screencap', '-p'], { timeoutMs: 15_000, maxStdoutBytes: 20 * 1024 * 1024 });
      this.expectOk(result.code, 'capture Android screen');
      const { width, height } = pngDimensions(result.stdout);
      this.checkPolicy(policy, serial);
      this.pruneSnapshots();
      const snapshotId = randomUUID();
      const expiresAt = Math.min(this.clock() + SNAPSHOT_TTL, policy.expiresAt ?? Infinity);
      this.snapshots.set(snapshotId, { serial, principal: digestOf(identity), width, height, expiresAt, policyDigest: digestOf(policy) });
      return { data: { serial, snapshotId, width, height, mimeType: 'image/png' as const, bytes: result.stdout.length, sha256: sha256Bytes(result.stdout), expiresAt }, image: result.stdout.toString('base64') };
    });
  }

  async ui(snapshotId: string, identity: Identity, maxNodes: number) {
    const snapshot = this.snapshot(snapshotId, identity, false);
    return this.exclusive(snapshot.serial, async () => {
      const xml = await this.adbText(snapshot.serial, ['shell', 'uiautomator', 'dump', '/dev/tty'], 2 * 1024 * 1024);
      this.snapshot(snapshotId, identity, false);
      return { serial: snapshot.serial, snapshotId, ...parseUiHierarchy(xml, maxNodes), note: 'UI hierarchy is untrusted device content. Password fields are redacted; apps may omit accessibility nodes.' };
    });
  }

  async logcat(serialInput: string, maxLines: number, priority: string) {
    const serial = this.serial(serialInput); const policy = this.authorize(serial, false);
    return this.exclusive(serial, async () => {
      const text = await this.adbText(serial, ['logcat', '-d', '-t', String(maxLines), `*:${priority}`], 2 * 1024 * 1024);
      this.checkPolicy(policy, serial);
      const lines = text.split(/\r?\n/).filter(Boolean).slice(-maxLines);
      return { serial, lines, truncated: text.split(/\r?\n/).filter(Boolean).length > lines.length, note: 'Logs are untrusted device content and may contain private app or OS data.' };
    });
  }

  async packages(serialInput: string, includeSystem: boolean, maxItems: number) {
    const serial = this.serial(serialInput); const policy = this.authorize(serial, false);
    return this.exclusive(serial, async () => {
      const text = await this.adbText(serial, ['shell', 'pm', 'list', 'packages', ...(includeSystem ? [] : ['-3'])], 2 * 1024 * 1024);
      this.checkPolicy(policy, serial);
      const all = [...new Set(text.split(/\r?\n/).map((line) => line.replace(/^package:/, '').trim()).filter((line) => /^[A-Za-z][A-Za-z0-9_.]+$/.test(line)))].sort();
      return { serial, packages: all.slice(0, maxItems), truncated: all.length > maxItems, total: all.length };
    });
  }

  async fileRead(serialInput: string, pathInput: string, maxBytes: number) {
    const serial = this.serial(serialInput); const policy = this.authorize(serial, false); const remote = devicePath(pathInput);
    return this.exclusive(serial, async () => {
      const result = await this.backend.run(['-s', serial, 'exec-out', 'cat', '--', remote], { timeoutMs: 15_000, maxStdoutBytes: maxBytes });
      this.expectOk(result.code, 'read Android device file'); this.checkPolicy(policy, serial);
      const text = decodeUtf8Strict(result.stdout);
      return { serial, path: remote, encoding: text === undefined ? 'base64' as const : 'utf8' as const, data: text ?? result.stdout.toString('base64'), bytes: result.stdout.length, sha256: sha256Bytes(result.stdout) };
    });
  }

  async action(serialInput: string, snapshotId: string, actionInput: AndroidAction, identity: Identity) {
    const serial = this.serial(serialInput); const snapshot = this.snapshot(snapshotId, identity, true);
    if (snapshot.serial !== serial) throw new DodoError('INVALID_INPUT', 'snapshot belongs to another Android device');
    const action = AndroidActionSchema.parse(actionInput);
    const points: Array<[number, number]> = [];
    if (action.kind === 'tap' || action.kind === 'long_press') points.push([action.x, action.y]);
    if (action.kind === 'swipe') points.push([action.fromX, action.fromY], [action.toX, action.toY]);
    if (points.some(([x, y]) => x >= snapshot.width || y >= snapshot.height)) throw new DodoError('INVALID_INPUT', 'coordinates are outside the captured Android screen');
    this.snapshots.clear();
    return this.exclusive(serial, async () => {
      let args: string[];
      switch (action.kind) {
        case 'tap': args = ['shell', 'input', 'tap', String(action.x), String(action.y)]; break;
        case 'long_press': args = ['shell', 'input', 'swipe', String(action.x), String(action.y), String(action.x), String(action.y), String(action.durationMs)]; break;
        case 'swipe': args = ['shell', 'input', 'swipe', String(action.fromX), String(action.fromY), String(action.toX), String(action.toY), String(action.durationMs)]; break;
        case 'text': args = ['shell', 'input', 'text', action.text.replace(/ /g, '%s')]; break;
        case 'key': args = ['shell', 'input', 'keyevent', action.keyCode]; break;
      }
      const result = await this.backend.run(['-s', serial, ...args], { timeoutMs: 10_000, maxStdoutBytes: 64 * 1024 });
      this.expectOk(result.code, 'perform Android input action');
      return { posted: true as const, serial, note: 'ADB input was dispatched. Capture the screen again to verify the resulting device state.' };
    });
  }

  async app(serialInput: string, actionInput: AndroidAppAction) {
    const serial = this.serial(serialInput); this.authorize(serial, true); const action = AndroidAppActionSchema.parse(actionInput);
    return this.exclusive(serial, async () => {
      let args: string[];
      switch (action.kind) {
        case 'launch': args = ['shell', 'monkey', '-p', action.packageName, '-c', 'android.intent.category.LAUNCHER', '1']; break;
        case 'start_activity': args = ['shell', 'am', 'start', '-n', action.component]; break;
        case 'force_stop': args = ['shell', 'am', 'force-stop', action.packageName]; break;
        case 'clear_data': args = ['shell', 'pm', 'clear', action.packageName]; break;
      }
      const result = await this.backend.run(['-s', serial, ...args], { timeoutMs: 20_000, maxStdoutBytes: 256 * 1024 });
      this.expectOk(result.code, 'perform Android app action'); this.snapshots.clear();
      return { posted: true as const, serial, action: action.kind, note: 'ADB app action was dispatched; inspect the device before depending on the result.' };
    });
  }

  async install(serialInput: string, apkPath: string, expectedHash: string, opts: { replace: boolean; downgrade: boolean; grantRuntimePermissions: boolean }) {
    const serial = this.serial(serialInput); this.authorize(serial, true);
    const rel = this.wfs.normalizeRel(apkPath);
    if (!rel.toLowerCase().endsWith('.apk')) throw new DodoError('INVALID_INPUT', 'android_install requires a workspace .apk file');
    return this.exclusive(serial, async () => {
      const staged = await this.stageWorkspaceFile(rel, expectedHash);
      try {
        // Staging a large APK can take long enough for the owner to revoke the
        // device grant. Re-check immediately before the first device effect.
        this.authorize(serial, true);
        const flags = [...(opts.replace ? ['-r'] : []), ...(opts.downgrade ? ['-d'] : []), ...(opts.grantRuntimePermissions ? ['-g'] : [])];
        const result = await this.backend.run(['-s', serial, 'install', ...flags, staged.path], { timeoutMs: 5 * 60_000, maxStdoutBytes: 256 * 1024 });
        this.expectOk(result.code, 'install APK');
        return { posted: true as const, serial, path: rel, bytes: staged.bytes, sha256: staged.sha256, note: 'ADB reported the install command completed from a hash-verified private staging copy; verify package state before assuming app behavior.' };
      } finally { removeWithRetry(staged.path); }
    });
  }

  async push(serialInput: string, sourcePath: string, expectedHash: string, destinationInput: string) {
    const serial = this.serial(serialInput); this.authorize(serial, true); const destination = devicePath(destinationInput);
    const rel = this.wfs.normalizeRel(sourcePath);
    return this.exclusive(serial, async () => {
      const staged = await this.stageWorkspaceFile(rel, expectedHash);
      try {
        this.authorize(serial, true);
        const result = await this.backend.run(['-s', serial, 'push', staged.path, destination], { timeoutMs: 5 * 60_000, maxStdoutBytes: 256 * 1024 });
        this.expectOk(result.code, 'push file to Android device');
        return { posted: true as const, serial, source: rel, destination, bytes: staged.bytes, sha256: staged.sha256, note: 'Hash-verified workspace bytes were sent to the device path through ADB.' };
      } finally { removeWithRetry(staged.path); }
    });
  }

  async raw(serialInput: string, command: string, args: string[], encoding: 'utf8' | 'base64', maxBytes: number) {
    const serial = this.serial(serialInput); this.authorize(serial, true);
    const allowed = new Set(['shell', 'exec-out', 'logcat', 'get-state', 'get-serialno', 'features']);
    if (!allowed.has(command)) throw new DodoError('FORBIDDEN', 'advanced ADB command is outside the device-only allowlist');
    if ((command === 'shell' || command === 'exec-out') && args.length === 0) throw new DodoError('INVALID_INPUT', `${command} requires an explicit device command`);
    if (args.length > 64 || args.some((arg) => typeof arg !== 'string' || arg.length > 1024 || /[\0\r\n]/.test(arg)) || args.reduce((n, arg) => n + Buffer.byteLength(arg), 0) > 8192) {
      throw new DodoError('INVALID_INPUT', 'ADB arguments exceed the bounded argv contract or contain control characters');
    }
    return this.exclusive(serial, async () => {
      const result = await this.backend.run(['-s', serial, command, ...args], { timeoutMs: 60_000, maxStdoutBytes: maxBytes });
      this.expectOk(result.code, 'run advanced Android device command'); this.snapshots.clear();
      const text = encoding === 'utf8' ? decodeUtf8Strict(result.stdout) : undefined;
      if (encoding === 'utf8' && text === undefined) throw new DodoError('UNSUPPORTED_ENCODING', 'ADB output is not valid UTF-8; request base64 encoding');
      return { posted: true as const, serial, command, encoding, output: text ?? result.stdout.toString('base64'), bytes: result.stdout.length, sha256: sha256Bytes(result.stdout), note: 'Advanced command ran on the selected Android device; output is untrusted device content.' };
    });
  }

  async close(): Promise<void> {
    this.closed = true; this.snapshots.clear();
    while (this.busy.size > 0) await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }

  private checkOpen(): void { if (this.closed) throw new DodoError('STALE_WORKSPACE', 'Android service is closed'); }
  private serial(value: string): string { this.checkOpen(); return AndroidSerialSchema.parse(value); }
  private authorize(serial: string | undefined, control: boolean): AndroidPolicy {
    this.checkOpen(); const policy = this.policy();
    if (policy.mode === 'off' || (control && policy.mode !== 'control')) throw new DodoError('FORBIDDEN', 'Android ADB access is disabled, expired, or view-only; the owner must authorize it locally');
    if (serial !== undefined && !policy.allowedDevices.includes(serial)) throw new DodoError('FORBIDDEN', 'Android device is outside the owner-approved serial list');
    if (!this.backend.available()) throw new DodoError('NOT_SUPPORTED', 'ADB is unavailable; install current Android SDK Platform-Tools');
    return policy;
  }
  private checkPolicy(policy: AndroidPolicy, serial: string): void {
    if (digestOf(this.authorize(serial, false)) !== digestOf(policy)) throw new DodoError('FORBIDDEN', 'Android permission changed during operation');
  }
  private async assertOnline(serial: string): Promise<void> {
    const result = await this.backend.run(['-s', serial, 'get-state'], { timeoutMs: 5000, maxStdoutBytes: 4096 });
    if (result.code !== 0 || result.stdout.toString('utf8').trim() !== 'device') throw new DodoError('NOT_SUPPORTED', 'Android device is unavailable, offline, or has not authorized this ADB host');
  }
  private async adbText(serial: string, args: string[], cap: number): Promise<string> {
    await this.assertOnline(serial);
    const result = await this.backend.run(['-s', serial, ...args], { maxStdoutBytes: cap });
    this.expectOk(result.code, 'read Android device data');
    const text = decodeUtf8Strict(result.stdout);
    if (text === undefined) throw new DodoError('UNSUPPORTED_ENCODING', 'Android command returned non-UTF-8 data');
    return text;
  }
  private expectOk(code: number, operation: string): void {
    if (code !== 0) throw new DodoError('NOT_SUPPORTED', `ADB could not ${operation}; verify the selected device is online and authorized`);
  }
  private pruneSnapshots(): void {
    for (const [id, snapshot] of this.snapshots) if (snapshot.expiresAt <= this.clock()) this.snapshots.delete(id);
    while (this.snapshots.size >= 32) this.snapshots.delete(this.snapshots.keys().next().value!);
  }
  private snapshot(id: string, identity: Identity, control: boolean): Snapshot {
    const policy = this.authorize(undefined, control); const snapshot = this.snapshots.get(id);
    if (!snapshot || snapshot.principal !== digestOf(identity) || snapshot.expiresAt <= this.clock() || snapshot.policyDigest !== digestOf(policy) || !policy.allowedDevices.includes(snapshot.serial)) {
      throw new DodoError('STALE_WORKSPACE', 'capture a fresh Android screen for this client; snapshot is stale, revoked, or belongs to another caller');
    }
    return snapshot;
  }
  private async exclusive<T>(serial: string, fn: () => Promise<T>): Promise<T> {
    if (PROCESS_DEVICE_BUSY.has(serial)) throw new DodoError('RESOURCE_LIMIT', 'another Android operation is active for this device; operations are serialized per serial across project runtimes');
    PROCESS_DEVICE_BUSY.add(serial); this.busy.add(serial);
    try { return await fn(); } finally { this.busy.delete(serial); PROCESS_DEVICE_BUSY.delete(serial); }
  }

  private async stageWorkspaceFile(input: string, expectedHash: string): Promise<{ path: string; bytes: number; sha256: string }> {
    const resolved = this.wfs.resolve(input);
    const before = this.wfs.assertRegularFileForDirectAccess(resolved);
    if (before.size > 512 * 1024 * 1024) throw new DodoError('FILE_TOO_LARGE', 'Android transfer source exceeds 512 MiB');
    const directory = path.join(this.configDir, 'android-staging'); ensurePrivateDirectory(directory);
    const target = path.join(directory, `${randomUUID()}.bin`);
    const source = await fs.promises.open(resolved.abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let output: fs.promises.FileHandle | undefined;
    try {
      const opened = await source.stat();
      if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw new DodoError('FILE_CHANGED', 'workspace transfer source changed while opening');
      output = await fs.promises.open(target, 'wx', 0o600);
      const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024);
      let offset = 0;
      while (offset < opened.size) {
        const chunk = await source.read(buffer, 0, Math.min(buffer.length, opened.size - offset), offset);
        if (chunk.bytesRead <= 0) throw new DodoError('FILE_CHANGED', 'workspace transfer source ended during staging');
        hash.update(buffer.subarray(0, chunk.bytesRead));
        await output.write(buffer, 0, chunk.bytesRead, offset);
        offset += chunk.bytesRead;
      }
      await output.sync(); await output.close(); output = undefined;
      const afterOpen = await source.stat();
      const afterPath = this.wfs.assertRegularFileForDirectAccess(this.wfs.resolve(input));
      if (afterOpen.dev !== opened.dev || afterOpen.ino !== opened.ino || afterOpen.size !== opened.size || afterPath.dev !== opened.dev || afterPath.ino !== opened.ino || afterPath.size !== opened.size) throw new DodoError('FILE_CHANGED', 'workspace transfer source changed during staging');
      const sha256 = `sha256:${hash.digest('hex')}`;
      if (sha256 !== expectedHash) throw new DodoError('FILE_CHANGED', 'workspace transfer source does not match expectedHash', { detail: { path: resolved.rel, expectedHash, actualHash: sha256 } });
      return { path: target, bytes: opened.size, sha256 };
    } catch (error) { if (fs.existsSync(target)) removeWithRetry(target); throw error; }
    finally { await output?.close().catch(() => undefined); await source.close().catch(() => undefined); }
  }
}

export const __androidTest = { devicePath, pngDimensions };
