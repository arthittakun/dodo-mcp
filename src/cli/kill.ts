import fs from 'node:fs';
import { ipcIdentity } from '../ipc/authentication.js';
import { z } from 'zod';
import { ipcSocketPath, statePaths } from '../config/paths.js';
import { openDatabaseReadonly } from '../store/db.js';
import { Store } from '../store/store.js';
import { mintWorkspaceId } from '../workspace/identity.js';
import { ipcCall, IpcError } from '../ipc/client.js';

const LiveStatus = z.looseObject({
  pid: z.number().int().positive(), root: z.string().min(1).max(4096),
  workspaceId: z.string(), workspaceEpoch: z.string().min(1),
  version: z.string(), transport: z.enum(['http', 'stdio']),
});
type Status = z.infer<typeof LiveStatus>;
type Candidate = { id: string; root: string; socket: string; instance?: boolean };
export interface KillReport {
  configDir: string;
  stopped: Array<{ pid: number; root: string; transport: string }>;
  failed: Array<{ root: string; reason: string }>;
  authPreserved: true;
}

/** Owner-only shutdown discovery. Never sends signals to PIDs or scans ports. */
export async function killServers(configDir: string, timeoutMs = 30_000): Promise<KillReport> {
  const report: KillReport = { configDir, stopped: [], failed: [], authPreserved: true };
  const dbFile = statePaths(configDir).dbFile;
  if (!fs.existsSync(dbFile)) return report;
  const db = openDatabaseReadonly(dbFile);
  if (!db) throw new Error('cannot read DODO state; no processes were stopped');
  const candidates: Candidate[] = [];
  try {
    const secret = new Store(db).readInstallSecret();
    if (!secret) throw new Error('DODO installation identity is missing; no processes were stopped');
    let roots = db.prepare('SELECT id, root FROM workspaces ORDER BY root LIMIT 10001').all() as Array<{ id: string; root: string }>;
    if (roots.length > 10000) throw new Error('too many workspace records to inspect safely; use dodo stop for a specific workspace');
    roots = roots.filter(w => typeof w.root === 'string' && typeof w.id === 'string' && w.id === mintWorkspaceId(secret, w.root));
    for (const w of roots) candidates.push({ ...w, socket: ipcSocketPath(configDir, w.id, { createDirectory: false }) });
    const instances = db.prepare("SELECT value FROM meta WHERE key LIKE 'ipc-instance:%' LIMIT 10001").all() as Array<{ value: string }>;
    if (instances.length > 10000) throw new Error('too many instance records to inspect safely');
    const Instance = z.object({ socketKey: z.string().regex(/^[a-f0-9]{32}$/), workspaceId: z.string(), root: z.string() }).strict();
    for (const row of instances) {
      try {
        const i = Instance.parse(JSON.parse(row.value));
        if (!roots.some(w => w.id === i.workspaceId && w.root === i.root)) continue;
        candidates.unshift({ id: i.workspaceId, root: i.root, socket: ipcSocketPath(configDir, i.socketKey, { createDirectory: false }), instance: true });
      } catch { /* malformed historical metadata cannot authorize a target */ }
    }
  } finally { db.close(); }

  // Probe all candidates before stopping anything, so root aliases cannot race
  // their per-instance endpoints. Never trust stored PIDs as signal targets.
  const live = new Map<number, { candidate: Candidate; status: Status; identity: string }>();
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(8, candidates.length) }, async () => {
    while (index < candidates.length) {
      const w = candidates[index++]!, { socket } = w;
      try {
        const original = socketIdentity(socket);
        if (!original) continue;
        let status: Status;
        try { status = LiveStatus.parse(await ipcCall(socket, 'status', {}, 1500)); }
        catch (e) { if (isNotRunning(e)) continue; throw e; }
        if (status.workspaceId !== w.id || status.root !== w.root) throw new Error('IPC identity does not match the registered workspace');
        if (socketIdentity(socket) !== original) throw new Error('server changed while checking; retry dodo kill');
        if (!live.has(status.pid) || (w.instance && !live.get(status.pid)!.candidate.instance)) live.set(status.pid, { candidate: w, status, identity: original });
      } catch (e) {
        if (!isNotRunning(e)) report.failed.push({ root: w.root, reason: e instanceof Error ? e.message : 'shutdown failed' });
      }
    }
  }));
  const targets = [...live.values()];
  index = 0;
  await Promise.all(Array.from({ length: Math.min(8, targets.length) }, async () => {
    while (index < targets.length) {
      const { candidate: w, status, identity } = targets[index++]!;
      try {
        if (socketIdentity(w.socket) !== identity) throw new Error('server changed before shutdown; retry dodo kill');
        const result = await ipcCall(w.socket, 'stop', { expectedPid: status.pid, expectedEpoch: status.workspaceEpoch }, 1500);
        if (!z.object({ stopping: z.literal(true) }).safeParse(result).success) throw new Error('server did not acknowledge shutdown');
        const deadline = Date.now() + timeoutMs;
        while (socketIdentity(w.socket) === identity) {
          if (Date.now() >= deadline) throw new Error('shutdown is still draining work; retry status later (no force kill sent)');
          await new Promise<void>(resolve => setTimeout(resolve, 100));
        }
        report.stopped.push({ pid: status.pid, root: status.root, transport: status.transport });
      } catch (e) {
        if (!isNotRunning(e)) report.failed.push({ root: w.root, reason: e instanceof Error ? e.message : 'shutdown failed' });
      }
    }
  }));
  report.stopped.sort((a, b) => a.root.localeCompare(b.root));
  report.failed.sort((a, b) => a.root.localeCompare(b.root));
  return report;
}

function isNotRunning(e: unknown): boolean {
  return e instanceof IpcError && e.message.startsWith('no running DODO server');
}

function socketIdentity(socket: string): string | undefined {
  return ipcIdentity(socket);
}
