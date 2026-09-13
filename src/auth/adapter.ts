import type { Adapter, AdapterPayload } from 'oidc-provider';
import type { Store } from '../store/store.js';

/**
 * oidc-provider persistence adapter backed by SQLite (spec §5, §8).
 * The provider's own serializers are used untouched — DODO never invents its
 * own OAuth token formats. Model `Client` resolves against the static
 * registrations table so `dodo auth add-client` entries are live without a
 * provider restart.
 */
export function createAdapterFactory(store: Store): (name: string) => Adapter {
  return (name: string) => new SqliteOidcAdapter(store, name);
}

class SqliteOidcAdapter implements Adapter {
  constructor(
    private readonly store: Store,
    private readonly name: string,
  ) {}

  async upsert(id: string, payload: AdapterPayload, expiresIn?: number): Promise<void> {
    this.store.oauthUpsert(this.name, id, payload as Record<string, unknown>, expiresIn);
  }

  async find(id: string): Promise<AdapterPayload | undefined> {
    if (this.name === 'Client') {
      return this.store.getOAuthClient(id) as AdapterPayload | undefined;
    }
    return this.store.oauthFind(this.name, id) as AdapterPayload | undefined;
  }

  async findByUserCode(userCode: string): Promise<AdapterPayload | undefined> {
    return this.store.oauthFindByUserCode(this.name, userCode) as AdapterPayload | undefined;
  }

  async findByUid(uid: string): Promise<AdapterPayload | undefined> {
    return this.store.oauthFindByUid(this.name, uid) as AdapterPayload | undefined;
  }

  async consume(id: string): Promise<void> {
    this.store.oauthConsume(this.name, id);
  }

  async destroy(id: string): Promise<void> {
    this.store.oauthDestroy(this.name, id);
  }

  async revokeByGrantId(grantId: string): Promise<void> {
    this.store.oauthRevokeByGrantId(grantId);
  }
}
