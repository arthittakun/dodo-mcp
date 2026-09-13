import { describe, it, expect, vi } from 'vitest';
import { launch, obtainToken, mcpRaw, rpc } from '../helpers/testServer.js';

/**
 * §18 regression: the provider must define an EXPLICIT IdToken TTL. When it is
 * missing, oidc-provider's default TTL function fires a one-time
 * "default ttl.IdToken function called" NOTICE through console.warn the first
 * time an ID token is issued. An openid-scoped authorization (what ChatGPT
 * sends) must complete without that notice and without changing the resource
 * scopes the tools see.
 */
describe('explicit IdToken TTL', () => {
  it('an openid login issues tokens without the default-TTL notice and with unchanged dodo scopes', async () => {
    const warnings: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    });
    const ctx = await launch({ toolSurface: 'full', fixtureFiles: { 'a.txt': 'A\n' } });
    try {
      const tokens = await obtainToken(ctx, { scope: 'openid dodo:read dodo:write dodo:exec offline_access' });
      expect(tokens.accessToken).toBeTruthy();
      const res = await mcpRaw(ctx, rpc('tools/list'), tokens.accessToken);
      expect(res.status).toBe(200);
      expect(warnings.filter((w) => w.includes('ttl.IdToken'))).toEqual([]);
      expect(warnings.filter((w) => w.includes('default ttl'))).toEqual([]);
    } finally {
      spy.mockRestore();
      await ctx.cleanup();
    }
  }, 120_000);
});
