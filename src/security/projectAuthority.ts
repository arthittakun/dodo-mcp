import { DodoError } from '../errors.js';
import type { Principal } from '../tools/context.js';
import type { Store } from '../store/store.js';
import { isPersonalMode } from './accessMode.js';
import { projectScopeCeiling } from './projectAccess.js';
export function isOwner(p: Principal): boolean {
  return p.sub === 'owner' && ((p.grantId === 'local-stdio' && p.clientId === 'stdio') || (p.grantId === 'local-config-owner' && p.clientId === 'local-config'));
}
/** Installation tools use the client's live login/scopes, never a project ACL. */
export function installationAuthority(store: Store, p: Principal): Principal {
  if (p.projectRestriction) throw new DodoError('FORBIDDEN', 'project-restricted delegations cannot use installation tools');
  if (p.expiresAt !== undefined && p.expiresAt <= Date.now() / 1000) throw new DodoError('AUTH_REQUIRED', 'authorization expired; authenticate and resume');
  if (isOwner(p)) return { ...p, scopes: [...p.scopes] };
  const grant = store.getGrant(p.grantId);
  if (!grant || grant.revokedAt !== null || grant.clientId !== p.clientId || !store.getOAuthClient(p.clientId)) throw new DodoError('AUTH_REQUIRED', 'authorization was revoked');
  if (p.identityGrant === false || store.getMeta(`identity-grant:${p.grantId}`) !== '2') throw new DodoError('AUTH_REQUIRED', 'reconnect this client to use installation tools with an installation login');
  return { ...p, scopes: (p.tokenScopes ?? p.scopes).filter(scope => grant.scopes.includes(scope)) };
}
/** A delegation can narrow token scopes; live target ACLs and expiry are always re-read. */
export function projectAuthority(store: Store, p: Principal, workspaceId: string): Principal {
  if (store.getMeta('installation-workspace-id') === workspaceId) return installationAuthority(store, p);
  if (p.projectRestriction && p.projectRestriction !== workspaceId) throw new DodoError('FORBIDDEN','delegation is restricted to its target project');
  if (p.expiresAt !== undefined && p.expiresAt <= Date.now() / 1000) throw new DodoError('AUTH_REQUIRED', 'authorization expired; authenticate and resume');
  if (isOwner(p)) return { ...p, scopes: [...p.scopes] };
  const grant = store.getGrant(p.grantId);
  if (!grant || grant.revokedAt !== null || grant.clientId !== p.clientId || !store.getOAuthClient(p.clientId)) throw new DodoError('AUTH_REQUIRED', 'authorization was revoked');
  if ((p.identityGrant === false || store.getMeta(`identity-grant:${p.grantId}`) !== '2') && grant.workspaceId !== workspaceId) throw new DodoError('FORBIDDEN', 'authorization is bound to another workspace');
  const allowed = isPersonalMode(store) ? grant.scopes : store.clientAccess(workspaceId, p.clientId);
  // The owner's Simple Project Access Policy is an additional ceiling: it can
  // only remove scopes, never add them, so the OAuth token stays authoritative.
  const projectCeiling: readonly string[] = projectScopeCeiling(store, workspaceId);
  return { ...p, scopes: (p.tokenScopes ?? p.scopes).filter(s => grant.scopes.includes(s) && allowed.includes(s) && projectCeiling.includes(s)) };
}
