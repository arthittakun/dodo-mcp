import type { RecoveryEntry, RecoveryManifest } from './contracts.js';
import type { DeploymentTarget } from './deploymentContracts.js';
import { DodoError } from '../../errors.js';
import { digestOf } from '../../util/hash.js';

/** Ignore directory inodes, never file bytes, permissions or coverage. */
export function recoverySourceDigest(entries: RecoveryEntry[]): string {
  return digestOf(entries.map(({ path, kind, hash, bytes, mode }) => ({ path, kind, hash, bytes, mode }))
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export function buildContextEntries(manifest: RecoveryManifest, target: DeploymentTarget): RecoveryEntry[] {
  const root = target.contextRoot;
  const entries = manifest.entries.filter(e => e.kind !== 'absent' && (root === '.' || e.path.startsWith(root + '/')))
    .map(e => ({ ...e, path: root === '.' ? e.path : e.path.slice(root.length + 1) }));
  if (!entries.some(e => e.path === target.dockerfile && e.kind === 'file'))
    throw new DodoError('NOT_FOUND', 'approved Dockerfile is not in the complete source checkpoint');
  // Ignore files participate in the sealed context digest. They can only remove
  // already-allowed source; image source recovery still requires exact coverage.
  return entries;
}

export function mappedSourceEntries(manifest: RecoveryManifest, target: DeploymentTarget): RecoveryEntry[] {
  if (!target.sourceMapping) throw new DodoError('NOT_SUPPORTED', 'owner has not declared an image source mapping');
  const root = target.sourceMapping.workspaceRoot;
  return manifest.entries.filter(e => e.kind !== 'absent' && (root === '.' || e.path.startsWith(root + '/')))
    .map(e => ({ ...e, path: root === '.' ? e.path : e.path.slice(root.length + 1) }));
}

export function sourceComparison(expected: RecoveryEntry[], current: RecoveryEntry[], limit = 50) {
  const before = new Map(expected.map(e => [e.path, e]));
  const after = new Map(current.map(e => [e.path, e]));
  const changes: Array<{ path: string; change: 'added' | 'modified' | 'deleted' }> = [];
  for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const a = before.get(path), b = after.get(path);
    if (recoverySourceDigest(a ? [a] : []) !== recoverySourceDigest(b ? [b] : []))
      changes.push({ path, change: !b || b.kind === 'absent' ? 'deleted' : !a || a.kind === 'absent' ? 'added' : 'modified' });
  }
  return { matches: !changes.length, changedCount: changes.length, changes: changes.slice(0, limit), truncated: changes.length > limit };
}
