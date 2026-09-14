import { createLocalJWKSet, jwtVerify } from 'jose';
import { OAuthError, OAuthErrorCode, type AuthInfo, type OAuthTokenVerifier } from '@modelcontextprotocol/server';
import type { Store } from '../store/store.js';
import { publicJwks, type JwksFile } from './keys.js';

/**
 * Resource-server token verification (spec §8.5): every call checks
 * issuer, exact audience, expiry, algorithm AND live grant state in the
 * durable store — a revoked grant is rejected immediately, before its access
 * token would expire. Legacy dodo_ws stays root-bound; v2 identity grants
 * additionally intersect token/grant scopes with a live workspace/client ACL.
 */
export interface VerifierOptions {
  issuer: string;
  resourceUrl: string;
  jwks: JwksFile;
  /** Static binding (stdio / tests). */
  workspaceId?: string;
  /** HTTP defers only target binding, never token identity validation. */
  targetRouting?: boolean;
  store?: Store;
  /**
   * Per-call binding: the ACTIVE workspace of a `dodo start` process can be
   * switched by the owner at runtime (ADR-019), so the ACL lookup must read
   * the current workspace on every request, never a captured one.
   */
  active?: () => { workspaceId: string; store: Store };
}

export function buildTokenVerifier(opts: VerifierOptions): OAuthTokenVerifier {
  const jwkSet = createLocalJWKSet(publicJwks(opts.jwks) as Parameters<typeof createLocalJWKSet>[0]);
  const active = (): { workspaceId: string; store: Store } => {
    if (opts.active) return opts.active();
    if (opts.workspaceId === undefined || opts.store === undefined) throw new Error('verifier needs workspaceId+store or active()');
    return { workspaceId: opts.workspaceId, store: opts.store };
  };
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      const { workspaceId, store } = active();
      let payload: Record<string, unknown>;
      try {
        const result = await jwtVerify(token, jwkSet, {
          issuer: opts.issuer,
          audience: opts.resourceUrl,
          algorithms: ['ES256'],
          typ: 'at+jwt',
        });
        payload = result.payload as Record<string, unknown>;
      } catch {
        throw new OAuthError(OAuthErrorCode.InvalidToken, 'invalid access token');
      }
      const grantId = payload['dodo_grant'];
      const tokenWs = payload['dodo_ws'];
      const clientId = payload['client_id'];
      const exp = payload['exp'];
      if (typeof grantId !== 'string' || typeof tokenWs !== 'string' || typeof clientId !== 'string' || typeof exp !== 'number') {
        throw new OAuthError(OAuthErrorCode.InvalidToken, 'invalid access token');
      }
      const grant = store.getGrant(grantId);
      if (!store.getOAuthClient(clientId) || !grant || grant.revokedAt !== null) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, 'grant revoked or unknown');
      }
      if (grant.clientId !== clientId) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, 'client mismatch');
      }
      const identityGrant = payload['dodo_auth'] === 2 && store.getMeta(`identity-grant:${grantId}`) === '2';
      if (!identityGrant && (tokenWs !== grant.workspaceId || (!opts.targetRouting && tokenWs !== workspaceId))) {
        // Token from another workspace on the same hostname: consent is
        // per-workspace; never disclose the current root in the refusal.
        throw new OAuthError(OAuthErrorCode.InvalidToken, 'token is not valid for this workspace');
      }
      let scopes = typeof payload['scope'] === 'string' ? (payload['scope'] as string).split(' ').filter(Boolean) : [];
      const tokenScopes = [...scopes];
      {
        const access = store.clientAccess(workspaceId, clientId);
        scopes = scopes.filter((scope) => access.includes(scope) && grant.scopes.includes(scope));
        // Authentication remains valid with no workspace permissions. Tool gate
        // returns WORKSPACE_ACCESS_REQUIRED without an OAuth relinking challenge.
      }
      return {
        token,
        clientId,
        scopes,
        expiresAt: exp,
        resource: new URL(opts.resourceUrl),
        extra: {
          tokenScopes,
          identityGrant,
          grantId,
          workspaceId,
          sub: typeof payload['sub'] === 'string' ? payload['sub'] : 'owner',
        },
      };
    },
  };
}
