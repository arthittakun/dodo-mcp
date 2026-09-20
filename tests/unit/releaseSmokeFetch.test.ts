import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

const { restartInitializationFetch } = await import(pathToFileURL(path.resolve('scripts/release-smoke-fetch.mjs')).href) as {
  restartInitializationFetch: (fn: typeof fetch) => typeof fetch;
};
const input='http://127.0.0.1:19999/mcp';
const request=(method:string)=>({method:'POST',body:JSON.stringify({jsonrpc:'2.0',method,id:1})});
const reset=()=>Object.assign(new TypeError('fixture transport reset'),{cause:{code:'ECONNRESET'}});
describe('installed-package restart handshake',()=>{
  it('retries a reset initialization only, preserving the exact request',async()=>{
    const response=new Response('fixture'),fn=vi.fn<typeof fetch>().mockRejectedValueOnce(reset()).mockResolvedValue(response);
    const init=request('initialize');expect(await restartInitializationFetch(fn)(input,init)).toBe(response);
    expect(fn.mock.calls).toEqual([[input,init],[input,init]]);
  });
  it('never retries tools, notifications, ambiguous input or HTTP errors',async()=>{
    for(const method of ['tools/call','notifications/initialized','unknown']){
      const fn=vi.fn<typeof fetch>().mockRejectedValue(reset());await expect(restartInitializationFetch(fn)(input,request(method))).rejects.toThrow();expect(fn).toHaveBeenCalledTimes(1);
    }
    const fn=vi.fn<typeof fetch>().mockRejectedValue(reset());await expect(restartInitializationFetch(fn)(input,{method:'POST',body:'invalid'})).rejects.toThrow();expect(fn).toHaveBeenCalledTimes(1);
    const forbidden=new Response('',{status:401}),auth=vi.fn<typeof fetch>().mockResolvedValue(forbidden);
    expect(await restartInitializationFetch(auth)(input,request('initialize'))).toBe(forbidden);expect(auth).toHaveBeenCalledTimes(1);
  });
  it('bounds retries and preserves cancellation and unrelated errors',async()=>{
    const error=reset(),fn=vi.fn<typeof fetch>().mockRejectedValue(error);await expect(restartInitializationFetch(fn)(input,request('initialize'))).rejects.toBe(error);expect(fn).toHaveBeenCalledTimes(4);
    const abort=vi.fn<typeof fetch>().mockRejectedValue(error);await expect(restartInitializationFetch(abort)(input,{...request('initialize'),signal:AbortSignal.abort()})).rejects.toBe(error);expect(abort).toHaveBeenCalledTimes(1);
    const timeout=vi.fn<typeof fetch>().mockRejectedValue(Object.assign(new Error('timeout'),{cause:{code:'ETIMEDOUT'}}));await expect(restartInitializationFetch(timeout)(input,request('initialize'))).rejects.toThrow('timeout');expect(timeout).toHaveBeenCalledTimes(1);
  });
});
