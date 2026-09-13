import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import type net from 'node:net';
import { ipcSocketPath } from '../config/paths.js';
import type { BootstrappedWorkspace } from '../server/bootstrap.js';
import { startIpcServer, type IpcHandler } from './server.js';

/** A private instance endpoint remains discoverable when the root alias is replaced. */
export async function startOwnerControl(ws: BootstrappedWorkspace, handler: IpcHandler) {
  const socketKey = randomBytes(16).toString('hex');
  const instancePath = ipcSocketPath(ws.configDir, socketKey);
  const rootPath = ipcSocketPath(ws.configDir, ws.workspaceId);
  const metaKey = `ipc-instance:${socketKey}`;
  const instance = await startIpcServer(instancePath, handler);
  let root: net.Server | undefined;
  try {
    root = await startIpcServer(rootPath, handler);
    ws.store.setMeta(metaKey, JSON.stringify({ socketKey, workspaceId: ws.workspaceId, root: ws.rootInfo.root }));
  } catch (error) { root?.close(); instance.close(); throw error; }
  const inode = (file: string) => process.platform === 'win32' ? undefined : fs.lstatSync(file).ino;
  const rootInode = inode(rootPath), instanceInode = inode(instancePath), rootServer = root;
  let closing: Promise<void> | undefined;
  return {
    close(): Promise<void> {
      if (!closing) closing = (async () => {
        ws.store.db.prepare('DELETE FROM meta WHERE key = ?').run(metaKey);
        await Promise.all([closeSocket(rootServer, rootPath, rootInode), closeSocket(instance, instancePath, instanceInode)]);
      })();
      return closing;
    },
  };
}
async function closeSocket(server: net.Server, socket: string, inode: number | undefined) {
  await new Promise<void>(resolve => { server.close(() => resolve()); setTimeout(resolve, 500).unref(); });
  if (inode === undefined) return; // named pipes disappear when their handles close
  try { if (fs.lstatSync(socket).ino === inode) fs.unlinkSync(socket); } catch { /* absent/replaced */ }
}
