import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { platformFixture } from '../helpers/platform.js';
import { ProjectRegistry } from '../../src/projects/registry.js';
import { bootstrapWorkspace } from '../../src/server/bootstrap.js';

describe('R01 abrupt capture termination',()=>{
  it('reopens durable incomplete state without replaying a command or treating it as a complete snapshot',async()=>{
    const f=platformFixture();fs.writeFileSync(path.join(f.root,'a.txt'),'original');new ProjectRegistry(f.ws.store).add(f.root,'Fixture');await f.ws.shutdownServices();
    const modulePath=new URL('../../dist/server/bootstrap.js',import.meta.url).href;
    const code=`import { bootstrapWorkspace } from ${JSON.stringify(modulePath)};
      const ws=bootstrapWorkspace({invokedCwd:process.argv[1],configDir:{dir:process.argv[2],source:'env'},log:()=>{}});
      ws.services.recovery.storage.publish=async()=>process.exit(79);
      await ws.services.recovery.checkpoint('before-exec','crash-fixture');process.exit(80);`;
    const child=spawnSync(process.execPath,['--input-type=module','-e',code,f.root,f.configDir],{timeout:20000,encoding:'utf8'});
    let next:ReturnType<typeof bootstrapWorkspace>|undefined;
    try{
      expect(child.status,child.stderr).toBe(79);
      next=bootstrapWorkspace({invokedCwd:f.root,configDir:{dir:f.configDir,source:'env'},log:()=>{}});
      expect(next.store.db.prepare("SELECT COUNT(*) n FROM recovery_snapshots WHERE state='INCOMPLETE'").get()).toEqual({n:1});
      expect(next.store.db.prepare('SELECT COUNT(*) n FROM recovery_reservations').get()).toEqual({n:0});
      await next.services.recovery!.checkpoint('owner-checkpoint','owner');
      expect(next.services.recovery!.status().state).toBe('READY');expect(next.store.db.prepare('SELECT COUNT(*) n FROM jobs').get()).toEqual({n:0});
      expect(fs.readFileSync(path.join(f.root,'a.txt'),'utf8')).toBe('original');
    }finally{await next?.shutdownServices();await f.close();}
  });
});
