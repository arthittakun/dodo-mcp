import Provider from 'oidc-provider';
import type { Configuration } from 'oidc-provider';
import { createAdapterFactory } from './adapter.js';
import type { Store } from '../store/store.js';
import type { JwksFile } from './keys.js';
import { ALL_SCOPES } from '../security/policy.js';
import { OWNER_ACCOUNT_ID } from './constants.js';

/**
 * Embedded OAuth 2.1 / OIDC Authorization Server (spec §8) built on
 * `oidc-provider` — protocol, PKCE, token formats and rotation are the
 * library's, never hand-rolled.
 *
 * Issuer  = configured public origin  (e.g. https://dodo.example.com)
 * Resource = issuer + /mcp            (exact audience for access tokens)
 */
export interface BuildProviderOptions {
  issuer: string; // public origin
  resourceUrl: string; // issuer + '/mcp'
  store: Store;
  jwks: JwksFile;
  cookieKeys: string[];
  /** Static id, or a getter for the ACTIVE workspace when it can be switched at runtime (ADR-019). */
  workspaceId: string | (() => string);
  accessTokenTtlSec?: number;
}

export { OWNER_ACCOUNT_ID } from './constants.js';

export function buildProvider(opts: BuildProviderOptions): Provider {
  const { store, resourceUrl } = opts;
  const activeWorkspaceId = (): string => (typeof opts.workspaceId === 'function' ? opts.workspaceId() : opts.workspaceId);
  const scopeString = ALL_SCOPES.join(' ');

  const configuration: Configuration = {
    adapter: createAdapterFactory(store),
    clients: [],
    jwks: { keys: opts.jwks.keys as never },
    cookies: {
      keys: opts.cookieKeys,
      short: { signed: true, httpOnly: true, sameSite: 'lax' },
      long: { signed: true, httpOnly: true, sameSite: 'lax' },
    },
    // dodo:* are advertised both as global scopes (so the authorization
    // request's `scope` param is accepted) and as resource scopes via
    // resourceIndicators below (so the access token's audience is the /mcp
    // resource). The grant binds both levels; the verifier still checks the
    // exact resource audience.
    scopes: ['offline_access', ...ALL_SCOPES],
    claims: {},
    clientDefaults: {
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_basic',
      // The signing key set is ES256-only; align client alg defaults with it.
      id_token_signed_response_alg: 'ES256',
    },
    pkce: {
      required: () => true,
    },
    responseTypes: ['code'],
    interactions: {
      // The default login+consent policy still applies; we simply render the
      // prompt ourselves (owner terminal approval) at this URL. On resume the
      // interaction result carries both login and consent, satisfying it.
      url: (_ctx, interaction) => `/interaction/${interaction.uid}`,
    },
    findAccount: async (_ctx, id) =>
      id === OWNER_ACCOUNT_ID
        ? {
            accountId: OWNER_ACCOUNT_ID,
            claims: async () => ({ sub: OWNER_ACCOUNT_ID }),
          }
        : undefined,
    /**
     * Reuse the DODO grant the owner just approved (or approved earlier) for
     * THIS client and THIS workspace. Consent for the single owner is granted
     * once over local IPC; the flow must not then re-prompt in the browser.
     * A grant bound to a different workspace never authorizes this one (spec
     * §6, AUTH-07) — it is filtered out, forcing a fresh owner approval.
     */
    loadExistingGrant: async (ctx) => {
      const clientId = ctx.oidc.client?.clientId;
      const result = ctx.oidc.result as { login?: { accountId?: string }; consent?: { grantId?: string } } | undefined;
      const accountId = ctx.oidc.session?.accountId ?? result?.login?.accountId;
      if (!clientId || accountId !== OWNER_ACCOUNT_ID) return undefined;
      // Prefer a grantId explicitly carried by the just-submitted interaction.
      const explicit = result?.consent?.grantId;
      const wsId = activeWorkspaceId();
      const candidate =
        (explicit && store.getGrant(explicit)) ||
        store
          .listGrants()
          .filter((g) => g.clientId === clientId && g.revokedAt === null && (g.workspaceId === wsId || store.getMeta(`identity-grant:${g.id}`) === '2'))
          .pop();
      if (!candidate || candidate.revokedAt !== null || (candidate.workspaceId !== wsId && store.getMeta(`identity-grant:${candidate.id}`) !== '2')) return undefined;
      return ctx.oidc.provider.Grant.find(candidate.id);
    },
    issueRefreshToken: async (_ctx, client) => client.grantTypeAllowed('refresh_token'),
    rotateRefreshToken: true,
    extraTokenClaims: async (_ctx, token) => {
      // Preserve the original grant and version across refresh. dodo_ws is
      // retained for legacy tokens; v2 authorization checks the active ACL.
      const grantId = (token as { grantId?: string }).grantId;
      const appGrant = grantId ? store.getGrant(grantId) : undefined;
      return {
        dodo_grant: grantId ?? null,
        dodo_ws: appGrant?.workspaceId ?? null,
        dodo_auth: grantId && store.getMeta(`identity-grant:${grantId}`) === '2' ? 2 : 1,
      };
    },
    ttl: {
      AccessToken: opts.accessTokenTtlSec ?? 600,
      IdToken: 600,
      AuthorizationCode: 60,
      Grant: 30 * 24 * 3600,
      Interaction: 300,
      Session: 14 * 24 * 3600,
      RefreshToken: 30 * 24 * 3600,
    },
    features: {
      devInteractions: { enabled: false },
      revocation: { enabled: true },
      introspection: { enabled: false },
      registration: { enabled: false }, // DCR off by default (spec §8.3)
      rpInitiatedLogout: { enabled: false },
      resourceIndicators: {
        enabled: true,
        defaultResource: () => resourceUrl,
        useGrantedResource: () => true,
        getResourceServerInfo: () => ({
          scope: scopeString,
          audience: resourceUrl,
          accessTokenTTL: opts.accessTokenTtlSec ?? 600,
          accessTokenFormat: 'jwt',
          jwt: { sign: { alg: 'ES256' } },
        }),
      },
    },
    renderError: async (ctx, out, _error) => {
      ctx.type = 'html';
      ctx.body = `<!doctype html><meta charset="utf-8"><title>DODO auth error</title><body style="font-family:system-ui;max-width:36rem;margin:4rem auto"><h1>Authorization error</h1><p>${escapeHtml(
        out.error ?? 'error',
      )}</p><p>${escapeHtml(out.error_description ?? '')}</p></body>`;
    },
  };

  const provider = new Provider(opts.issuer, configuration);
  // The only hop in front of DODO is the owner's local tunnel daemon on
  // loopback; X-Forwarded-Proto from it is trusted so secure-cookie and
  // https checks reflect the public HTTPS origin (ADR-013; Host is
  // allowlisted before the provider ever sees a request).
  provider.proxy = true;
  return provider;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}
