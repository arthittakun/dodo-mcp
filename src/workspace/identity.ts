import { createHash } from 'node:crypto';
import { newId } from '../util/hash.js';

/**
 * Workspace identity (spec §6):
 * - workspaceId: opaque, server-minted, stable per (canonical root, install);
 *   derived with the install secret so the id itself reveals nothing about
 *   the path and cannot be forged by a client.
 * - workspaceEpoch: fresh random id per server boot.
 */
export function mintWorkspaceId(installSecret: string, rootRealPath: string): string {
  const digest = createHash('sha256').update(installSecret).update('\0').update(rootRealPath).digest('hex');
  return `ws_${digest.slice(0, 20)}`;
}

export function mintEpoch(): string {
  return newId('boot', 10);
}
