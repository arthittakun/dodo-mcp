import { afterEach, describe, expect, it } from 'vitest';
import type { TunnelRuntime } from '../../src/tunnel/runtime.js';
import { callToolLegacy, launch, obtainToken, type TestContext } from '../helpers/testServer.js';

const running: TestContext[] = [];
afterEach(async () => {
  for (const context of running.splice(0)) await context.cleanup();
});

async function ownerState(context: TestContext): Promise<Record<string, unknown>> {
  if (!context.configUrl) throw new Error('missing Local Config URL');
  const url = new URL(context.configUrl);
  const token = url.hash.slice(1);
  const response = await fetch(`${url.origin}/api/state`, { headers: { authorization: `Bearer ${token}` } });
  expect(response.status).toBe(200);
  return await response.json() as Record<string, unknown>;
}

describe('persistent MCP connection mode', () => {
  it('uses the loopback endpoint as the OAuth issuer and MCP resource in Local mode', async () => {
    const context = await launch({
      connectionMode: 'local',
      configPort: 0,
      configPatch: { publicUrl: 'https://saved-tunnel.example.test' },
    });
    running.push(context);

    expect(context.server.connectionMode).toBe('local');
    expect(context.server.publicUrl).toBe(context.baseUrl);
    const state = await ownerState(context) as { connection: Record<string, unknown> };
    expect(state.connection).toMatchObject({
      connectionMode: 'local',
      activeMcpUrl: `${context.baseUrl}/mcp`,
      mcpLocalUrl: `${context.baseUrl}/mcp`,
      mcpPublicUrl: null,
      activePublicUrl: null,
    });

    const tokens = await obtainToken(context);
    const overview = await callToolLegacy(context, tokens.accessToken, 'project_overview', {});
    expect(overview.isError).toBe(false);
    expect(overview.envelope['ok']).toBe(true);
  }, 60_000);

  it('advertises only the saved public endpoint in Tunnel mode while keeping the upstream loopback-only', async () => {
    const tunnelRuntime = {
      status: () => ({ available: true as const, running: true, current: null, lastKnown: null }),
    } as unknown as TunnelRuntime;
    const publicUrl = 'https://dodo-tunnel.example.test';
    const context = await launch({
      configPort: 0,
      tunnelRuntime,
      configPatch: {
        publicUrl,
        tunnel: {
          connectionMode: 'tunnel',
          credentialRef: { provider: 'env', name: 'FIXTURE_TUNNEL_TOKEN' },
        },
      },
    });
    running.push(context);

    expect(context.server.connectionMode).toBe('tunnel');
    expect(context.server.publicUrl).toBe(publicUrl);
    const state = await ownerState(context) as { connection: Record<string, unknown> };
    expect(state.connection).toMatchObject({
      connectionMode: 'tunnel',
      activeMcpUrl: `${publicUrl}/mcp`,
      mcpPublicUrl: `${publicUrl}/mcp`,
      mcpLocalUrl: `${context.baseUrl}/mcp`,
      activePublicUrl: publicUrl,
    });
  });
});
