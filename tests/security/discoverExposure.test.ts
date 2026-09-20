import { afterEach, describe, expect, it } from 'vitest';
import { surfaceCatalog, discoverExposure, normalizeDisabledDiscoverOperations, operationSchema, surfaceStats } from '../../src/tools/surface.js';
import { GlobalConfigSchema, loadGlobalConfig } from '../../src/config/globalConfig.js';
import { invokeToolDefinition } from '../../src/tools/context.js';
import { platformFixture } from '../helpers/platform.js';
import { launch, type TestContext } from '../helpers/testServer.js';

describe('restored release tool visibility is exposure only', () => {
  let f: ReturnType<typeof platformFixture> | undefined, http: TestContext | undefined;
  afterEach(async () => { await f?.close(); f = undefined; await http?.cleanup(); http = undefined; });
  const features = { subagents: false, disabledDiscoverOperations: ['write_file', 'fetch_url'] };
  it('canonicalizes names, rejects unknown/duplicate policy and removes empty gateways', () => {
    expect(normalizeDisabledDiscoverOperations(['fetch_url','write_file'])).toEqual(normalizeDisabledDiscoverOperations(['write_file','fetch_url']));
    expect(() => normalizeDisabledDiscoverOperations(['owner_control'])).toThrow('unknown discover operation');
    expect(GlobalConfigSchema.safeParse({disabledDiscoverOperations:['write_file','write_file']}).success).toBe(false);
    expect(GlobalConfigSchema.parse({}).disabledDiscoverOperations).toEqual([]);
    expect(surfaceCatalog('compact', features).some(t => t.name === 'dodo_web')).toBe(false);
    expect(surfaceCatalog('hybrid', features).some(t => t.name === 'write_file')).toBe(false);
    expect(surfaceCatalog('full', features).some(t => t.name === 'write_file')).toBe(true);
    expect(surfaceCatalog('compact', features).length).toBeLessThanOrEqual(20);
    expect(discoverExposure(features).operations.find(t => t.operation === 'write_file')?.enabled).toBe(false);
  });
  it('hidden operation is absent in both discover detail and gateway schema', async () => {
    f = platformFixture();
    const catalog = surfaceCatalog('compact', features);
    const schema = operationSchema(catalog.find(t => t.name === 'dodo_write')!).inputSchema;
    expect(JSON.stringify(schema)).not.toContain('"write_file"');
    const result = await invokeToolDefinition({def:catalog.find(t => t.name === 'dodo_discover')!,services:f.ws.services,principal:f.ws.services.localPrincipal!,args:{workspaceId:f.ws.workspaceId,workspaceEpoch:f.ws.epoch,operation:'write_file'}});
    expect(result.envelope.ok).toBe(false);
    expect(surfaceStats('compact',features).schemaBytes).toBeLessThan(surfaceStats('compact',{subagents:false}).schemaBytes);
  });
  it('private editor requires owner authentication/context, persists real settings and never echoes bad values', async () => {
    http = await launch({configPort:0});
    const url = new URL(http.configUrl!); const token = url.hash.slice(1);
    const request = (endpoint:string, body?:unknown, auth = true, epoch = http!.server.epoch) => fetch(url.origin+'/api/admin/'+endpoint,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json',...(auth?{authorization:'Bearer '+token}:{}),'x-dodo-workspace':http!.server.workspaceId,'x-dodo-epoch':epoch},...(body===undefined?{}:{body:JSON.stringify(body)})});
    expect((await request('discover-exposure',undefined,false)).status).toBe(401);
    expect((await request('config',{disabledDiscoverOperations:['write_file']},true,'old')).status).toBe(409);
    const saved = await (await request('config',{disabledDiscoverOperations:['write_file']})).json() as {data:{saved:boolean;restartRequired:boolean}};
    expect(saved.data).toMatchObject({saved:true,restartRequired:true});
    expect(loadGlobalConfig(http.configDir+'/config.json').disabledDiscoverOperations).toEqual(['write_file']);
    const exposure=await (await request('discover-exposure')).json() as {data:{operations:Array<{operation:string;enabled:boolean}>}};
    expect(exposure.data.operations.find(t=>t.operation==='write_file')?.enabled).toBe(false);
    const marker='fixture-value-must-not-echo'; const bad=await request('config',{logRetentionDays:marker});const text=await bad.text();
    expect(bad.status).toBe(400);expect(text).toContain('logRetentionDays');expect(text).not.toContain(marker);
    expect((await fetch(http.baseUrl+'/api/admin/discover-exposure')).status).toBe(404);
  });
});
