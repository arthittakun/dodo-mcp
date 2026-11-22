import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/store/db.js';
import { Store } from '../../src/store/store.js';
import { ResourceService } from '../../src/services/resources/resourceService.js';
import { WorkspaceFS } from '../../src/workspace/fs.js';
import { IgnoreEngine } from '../../src/workspace/ignores.js';
import { resolveWorkspaceRoot } from '../../src/workspace/root.js';
import { mintWorkspaceId } from '../../src/workspace/identity.js';
import { ensurePrivateDirectory } from '../../src/platform/privateFs.js';
import { removeWithRetry } from '../../src/platform/fsRetry.js';
import { newId, sha256Bytes } from '../../src/util/hash.js';
import type { AppServices, ToolCtx } from '../../src/tools/context.js';

describe('bounded generated animation JSON resources', () => {
  let directory: string, store: Store, resources: ResourceService, owner: ToolCtx;
  const frame = { filename: 'animation 0', frame: { x: 0, y: 0, w: 800, h: 800 }, rotated: false, trimmed: false,
    spriteSourceSize: { x: 0, y: 0, w: 800, h: 800 }, sourceSize: { w: 800, h: 800 }, duration: 20 };
  const atlas = Buffer.from(JSON.stringify({ frames: Array.from({ length: 250 }, () => frame), meta: { image: 'animation.png' } }, null, 2));
  beforeAll(() => {
    directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dodo-generated-json-')));
    const root = path.join(directory, 'workspace'), privateDir = path.join(directory, 'private');
    fs.mkdirSync(root); ensurePrivateDirectory(privateDir);
    store = new Store(openDatabase(path.join(privateDir, 'state.db')));
    const identity = resolveWorkspaceRoot(root), workspaceId = mintWorkspaceId(store.installSecret(), identity.root);
    store.upsertWorkspace({ id: workspaceId, ...identity, epoch: 'boot_generatedjson' });
    const services = { store, workspaceId, wfs: new WorkspaceFS(root, new IgnoreEngine({ root })) } as AppServices;
    resources = new ResourceService(services, privateDir, path.join(privateDir, 'objects'), path.join(privateDir, 'staging'), store.installSecret());
    services.resources = resources;
    owner = { services, trustMode: 'trusted', principal: { grantId: 'local-stdio', clientId: 'stdio', sub: 'owner', scopes: ['dodo:read', 'dodo:write', 'dodo:exec'] } };
  });
  afterAll(() => { resources?.close(); store?.db.close(); if (directory) removeWithRetry(directory, true); });

  it('retains and exports a complete valid atlas larger than the MIME header window', async () => {
    expect(atlas.length).toBeGreaterThan(64 * 1024);
    const info = await resources.ingestGenerated(owner, atlas, 'application/json', newId('anim'), { format: 'spritesheet' });
    expect(info).toMatchObject({ mimeType: 'application/json', bytes: atlas.length, sha256: sha256Bytes(atlas), source: { kind: 'generated' } });
    const exported = await resources.exportBytes(owner, info.resourceId, info.sha256, 256 * 1024);
    expect(exported.bytes.equals(atlas)).toBe(true);
    expect(JSON.parse(exported.bytes.toString()).frames).toHaveLength(250);
  });

  it.each([
    { name: 'truncated document', bytes: Buffer.from('{"frames":[') },
    { name: 'trailing data beyond the header window', bytes: Buffer.from('{"frames":[]}' + ' '.repeat(65536) + 'garbage') },
    { name: 'trailing data after a large atlas', bytes: Buffer.concat([atlas, Buffer.from('\ninvalid')]) },
    { name: 'invalid UTF-8', bytes: Buffer.concat([Buffer.from('{"name":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}')]) },
  ])('rejects $name before inserting CAS metadata', async ({ bytes }) => {
    const before = store.db.prepare('SELECT COUNT(*) AS n FROM resource_objects').get();
    await expect(resources.ingestGenerated(owner, bytes, 'application/json', newId('anim'))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM resource_objects').get()).toEqual(before);
  });

  it('rejects metadata above the complete-document budget before parsing or publishing', async () => {
    const bytes = Buffer.from(JSON.stringify({ padding: 'x'.repeat(1024 * 1024) }));
    const before = store.db.prepare('SELECT COUNT(*) AS n FROM resource_objects').get();
    await expect(resources.ingestGenerated(owner, bytes, 'application/json', newId('anim'))).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' });
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM resource_objects').get()).toEqual(before);
  });
});
