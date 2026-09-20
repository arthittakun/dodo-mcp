import fs from 'node:fs';
import path from 'node:path';
import {describe,it,expect} from 'vitest';
import {bootstrapWorkspace} from '../../src/server/bootstrap.js';
import {InstallationRuntime} from '../../src/server/installationRuntime.js';
import {ProjectRegistry} from '../../src/projects/registry.js';
import {mkTmpDir} from '../helpers/testServer.js';

describe('project runtime lifetime',()=>{
  it('blocks new requests while an idle target is tearing down, keeping the default available',async()=>{
    const fixture=mkTmpDir('dodo-runtime-lifetime-');
    for(const name of ['a','b','config'])fs.mkdirSync(path.join(fixture,name),{mode:0o700});
    const initial=bootstrapWorkspace({invokedCwd:path.join(fixture,'a'),configDir:{dir:path.join(fixture,'config'),source:'env'},log:()=>undefined});
    let finish=()=>{},started=()=>{};
    const wait=new Promise<void>(r=>{finish=r;}),closing=new Promise<void>(r=>{started=r;});
    const manager=new InstallationRuntime(initial,()=>initial,async()=>({close:async()=>{started();await wait;}}),()=>undefined);
    try{
      const registry=new ProjectRegistry(manager.store),a=registry.add(path.join(fixture,'a')).project,b=registry.add(path.join(fixture,'b')).project;
      const lease=await manager.acquire(b.projectId,manager.owner());const epoch=lease.services.epoch;await lease.services.recovery!.checkpoint('owner-checkpoint','fixture');lease.release();
      const close=manager.closeProject(b.projectId);await closing;
      await expect(manager.acquire(b.projectId,manager.owner())).rejects.toMatchObject({code:'CONFLICT'});
      const active=await manager.acquire(a.projectId,manager.owner());expect(active.services.workspaceId).toBe(initial.workspaceId);active.release();
      finish();expect(await close).toBe(true);
      const reopened=await manager.acquire(b.projectId,manager.owner());expect(reopened.services.epoch).not.toBe(epoch);reopened.release();
    }finally{finish();await manager.close();await initial.shutdownServices();fs.rmSync(fixture,{recursive:true,force:true});}
  });
});
