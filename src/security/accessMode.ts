import type { Store } from '../store/store.js';

export const ACCESS_MODE_META_KEY = 'owner-access-mode';
export type AccessMode = 'personal' | 'managed';

/**
 * Personal mode is DODO's single-owner default. OAuth still identifies the
 * installed client and limits token scopes, while registered projects become
 * available without a second per-project ACL/profile ceremony.
 *
 * Managed mode keeps the original project ACL, trust and AI egress allowlists
 * for owners who share one installation between independently trusted clients.
 */
export function accessMode(store: Store): AccessMode {
  return store.getMeta(ACCESS_MODE_META_KEY) === 'managed' ? 'managed' : 'personal';
}

export function setAccessMode(store: Store, mode: AccessMode): void {
  store.setMeta(ACCESS_MODE_META_KEY, mode);
}

export function isPersonalMode(store: Store): boolean {
  return accessMode(store) === 'personal';
}
