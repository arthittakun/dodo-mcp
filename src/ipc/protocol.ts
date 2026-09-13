/**
 * Private local IPC: challenge/HMAC-authenticated JSON over a Unix socket
 * or Windows named pipe. Per-listener credentials live in owner-private
 * state (POSIX permissions or Windows DACL). The token is never sent on the
 * wire or inherited by jobs. Same-OS-user processes remain trusted; IPC is
 * not an isolation boundary against the machine owner.
 */
export interface IpcRequest {
  id: number;
  cmd: string;
  args?: Record<string, unknown>;
}

export type IpcResponse = { id: number; ok: true; data: unknown } | { id: number; ok: false; error: string };

export interface StatusData {
  version: string;
  pid: number;
  root: string;
  workspaceId: string;
  workspaceEpoch: string;
  port: number;
  locked: boolean;
  publicUrl: string | null;
  trustMode: string;
  runningJobs: number;
  recoveryRequired: string[];
  transport: 'http' | 'stdio';
}
