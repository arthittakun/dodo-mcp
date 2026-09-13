import { randomBytes } from 'node:crypto';
import { DodoError } from '../errors.js';
import type { Store } from '../store/store.js';

/**
 * Static OAuth client preregistration (spec §8.3): the local owner copies the
 * EXACT redirect URI the client UI shows (no wildcards) and registers it.
 * The generated secret is printed once, locally, and stored only as part of
 * the provider client payload the library expects.
 */
export interface RegisteredClientInfo {
  clientId: string;
  clientSecret?: string;
  redirectUris: string[];
  name: string;
  tokenEndpointAuthMethod: string;
}

export function addStaticClient(
  store: Store,
  opts: { redirectUris: string[]; name?: string; public?: boolean },
): RegisteredClientInfo {
  if (opts.redirectUris.length === 0) throw new DodoError('INVALID_INPUT', 'at least one --redirect-uri is required');
  for (const uri of opts.redirectUris) {
    let parsed: URL;
    try {
      parsed = new URL(uri);
    } catch {
      throw new DodoError('INVALID_INPUT', `redirect URI is not a valid URL: ${uri}`);
    }
    if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
      throw new DodoError('INVALID_INPUT', 'redirect URIs must be https (or loopback for local testing)');
    }
    if (uri.includes('*')) throw new DodoError('INVALID_INPUT', 'wildcard redirect URIs are not allowed');
    if (parsed.hash !== '') throw new DodoError('INVALID_INPUT', 'redirect URIs must not contain a fragment');
  }
  const clientId = `dodo-client-${randomBytes(6).toString('hex')}`;
  const isPublic = opts.public === true;
  const clientSecret = isPublic ? undefined : randomBytes(32).toString('base64url');
  const payload: Record<string, unknown> = {
    client_id: clientId,
    client_name: opts.name ?? 'dodo remote client',
    redirect_uris: opts.redirectUris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: isPublic ? 'none' : 'client_secret_basic',
    application_type: 'web',
  };
  if (clientSecret) payload['client_secret'] = clientSecret;
  store.putOAuthClient(clientId, payload);
  const info: RegisteredClientInfo = {
    clientId,
    redirectUris: opts.redirectUris,
    name: (payload['client_name'] as string) ?? 'dodo remote client',
    tokenEndpointAuthMethod: payload['token_endpoint_auth_method'] as string,
  };
  if (clientSecret !== undefined) info.clientSecret = clientSecret;
  return info;
}

export function listStaticClients(store: Store): Array<{ clientId: string; name: string; redirectUris: string[]; createdAt: number }> {
  return store.listOAuthClients().map((c) => ({
    clientId: c.clientId,
    name: (c.payload['client_name'] as string) ?? '',
    redirectUris: (c.payload['redirect_uris'] as string[]) ?? [],
    createdAt: c.createdAt,
  }));
}
