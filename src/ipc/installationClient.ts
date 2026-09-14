import { z } from 'zod';
import { ipcSocketPath, statePaths } from '../config/paths.js';
import { openDatabaseReadonly } from '../store/db.js';
import { Store } from '../store/store.js';
import { mintWorkspaceId } from '../workspace/identity.js';
import { ipcCall, IpcError } from './client.js';

const Instance = z.object({
  socketKey: z.string().regex(/^[a-f0-9]{32}$/),
  workspaceId: z.string(),
  root: z.string(),
}).strict();

const Status = z.object({
  pid: z.number().int().positive(),
  root: z.string(),
  workspaceId: z.string(),
  transport: z.enum(['http', 'stdio']),
}).loose();

/**
 * Find the one live HTTP installation process from its authenticated,
 * per-instance owner endpoints. This deliberately does not derive an IPC
 * name from process.cwd(): OAuth registration and consent are installation
 * operations. The final command is sent once, so an uncertain effectful
 * result is never replayed against another endpoint.
 */
export async function installationIpcCall(
  configDir: string,
  cmd: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  const db = openDatabaseReadonly(statePaths(configDir).dbFile);
  if (!db) throw new IpcError('no running DODO installation (start it with `dodo`)');
  const candidates: Array<{ socket: string; workspaceId: string; root: string }> = [];
  try {
    const store = new Store(db);
    const secret = store.readInstallSecret();
    if (!secret) throw new IpcError('DODO installation identity is unavailable');
    const rows = db.prepare("SELECT value FROM meta WHERE key LIKE 'ipc-instance:%' ORDER BY key LIMIT 10001").all() as Array<{ value: string }>;
    if (rows.length > 10000) throw new IpcError('too many DODO owner endpoints to inspect safely');
    for (const row of rows) {
      const parsed = Instance.safeParse(safeJson(row.value));
      if (!parsed.success || mintWorkspaceId(secret, parsed.data.root) !== parsed.data.workspaceId) continue;
      candidates.push({
        socket: ipcSocketPath(configDir, parsed.data.socketKey, { createDirectory: false }),
        workspaceId: parsed.data.workspaceId,
        root: parsed.data.root,
      });
    }
  } finally {
    db.close();
  }

  const byPid = new Map<number, { socket: string }>();
  for (const candidate of candidates) {
    try {
      const status = Status.parse(await ipcCall(candidate.socket, 'status', {}, 1500));
      if (status.transport !== 'http' || status.workspaceId !== candidate.workspaceId || status.root !== candidate.root) continue;
      if (!byPid.has(status.pid)) byPid.set(status.pid, { socket: candidate.socket });
    } catch (error) {
      if (!(error instanceof IpcError && error.message.startsWith('no running DODO server'))) throw error;
    }
  }
  if (byPid.size === 0) throw new IpcError('no running DODO installation (start it with `dodo`)');
  if (byPid.size > 1) throw new IpcError('multiple DODO HTTP processes use this installation; close extras with `dodo kill` before reviewing OAuth consent');
  const target = [...byPid.values()][0];
  if (!target) throw new IpcError('no running DODO installation (start it with `dodo`)');
  return ipcCall(target.socket, cmd, args);
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}
